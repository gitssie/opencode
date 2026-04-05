import { pathToFileURL } from "url"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { DuckDBIPCClient, type ColumnDef } from "./duckdb-ipc-client"
import { Ripgrep } from "../file/ripgrep"
import { IGNORE_PATTERNS } from "../tool/ls"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import path from "path"
import { LSPClient } from "./client"
import type { Location as VSCodeLocation } from "vscode-languageserver-types"
import { LSP } from "."
import type { LSPServer } from "./server"

export namespace Index {
  const log = Log.create({ service: "lsp.index" })

  interface State {
    client: DuckDBIPCClient
    counter: number
    rebuildInProgress: boolean
    buildingClients: Map<string, Promise<{ indexed: number; skipped: number; errors: number }>>
    pendingUpdates: Map<string, Map<string, { event: string }>>
    flushTimers: Map<string, ReturnType<typeof setTimeout>>
  }

  interface Interface {
    state: () => Effect.Effect<State>
  }

  class Service extends ServiceMap.Service<Service, Interface>()("@opencode/LSP/Index") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const live = yield* InstanceState.make<State>((ctx) =>
        Effect.gen(function* () {
          const client = new DuckDBIPCClient(ctx.directory)
          yield* Effect.promise(() => client.start())

          const state: State = {
            client,
            counter: 1,
            rebuildInProgress: false,
            buildingClients: new Map(),
            pendingUpdates: new Map(),
            flushTimers: new Map(),
          }

          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              for (const timer of state.flushTimers.values()) {
                clearTimeout(timer)
              }
              await client.shutdown().catch(() => {})
            }),
          )

