import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import type {
  Diagnostic as VSCodeDiagnostic,
  DocumentSymbol as VSCodeDocumentSymbol,
} from "vscode-languageserver-types"
import { Log } from "../util/log"
import { Process } from "../util/process"
import { LANGUAGE_EXTENSIONS } from "./language"
import z from "zod"
import type { LSPServer } from "./server"
import { NamedError } from "@opencode-ai/util/error"
import { withTimeout } from "../util/timeout"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"

const DIAGNOSTICS_DEBOUNCE_MS = 150

export namespace LSPClient {
  const log = Log.create({ service: "lsp.client" })

  export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

  export type Diagnostic = VSCodeDiagnostic

  export type DocumentSymbol = VSCodeDocumentSymbol & { overloadIdx?: number }

  interface File {
    version: number
    refs: number
  }

  interface Methods {
    diagnostics?: (input: { path: string }) => Promise<Diagnostic[]>
    documentSymbol?: (input: { path: string; url?: URL }) => Promise<DocumentSymbol[]>
    ready?: () => Promise<void>
  }

  interface Initialize extends Record<string, unknown> {
    rootUri: string
    processId: number | undefined
    rootPath: string
    workspaceFolders: Array<{ name: string; uri: string }>
    initializationOptions: Record<string, unknown>
    capabilities: {
      window: {
        workDoneProgress: boolean
      }
      workspace: {
        configuration: boolean
        didChangeWatchedFiles: {
          dynamicRegistration: boolean
        }
      }
      textDocument: {
        synchronization: {
          didOpen: boolean
          didChange: boolean
        }
        publishDiagnostics: {
          versionSupport: boolean
        }
      }
    }
  }

  export const InitializeError = NamedError.create(
    "LSPInitializeError",
    z.object({
      serverID: z.string(),
    }),
  )

  export const Event = {
    Diagnostics: BusEvent.define(
      "lsp.client.diagnostics",
      z.object({
        serverID: z.string(),
        path: z.string(),
      }),
    ),
  }

