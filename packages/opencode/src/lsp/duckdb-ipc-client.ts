import { type Subprocess, spawn } from "bun"
import crypto from "crypto"
import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { Log } from "../util/log"
import { Global } from "../global"
import { BunProc } from "../bun"

const log = Log.create({ service: "lsp.duckdb-ipc" })

export interface ColumnDef {
  name: string
  type: "varchar" | "integer" | "bigint" | "text" | "varchar[]"
  nullable?: boolean
}

interface RPCRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: any
}

interface RPCResponse {
  jsonrpc: "2.0"
  id: number
  result?: any
  error?: { code: number; message: string }
}

// Server code as string - will be written to temp file at runtime
// This avoids @duckdb/node-api dependency in main process compilation
const SERVER_CODE = String.raw`import { DuckDBInstance, listValue, LIST, VARCHAR } from "@duckdb/node-api"
import { mkdir } from "fs/promises"
import { dirname } from "path"

let conn = null
let instance = null

const handlers = {
  async init({ dbPath }) {
    await mkdir(dirname(dbPath), { recursive: true })
    instance = await DuckDBInstance.create(dbPath)
    conn = await instance.connect()
    return true
  },

  async exec({ sql }) {
    await conn.run(sql)
    return true
  },

  async query({ sql, params }) {
    const reader = await conn.runAndReadAll(sql, params)
    return reader.getRowObjects()
  },

  async appendRows({ table, schema, columns, rows }) {
    const appender = await conn.createAppender(table, schema)
    for (const row of rows) {
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i]
        const val = row[i]
        if (val === null || val === undefined) {
          appender.appendNull()
        } else if (col.type === "varchar" || col.type === "text") {
          appender.appendVarchar(val)
        } else if (col.type === "integer") {
          appender.appendInteger(val)
        } else if (col.type === "bigint") {
          appender.appendBigInt(BigInt(val))
        } else if (col.type === "varchar[]") {
          appender.appendList(listValue(val), LIST(VARCHAR))
        }
      }
      appender.endRow()
    }
    appender.flushSync()
    appender.closeSync()
    return true
  },

  async delete({ sql, params }) {
    await conn.run(sql, params)
    return true
  },

  shutdown() {
    if (conn) conn.closeSync()
    return true
  }
}

let buffer = ""

process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""

  for (const line of lines) {
    if (!line.trim()) continue
    let req = null
    try {
      req = JSON.parse(line)
      const handler = handlers[req.method]
      if (!handler) throw new Error("Unknown method: " + req.method)
      const result = await handler(req.params)
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n")
    } catch (e) {
      const id = req?.id ?? 0
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message: e.message } }) + "\n")
    }
  }
})
`

export class DuckDBIPCClient {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>()
  private id = 0
  private buffer = ""
  private dbPath: string
  private serverScriptPath: string | null = null
  private started = false
  private restartCount = 0
  private maxRestarts = 3
  private timeout = 30000

  constructor(instanceDir: string) {
    const rootHash = crypto.createHash("md5").update(instanceDir).digest("hex")
    this.dbPath = path.join(Global.Path.bin, "lsp-symbols-index", rootHash, "symbols.duckdb")
  }

  async start(): Promise<void> {
    if (this.started) return

    log.info("starting duckdb ipc server", { dbPath: this.dbPath })

    // Ensure @duckdb/node-api is installed in Global.Path.bin
    const duckdbModulePath = path.join(Global.Path.bin, "node_modules", "@duckdb", "node-api")
    if (!(await Bun.file(path.join(duckdbModulePath, "package.json")).exists())) {
      await Bun.spawn([BunProc.which(), "install", "@duckdb/node-api"], {
        cwd: Global.Path.bin,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      }).exited
    }

    // Write server script to Global.Path.bin (where @duckdb/node-api is installed)
    const serverDir = path.join(Global.Path.bin, "lsp-symbols-index")
    await mkdir(serverDir)
    this.serverScriptPath = path.join(serverDir, "server.js")
    
    // Write the server code
    await writeFile(this.serverScriptPath, SERVER_CODE)

    this.proc = spawn([BunProc.which(), "run", this.serverScriptPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: Global.Path.bin, // Run from bin directory where node_modules exists
    })

    this.setupReader()
    this.setupErrorReader()

    await this.request("init", { dbPath: this.dbPath })
    this.started = true
    this.restartCount = 0
  }

  private setupReader(): void {
    if (!this.proc) return

    const reader = this.proc.stdout.getReader()
    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          this.buffer += new TextDecoder().decode(value)
          this.processBuffer()
        }
      } catch (e) {
        log.debug("stdout reader error", { error: e })
      }
    }
    read()
  }

  private setupErrorReader(): void {
    if (!this.proc) return

    const reader = this.proc.stderr.getReader()
    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = new TextDecoder().decode(value)
          log.error("duckdb server stderr", { text })
        }
      } catch (e) {
        // ignore
      }
    }
    read()
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const response: RPCResponse = JSON.parse(line)
        const pending = this.pending.get(response.id)
        if (pending) {
          this.pending.delete(response.id)
          clearTimeout(pending.timer)
          if (response.error) {
            pending.reject(new Error(response.error.message))
          } else {
            pending.resolve(response.result)
          }
        }
      } catch (e) {
        log.error("failed to parse response", { line, error: e })
      }
    }
  }

  private async ensureRunning(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) {
      if (this.restartCount >= this.maxRestarts) {
        throw new Error("DuckDB server crashed too many times")
      }
      this.restartCount++
      this.started = false
      log.warn("duckdb server not running, restarting", { restartCount: this.restartCount })
      await this.start()
    }
  }

  private request<T>(method: string, params?: any): Promise<T> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.ensureRunning()
      } catch (e) {
        return reject(e)
      }

      if (!this.proc) {
        return reject(new Error("DuckDB IPC client not started"))
      }

      const id = this.id++

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`IPC timeout: ${method}`))
      }, this.timeout)

      this.pending.set(id, { resolve, reject, timer })

      const request: RPCRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      }

      try {
        this.proc.stdin.write(JSON.stringify(request) + "\n")
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  async exec(sql: string): Promise<void> {
    await this.request("exec", { sql })
  }

  async query<T>(sql: string, params?: Record<string, any>): Promise<T[]> {
    return this.request<T[]>("query", { sql, params })
  }

  async appendRows(table: string, schema: string, columns: ColumnDef[], rows: any[][]): Promise<void> {
    await this.request("appendRows", { table, schema, columns, rows })
  }

  async delete(sql: string, params?: Record<string, any>): Promise<void> {
    await this.request("delete", { sql, params })
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return

    // Cancel all pending requests first (this unblocks any waiters)
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Client shutdown"))
    }
    this.pending.clear()

    // Try to send graceful shutdown
    try {
      await this.request("shutdown", {})
    } catch {
      // ignore - process may already be gone
    }

    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    this.started = false
  }

  isStarted(): boolean {
    return this.started && this.proc !== null && this.proc.exitCode === null
  }
}