          return state
        }),
      )

      return Service.of({
        state: () => InstanceState.get(live),
      })
    }),
  )

  const { runPromise } = makeRuntime(Service, layer)

  const getState = () => runPromise((svc) => svc.state())

  const clearPending = (s: State, serverID: string) => {
    const timer = s.flushTimers.get(serverID)
    if (timer) clearTimeout(timer)
    s.flushTimers.delete(serverID)
    s.pendingUpdates.delete(serverID)
  }

  const clearBuilding = (s: State, serverID: string) => {
    for (const key of s.buildingClients.keys()) {
      if (key.startsWith(`${serverID}:`)) {
        s.buildingClients.delete(key)
      }
    }
  }

  export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

  type Location = VSCodeLocation & {
    absolutePath?: string
    relativePath?: string
  }

  type DocumentSymbol = LSPClient.DocumentSymbol & {
    body?: string
    location?: Location
    namePath?: string
  }

  interface Document {
    id: string
    relativePath: string
    contentHash: string
    symbols: DocumentSymbol[]
  }

  // ==================== FileBuffer ====================

  export class FileBuffer {
    readonly uri: string
    readonly absolutePath: string
    readonly relativePath: string
    private _contents: string | null = null
    private _lines: string[] | null = null
    private _contentHash: string | null = null
    private _exists: boolean | null = null

    constructor(absolutePath: string, relativePath: string) {
      this.absolutePath = absolutePath
      this.relativePath = relativePath
      this.uri = pathToFileURL(absolutePath).href
    }

    async exists(): Promise<boolean> {
      if (this._exists === null) {
        this._exists = await Bun.file(this.absolutePath).exists()
      }
      return this._exists
    }

    async getContents(): Promise<string> {
      if (this._contents === null) {
        this._contents = await Bun.file(this.absolutePath)
          .text()
          .catch(() => "")
      }
      return this._contents
    }

    async splitLines(): Promise<string[]> {
      if (this._lines === null) {
        const contents = await this.getContents()
        this._lines = contents.split("\n")
      }
      return this._lines
    }

    async getContentHash(): Promise<string> {
      if (this._contentHash === null) {
        const contents = await this.getContents()
        this._contentHash = Bun.hash(contents).toString()
      }
      return this._contentHash
    }
  }

  export class FileBufferCache {
    private cache = new Map<string, FileBuffer>()

    async get(absolutePath: string, relativePath?: string): Promise<FileBuffer> {
      let buffer = this.cache.get(absolutePath)
      if (!buffer) {
        const relPath = relativePath ?? path.relative(Instance.directory, absolutePath)
        buffer = new FileBuffer(absolutePath, relPath)
        this.cache.set(absolutePath, buffer)
      }
      return buffer
    }

    clear(): void {
      this.cache.clear()
    }
  }

  // ==================== Abstract Interface ====================

  export interface SymbolIndex {
    start(): void
    stop(): void
    isStarted(): boolean

    isDocCached(relativePath: string, contentHash: string): Promise<boolean>
    storeDocSymbols(relativePath: string, contentHash: string, symbols: DocumentSymbol[]): Promise<void>
    getDocSymbols(relativePath: string, contentHash: string): Promise<DocumentSymbol[] | null>

    searchSymbols(opts: {
      namePathRegex: string
      relativePathRegex?: string
      includeKinds?: number[]
      excludeKinds?: number[]
      includeBody?: boolean
    }): Promise<Document[]>

    invalidateDoc(relativePath: string): Promise<void>
    invalidateDocs(docIds: string[]): Promise<void>
    clearAll(): Promise<void>
    createAppender(batchMode: boolean): SymbolAppender
  }

  export interface SymbolAppender {
    append(relativePath: string, contentHash: string, symbols: DocumentSymbol[]): Promise<void>
    commit(): Promise<void>
  }

  // Symbol row data type
  interface SymbolRow {
    id: string
    docId: string
    parentId: string | null
    parentIds: string[]
    name: string
    namePath: string
    kind: number
    startLine: number
    startChar: number
    endLine: number
    endChar: number
    body: string | null
    detail: string | null
    overloadIdx: number
    children?: SymbolRow[]
  }

  // Document row data type
  interface DocRow {
    id: string
    name: string
    relativePath: string
    contentHash: string
    schemaVersion: number
  }

  interface ResultRow {
    id: string
    doc_id: string
    parent_id: string | null
    parent_ids: string[]
    name: string
    name_path: string
    kind: number
    start_line: number
    start_char: number
    end_line: number
    end_char: number
    body: string | null
    detail: string | null
    overload_idx: number
    relative_path: string
    content_hash: string
  }

  type Params = Record<string, unknown>

  async function getSharedClient(): Promise<DuckDBIPCClient> {
    const s = await getState()
    return s.client
  }

  export class DuckDBIndex implements SymbolIndex {
    private schemaName: string
    private schemaInitialized = false
    private started = false

    constructor(schemaName: string = "symbols") {
      this.schemaName = schemaName.replace(/[^a-zA-Z0-9_]/g, "_")
    }

    start(): void {
      this.started = true
      this.schemaInitialized = false
    }

    private async ensureInit(): Promise<DuckDBIPCClient> {
      const client = await getSharedClient()
      if (!this.schemaInitialized) {
        await this.initSchema(client)
        this.schemaInitialized = true
      }
      return client
    }

    stop(): void {
      if (this.started) {
        this.started = false
        this.schemaInitialized = false
      }
    }

    isStarted(): boolean {
      return this.started
    }

    private async exec(sql: string): Promise<void> {
      const client = await this.ensureInit()
      await client.exec(sql)
    }

    private async run(sql: string, params?: Params): Promise<void> {
      const client = await this.ensureInit()
      if (params) {
        await client.delete(sql, params)
      } else {
        await client.exec(sql)
      }
    }

    private async all<T>(sql: string, params?: Params): Promise<T[]> {
      const client = await this.ensureInit()
      return client.query<T>(sql, params)
    }

    private async initSchema(client: DuckDBIPCClient): Promise<void> {
      const schema = this.schemaName

      await client.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`)

      await client.exec(`
      CREATE TABLE IF NOT EXISTS ${schema}.docs (
        id VARCHAR PRIMARY KEY,
        name VARCHAR,
        relative_path VARCHAR,
        content_hash VARCHAR,
        last_modified BIGINT,
        schema_version INTEGER
      )
    `)

      await client.exec(`
      CREATE TABLE IF NOT EXISTS ${schema}.symbols (
        id VARCHAR PRIMARY KEY,
        doc_id VARCHAR NOT NULL,
        parent_id VARCHAR,
        parent_ids VARCHAR[],
        name VARCHAR NOT NULL,
        name_path VARCHAR NOT NULL,
        kind INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        start_char INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        end_char INTEGER NOT NULL,
        body TEXT,
        detail TEXT,
        overload_idx INTEGER DEFAULT 0
      )
    `)

      await client.exec(`CREATE INDEX IF NOT EXISTS idx_${schema}_symbols_doc ON ${schema}.symbols(doc_id)`)
      await client.exec(`CREATE INDEX IF NOT EXISTS idx_${schema}_symbols_parent ON ${schema}.symbols(parent_id)`)
      await client.exec(`CREATE INDEX IF NOT EXISTS idx_${schema}_symbols_name_path ON ${schema}.symbols(name_path)`)
    }

    private makeDocId(relativePath: string): string {
      const normalized = relativePath.replace(/\\/g, "/")
      return Bun.hash(`doc://${this.schemaName}:${normalized}`).toString(16)
    }

    private makeSymbolId(
      docId: string,
      parentId: string | null,
      name: string,
      startLine: number,
      startChar: number,
      overloadIdx: number = 0,
    ): string {
      let base = parentId
        ? `${docId}::${parentId}::${name}::${startLine}:${startChar}`
        : `${docId}::${name}::${startLine}:${startChar}`
      if (overloadIdx > 0) {
        base += `::[${overloadIdx}]`
      }
      return Bun.hash(base).toString(16)
    }

    async isDocCached(relativePath: string, contentHash: string): Promise<boolean> {
      await this.ensureInit()
      const docId = this.makeDocId(relativePath)
      const rows = await this.all<{ content_hash: string }>(
        `SELECT content_hash FROM ${this.schemaName}.docs WHERE id = $1`,
        { 1: docId },
      )
      return rows[0]?.content_hash === contentHash
    }

    async storeDocSymbols(relativePath: string, contentHash: string, symbols: DocumentSymbol[]): Promise<void> {
      const docRow = this.createDocRow(relativePath, contentHash)
      const symbolRows: SymbolRow[] = []
      this.collectSymbolRows(docRow.id, symbols, null, "", [], symbolRows)

      await this.batchSave([docRow], symbolRows, [docRow.id])
    }

    // 收集符号为行数据（用于批量插入）
    collectSymbolRows(
      docId: string,
      symbols: DocumentSymbol[],
      parentId: string | null,
      parentPath: string,
      parentIds: string[],
      rows: SymbolRow[],
    ): void {
      // Normalize names and assign overload indices for this sibling group.
      normalizeSymbols(symbols)

      for (const sym of symbols) {
        const name = sym.name
        const overloadIdx = sym.overloadIdx ?? 0

        // Append overload index using # symbol (regex-safe)
        let namePath = parentPath ? `${parentPath}/${name}` : name
        if (overloadIdx > 0) {
          namePath += `#${overloadIdx}`
        }
        const range = sym.range
        const startLine = range?.start?.line ?? 0
        const startChar = range?.start?.character ?? 0
        const endLine = range?.end?.line ?? 0
        const endChar = range?.end?.character ?? 0
        const kind = sym.kind ?? 0
        const detail = sym.detail ?? null

        const symbolId = this.makeSymbolId(docId, parentId, name, startLine, startChar, overloadIdx)
        const currentParentIds = parentId ? [...parentIds, parentId] : parentIds

        rows.push({
          id: symbolId,
          docId,
          parentId,
          parentIds: currentParentIds,
          name,
          namePath,
          kind,
          startLine,
          startChar,
          endLine,
          endChar,
          body: null,
          detail,
          overloadIdx,
        })

        if ("children" in sym && Array.isArray(sym.children)) {
          this.collectSymbolRows(docId, sym.children as DocumentSymbol[], symbolId, namePath, currentParentIds, rows)
        }
      }
    }

    // 创建文档行数据
    createDocRow(relativePath: string, contentHash: string): DocRow {
      const docId = this.makeDocId(relativePath)
      const docName = path.basename(relativePath)
      const normalizedPath = relativePath.replace(/\\/g, "/")
      return { id: docId, name: docName, relativePath: normalizedPath, contentHash, schemaVersion: 1 }
    }

    // 批量保存（供 BatchAppender 使用）
    async batchSave(docRows: DocRow[], symbolRows: SymbolRow[], docIdsToDelete: string[]): Promise<void> {
      const client = await this.ensureInit()
      const schema = this.schemaName

      // 删除旧数据
      if (docIdsToDelete.length > 0) {
        const placeholders = docIdsToDelete.map((_, i) => `$${i + 1}`).join(",")
        const params: Params = {}
        docIdsToDelete.forEach((id, i) => {
          params[i + 1] = id
        })
        await client.delete(`DELETE FROM ${schema}.symbols WHERE doc_id IN (${placeholders})`, params)
        await client.delete(`DELETE FROM ${schema}.docs WHERE id IN (${placeholders})`, params)
      }

      // 批量插入 docs（使用 IPC appendRows）
      if (docRows.length > 0) {
        const docColumns: ColumnDef[] = [
          { name: "id", type: "varchar" },
          { name: "name", type: "varchar" },
          { name: "relative_path", type: "varchar" },
          { name: "content_hash", type: "varchar" },
          { name: "last_modified", type: "bigint" },
          { name: "schema_version", type: "integer" },
        ]
        const docData = docRows.map((row) => [
          row.id,
          row.name,
          row.relativePath,
          row.contentHash,
          Date.now(),
          row.schemaVersion,
        ])
        await client.appendRows("docs", schema, docColumns, docData)
      }

      // 批量插入 symbols（使用 IPC appendRows）
      if (symbolRows.length > 0) {
        const symbolColumns: ColumnDef[] = [
          { name: "id", type: "varchar" },
          { name: "doc_id", type: "varchar" },
          { name: "parent_id", type: "varchar", nullable: true },
          { name: "parent_ids", type: "varchar[]" },
          { name: "name", type: "varchar" },
          { name: "name_path", type: "varchar" },
          { name: "kind", type: "integer" },
          { name: "start_line", type: "integer" },
          { name: "start_char", type: "integer" },
          { name: "end_line", type: "integer" },
          { name: "end_char", type: "integer" },
          { name: "body", type: "text", nullable: true },
          { name: "detail", type: "text", nullable: true },
          { name: "overload_idx", type: "integer" },
        ]
        const symbolData = symbolRows.map((row) => [
          row.id,
          row.docId,
          row.parentId,
          row.parentIds,
          row.name,
          row.namePath,
          row.kind,
          row.startLine,
          row.startChar,
          row.endLine,
          row.endChar,
          row.body,
          row.detail,
          row.overloadIdx,
        ])
        await client.appendRows("symbols", schema, symbolColumns, symbolData)
      }
    }

    async getDocSymbols(relativePath: string, contentHash: string): Promise<DocumentSymbol[] | null> {
      await this.ensureInit()

      const schema = this.schemaName
      const docId = this.makeDocId(relativePath)

      const docRows = await this.all<{ content_hash: string }>(
        `SELECT content_hash FROM ${schema}.docs WHERE id = $1`,
        {
          1: docId,
        },
      )
      if (!docRows[0] || docRows[0].content_hash !== contentHash) return null

      interface DBSymbolRow {
        id: string
        parent_id: string | null
        parent_ids: string[]
        name: string
        name_path: string
        kind: number
        start_line: number
        start_char: number
        end_line: number
        end_char: number
        body: string | null
        detail: string | null
        overload_idx: number
      }

      const rows = await this.all<DBSymbolRow>(
        `SELECT id, parent_id, parent_ids, name, name_path, kind, start_line, start_char, end_line, end_char, body, detail, overload_idx FROM ${schema}.symbols WHERE doc_id = $1 ORDER BY start_line`,
        { 1: docId },
      )

      const symbolMap = new Map<string, SymbolRow>()

      for (const row of rows) {
        symbolMap.set(row.id, {
          id: row.id,
          docId,
          parentId: row.parent_id,
          parentIds: row.parent_ids ?? [],
          name: row.name,
          namePath: row.name_path,
          kind: row.kind,
          startLine: row.start_line,
          startChar: row.start_char,
          endLine: row.end_line,
          endChar: row.end_char,
          body: row.body,
          detail: row.detail,
          overloadIdx: row.overload_idx,
          children: [],
        })
      }

      const roots: SymbolRow[] = []
      for (const sym of symbolMap.values()) {
        if (sym.parentId === null) {
          roots.push(sym)
        } else {
          const parent = symbolMap.get(sym.parentId)
          if (parent) {
            parent.children!.push(sym)
          }
        }
      }

      return this.symbolRowsToDocSymbols(roots)
    }

    private symbolRowsToDocSymbols(rows: SymbolRow[], includeBody = false): DocumentSymbol[] {
      return rows.map((row) => ({
        name: row.name,
        namePath: row.namePath,
        kind: row.kind as DocumentSymbol["kind"],
        range: {
          start: { line: row.startLine, character: row.startChar },
          end: { line: row.endLine, character: row.endChar },
        },
        selectionRange: {
          start: { line: row.startLine, character: row.startChar },
          end: { line: row.endLine, character: row.endChar },
        },
        detail: row.detail ?? undefined,
        overloadIdx: row.overloadIdx > 0 ? row.overloadIdx : undefined,
        body: includeBody ? (row.body ?? undefined) : undefined,
        // 不递归处理 children，只保持 doc -> symbols 扁平结构
        children: undefined,
      }))
    }

    async searchSymbols(opts: {
      namePathRegex: string
      relativePathRegex?: string
      includeBody?: boolean
      includeKinds?: number[]
      excludeKinds?: number[]
    }): Promise<Document[]> {
      await this.ensureInit()

      const schema = this.schemaName
      let sql = `SELECT s.id, s.doc_id, s.parent_id, s.parent_ids, s.name, s.name_path, s.kind, s.start_line, s.start_char, s.end_line, s.end_char, s.body, s.detail, s.overload_idx, d.relative_path, d.content_hash FROM ${schema}.symbols s JOIN ${schema}.docs d ON s.doc_id = d.id WHERE 1=1`
      const params: Params = {}
      let paramIndex = 1

      if (opts.namePathRegex) {
        sql += ` AND regexp_matches(s.name_path, $${paramIndex})`
        params[paramIndex++] = opts.namePathRegex
      }

      if (opts.includeKinds?.length) {
        sql += ` AND s.kind IN (${opts.includeKinds.join(",")})`
      }

      if (opts.excludeKinds?.length) {
        sql += ` AND s.kind NOT IN (${opts.excludeKinds.join(",")})`
      }

      if (opts.relativePathRegex) {
        sql += ` AND regexp_matches(d.relative_path, $${paramIndex})`
        params[paramIndex++] = opts.relativePathRegex
      }

      sql += ` ORDER BY d.id, s.kind LIMIT 5000`

      const rows = await this.all<ResultRow>(sql, params)

      const docMap = new Map<
        string,
        { id: string; relativePath: string; contentHash: string; symbols: Map<string, SymbolRow> }
      >()

      for (const row of rows) {
        if (!docMap.has(row.doc_id)) {
          docMap.set(row.doc_id, {
            id: row.doc_id,
            relativePath: row.relative_path,
            contentHash: row.content_hash,
            symbols: new Map(),
          })
        }
        const doc = docMap.get(row.doc_id)!
        doc.symbols.set(row.id, {
          id: row.id,
          docId: row.doc_id,
          parentId: row.parent_id,
          parentIds: row.parent_ids ?? [],
          name: row.name,
          namePath: row.name_path,
          kind: row.kind,
          startLine: row.start_line,
          startChar: row.start_char,
          endLine: row.end_line,
          endChar: row.end_char,
          body: row.body,
          detail: row.detail,
          overloadIdx: row.overload_idx,
          children: [],
        })
      }

      const result: Document[] = []
      for (const doc of docMap.values()) {
        const roots: SymbolRow[] = []
        for (const sym of doc.symbols.values()) {
          if (sym.parentId === null) {
            roots.push(sym)
          } else {
            const parent = doc.symbols.get(sym.parentId)
            if (parent) {
              parent.children!.push(sym)
            } else {
              // 父符号不在结果集中，将当前符号作为根节点
              roots.push(sym)
            }
          }
        }
        result.push({
          id: doc.id,
          relativePath: doc.relativePath,
          contentHash: doc.contentHash,
          symbols: this.symbolRowsToDocSymbols(roots, opts.includeBody),
        })
      }

      return result
    }

    async invalidateDoc(relativePath: string): Promise<void> {
      await this.ensureInit()
      const schema = this.schemaName
      const docId = this.makeDocId(relativePath)
      await this.run(`DELETE FROM ${schema}.symbols WHERE doc_id = $1`, { 1: docId })
      await this.run(`DELETE FROM ${schema}.docs WHERE id = $1`, { 1: docId })
    }

    async invalidateDocs(docIds: string[]): Promise<void> {
      if (docIds.length === 0) return
      await this.ensureInit()
      const schema = this.schemaName
      const placeholders = docIds.map((_, i) => `$${i + 1}`).join(",")
      const params: Params = {}
      docIds.forEach((id, i) => {
        params[i + 1] = id
      })
      await this.run(`DELETE FROM ${schema}.symbols WHERE doc_id IN (${placeholders})`, params)
      await this.run(`DELETE FROM ${schema}.docs WHERE id IN (${placeholders})`, params)
    }

    async clearAll(): Promise<void> {
      await this.ensureInit()
      const schema = this.schemaName
      await this.run(`DELETE FROM ${schema}.symbols`)
      await this.run(`DELETE FROM ${schema}.docs`)
    }

    createAppender(batchMode: boolean): SymbolAppender {
      if (batchMode) {
        return new DuckDBBatchAppender(this)
      }
      return new SingleAppender(this)
    }
  }

  // ==================== Appender Implementations ====================

  class SingleAppender implements SymbolAppender {
    constructor(private backend: SymbolIndex) {}

    async append(relativePath: string, contentHash: string, symbols: DocumentSymbol[]): Promise<void> {
      this.backend.storeDocSymbols(relativePath, contentHash, symbols)
    }

    async commit(): Promise<void> {}
  }

  class DuckDBBatchAppender implements SymbolAppender {
    private docRows: DocRow[] = []
    private symbolRows: SymbolRow[] = []
    private docIdsToDelete: string[] = []
    private batchSize = 1000

    constructor(private backend: DuckDBIndex) {}

    async append(relativePath: string, contentHash: string, symbols: DocumentSymbol[]): Promise<void> {
      const docRow = this.backend.createDocRow(relativePath, contentHash)
      const rows: SymbolRow[] = []
      this.backend.collectSymbolRows(docRow.id, symbols, null, "", [], rows)

      this.docRows.push(docRow)
      this.symbolRows.push(...rows)
      this.docIdsToDelete.push(docRow.id)

      if (this.symbolRows.length >= this.batchSize) {
        await this.flush()
      }
    }

    private async flush(): Promise<void> {
      if (this.docRows.length === 0) return

      const docRows = this.docRows
      const symbolRows = this.symbolRows
      const docIdsToDelete = this.docIdsToDelete

      this.docRows = []
      this.symbolRows = []
      this.docIdsToDelete = []

      await this.backend.batchSave(docRows, symbolRows, docIdsToDelete)
    }

    async commit(): Promise<void> {
      await this.flush()
    }
  }

  // ==================== 工具函数 ====================

  /**
   * Strip extra encoding from an LSP symbol name to produce a clean, searchable base name.
   *
   * LSP servers embed extra information into symbol names that hurts search quality:
   *   - Parameter signatures: "save(Object, NodeConversion<T>)" → "save"  (Java jdtls, etc.)
   *   - Angle-bracket generics: "ModelListener<T>", "Map<K,V>"  → bare name  (Java/TS/C#/Rust/C++)
   *   - Square-bracket generics: "Map[K, V any]"                → bare name  (Go 1.18+, Scala)
   */
  function normalizeSymbolName(name: string): string {
    const parenIdx = name.indexOf("(")
    if (parenIdx !== -1) name = name.slice(0, parenIdx)
    // Strip nested angle-bracket generics iteratively (handles Map<String, List<Integer>>)
    while (/<[^<>]*>/.test(name)) name = name.replace(/<[^<>]*>/g, "")
    // Strip nested square-bracket generics iteratively (handles Map[K, [V]])
    while (/\[[^\[\]]*\]/.test(name)) name = name.replace(/\[[^\[\]]*\]/g, "")
    return name.trim()
  }

  /**
   * Normalize a flat list of sibling symbols in-place:
   *   1. Strip parameter signatures and generic type parameters from each symbol name.
   *   2. Assign overloadIdx (0-based) only to names that appear more than once,
   *      so duplicates become  "save" (idx=0), "save#1" (idx=1), "save#2" (idx=2), …
   *
   * Mutates elements directly so callers can read sym.name / sym.overloadIdx without
   * any extra processing.
   */
  function normalizeSymbols(symbols: DocumentSymbol[]): void {
    const totalCounts: Record<string, number> = {}
    const counts: Record<string, number> = {}

    for (const sym of symbols) {
      sym.name = normalizeSymbolName(sym.name)
      totalCounts[sym.name] = (totalCounts[sym.name] ?? 0) + 1
      counts[sym.name] = 0
    }

    for (const sym of symbols) {
      if (totalCounts[sym.name] > 1) {
        sym.overloadIdx = counts[sym.name]
        counts[sym.name]++
      }
    }
  }

  // Optimize namePathRegex: simple string matches symbol name (last segment of namePath)
  function optimizeNamePathPattern(pattern: string): string {
    if (pattern.includes("/")) return pattern
    const regexMarkers = [
      "^",
      "$",
      ".*",
      ".+",
      "[",
      "]",
      "(",
      ")",
      "|",
      "{",
      "}",
      "?",
      "\\d",
      "\\D",
      "\\w",
      "\\W",
      "\\s",
      "\\S",
    ]
    if (regexMarkers.some((marker) => pattern.includes(marker))) return pattern
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Match symbol name at any position, including overloaded variants (e.g. queryMap#1, queryMap#2)
    return `(^|/)${escaped}(#\\d+)?($|/)`
  }

  function filterSymbols(
    symbols: DocumentSymbol[],
    opts: {
      namePathRegex?: RegExp | null
      includeKinds?: number[]
      excludeKinds?: number[]
    },
    parentPath: string = "",
  ): DocumentSymbol[] {
    // Normalize names and assign overload indices for this sibling group.
    normalizeSymbols(symbols)

    const result: DocumentSymbol[] = []
    for (const sym of symbols) {
      if (opts.includeKinds?.length && !opts.includeKinds.includes(sym.kind)) continue
      if (opts.excludeKinds?.length && opts.excludeKinds.includes(sym.kind)) continue

      // Build namePath using already-normalized name (normalizeSymbols mutated sym.name)
      let namePath = parentPath ? `${parentPath}/${sym.name}` : sym.name
      if ((sym.overloadIdx ?? 0) > 0) {
        namePath += `#${sym.overloadIdx}`
      }
      if (opts.namePathRegex && !opts.namePathRegex.test(namePath)) continue

      const filteredChildren = sym.children
        ? filterSymbols(sym.children as DocumentSymbol[], opts, namePath)
        : undefined
      result.push({ ...sym, namePath, children: filteredChildren })
    }
    return result
  }

  export async function create(input: {
    server: LSPServer.Info
    getClients: (file: string) => Promise<LSPClient.Info[]>
    hasClients: (file: string) => Promise<boolean>
    getClientsByServerId: (serverID: string) => Promise<LSPClient.Info[]>
  }) {
    const serverID = input.server.id
    const index = new DuckDBIndex(serverID)
    const s = await getState()
    const off: Array<() => void> = []
    let dead = false

    index.start()

    const cleanup = () => {
      if (dead) return
      dead = true
      off.forEach((item) => item())
      clearPending(s, serverID)
      clearBuilding(s, serverID)
      index.stop()
    }

    const getClients = async (file: string) => {
      if (!(await input.hasClients(file))) {
        return []
      }
      const clients = await input.getClients(file)
      return clients.filter((c) => c.serverID === serverID)
    }

    const hasClients = async (serverId: string) => {
      const clients = await input.getClientsByServerId(serverId)
      return clients ? clients.length > 0 : false
    }

    const buildIndexIncremental = async (client: LSPClient.Info) => {
      if (dead) return
      const extensions = input.server.extensions
      s.rebuildInProgress = true
      try {
        await buildIndexForClient({ index, client, extensions })
      } finally {
        s.rebuildInProgress = false
      }
    }

    const initializeIndex = async () => {
      if (dead) {
        return
      }
      if (s.rebuildInProgress) {
        return
      }
      s.rebuildInProgress = true
      try {
        const clients = await input.getClientsByServerId(serverID)
        for (const client of clients) {
          await buildIndexForClient({ index, client, extensions: input.server.extensions })
        }
      } finally {
        s.rebuildInProgress = false
      }
    }

    // 订阅文件变更事件
    off.push(
      Bus.subscribe(FileWatcher.Event.Updated, async (evt) => {
        if (dead) {
          return
        }
        if ((await hasClients(serverID)) == false) {
          return
        }
        const absolutePath = evt.properties.file
        const relativePath = path.relative(Instance.directory, absolutePath).replace(/\\/g, "/")

        // 确保当前 serverID 的 pendingUpdates 存在
        if (!s.pendingUpdates.has(serverID)) {
          s.pendingUpdates.set(serverID, new Map())
        }

        // 收集到 pending，使用 relativePath 作为 key
        const pending = s.pendingUpdates.get(serverID)!
        pending.set(relativePath, { event: evt.properties.event })

        // 只在没有 timer 时创建
        if (!s.flushTimers.has(serverID)) {
          s.flushTimers.set(
            serverID,
            setTimeout(async () => {
              if (dead) return
              s.flushTimers.delete(serverID)
              const pending = s.pendingUpdates.get(serverID)
              if (!pending || pending.size === 0) return

              const updates = new Map(pending)
              pending.clear()

              await flushPendingUpdates({
                index,
                updates,
                getClients,
                serverID,
              })
            }, 2000),
          )
        }
      }),
    )

    off.push(
      Bus.subscribe(LSP.Event.Updated, async (evt) => {
        if (dead) {
          return
        }
        if (s.rebuildInProgress) {
          return
        }
        const client = evt.properties.client as LSPClient.Info
        if (client.serverID !== serverID) return
        buildIndexIncremental(client).catch((error) => {
          log.error("buildIndexIncremental: failed", { serverID, error })
        })
      }),
    )

    async function buildIndex(buffer: FileBuffer): Promise<DocumentSymbol[]> {
      const relativePath = buffer.relativePath
      const currentHash = await buffer.getContentHash()

      const clients = await getClients(buffer.relativePath)
      if (clients.length === 0) {
        return []
      }
      const res: DocumentSymbol[] = []
      for (const client of clients) {
        const freshSymbols = await client.documentSymbol({ path: buffer.absolutePath })
        if (freshSymbols && freshSymbols.length > 0) {
          await index.storeDocSymbols(relativePath, currentHash, freshSymbols as DocumentSymbol[])
          res.push(...(freshSymbols as DocumentSymbol[]))
        }
      }
      return res
    }

    // 启动时初始化索引
    try {
      await initializeIndex()
    } catch (error) {
      cleanup()
      throw error
    }

    return {
      serverID,
      appender: index.createAppender(true),
      async isDocCached(relativePath: string, contentHash: string) {
        return await index.isDocCached(relativePath, contentHash)
      },
      async searchSymbols(opts: {
        namePathRegex: string
        relativePathRegex?: string
        includeBody?: boolean
        includeKinds?: number[]
        excludeKinds?: number[]
      }): Promise<DocumentSymbol[]> {
        // Optimize namePathRegex: simple string matches symbol name (last segment)
        const optimizedPattern = optimizeNamePathPattern(opts.namePathRegex)
        const optimizedOpts = { ...opts, namePathRegex: optimizedPattern }
        const namePathRegex = optimizedPattern ? new RegExp(optimizedPattern) : null
        const docResults = await index.searchSymbols(optimizedOpts)

        const allSymbols: DocumentSymbol[] = []
        const bufferCache = new FileBufferCache()
        const filteredDocResults: Document[] = []
        const deletedDocIds: string[] = []

        for (const docResult of docResults) {
          const relativePath = docResult.relativePath
          const absolutePath = path.join(Instance.directory, relativePath)
          const buffer = await bufferCache.get(absolutePath, relativePath)

          // 检查文件是否存在
          if (!(await buffer.exists())) {
            deletedDocIds.push(docResult.id)
            continue
          }

          const currentHash = await buffer.getContentHash()

          if (docResult.contentHash === currentHash) {
            filteredDocResults.push(docResult)
          } else {
            log.debug("File modified (hash mismatch), updating symbols", { relativePath })
            const symbols = await buildIndex(buffer)
            if (symbols.length > 0) {
              const filteredSymbols = filterSymbols(symbols, {
                namePathRegex,
                includeKinds: opts.includeKinds,
                excludeKinds: opts.excludeKinds,
              })
              if (filteredSymbols.length > 0) {
                filteredDocResults.push({
                  id: docResult.id,
                  relativePath,
                  contentHash: currentHash,
                  symbols: filteredSymbols,
                })
              }
            }
          }
        }

        for (const docResult of filteredDocResults) {
          const relativePath = docResult.relativePath
          const absolutePath = path.join(Instance.directory, relativePath)
          const buffer = await bufferCache.get(absolutePath, relativePath)

          // 如果需要 body，获取文件行
          let fileLines: string[] | null = null
          if (opts.includeBody) {
            fileLines = await buffer.splitLines()
          }

          // 递归处理符号及其子符号
          const addSymbolsWithLocation = (symbols: DocumentSymbol[]) => {
            for (const sym of symbols) {
              let body = sym.body
              // 如果需要 body 但符号中没有，从文件中提取
              if (opts.includeBody && !body && fileLines) {
                const startLine = sym.range.start.line
                const endLine = sym.range.end.line
                body = fileLines.slice(startLine, endLine + 1).join("\n")
              }

              const symbolWithLocation: DocumentSymbol = {
                ...sym,
                body,
                location: {
                  uri: buffer.uri,
                  range: sym.range,
                  absolutePath,
                  relativePath,
                },
              }
              allSymbols.push(symbolWithLocation)

              if (sym.children) {
                addSymbolsWithLocation(sym.children as DocumentSymbol[])
              }
            }
          }

          addSymbolsWithLocation(docResult.symbols)
        }

        // 清理已删除文件的索引
        if (deletedDocIds.length > 0) {
          log.debug("Files no longer exist, invalidating indexes", { count: deletedDocIds.length })
          await index.invalidateDocs(deletedDocIds)
        }

        return allSymbols
      },
      async invalidateDoc(relativePath: string) {
        return await index.invalidateDoc(relativePath)
      },
      async shutdown() {
        cleanup()
      },
    }
  }

  export async function buildIndex(options: {
    indexes: Map<string, Info>
    extensions: Set<string>
    getSymbols: (file: string) => Promise<Map<string, DocumentSymbol[]>>
    rebuild?: boolean
  }): Promise<{ indexed: number; skipped: number; errors: number }> {
    const { indexes, extensions, getSymbols, rebuild } = options
    const s = await getState()
    if (extensions.size === 0) {
      return { indexed: 0, skipped: 0, errors: 0 }
    }
    s.rebuildInProgress = true
    let indexed = 0
    let skipped = 0
    let errors = 0
    let fileCount = 0
    try {
      const extensionGlobs = [...extensions].map((ext) => `*${ext}`)
      const ignoreGlobs = IGNORE_PATTERNS.map((p) => `!${p}*`)
      const globs = [...extensionGlobs, ...ignoreGlobs]

      log.info("buildIndex: starting", { extensions: [...extensions], directory: Instance.directory })

      const files: string[] = []
      for await (const file of Ripgrep.files({ cwd: Instance.directory, glob: globs })) {
        files.push(file)
      }
      fileCount = files.length

      for (const file of files) {
        const fullPath = path.join(Instance.directory, file)
        const relativePath = file.replace(/\\/g, "/")

        try {
          const content = await Bun.file(fullPath)
            .text()
            .catch(() => "")
          const hash = Bun.hash(content).toString()

          const symbolsByServer = await getSymbols(relativePath)

          for (const [serverId, symbols] of symbolsByServer) {
            const index = indexes.get(serverId)
            if (!index) {
              log.warn("buildIndex: no index found for server", { serverId })
              continue
            }

            if (!rebuild && (await index.isDocCached(relativePath, hash))) {
              skipped++
              continue
            }
            if (symbols?.length > 0) {
              await index.appender.append(relativePath, hash, symbols)
            }
          }
          indexed++
        } catch (e) {
          errors++
          log.debug("buildIndex: error", { file, error: e })
        }
      }

      for (const index of indexes.values()) {
        await index.appender.commit()
      }

      log.info("buildIndex: completed", { indexed, skipped, errors, fileCount })
    } finally {
      s.rebuildInProgress = false
    }
    return { indexed, skipped, errors }
  }

  // 增量构建：为单个 Client 构建索引
  export async function buildIndexForClient(options: {
    index: SymbolIndex
    client: LSPClient.Info
    extensions: string[]
  }): Promise<{ indexed: number; skipped: number; errors: number }> {
    const { index, client, extensions } = options
    const key = `${client.serverID}:${client.root}`
    const s = await getState()

    // 检查是否已经在构建中
    const existing = s.buildingClients.get(key)
    if (existing) {
      return existing
    }

    const buildPromise = doBuildIndexForClient(index, client, extensions)
    s.buildingClients.set(key, buildPromise)

    try {
      return await buildPromise
    } finally {
      s.buildingClients.delete(key)
    }
  }

  async function doBuildIndexForClient(
    index: SymbolIndex,
    client: LSPClient.Info,
    extensions: string[],
  ): Promise<{ indexed: number; skipped: number; errors: number }> {
    if (extensions.length === 0) {
      return { indexed: 0, skipped: 0, errors: 0 }
    }

    let indexed = 0
    let skipped = 0
    let errors = 0

    const extensionGlobs = extensions.map((ext) => `*${ext}`)
    const ignoreGlobs = IGNORE_PATTERNS.map((p) => `!${p}*`)
    const globs = [...extensionGlobs, ...ignoreGlobs]

    log.info("buildIndexForClient: starting", { serverID: client.serverID, root: client.root, extensions })

    const appender = index.createAppender(true)

    try {
      for await (const file of Ripgrep.files({ cwd: client.root, glob: globs })) {
        const fullPath = path.join(client.root, file)
        const relativePath = path.relative(Instance.directory, fullPath).replace(/\\/g, "/")

        try {
          const content = await Bun.file(fullPath)
            .text()
            .catch(() => "")
          const hash = Bun.hash(content).toString()

          if (await index.isDocCached(relativePath, hash)) {
            skipped++
            continue
          }

          const input = { path: relativePath }
          await client.openFile(input)

          try {
            const symbols = await client.documentSymbol(input)
            if (symbols && symbols.length > 0) {
              await appender.append(relativePath, hash, symbols as DocumentSymbol[])
              indexed++
            }
          } finally {
            await client.closeFile(input)
          }
        } catch (e) {
          errors++
          log.debug("buildIndexForClient: error", { file, error: e })
        }
      }

      await appender.commit()
      log.info("buildIndexForClient: completed", { serverID: client.serverID, indexed, skipped, errors })
    } catch (e) {
      log.error("buildIndexForClient: failed", { serverID: client.serverID, error: e })
    }

    return { indexed, skipped, errors }
  }

  // 文件变更批量处理
  export async function flushPendingUpdates(options: {
    index: SymbolIndex
    updates: Map<string, { event: string }>
    getClients: (file: string) => Promise<LSPClient.Info[]>
    serverID: string
  }): Promise<{ indexed: number; deleted: number; skipped: number; errors: number }> {
    const { index, updates, getClients, serverID } = options

    let indexed = 0
    let deleted = 0
    let skipped = 0
    let errors = 0

    const appender = index.createAppender(true)

    for (const [relativePath, { event }] of updates) {
      if (event === "unlink") {
        log.debug("File deleted, invalidating index", { relativePath })
        await index.invalidateDoc(relativePath)
        deleted++
        continue
      }

      const clients = await getClients(relativePath)
      if (clients.length === 0) continue

      const fullPath = path.join(Instance.directory, relativePath)
      try {
        const content = await Bun.file(fullPath)
          .text()
          .catch(() => "")
        const hash = Bun.hash(content).toString()

        if (await index.isDocCached(relativePath, hash)) {
          skipped++
          continue
        }
        const input = { path: relativePath }
        for (const client of clients) {
          await client.openFile(input)
          try {
            const symbols = await client.documentSymbol(input)
            if (symbols && symbols.length > 0) {
              await appender.append(relativePath, hash, symbols as DocumentSymbol[])
            }
          } finally {
            await client.closeFile(input)
          }
        }
        indexed++
      } catch (e) {
        errors++
        log.debug("flushPendingUpdates: error", { relativePath, error: e })
      }
    }
    await appender.commit()
    return { indexed, deleted, skipped, errors }
  }

  // ==================== 格式化输出 ======================================

  interface PrettyOptions {
    kind?: boolean
    location?: boolean
    depth?: number
    includeBody?: boolean
    includeChildrenBody?: boolean
    includeRelativePath?: boolean
  }

  interface PrettySymbol {
    name_path: string
    kind?: string
    detail?: string
    relative_path?: string
    body_location?: [number, number]
    body?: string
    children?: PrettySymbol[]
  }

  // LSP SymbolKind 枚举映射
  const SymbolKindNames: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  }

  function symbolToDict(symbol: DocumentSymbol, opts: PrettyOptions, includeRelativePath: boolean): PrettySymbol {
    const result: PrettySymbol = {
      name_path: symbol.namePath ?? symbol.name,
    }

    if (opts.kind) {
      result.kind = SymbolKindNames[symbol.kind] ?? `Unknown(${symbol.kind})`
    }

    if (symbol.detail) {
      result.detail = symbol.detail
    }

    if (opts.location && symbol.location) {
      if (includeRelativePath && symbol.location.relativePath) {
        result.relative_path = symbol.location.relativePath
      }
      result.body_location = [symbol.range.start.line + 1, symbol.range.end.line + 1]
    }

    if (opts.includeBody && symbol.body) {
      result.body = symbol.body
    }

    const depth = opts.depth ?? 0
    if (depth > 0 && symbol.children && symbol.children.length > 0) {
      const childOpts = { ...opts, depth: depth - 1, includeBody: opts.includeChildrenBody }
      result.children = symbol.children.map((child) => symbolToDict(child as DocumentSymbol, childOpts, false))
    }

    return result
  }

  async function compressSymbols(symbolDicts: PrettySymbol[]): Promise<(string | PrettySymbol)[]> {
    if (symbolDicts.length === 0) return []

    const pathToKey = new Map<string, string>()
    const s = await getState()

    for (const symbol of symbolDicts) {
      const relativePath = symbol.relative_path
      if (relativePath && !pathToKey.has(relativePath)) {
        pathToKey.set(relativePath, `e${s.counter++}`)
      }
      if (relativePath) {
        symbol.relative_path = pathToKey.get(relativePath)
      }
    }

    const filesMapping =
      "Files: " +
      [...pathToKey.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([path, key]) => `${key}=${path}`)
        .join(", ")

    return [filesMapping, ...symbolDicts]
  }

  function formatAsXml(symbols: DocumentSymbol[], opts: PrettyOptions): string {
    const lines: string[] = []
    const grouped = new Map<string, DocumentSymbol[]>()
    for (const sym of symbols) {
      const loc = sym.location?.relativePath ?? ""
      const arr = grouped.get(loc) || []
      arr.push(sym)
      grouped.set(loc, arr)
    }
    const formatSymbol = (sym: DocumentSymbol, indent: number) => {
      const prefix = "  ".repeat(indent)
      const kind = SymbolKindNames[sym.kind] ?? "Unknown"
      const startLine = sym.range.start.line + 1
      const endLine = sym.range.end.line + 1
      const detail = sym.detail ? ` detail="${sym.detail}"` : ""
      const hasBody = opts.includeBody && sym.body
      const depth = opts.depth ?? 0
      const hasChildren = depth > 0 && sym.children && sym.children.length > 0
      if (!hasBody && !hasChildren) {
        lines.push(
          `${prefix}<symbol name="${sym.namePath ?? sym.name}" kind="${kind}" line="${startLine}-${endLine}"${detail} />`,
        )
        return
      }
      lines.push(
        `${prefix}<symbol name="${sym.namePath ?? sym.name}" kind="${kind}" line="${startLine}-${endLine}"${detail}>`,
      )
      if (hasBody) {
        lines.push(`${prefix}  <body><![CDATA[${sym.body}]]></body>`)
      }
      if (hasChildren) {
        const childOpts = { ...opts, depth: depth - 1, includeBody: opts.includeChildrenBody }
        for (const child of sym.children!) {
          formatSymbol(child as DocumentSymbol, indent + 1)
        }
      }
      lines.push(`${prefix}</symbol>`)
    }
    lines.push("<symbols>")
    for (const [loc, syms] of grouped) {
      if (loc) {
        lines.push(`  <file path="${loc}">`)
        for (const sym of syms) {
          formatSymbol(sym, 2)
        }
        lines.push("  </file>")
      } else {
        for (const sym of syms) {
          formatSymbol(sym, 1)
        }
      }
    }
    lines.push("</symbols>")
    return lines.join("\n")
  }

  export async function pretty(
    symbols: DocumentSymbol[],
    opts: PrettyOptions & { format?: "json" | "markdown" | "xml" } = {},
  ): Promise<string | (string | PrettySymbol)[]> {
    if (opts.format === "xml") {
      return formatAsXml(symbols, opts)
    }
    const symbolDicts = symbols.map((s) => symbolToDict(s, opts, opts.includeRelativePath ?? true))
    return await compressSymbols(symbolDicts)
  }
}
