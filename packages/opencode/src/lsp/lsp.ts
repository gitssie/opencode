import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Log from "@opencode-ai/core/util/log"
import { LSPClient } from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { LSPServer } from "./server"
import z from "zod"
import { Config } from "@/config/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Process } from "@/util/process"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, Context, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Index from "./symbols"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { zod, ZodOverride } from "@/util/effect-zod"

const log = Log.create({ service: "lsp" })

export const Event = {
  Updated: BusEvent.define(
    "lsp.updated",
    Schema.Struct({
      serverID: Schema.String,
      root: Schema.String,
      client: Schema.Unknown,
      extensions: Schema.Array(Schema.String),
    }),
  ),
}

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
})
  .annotate({ identifier: "Range" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
})
  .annotate({ identifier: "Symbol" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
})
  .annotate({ identifier: "DocumentSymbol" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]).annotate({
    [ZodOverride]: z.union([z.literal("connected"), z.literal("error")]),
  }),
})
  .annotate({ identifier: "LSPStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>) => {
  if (Flag.OPENCODE_EXPERIMENTAL_LSP_TY) {
    if (servers["pyright"]) {
      log.info("LSP server pyright is disabled because OPENCODE_EXPERIMENTAL_LSP_TY is enabled")
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }
type SearchInput = {
  namePathRegex: string
  includeKinds?: number[]
  excludeKinds?: number[]
  relativePathRegex?: string
  includeBody?: boolean
}

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: Set<string>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
  indexes: Map<string, Index.Index.Info>
  getClientsByServerId: (serverID: string) => Promise<LSPClient.Info[]>
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly openFile: (input: { path: string }) => Effect.Effect<void>
  readonly closeFile: (input: { path: string }) => Effect.Effect<void>
  readonly touchFile: (input: string, waitForDiagnostics?: boolean | "full" | "incremental" | "document") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly rebuildIndex: (rebuild?: boolean) => Effect.Effect<{ indexed: number; skipped: number; errors: number }>
  readonly searchSymbols: (opts: SearchInput) => Effect.Effect<LSPClient.DocumentSymbol[]>
  readonly getSymbols: (file: string) => Effect.Effect<Map<string, LSPClient.DocumentSymbol[]>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}

        if (!cfg.lsp) {
          log.info("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers)

          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                log.info(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx!.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root) => ({
                  process: lspspawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }),
                  initialization: item.initialization,
                }),
              }
            }
          }

          log.info("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          clients: [],
          servers,
          broken: new Set(),
          spawning: new Map(),
          indexes: new Map(),
          getClientsByServerId: async () => [],
        }

        s.getClientsByServerId = async (serverID) => s.clients.filter((x) => x.serverID === serverID)

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(s.clients.map((client) => client.shutdown()))
            await Promise.all([...s.indexes.values()].map((index) => index.shutdown()))
          }),
        )

        return s
      }),
    )

    const getClients = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      const normalizedFile = AppFileSystem.normalizePath(
        path.isAbsolute(file) ? file : path.resolve(ctx.directory, file),
      )
      if (
        !AppFileSystem.contains(ctx.directory, normalizedFile) &&
        (ctx.worktree === "/" || !AppFileSystem.contains(ctx.worktree, normalizedFile))
      ) {
        return [] as LSPClient.Info[]
      }
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(normalizedFile).ext || normalizedFile
        const result: LSPClient.Info[] = []

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          const handle = await server
            .spawn(root, ctx)
            .then((value) => {
              if (!value) s.broken.add(key)
              return value
            })
            .catch((err) => {
              s.broken.add(key)
              log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
              return undefined
            })

          if (!handle) return undefined
          log.info("spawned lsp server", { serverID: server.id, root })

          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            info: server,
            root,
            getClients: (file: string) => Effect.runPromise(getClients(file)),
          }).catch(async (err) => {
            s.broken.add(key)
            await Process.stop(handle.process)
            log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
            return undefined
          })

          if (!client) return undefined

          const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (existing) {
            await Process.stop(handle.process)
            return existing
          }

          s.clients.push(client)
          return client
        }

        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(normalizedFile, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue

          const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (match) {
            result.push(match)
            continue
          }

          const inflight = s.spawning.get(root + server.id)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            result.push(client)
            continue
          }

          const task = schedule(server, root, root + server.id)
          s.spawning.set(root + server.id, task)

          task.finally(() => {
            if (s.spawning.get(root + server.id) === task) {
              s.spawning.delete(root + server.id)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          Bus.publish(Event.Updated, {
            serverID: server.id,
            root,
            client,
            extensions: server.extensions,
          })
        }

        return result
      })
    })

    const resolveFile = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      return AppFileSystem.normalizePath(path.isAbsolute(file) ? file : path.resolve(ctx.directory, file))
    })

    const run = Effect.fnUntraced(function* <T>(
      file: string,
      fn: (client: LSPClient.Info, file: string) => Promise<T>,
    ) {
      const normalizedFile = yield* resolveFile(file)
      const clients = yield* getClients(normalizedFile)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x, normalizedFile))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(() => Promise.all(s.clients.map((x) => fn(x))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const client of s.clients) {
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
        })
      }
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const normalizedFile = AppFileSystem.normalizePath(
        path.isAbsolute(file) ? file : path.resolve(ctx.directory, file),
      )
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(normalizedFile).ext || normalizedFile
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(normalizedFile, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue
          return true
        }
        return false
      })
    })

    const ensureIndexes = Effect.fnUntraced(function* () {
      const s = yield* InstanceState.get(state)
      for (const server of Object.values(s.servers)) {
        if (s.indexes.has(server.id)) continue
        const index = yield* Effect.promise(() =>
          Index.Index.create({
            server,
            getClients: async (file: string) => Effect.runPromise(getClients(file)),
            hasClients: async (file: string) => Effect.runPromise(hasClients(file)),
            getClientsByServerId: s.getClientsByServerId,
          }),
        )
        s.indexes.set(server.id, index)
      }
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (
      input: string,
      waitForDiagnostics?: boolean | "full" | "incremental" | "document",
    ) {
      log.info("touching file", { file: input })
      const clients = yield* getClients(input)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!waitForDiagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode:
                waitForDiagnostics === true || waitForDiagnostics === "incremental"
                  ? undefined
                  : waitForDiagnostics,
              after,
            })
          }),
        ).catch((err) => {
          log.error("failed to touch file", { err, file: input })
        }),
      )
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const openFile = Effect.fn("LSP.openFile")(function* (input: { path: string }) {
      const clients = yield* getClients(input.path)
      yield* Effect.promise(() => Promise.all(clients.map((client) => client.openFile(input))))
    })

    const closeFile = Effect.fn("LSP.closeFile")(function* (input: { path: string }) {
      const clients = yield* getClients(input.path)
      yield* Effect.promise(() => Promise.all(clients.map((client) => client.closeFile(input))))
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client, file) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client, file) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client, file) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client, file) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, async (client, file) => {
        await client.openFile({ path: file })
        try {
          return await client.documentSymbol({ path: file })
        } finally {
          await client.closeFile({ path: file })
        }
      })
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client, file) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client, file) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    const getSymbolsNow = Effect.fnUntraced(function* (file: string) {
      const clients = yield* getClients(file)
      const result = new Map<string, LSPClient.DocumentSymbol[]>()
      const input = { path: file }

      yield* Effect.promise(() => Promise.all(clients.map((client) => client.openFile(input)).filter(Boolean))).pipe(
        Effect.catch(() => Effect.void),
      )

      try {
        const symbols = yield* Effect.promise(() =>
          Promise.all(
            clients.map(async (client) => ({
              serverID: client.serverID,
              symbols: await client.documentSymbol(input),
            })),
          ),
        )
        for (const item of symbols) {
          result.set(item.serverID, item.symbols.filter(Boolean))
        }
      } finally {
        yield* Effect.promise(() => Promise.all(clients.map((client) => client.closeFile(input)).filter(Boolean))).pipe(
          Effect.catch(() => Effect.void),
        )
      }

      return result
    })

    const getSymbols = Effect.fn("LSP.getSymbols")(function* (file: string) {
      return yield* getSymbolsNow(file)
    })

    const rebuildIndex = Effect.fn("LSP.rebuildIndex")(function* (rebuild?: boolean) {
      yield* ensureIndexes()
      const s = yield* InstanceState.get(state)
      const extensions = new Set<string>()
      for (const server of Object.values(s.servers)) {
        for (const ext of server.extensions) extensions.add(ext)
      }
      return yield* Effect.promise(() =>
        Index.Index.buildIndex({
          indexes: s.indexes,
          extensions,
          rebuild,
          getSymbols: (file: string) => Effect.runPromise(getSymbolsNow(file)),
        }),
      )
    })

    const searchSymbols = Effect.fn("LSP.searchSymbols")(function* (opts: SearchInput) {
      yield* ensureIndexes()
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const results: LSPClient.DocumentSymbol[] = []
        for (const index of s.indexes.values()) {
          results.push(...(await index.searchSymbols(opts)))
        }
        return results
      })
    })

    return Service.of({
      init,
      status,
      hasClients,
      openFile,
      closeFile,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
      rebuildIndex,
      searchSymbols,
      getSymbols,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Diagnostic from "./diagnostic"
export const Format = {
  pretty: Index.Index.pretty,
}

export * as LSP from "./lsp"