  export async function create(input: {
    serverID: string
    server: LSPServer.Handle
    info: LSPServer.Info
    root: string
    getClients: (file: string) => Promise<LSPClient.Info[]>
  }) {
    const l = log.clone().tag("serverID", input.serverID)
    l.info("starting client")

    const abs = (file: string) =>
      Filesystem.normalizePath(path.isAbsolute(file) ? file : path.resolve(Instance.directory, file))

    const connection = createMessageConnection(
      new StreamMessageReader(input.server.process.stdout),
      new StreamMessageWriter(input.server.process.stdin),
    )

    const diagnostics = new Map<string, Diagnostic[]>()
    const files = new Map<string, File>()

    const publishDiagnostics = (filePath: string, diagnosticsInfo: Diagnostic[]) => {
      const state = files.get(filePath)
      if (!state || state.version === 0) return

      const exists = diagnostics.has(filePath)
      diagnostics.set(filePath, diagnosticsInfo)
      if (!exists && input.serverID === "typescript" && diagnosticsInfo.length == 0) return
      Bus.publish(Event.Diagnostics, { path: filePath, serverID: input.serverID })
    }

    connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const filePath = Filesystem.normalizePath(fileURLToPath(params.uri))
      l.info("textDocument/publishDiagnostics", {
        path: filePath,
        count: params.diagnostics.length,
      })
      publishDiagnostics(filePath, params.diagnostics)
    })
    connection.onRequest("window/workDoneProgress/create", (params) => {
      l.debug("window/workDoneProgress/create", params)
      return null
    })
    connection.onRequest("workspace/configuration", async () => {
      // Return server initialization options
      return [input.server.initialization ?? {}]
    })
    connection.onRequest("client/registerCapability", async () => {})
    connection.onRequest("client/unregisterCapability", async () => {})
    connection.onRequest("workspace/workspaceFolders", async () => [
      {
        name: "workspace",
        uri: pathToFileURL(input.root).href,
      },
    ])
    connection.listen()

    // Build initialize params with defaults
    const initialize: Initialize = {
      rootUri: pathToFileURL(input.root).href,
      processId: input.server.process.pid,
      rootPath: input.root,
      workspaceFolders: [
        {
          name: path.basename(input.root),
          uri: pathToFileURL(input.root).href,
        },
      ],
      initializationOptions: {
        ...(input.server.initialization ?? {}),
      },
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
          },
          publishDiagnostics: {
            versionSupport: true,
          },
        },
      },
    }

    // Call setup hook before initialize - allows customizing connection handlers and capabilities
    let methods: Methods = {}
    if (input.info.setup) {
      methods = await input.info.setup({ connection, initialize, getClients: input.getClients })
    }
    const diagnosticsFromLSP = methods.diagnostics
    const documentSymbolFromLSP = methods.documentSymbol
    const ready = methods.ready

    l.info("sending initialize")
    await withTimeout(connection.sendRequest("initialize", initialize), 45_000).catch((err) => {
      l.error("initialize error", { error: err })
      throw new InitializeError(
        { serverID: input.serverID },
        {
          cause: err,
        },
      )
    })

    await connection.sendNotification("initialized", {})

    if (initialize.initializationOptions?.settings) {
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: initialize.initializationOptions.settings,
      })
    }

    await ready?.()

    const result = {
      root: input.root,
      get serverID() {
        return input.serverID
      },
      get connection() {
        return connection
      },
      async touchFile(touchInput: { path: string }) {
        const filePath = abs(touchInput.path)

        const state = files.get(filePath)
        if (state) {
          const text = await Filesystem.readText(filePath)

          l.info("workspace/didChangeWatchedFiles", { path: filePath })
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(filePath).href,
                type: 2, // Changed
              },
            ],
          })

          const version = state.version
          state.version++
          l.info("textDocument/didChange", { path: filePath, version })
          await connection.sendNotification("textDocument/didChange", {
            textDocument: {
              uri: pathToFileURL(filePath).href,
              version,
            },
            contentChanges: [{ text }],
          })
          return
        }

        files.set(filePath, { version: 1, refs: 0 })

        const text = await Filesystem.readText(filePath)
        const extension = path.extname(filePath)
        const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

        l.info("workspace/didChangeWatchedFiles", { path: filePath })
        await connection.sendNotification("workspace/didChangeWatchedFiles", {
          changes: [
            {
              uri: pathToFileURL(filePath).href,
              type: 1, // Created
            },
          ],
        })

        l.info("textDocument/didOpen", { path: filePath })
        diagnostics.delete(filePath)
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: pathToFileURL(filePath).href,
            languageId,
            version: 0,
            text,
          },
        })
      },
      notify: {
        async open(openInput: { path: string }) {
          return result.touchFile(openInput)
        },
      },
      async openFile(openInput: { path: string }) {
        const filePath = abs(openInput.path)

        const state = files.get(filePath)
        if (state) {
          state.refs++
          return
        }

        files.set(filePath, { version: 0, refs: 1 })

        const text = await Filesystem.readText(filePath)
        const extension = path.extname(filePath)
        const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

        diagnostics.delete(filePath)
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: pathToFileURL(filePath).href,
            languageId,
            version: 0,
            text,
          },
        })
      },
      async closeFile(closeInput: { path: string }) {
        const filePath = abs(closeInput.path)

        const state = files.get(filePath)
        if (!state) return

        state.refs--

        if (state.refs > 0 || state.version > 0) return

        files.delete(filePath)
        await connection.sendNotification("textDocument/didClose", {
          textDocument: {
            uri: pathToFileURL(filePath).href,
          },
        })
        diagnostics.delete(filePath)
      },
      async documentSymbol(input: { path: string }) {
        const filePath = abs(input.path)
        if (documentSymbolFromLSP) {
          return documentSymbolFromLSP({ ...input, path: filePath })
        }
        const rootSymbols = await connection
          .sendRequest("textDocument/documentSymbol", {
            textDocument: {
              uri: pathToFileURL(filePath).href,
            },
          })
          .then((r) => (Array.isArray(r) ? r : []) as LSPClient.DocumentSymbol[])
          .catch(() => [])
        return rootSymbols
      },
      get diagnostics() {
        return diagnostics
      },
      async waitForDiagnostics(waitInput: { path: string; timeout?: number }) {
        const normalizedPath = abs(waitInput.path)
        l.info("waiting for diagnostics", { path: normalizedPath })
        let unsub: () => void
        let debounceTimer: ReturnType<typeof setTimeout> | undefined
        return await withTimeout(
          new Promise<void>((resolve) => {
            unsub = Bus.subscribe(Event.Diagnostics, (event) => {
              if (event.properties.path === normalizedPath && event.properties.serverID === result.serverID) {
                // Debounce to allow LSP to send follow-up diagnostics (e.g., semantic after syntax)
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = setTimeout(() => {
                  l.info("got diagnostics", { path: normalizedPath })
                  unsub?.()
                  resolve()
                }, DIAGNOSTICS_DEBOUNCE_MS)
              }
            })
            diagnosticsFromLSP?.({ path: normalizedPath }).then((diagnosticsInfo) => {
              publishDiagnostics(normalizedPath, diagnosticsInfo)
            })
          }),
          waitInput.timeout ?? 3000,
        )
          .catch(() => {})
          .finally(() => {
            if (debounceTimer) clearTimeout(debounceTimer)
            unsub?.()
          })
      },
      async shutdown() {
        l.info("shutting down")
        connection.end()
        connection.dispose()
        await Process.stop(input.server.process)
        l.info("shutdown")
      },
    }

    l.info("initialized")

    return result
  }
}
