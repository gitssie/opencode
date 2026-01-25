import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { Log } from "../util/log"
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
    root: string
    getClients: (file: string) => Promise<LSPClient.Info[]>
    setup?(ctx: {
      connection: ReturnType<typeof createMessageConnection>
      initializeParams: Record<string, any>
      getClients: (file: string) => Promise<LSPClient.Info[]>
    }): void
  }) {
    const l = log.clone().tag("serverID", input.serverID)
    l.info("starting client")

    const connection = createMessageConnection(
      new StreamMessageReader(input.server.process.stdout as any),
      new StreamMessageWriter(input.server.process.stdin as any),
    )

    const diagnostics = new Map<string, Diagnostic[]>()
    connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const filePath = Filesystem.normalizePath(fileURLToPath(params.uri))
      l.info("textDocument/publishDiagnostics", {
        path: filePath,
        count: params.diagnostics.length,
      })
      const exists = diagnostics.has(filePath)
      diagnostics.set(filePath, params.diagnostics)
      if (!exists && input.serverID === "typescript") return
      Bus.publish(Event.Diagnostics, { path: filePath, serverID: input.serverID })
    })
    connection.onRequest("window/workDoneProgress/create", (params) => {
      l.info("window/workDoneProgress/create", params)
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
    const initializeParams: Record<string, any> = {
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
        ...input.server.initialization,
      },
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          didChangeConfiguration: {
            dynamicRegistration: true,
          },
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
          symbol: {
            dynamicRegistration: true,
          },
        },
        textDocument: {
          synchronization: {
            didSave: true,
            didOpen: true,
            didChange: true,
            dynamicRegistration: true,
          },
          completion: {
            dynamicRegistration: true,
            completionItem: {
              snippetSupport: true,
            },
          },
          definition: {
            dynamicRegistration: true,
            linkSupport: true,
          },
          references: {
            dynamicRegistration: true,
          },
          documentSymbol: {
            dynamicRegistration: true,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: {
              valueSet: Array.from({ length: 26 }, (_, i) => i + 1),
            },
          },
          hover: {
            dynamicRegistration: true,
            contentFormat: ["markdown", "plaintext"],
          },
          signatureHelp: {
            dynamicRegistration: true,
          },
          codeAction: {
            dynamicRegistration: true,
          },
          rename: {
            dynamicRegistration: true,
            prepareSupport: true,
          },
          publishDiagnostics: {
            dynamicRegistration: true,
            relatedInformation: true,
            tagSupport: {
              valueSet: [1, 2],
            },
            versionSupport: true,
          },
          diagnostic: {
            dynamicRegistration: true,
          },
        },
      },
    }

    // Call setup hook before initialize - allows customizing connection handlers and capabilities
    if (input.setup) {
      input.setup({ connection, initializeParams, getClients: input.getClients })
    }

    l.info("sending initialize")
    await withTimeout(
      connection.sendRequest("initialize", initializeParams),
      45_000,
    ).catch((err) => {
      l.error("initialize error", { error: err })
      throw new InitializeError(
        { serverID: input.serverID },
        {
          cause: err,
        },
      )
    })

    await connection.sendNotification("initialized", {})

    if (input.server.initialization) {
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: input.server.initialization,
      })
    }

    const files: {
      [path: string]: number
    } = {}

    const result = {
      root: input.root,
      get serverID() {
        return input.serverID
      },
      get connection() {
        return connection
      },
      notify: {
        async open(openInput: { path: string }) {
          openInput.path = path.isAbsolute(openInput.path)
            ? openInput.path
            : path.resolve(Instance.directory, openInput.path)
          const file = Bun.file(openInput.path)
          const text = await file.text()
          const extension = path.extname(openInput.path)
          const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

          const version = files[openInput.path]
          if (version !== undefined) {
            l.info("workspace/didChangeWatchedFiles", openInput)
            await connection.sendNotification("workspace/didChangeWatchedFiles", {
              changes: [
                {
                  uri: pathToFileURL(openInput.path).href,
                  type: 2, // Changed
                },
              ],
            })

            const next = version + 1
            files[openInput.path] = next
            l.info("textDocument/didChange", {
              path: openInput.path,
              version: next,
            })
            await connection.sendNotification("textDocument/didChange", {
              textDocument: {
                uri: pathToFileURL(openInput.path).href,
                version: next,
              },
              contentChanges: [{ text }],
            })
            return
          }

          l.info("workspace/didChangeWatchedFiles", openInput)
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(openInput.path).href,
                type: 1, // Created
              },
            ],
          })

          l.info("textDocument/didOpen", openInput)
          diagnostics.delete(openInput.path)
          await connection.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri: pathToFileURL(openInput.path).href,
              languageId,
              version: 0,
              text,
            },
          })
          files[openInput.path] = 0

          // Request diagnostics after opening file
          const uri = pathToFileURL(openInput.path).href
          try {
            l.info("textDocument/diagnostic", { path: openInput.path })
            const response = await withTimeout(
              connection.sendRequest("textDocument/diagnostic", {
                textDocument: { uri },
              }),
              10_000,
            )
            l.info("textDocument/diagnostic response", { path: openInput.path, response })
            if (response && typeof response === "object") {
              const items = (response as any).items ?? []
              const fileDiagnostics: Diagnostic[] = items.map((item: any) => ({
                ...item,
                uri,
              }))
              diagnostics.set(openInput.path, fileDiagnostics)
              Bus.publish(Event.Diagnostics, { path: openInput.path, serverID: input.serverID })
            }
          } catch (err) {
            // textDocument/diagnostic may not be supported by all servers, ignore errors
            l.info("textDocument/diagnostic error", { path: openInput.path, error: err })
          } finally {
            // Close the document after getting diagnostics
            l.info("textDocument/didClose", { path: openInput.path })
            await connection.sendNotification("textDocument/didClose", {
              textDocument: { uri },
            })
            delete files[openInput.path]
          }

          return
        },
      },
      request: {
        async diagnostics(requestInput: { path: string }): Promise<Diagnostic[]> {
          const filePath = path.isAbsolute(requestInput.path)
            ? requestInput.path
            : path.resolve(Instance.directory, requestInput.path)
          const uri = pathToFileURL(filePath).href

          l.info("textDocument/diagnostic", { path: filePath })

          const response = await connection.sendRequest("textDocument/diagnostic", {
            textDocument: { uri },
          })

          if (!response || typeof response !== "object") {
            return []
          }

          const items = (response as any).items ?? []
          return items.map((item: any) => ({
            uri,
            severity: item.severity,
            message: item.message,
            range: item.range,
            code: item.code,
          }))
        },
      },
      get diagnostics() {
        return diagnostics
      },
      async waitForDiagnostics(waitInput: { path: string }) {
        const normalizedPath = Filesystem.normalizePath(
          path.isAbsolute(waitInput.path) ? waitInput.path : path.resolve(Instance.directory, waitInput.path),
        )
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
          }),
          13000,
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
        input.server.process.kill()
        l.info("shutdown")
      },
    }

    l.info("initialized")

    return result
  }
}
