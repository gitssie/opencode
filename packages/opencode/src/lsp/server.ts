import { spawn as launch, type ChildProcessWithoutNullStreams } from "child_process"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { text } from "node:stream/consumers"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { Archive } from "../util/archive"
import type { MessageConnection } from "vscode-jsonrpc/node"
import type { LSPClient } from "./client"
import { pathToFileURL } from "url"
import { Process } from "../util/process"
import { which } from "../util/which"
import { Module } from "@opencode-ai/util/module"

const spawn = ((cmd, args, opts) => {
  if (Array.isArray(args)) return launch(cmd, [...args], { ...(opts ?? {}), windowsHide: true })
  return launch(cmd, { ...(args ?? {}), windowsHide: true })
}) as typeof launch

export namespace LSPServer {
  const log = Log.create({ service: "lsp.server" })
  const pathExists = async (p: string) =>
    fs
      .stat(p)
      .then(() => true)
      .catch(() => false)
  const run = (cmd: string[], opts: Process.RunOptions = {}) => Process.run(cmd, { ...opts, nothrow: true })
  const output = (cmd: string[], opts: Process.RunOptions = {}) => Process.text(cmd, { ...opts, nothrow: true })

  export interface Handle {
    process: ChildProcessWithoutNullStreams
    initialization?: Record<string, any>
  }

  type RootFunction = (file: string) => Promise<string | undefined>

  const NearestRoot = (includePatterns: string[], excludePatterns?: string[]): RootFunction => {
    return async (file) => {
      if (excludePatterns) {
        const excludedFiles = Filesystem.up({
          targets: excludePatterns,
          start: path.dirname(file),
          stop: Instance.directory,
        })
        const excluded = await excludedFiles.next()
        await excludedFiles.return()
        if (excluded.value) return undefined
      }
      const files = Filesystem.up({
        targets: includePatterns,
        start: path.dirname(file),
        stop: Instance.directory,
      })
      const first = await files.next()
      await files.return()
      if (!first.value) return Instance.directory
      return path.dirname(first.value)
    }
  }

  export interface Info {
    id: string
    extensions: string[]
    global?: boolean
    root: RootFunction
    spawn(root: string): Promise<Handle | undefined>
    setup?(ctx: {
      connection: MessageConnection
      initialize: Record<string, any>
      getClients: (file: string) => Promise<LSPClient.Info[]>
    }): Promise<{
      diagnostics?: (input: { path: string }) => Promise<LSPClient.Diagnostic[]>
      documentSymbol?: (input: { path: string; url?: URL }) => Promise<LSPClient.DocumentSymbol[]>
      ready?: () => Promise<void>
    }>
  }

  export const Deno: Info = {
    id: "deno",
    root: async (file) => {
      const files = Filesystem.up({
        targets: ["deno.json", "deno.jsonc"],
        start: path.dirname(file),
        stop: Instance.directory,
      })
      const first = await files.next()
      await files.return()
      if (!first.value) return undefined
      return path.dirname(first.value)
    },
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    async spawn(root) {
      log.info("spawn deno", { root })
      const deno = which("deno")
      if (!deno) {
        log.info("deno not found, please install deno first")
        return
      }
      return {
        process: spawn(deno, ["lsp"], {
          cwd: root,
        }),
      }
    },
  }

  export const Typescript: Info = {
    id: "typescript",
    root: NearestRoot(
      ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
      ["deno.json", "deno.jsonc"],
    ),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
    async spawn(root) {
      const tsserver = Module.resolve("typescript/lib/tsserver.js", root)
      if (!tsserver) {
        log.info("typescript server not found", { root, tsserver })
        return
      }

      // Only load @vue/typescript-plugin if the project depends on vue
      const vue = await Bun.resolve("vue", root).catch(() => {})
      let vuePluginPath: string | undefined
      if (vue) {
        vuePluginPath = await Bun.resolve("@vue/typescript-plugin", Global.Path.bin).catch(() => undefined)
        if (!vuePluginPath) {
          if (!Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) {
            log.info("installing @vue/language-server for typescript-plugin")
            await Bun.spawn([BunProc.which(), "install", "@vue/language-server"], {
              cwd: Global.Path.bin,
              env: { ...process.env, BUN_BE_BUN: "1" },
              stdout: "pipe",
              stderr: "pipe",
              stdin: "pipe",
            }).exited
          }
          vuePluginPath = await Bun.resolve("@vue/typescript-plugin", Global.Path.bin).catch(() => undefined)
        }
      }

      log.info("typescript server", { root, tsserver, vuePluginPath })

      const proc = spawn(BunProc.which(), ["x", "typescript-language-server", "--stdio"], {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })

      const initialization: Record<string, any> = {
        tsserver: {
          path: path.dirname(tsserver),
        },
      }

      // Configure @vue/typescript-plugin if available
      if (vuePluginPath) {
        log.info("vue typescript plugin found", { vuePluginPath })
        initialization.plugins = [
          {
            name: "@vue/typescript-plugin",
            location: path.dirname(vuePluginPath),
            languages: ["vue"],
          },
        ]
      }

      return {
        process: proc,
        initialization,
      }
    },
    async setup({ initialize, connection }) {
      // Merge TypeScript-specific capabilities into initialize params
      initialize.capabilities = {
        ...initialize.capabilities,
        workspace: {
          ...initialize.capabilities?.workspace,
          workspaceFolders: true,
          didChangeConfiguration: {
            dynamicRegistration: true,
          },
          symbol: {
            dynamicRegistration: true,
          },
        },
        textDocument: {
          ...initialize.capabilities?.textDocument,
          synchronization: {
            didSave: true,
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
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "",
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                  "source.fixAll",
                ],
              },
            },
            isPreferredSupport: true,
            disabledSupport: true,
            dataSupport: true,
            resolveSupport: {
              properties: ["edit"],
            },
            honorsChangeAnnotations: false,
          },
          rename: {
            dynamicRegistration: true,
            prepareSupport: true,
          },
          publishDiagnostics: {
            dynamicRegistration: true,
            tagSupport: true,
          },
        },
      }
      return {
        ready: () =>
          new Promise<void>((resolve) => {
            const timeout = setTimeout(() => resolve(), 15000)
            connection.onNotification("experimental/serverStatus", (params: any) => {
              if (params.quiescent === true) {
                clearTimeout(timeout)
                resolve()
              }
            })
          }),
      }
    },
  }

  export const Vue: Info = {
    id: "vue",
    extensions: [".vue"],
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    async spawn(root) {
      let binary = which("vue-language-server")
      const args: string[] = []
      if (!binary) {
        const js = path.join(
          Global.Path.bin,
          "node_modules",
          "@vue",
          "language-server",
          "bin",
          "vue-language-server.js",
        )
        if (!(await Filesystem.exists(js))) {
          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          await Process.spawn([BunProc.which(), "install", "@vue/language-server"], {
            cwd: Global.Path.bin,
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "pipe",
          }).exited
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = spawn(binary, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })

      // Find TypeScript SDK path for Vue
      const tsserver = await Bun.resolve("typescript/lib/tsserver.js", root).catch(() => {})
      log.info("spawn vue", { root, tsserver })
      return {
        process: proc,
        initialization: {
          vue: {
            hybridMode: true, // Enable hybrid mode - Vue LS handles .vue, TS LS handles .ts/.js
          },
          typescript: {
            tsdk: path.dirname(tsserver!),
          },
        },
      }
    },
    async setup({ connection, getClients, initialize }) {
      // Merge Vue-specific capabilities into initialize params
      initialize.capabilities = {
        ...initialize.capabilities,
        window: {
          ...initialize.capabilities?.window,
          workDoneProgress: true,
        },
        workspace: {
          ...initialize.capabilities?.workspace,
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
          ...initialize.capabilities?.textDocument,
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
            versionSupport: false,
          },
        },
      }

      // Helper function to find tsconfig.json for a file using Filesystem.up
      const findTsconfigForFile = async (filePath: string): Promise<string | null> => {
        const startDir = filePath ? path.dirname(filePath) : Instance.directory
        const files = Filesystem.up({
          targets: ["tsconfig.json"],
          start: startDir,
          stop: Instance.directory,
        })
        const first = await files.next()
        await files.return()
        return first.value ?? null
      }

      // Register tsserver/request notification handler for Vue hybrid mode
      connection.onNotification("tsserver/request", async (params: any[]) => {
        log.debug("tsserver/request", { params })

        if (params && params.length > 2) {
          const requestId = params[0]
          const method = params[1]
          const methodParams = params[2]

          const file = methodParams.file ?? ""
          // Handle _vue:projectInfo specially - find tsconfig.json
          if (method === "_vue:projectInfo") {
            const tsconfigPath = await findTsconfigForFile(file)
            const result = tsconfigPath ? { configFileName: tsconfigPath } : null
            connection.sendNotification("tsserver/response", [requestId, result])
            log.debug("tsserver/response for projectInfo", { tsconfigPath })
            return
          }

          // Find TypeScript server to forward the request
          const clients = await getClients(file)
          const tsClient = clients.find((c) => c.serverID === "typescript")
          if (tsClient) {
            // Forward request to TypeScript server
            tsClient.connection
              .sendRequest("workspace/executeCommand", {
                command: "typescript.tsserverRequest",
                arguments: [method, methodParams, { isAsync: true, lowPriority: true }],
              })
              .then((result: any) => {
                log.debug(`TypeScript server raw response for ${method}: ${result}`)
                const body = result?.body ?? result
                connection.sendNotification("tsserver/response", [requestId, body])
              })
              .catch((e) => {
                log.error(`Error forwarding tsserver request ${method}: ${e}`)
                connection.sendNotification("tsserver/response", [requestId, null])
              })
          } else {
            // No TypeScript server available, send empty response
            connection.sendNotification("tsserver/response", [requestId, null])
          }
        }
      })
      return {
        ready: () =>
          new Promise<void>((resolve) => {
            const timeout = setTimeout(() => resolve(), 5000)
            connection.onNotification("window/logMessage", (params: any) => {
              const message = (params.message ?? "").toLowerCase()
              if (message.includes("initialized") || message.includes("ready")) {
                clearTimeout(timeout)
                resolve()
              }
            })
          }),
        diagnostics: async (input: { path: string }) => {
          const uri = pathToFileURL(input.path).href
          log.debug("textDocument/diagnostic", { path: input.path })
          const response = await connection.sendRequest("textDocument/diagnostic", {
            textDocument: { uri },
          })
          const items = (response as any).items ?? []
          return items as LSPClient.Diagnostic[]
        },
        documentSymbol: async (input: { path: string }) => {
          const uri = pathToFileURL(input.path).href
          const response = await connection.sendRequest("textDocument/documentSymbol", {
            textDocument: { uri },
          })
          const symbols = (response ?? []) as LSPClient.DocumentSymbol[]
          if (symbols.length === 0) return []

          // Wrap all root symbols in a Module symbol named after the file
          const fileName = path.basename(input.path, path.extname(input.path))
          const content = await Bun.file(input.path)
            .text()
            .catch(() => "")
          const lines = content.split("\n")
          const vueSymbol: LSPClient.DocumentSymbol = {
            name: fileName,
            kind: 2, // Module
            range: {
              start: { line: 0, character: 0 },
              end: { line: lines.length, character: 0 },
            },
            selectionRange: {
              start: { line: 0, character: 0 },
              end: { line: lines.length, character: 0 },
            },
            children: symbols,
          }
          return [vueSymbol]
        },
      }
    },
  }

  export const ESLint: Info = {
    id: "eslint",
    root: NearestRoot([
      "eslint.config.js",
      ".eslintrc.js",
      ".eslintrc.json",
      ".eslintrc",
      "package-lock.json",
      "bun.lockb",
      "bun.lock",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
    async spawn(root) {
      const eslint = Module.resolve("eslint", root)
      if (!eslint) return
      log.info("spawning eslint server")
      const serverPath = path.join(Global.Path.bin, "vscode-eslint", "server", "out", "eslintServer.js")
      if (!(await Filesystem.exists(serverPath))) {
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading and building VS Code ESLint server")
        const response = await fetch("https://github.com/microsoft/vscode-eslint/archive/refs/tags/release/3.0.20.zip")
        if (!response.ok) return

        const zipPath = path.join(Global.Path.bin, "vscode-eslint.zip")
        if (response.body) await Filesystem.writeStream(zipPath, response.body)

        const ok = await Archive.extractZip(zipPath, Global.Path.bin)
          .then(() => true)
          .catch((error) => {
            log.error("Failed to extract vscode-eslint archive", { error })
            return false
          })
        if (!ok) return
        await fs.rm(zipPath, { force: true })

        const finalPath = path.join(Global.Path.bin, "vscode-eslint")

        const stats = await fs.stat(finalPath).catch(() => undefined)
        if (stats) {
          log.info("removing old eslint installation", { path: finalPath })
          await fs.rm(finalPath, { force: true, recursive: true })
        }

        // GitHub archive extracts to vscode-eslint-release-3.0.20
        await fs.rename(path.join(Global.Path.bin, "vscode-eslint-release-3.0.20"), finalPath)

        // Create symlink for $shared directory (required for server compilation)
        const sharedSource = path.join(finalPath, "$shared")
        const sharedTarget = path.join(finalPath, "server", "src", "shared")
        await fs.rm(sharedTarget, { force: true, recursive: true })
        await fs.symlink(sharedSource, sharedTarget, "junction")

        const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
        await Process.run([npmCmd, "install"], { cwd: finalPath })
        await Process.run([npmCmd, "run", "compile"], { cwd: finalPath })

        log.info("installed VS Code ESLint server", { serverPath })
      }

      const proc = spawn(BunProc.which(), [serverPath, "--stdio"], {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })

      return {
        process: proc,
        initialization: {
          validate: "on",
          packageManager: "npm",
          useESLintClass: true,
          codeAction: {
            disableRuleComment: {
              enable: true,
              location: "separateLine",
              commentStyle: "line",
            },
            showDocumentation: {
              enable: true,
            },
          },
          codeActionOnSave: {
            mode: "all",
            rules: null,
          },
          format: false,
          quiet: false,
          onIgnoredFiles: "off",
          options: {},
          rulesCustomizations: [],
          run: "onType",
          problems: {
            shortenToSingleLine: false,
          },
          nodePath: null,
          workspaceFolder: {
            name: path.basename(root),
            uri: pathToFileURL(root).href,
          },
          workingDirectory: {
            mode: "location",
          },
        },
      }
    },
    async setup({ connection, initialize }) {
      // Merge ESLint-specific capabilities
      initialize.capabilities = {
        ...initialize.capabilities,
        workspace: {
          ...initialize.capabilities?.workspace,
          configuration: true,
          didChangeConfiguration: {
            dynamicRegistration: true,
          },
          workspaceFolders: true,
        },
        textDocument: {
          ...initialize.capabilities?.textDocument,
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: {
              valueSet: [1, 2],
            },
          },
        },
      }

      return {
        diagnostics: async (input: { path: string }) => {
          const uri = pathToFileURL(input.path).href
          const response = await connection.sendRequest("textDocument/diagnostic", {
            textDocument: { uri },
          })
          const items = (response as any).items ?? []
          log.debug("ESLint textDocument/diagnostic", { path: input.path, uri, count: items.length })
          return items as LSPClient.Diagnostic[]
        },
        documentSymbol: async (input: { path: string }) => {
          return []
        },
      }
    },
  }

  export const Oxlint: Info = {
    id: "oxlint",
    root: NearestRoot([
      ".oxlintrc.json",
      "package-lock.json",
      "bun.lockb",
      "bun.lock",
      "pnpm-lock.yaml",
      "yarn.lock",
      "package.json",
    ]),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"],
    async spawn(root) {
      const ext = process.platform === "win32" ? ".cmd" : ""

      const serverTarget = path.join("node_modules", ".bin", "oxc_language_server" + ext)
      const lintTarget = path.join("node_modules", ".bin", "oxlint" + ext)

      const resolveBin = async (target: string) => {
        const localBin = path.join(root, target)
        if (await Filesystem.exists(localBin)) return localBin

        const candidates = Filesystem.up({
          targets: [target],
          start: root,
          stop: Instance.worktree,
        })
        const first = await candidates.next()
        await candidates.return()
        if (first.value) return first.value

        return undefined
      }

      let lintBin = await resolveBin(lintTarget)
      if (!lintBin) {
        const found = which("oxlint")
        if (found) lintBin = found
      }

      if (lintBin) {
        const proc = Process.spawn([lintBin, "--help"], { stdout: "pipe" })
        await proc.exited
        if (proc.stdout) {
          const help = await text(proc.stdout)
          if (help.includes("--lsp")) {
            return {
              process: spawn(lintBin, ["--lsp"], {
                cwd: root,
              }),
            }
          }
        }
      }

      let serverBin = await resolveBin(serverTarget)
      if (!serverBin) {
        const found = which("oxc_language_server")
        if (found) serverBin = found
      }
      if (serverBin) {
        log.info("spawn oxlint", { root })
        return {
          process: spawn(serverBin, [], {
            cwd: root,
          }),
        }
      }

      log.info("oxlint not found, please install oxlint")
      return
    },
  }

  export const Biome: Info = {
    id: "biome",
    root: NearestRoot([
      "biome.json",
      "biome.jsonc",
      "package-lock.json",
      "bun.lockb",
      "bun.lock",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]),
    extensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".mts",
      ".cts",
      ".json",
      ".jsonc",
      ".vue",
      ".astro",
      ".svelte",
      ".css",
      ".graphql",
      ".gql",
      ".html",
    ],
    async spawn(root) {
      const localBin = path.join(root, "node_modules", ".bin", "biome")
      let bin: string | undefined
      if (await Filesystem.exists(localBin)) bin = localBin
      if (!bin) {
        const found = which("biome")
        if (found) bin = found
      }

      let args = ["lsp-proxy", "--stdio"]

      if (!bin) {
        const resolved = Module.resolve("biome", root)
        if (!resolved) return
        bin = BunProc.which()
        args = ["x", "biome", "lsp-proxy", "--stdio"]
      }
      log.info("spawn biome", { root })
      const proc = spawn(bin, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })

      return {
        process: proc,
      }
    },
    async setup({ initialize }) {
      return {
        documentSymbol: async (input: { path: string }) => {
          return []
        },
      }
    },
  }

  export const Gopls: Info = {
    id: "gopls",
    root: async (file) => {
      const work = await NearestRoot(["go.work"])(file)
      if (work) return work
      return NearestRoot(["go.mod", "go.sum"])(file)
    },
    extensions: [".go"],
    async spawn(root) {
      log.info("spawn gopls", { root })
      let bin = which("gopls", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })
      if (!bin) {
        if (!which("go")) return
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return

        log.info("installing gopls")
        const proc = Process.spawn(["go", "install", "golang.org/x/tools/gopls@latest"], {
          env: { ...process.env, GOBIN: Global.Path.bin },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
        })
        const exit = await proc.exited
        if (exit !== 0) {
          log.error("Failed to install gopls")
          return
        }
        bin = path.join(Global.Path.bin, "gopls" + (process.platform === "win32" ? ".exe" : ""))
        log.info(`installed gopls`, {
          bin,
        })
      }
      return {
        process: spawn(bin!, {
          cwd: root,
        }),
      }
    },
  }

  export const Rubocop: Info = {
    id: "ruby-lsp",
    root: NearestRoot(["Gemfile"]),
    extensions: [".rb", ".rake", ".gemspec", ".ru"],
    async spawn(root) {
      log.info("spawn rubocop", { root })
      let bin = which("rubocop", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })
      if (!bin) {
        const ruby = which("ruby")
        const gem = which("gem")
        if (!ruby || !gem) {
          log.info("Ruby not found, please install Ruby first")
          return
        }
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("installing rubocop")
        const proc = Process.spawn(["gem", "install", "rubocop", "--bindir", Global.Path.bin], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
        })
        const exit = await proc.exited
        if (exit !== 0) {
          log.error("Failed to install rubocop")
          return
        }
        bin = path.join(Global.Path.bin, "rubocop" + (process.platform === "win32" ? ".exe" : ""))
        log.info(`installed rubocop`, {
          bin,
        })
      }
      return {
        process: spawn(bin!, ["--lsp"], {
          cwd: root,
        }),
      }
    },
  }

  export const Ty: Info = {
    id: "ty",
    extensions: [".py", ".pyi"],
    root: NearestRoot([
      "pyproject.toml",
      "ty.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "pyrightconfig.json",
    ]),
    async spawn(root) {
      log.info("spawn ty", { root })
      if (!Flag.OPENCODE_EXPERIMENTAL_LSP_TY) {
        return undefined
      }

      let binary = which("ty")

      const initialization: Record<string, string> = {}

      const potentialVenvPaths = [process.env["VIRTUAL_ENV"], path.join(root, ".venv"), path.join(root, "venv")].filter(
        (p): p is string => p !== undefined,
      )
      for (const venvPath of potentialVenvPaths) {
        const isWindows = process.platform === "win32"
        const potentialPythonPath = isWindows
          ? path.join(venvPath, "Scripts", "python.exe")
          : path.join(venvPath, "bin", "python")
        if (await Filesystem.exists(potentialPythonPath)) {
          initialization["pythonPath"] = potentialPythonPath
          break
        }
      }

      if (!binary) {
        for (const venvPath of potentialVenvPaths) {
          const isWindows = process.platform === "win32"
          const potentialTyPath = isWindows
            ? path.join(venvPath, "Scripts", "ty.exe")
            : path.join(venvPath, "bin", "ty")
          if (await Filesystem.exists(potentialTyPath)) {
            binary = potentialTyPath
            break
          }
        }
      }

      if (!binary) {
        log.error("ty not found, please install ty first")
        return
      }

      const proc = spawn(binary, ["server"], {
        cwd: root,
      })

      return {
        process: proc,
        initialization,
      }
    },
  }

  export const Pyright: Info = {
    id: "pyright",
    extensions: [".py", ".pyi"],
    root: NearestRoot([
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "pyrightconfig.json",
      "uv.lock",
    ]),
    async spawn(root) {
      log.info("spawn pyright", { root })
      let binary = which("pyright-langserver")
      const args = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "pyright", "dist", "pyright-langserver.js")
        if (!(await Filesystem.exists(js))) {
          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          await Process.spawn([BunProc.which(), "install", "pyright"], {
            cwd: Global.Path.bin,
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
            },
          }).exited
        }
        binary = BunProc.which()
        args.push(...["run", js])
      }
      args.push("--stdio")

      const initialization: Record<string, string> = {}

      // Try to detect uv-managed Python first
      if (which("uv")) {
        const uvPython = await run(["uv", "run", "which", "python"], { cwd: root })
        if (uvPython.code === 0) {
          const pythonPath = uvPython.stdout.toString().trim()
          if (pythonPath && (await Filesystem.exists(pythonPath))) {
            initialization["pythonPath"] = pythonPath
            log.info("detected uv-managed python", { pythonPath })
          }
        }
      }

      // Fall back to standard venv detection if uv detection failed
      if (!initialization["pythonPath"]) {
        const potentialVenvPaths = [
          process.env["VIRTUAL_ENV"],
          path.join(root, ".venv"),
          path.join(root, "venv"),
        ].filter((p): p is string => p !== undefined)
        for (const venvPath of potentialVenvPaths) {
          const isWindows = process.platform === "win32"
          const potentialPythonPath = isWindows
            ? path.join(venvPath, "Scripts", "python.exe")
            : path.join(venvPath, "bin", "python")
          if (await Filesystem.exists(potentialPythonPath)) {
            initialization["pythonPath"] = potentialPythonPath
            break
          }
        }
      }

      const proc = spawn(binary, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })
      return {
        process: proc,
        initialization,
      }
    },
  }

  export const ElixirLS: Info = {
    id: "elixir-ls",
    extensions: [".ex", ".exs"],
    root: NearestRoot(["mix.exs", "mix.lock"]),
    async spawn(root) {
      log.info("spawn elixir-ls", { root })
      let binary = which("elixir-ls")
      if (!binary) {
        const elixirLsPath = path.join(Global.Path.bin, "elixir-ls")
        binary = path.join(
          Global.Path.bin,
          "elixir-ls-master",
          "release",
          process.platform === "win32" ? "language_server.bat" : "language_server.sh",
        )

        if (!(await Filesystem.exists(binary))) {
          const elixir = which("elixir")
          if (!elixir) {
            log.error("elixir is required to run elixir-ls")
            return
          }

          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          log.info("downloading elixir-ls from GitHub releases")

          const response = await fetch("https://github.com/elixir-lsp/elixir-ls/archive/refs/heads/master.zip")
          if (!response.ok) return
          const zipPath = path.join(Global.Path.bin, "elixir-ls.zip")
          if (response.body) await Filesystem.writeStream(zipPath, response.body)

          const ok = await Archive.extractZip(zipPath, Global.Path.bin)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract elixir-ls archive", { error })
              return false
            })
          if (!ok) return

          await fs.rm(zipPath, {
            force: true,
            recursive: true,
          })

          const cwd = path.join(Global.Path.bin, "elixir-ls-master")
          const env = { MIX_ENV: "prod", ...process.env }
          await Process.run(["mix", "deps.get"], { cwd, env })
          await Process.run(["mix", "compile"], { cwd, env })
          await Process.run(["mix", "elixir_ls.release2", "-o", "release"], { cwd, env })

          log.info(`installed elixir-ls`, {
            path: elixirLsPath,
          })
        }
      }

      return {
        process: spawn(binary, {
          cwd: root,
        }),
      }
    },
  }

  export const Zls: Info = {
    id: "zls",
    extensions: [".zig", ".zon"],
    root: NearestRoot(["build.zig"]),
    async spawn(root) {
      log.info("spawn zls", { root })
      let bin = which("zls", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        const zig = which("zig")
        if (!zig) {
          log.error("Zig is required to use zls. Please install Zig first.")
          return
        }

        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading zls from GitHub releases")

        const releaseResponse = await fetch("https://api.github.com/repos/zigtools/zls/releases/latest")
        if (!releaseResponse.ok) {
          log.error("Failed to fetch zls release info")
          return
        }

        const release = (await releaseResponse.json()) as any

        const platform = process.platform
        const arch = process.arch
        let assetName = ""

        let zlsArch: string = arch
        if (arch === "arm64") zlsArch = "aarch64"
        else if (arch === "x64") zlsArch = "x86_64"
        else if (arch === "ia32") zlsArch = "x86"

        let zlsPlatform: string = platform
        if (platform === "darwin") zlsPlatform = "macos"
        else if (platform === "win32") zlsPlatform = "windows"

        const ext = platform === "win32" ? "zip" : "tar.xz"

        assetName = `zls-${zlsArch}-${zlsPlatform}.${ext}`

        const supportedCombos = [
          "zls-x86_64-linux.tar.xz",
          "zls-x86_64-macos.tar.xz",
          "zls-x86_64-windows.zip",
          "zls-aarch64-linux.tar.xz",
          "zls-aarch64-macos.tar.xz",
          "zls-aarch64-windows.zip",
          "zls-x86-linux.tar.xz",
          "zls-x86-windows.zip",
        ]

        if (!supportedCombos.includes(assetName)) {
          log.error(`Platform ${platform} and architecture ${arch} is not supported by zls`)
          return
        }

        const asset = release.assets.find((a: any) => a.name === assetName)
        if (!asset) {
          log.error(`Could not find asset ${assetName} in latest zls release`)
          return
        }

        const downloadUrl = asset.browser_download_url
        const downloadResponse = await fetch(downloadUrl)
        if (!downloadResponse.ok) {
          log.error("Failed to download zls")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        if (downloadResponse.body) await Filesystem.writeStream(tempPath, downloadResponse.body)

        if (ext === "zip") {
          const ok = await Archive.extractZip(tempPath, Global.Path.bin)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract zls archive", { error })
              return false
            })
          if (!ok) return
        } else {
          await run(["tar", "-xf", tempPath], { cwd: Global.Path.bin })
        }

        await fs.rm(tempPath, { force: true })

        bin = path.join(Global.Path.bin, "zls" + (platform === "win32" ? ".exe" : ""))

        if (!(await Filesystem.exists(bin))) {
          log.error("Failed to extract zls binary")
          return
        }

        if (platform !== "win32") {
          await fs.chmod(bin, 0o755).catch(() => {})
        }

        log.info(`installed zls`, { bin })
      }

      return {
        process: spawn(bin, {
          cwd: root,
        }),
      }
    },
  }

  export const CSharp: Info = {
    id: "csharp",
    root: NearestRoot([".slnx", ".sln", ".csproj", "global.json"]),
    extensions: [".cs"],
    async spawn(root) {
      log.info("spawn csharp-ls", { root })
      let bin = which("csharp-ls", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })
      if (!bin) {
        if (!which("dotnet")) {
          log.error(".NET SDK is required to install csharp-ls")
          return
        }

        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("installing csharp-ls via dotnet tool")
        const proc = Process.spawn(["dotnet", "tool", "install", "csharp-ls", "--tool-path", Global.Path.bin], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
        })
        const exit = await proc.exited
        if (exit !== 0) {
          log.error("Failed to install csharp-ls")
          return
        }

        bin = path.join(Global.Path.bin, "csharp-ls" + (process.platform === "win32" ? ".exe" : ""))
        log.info(`installed csharp-ls`, { bin })
      }

      return {
        process: spawn(bin, {
          cwd: root,
        }),
      }
    },
  }

  export const FSharp: Info = {
    id: "fsharp",
    root: NearestRoot([".slnx", ".sln", ".fsproj", "global.json"]),
    extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
    async spawn(root) {
      log.info("spawn fsautocomplete", { root })
      let bin = which("fsautocomplete", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })
      if (!bin) {
        if (!which("dotnet")) {
          log.error(".NET SDK is required to install fsautocomplete")
          return
        }

        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("installing fsautocomplete via dotnet tool")
        const proc = Process.spawn(["dotnet", "tool", "install", "fsautocomplete", "--tool-path", Global.Path.bin], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
        })
        const exit = await proc.exited
        if (exit !== 0) {
          log.error("Failed to install fsautocomplete")
          return
        }

        bin = path.join(Global.Path.bin, "fsautocomplete" + (process.platform === "win32" ? ".exe" : ""))
        log.info(`installed fsautocomplete`, { bin })
      }

      return {
        process: spawn(bin, {
          cwd: root,
        }),
      }
    },
  }

  export const SourceKit: Info = {
    id: "sourcekit-lsp",
    extensions: [".swift", ".objc", "objcpp"],
    root: NearestRoot(["Package.swift", "*.xcodeproj", "*.xcworkspace"]),
    async spawn(root) {
      log.info("spawn sourcekit-lsp", { root })
      // Check if sourcekit-lsp is available in the PATH
      // This is installed with the Swift toolchain
      const sourcekit = which("sourcekit-lsp")
      if (sourcekit) {
        return {
          process: spawn(sourcekit, {
            cwd: root,
          }),
        }
      }

      // If sourcekit-lsp not found, check if xcrun is available
      // This is specific to macOS where sourcekit-lsp is typically installed with Xcode
      if (!which("xcrun")) return

      const lspLoc = await output(["xcrun", "--find", "sourcekit-lsp"])

      if (lspLoc.code !== 0) return

      const bin = lspLoc.text.trim()

      return {
        process: spawn(bin, {
          cwd: root,
        }),
      }
    },
  }

  export const RustAnalyzer: Info = {
    id: "rust",
    root: async (root) => {
      const crateRoot = await NearestRoot(["Cargo.toml", "Cargo.lock"])(root)
      if (crateRoot === undefined) {
        return undefined
      }
      let currentDir = crateRoot

      while (currentDir !== path.dirname(currentDir)) {
        // Stop at filesystem root
        const cargoTomlPath = path.join(currentDir, "Cargo.toml")
        try {
          const cargoTomlContent = await Filesystem.readText(cargoTomlPath)
          if (cargoTomlContent.includes("[workspace]")) {
            return currentDir
          }
        } catch (err) {
          // File doesn't exist or can't be read, continue searching up
        }

        const parentDir = path.dirname(currentDir)
        if (parentDir === currentDir) break // Reached filesystem root
        currentDir = parentDir

        // Stop if we've gone above the app root
        if (!currentDir.startsWith(Instance.worktree)) break
      }

      return crateRoot
    },
    extensions: [".rs"],
    async spawn(root) {
      log.info("spawn rust-analyzer", { root })
      const bin = which("rust-analyzer")
      if (!bin) {
        log.info("rust-analyzer not found in path, please install it")
        return
      }
      return {
        process: spawn(bin, {
          cwd: root,
        }),
      }
    },
  }

  export const Clangd: Info = {
    id: "clangd",
    root: NearestRoot(["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "Makefile"]),
    extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
    async spawn(root) {
      log.info("spawn clangd", { root })
      const args = ["--background-index", "--clang-tidy"]
      const fromPath = which("clangd")
      if (fromPath) {
        return {
          process: spawn(fromPath, args, {
            cwd: root,
          }),
        }
      }

      const ext = process.platform === "win32" ? ".exe" : ""
      const direct = path.join(Global.Path.bin, "clangd" + ext)
      if (await Filesystem.exists(direct)) {
        return {
          process: spawn(direct, args, {
            cwd: root,
          }),
        }
      }

      const entries = await fs.readdir(Global.Path.bin, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith("clangd_")) continue
        const candidate = path.join(Global.Path.bin, entry.name, "bin", "clangd" + ext)
        if (await Filesystem.exists(candidate)) {
          return {
            process: spawn(candidate, args, {
              cwd: root,
            }),
          }
        }
      }

      if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
      log.info("downloading clangd from GitHub releases")

      const releaseResponse = await fetch("https://api.github.com/repos/clangd/clangd/releases/latest")
      if (!releaseResponse.ok) {
        log.error("Failed to fetch clangd release info")
        return
      }

      const release: {
        tag_name?: string
        assets?: { name?: string; browser_download_url?: string }[]
      } = await releaseResponse.json()

      const tag = release.tag_name
      if (!tag) {
        log.error("clangd release did not include a tag name")
        return
      }
      const platform = process.platform
      const tokens: Record<string, string> = {
        darwin: "mac",
        linux: "linux",
        win32: "windows",
      }
      const token = tokens[platform]
      if (!token) {
        log.error(`Platform ${platform} is not supported by clangd auto-download`)
        return
      }

      const assets = release.assets ?? []
      const valid = (item: { name?: string; browser_download_url?: string }) => {
        if (!item.name) return false
        if (!item.browser_download_url) return false
        if (!item.name.includes(token)) return false
        return item.name.includes(tag)
      }

      const asset =
        assets.find((item) => valid(item) && item.name?.endsWith(".zip")) ??
        assets.find((item) => valid(item) && item.name?.endsWith(".tar.xz")) ??
        assets.find((item) => valid(item))
      if (!asset?.name || !asset.browser_download_url) {
        log.error("clangd could not match release asset", { tag, platform })
        return
      }

      const name = asset.name
      const downloadResponse = await fetch(asset.browser_download_url)
      if (!downloadResponse.ok) {
        log.error("Failed to download clangd")
        return
      }

      const archive = path.join(Global.Path.bin, name)
      const buf = await downloadResponse.arrayBuffer()
      if (buf.byteLength === 0) {
        log.error("Failed to write clangd archive")
        return
      }
      await Filesystem.write(archive, Buffer.from(buf))

      const zip = name.endsWith(".zip")
      const tar = name.endsWith(".tar.xz")
      if (!zip && !tar) {
        log.error("clangd encountered unsupported asset", { asset: name })
        return
      }

      if (zip) {
        const ok = await Archive.extractZip(archive, Global.Path.bin)
          .then(() => true)
          .catch((error) => {
            log.error("Failed to extract clangd archive", { error })
            return false
          })
        if (!ok) return
      }
      if (tar) {
        await run(["tar", "-xf", archive], { cwd: Global.Path.bin })
      }
      await fs.rm(archive, { force: true })

      const bin = path.join(Global.Path.bin, "clangd_" + tag, "bin", "clangd" + ext)
      if (!(await Filesystem.exists(bin))) {
        log.error("Failed to extract clangd binary")
        return
      }

      if (platform !== "win32") {
        await fs.chmod(bin, 0o755).catch(() => {})
      }

      await fs.unlink(path.join(Global.Path.bin, "clangd")).catch(() => {})
      await fs.symlink(bin, path.join(Global.Path.bin, "clangd")).catch(() => {})

      log.info(`installed clangd`, { bin })

      return {
        process: spawn(bin, args, {
          cwd: root,
        }),
      }
    },
  }

  export const Svelte: Info = {
    id: "svelte",
    extensions: [".svelte"],
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    async spawn(root) {
      log.info("spawn svelte", { root })
      let binary = which("svelteserver")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "svelte-language-server", "bin", "server.js")
        if (!(await Filesystem.exists(js))) {
          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          await Process.spawn([BunProc.which(), "install", "svelte-language-server"], {
            cwd: Global.Path.bin,
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "pipe",
          }).exited
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = spawn(binary, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })
      return {
        process: proc,
        initialization: {},
      }
    },
  }

  export const Astro: Info = {
    id: "astro",
    extensions: [".astro"],
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    async spawn(root) {
      log.info("spawn astro", { root })
      const tsserver = Module.resolve("typescript/lib/tsserver.js", root)
      if (!tsserver) {
        log.info("typescript not found, required for Astro language server")
        return
      }
      const tsdk = path.dirname(tsserver)

      let binary = which("astro-ls")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "@astrojs", "language-server", "bin", "nodeServer.js")
        if (!(await Filesystem.exists(js))) {
          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          await Process.spawn([BunProc.which(), "install", "@astrojs/language-server"], {
            cwd: Global.Path.bin,
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "pipe",
          }).exited
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = spawn(binary, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })
      return {
        process: proc,
        initialization: {
          typescript: {
            tsdk,
          },
        },
      }
    },
  }

  export const JDTLS: Info = {
    id: "jdtls",
    root: async (file) => {
      // Without exclusions, NearestRoot defaults to instance directory so we can't
      // distinguish between a) no project found and b) project found at instance dir.
      // So we can't choose the root from (potential) monorepo markers first.
      // Look for potential subproject markers first while excluding potential monorepo markers.
      const settingsMarkers = ["settings.gradle", "settings.gradle.kts"]
      const gradleMarkers = ["gradlew", "gradlew.bat"]
      const exclusionsForMonorepos = gradleMarkers.concat(settingsMarkers)

      const [projectRoot, wrapperRoot, settingsRoot] = await Promise.all([
        NearestRoot(
          ["pom.xml", "build.gradle", "build.gradle.kts", ".project", ".classpath"],
          exclusionsForMonorepos,
        )(file),
        NearestRoot(gradleMarkers, settingsMarkers)(file),
        NearestRoot(settingsMarkers)(file),
      ])

      // If projectRoot is undefined we know we are in a monorepo or no project at all.
      // So can safely fall through to the other roots
      if (projectRoot) return projectRoot
      if (wrapperRoot) return wrapperRoot
      if (settingsRoot) return settingsRoot
    },
    extensions: [".java"],
    async spawn(root) {
      log.info("spawn jdtls with root dir", { root })
      const java = which("java")
      const platform = process.platform
      const arch = process.arch

      const platformId = (() => {
        if (platform === "darwin" && arch === "arm64") return "osx-arm64"
        if (platform === "darwin" && arch === "x64") return "osx-x64"
        if (platform === "linux" && arch === "arm64") return "linux-arm64"
        if (platform === "linux" && arch === "x64") return "linux-x64"
        if (platform === "win32" && arch === "x64") return "win-x64"
        return undefined
      })()

      if (!platformId) {
        log.error(`Platform ${platform}/${arch} is not supported by JDTLS`)
        return
      }

      const vscodJavaConfig: Record<
        string,
        {
          url: string
          jreHomePath: string
          jrePath: string
          lombokJarPath: string
          launcherJarPath: string
          configPath: string
        }
      > = {
        "osx-arm64": {
          url: "https://github.com/redhat-developer/vscode-java/releases/download/v1.50.0/java-darwin-arm64-1.50.0-769.vsix",
          jreHomePath: "extension/jre/21.0.9-macosx-aarch64",
          jrePath: "extension/jre/21.0.9-macosx-aarch64/bin/java",
          lombokJarPath: "extension/lombok/lombok-1.18.39-4050.jar",
          launcherJarPath: "extension/server/plugins/org.eclipse.equinox.launcher_1.7.100.v20251111-0406.jar",
          configPath: "extension/server/config_mac_arm",
        },
        "osx-x64": {
          url: "https://github.com/redhat-developer/vscode-java/releases/download/v1.50.0/java-darwin-x64-1.50.0-769.vsix",
          jreHomePath: "extension/jre/21.0.9-macosx-x86_64",
          jrePath: "extension/jre/21.0.9-macosx-x86_64/bin/java",
          lombokJarPath: "extension/lombok/lombok-1.18.39-4050.jar",
          launcherJarPath: "extension/server/plugins/org.eclipse.equinox.launcher_1.7.100.v20251111-0406.jar",
          configPath: "extension/server/config_mac",
        },
        "linux-arm64": {
          url: "https://github.com/redhat-developer/vscode-java/releases/download/v1.50.0/java-linux-arm64-1.50.0-769.vsix",
          jreHomePath: "extension/jre/21.0.9-linux-aarch64",
          jrePath: "extension/jre/21.0.9-linux-aarch64/bin/java",
          lombokJarPath: "extension/lombok/lombok-1.18.39-4050.jar",
          launcherJarPath: "extension/server/plugins/org.eclipse.equinox.launcher_1.7.100.v20251111-0406.jar",
          configPath: "extension/server/config_linux",
        },
        "linux-x64": {
          url: "https://github.com/redhat-developer/vscode-java/releases/download/v1.50.0/java-linux-x64-1.50.0-769.vsix",
          jreHomePath: "extension/jre/21.0.9-linux-x86_64",
          jrePath: "extension/jre/21.0.9-linux-x86_64/bin/java",
          lombokJarPath: "extension/lombok/lombok-1.18.39-4050.jar",
          launcherJarPath: "extension/server/plugins/org.eclipse.equinox.launcher_1.7.100.v20251111-0406.jar",
          configPath: "extension/server/config_linux",
        },
        "win-x64": {
          url: "https://github.com/redhat-developer/vscode-java/releases/download/v1.50.0/java-win32-x64-1.50.0-769.vsix",
          jreHomePath: "extension/jre/21.0.9-win32-x86_64",
          jrePath: "extension/jre/21.0.9-win32-x86_64/bin/java.exe",
          lombokJarPath: "extension/lombok/lombok-1.18.39-4050.jar",
          launcherJarPath: "extension/server/plugins/org.eclipse.equinox.launcher_1.7.100.v20251111-0406.jar",
          configPath: "extension/server/config_win",
        },
      }

      const config = vscodJavaConfig[platformId]

      // Check if user has Java >= 21 installed
      let userJavaPath: string | undefined
      let userJavaHomePath: string | undefined
      const systemJava = which("java")
      if (systemJava) {
        const javaVersion = await run(["java", "-version"])
        const versionMatch = /"(\d+)(?:\.\d+)*"/.exec(javaVersion.stderr.toString())
        const majorVersion = versionMatch ? parseInt(versionMatch[1]) : 0
        if (majorVersion >= 21) {
          userJavaPath = systemJava
          // Derive JAVA_HOME from java binary path (usually java is in JAVA_HOME/bin/java)
          userJavaHomePath = path.dirname(path.dirname(systemJava))
          log.info("Using system Java", { version: majorVersion, path: userJavaPath })
        }
      }

      // Setup paths
      const vscodJavaDir = path.join(Global.Path.bin, "vscode-java")
      const jreHomePath = userJavaHomePath ?? path.join(vscodJavaDir, config.jreHomePath)
      const jrePath = userJavaPath ?? path.join(vscodJavaDir, config.jrePath)
      const lombokJarPath = path.join(vscodJavaDir, config.lombokJarPath)
      const launcherJarPath = path.join(vscodJavaDir, config.launcherJarPath)
      const readonlyConfigPath = path.join(vscodJavaDir, config.configPath)

      // Download vscode-java if not exists
      if (!(await pathExists(launcherJarPath))) {
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) {
          log.info("JDTLS download disabled")
          return
        }
        await fs.mkdir(vscodJavaDir, { recursive: true })
        const archivePath = path.join(vscodJavaDir, "vscode-java.zip")

        // Only download if archive doesn't exist
        if (!(await pathExists(archivePath))) {
          log.info("Downloading vscode-java for JDTLS", { url: config.url })
          await run(["curl", "-L", "-o", archivePath, config.url])
          log.info("Downloaded vscode-java")
        }

        log.info("Extracting vscode-java archive")
        const ok = await Archive.extractZip(archivePath, vscodJavaDir)
          .then(() => true)
          .catch((err) => {
            log.error("Failed to extract vscode-java archive", { error: err })
            return false
          })
        if (!ok) return
        await fs.rm(archivePath, { force: true })
        // Make java executable on unix
        if (platform !== "win32" && !userJavaPath) {
          await fs.chmod(path.join(vscodJavaDir, config.jrePath), 0o755)
        }
      }

      // Verify all required paths exist
      const requiredPaths = [jrePath, lombokJarPath, launcherJarPath, readonlyConfigPath]
      if (!userJavaPath) requiredPaths.push(jreHomePath)
      for (const p of requiredPaths) {
        if (!(await pathExists(p))) {
          log.error("Required JDTLS path not found", { path: p })
          return
        }
      }

      // Create workspace-specific directories using hash of root path
      const crypto = await import("crypto")
      const rootHash = crypto.createHash("md5").update(root).digest("hex")
      const workspaceDir = path.join(Global.Path.bin, "jdtls-workspaces", rootHash)
      const dataDir = path.join(workspaceDir, "data")
      const configDir = path.join(workspaceDir, "config")
      const sharedIndexDir = path.join(Global.Path.bin, "jdtls-shared-index")

      await fs.mkdir(dataDir, { recursive: true })
      await fs.mkdir(sharedIndexDir, { recursive: true })

      // Copy config if not exists
      if (!(await pathExists(configDir))) {
        await fs.cp(readonlyConfigPath, configDir, { recursive: true })
      }

      // Build command arguments
      const cmd = [
        jrePath,
        "--add-modules=ALL-SYSTEM",
        "--add-opens",
        "java.base/java.util=ALL-UNNAMED",
        "--add-opens",
        "java.base/java.lang=ALL-UNNAMED",
        "--add-opens",
        "java.base/sun.nio.fs=ALL-UNNAMED",
        "-Declipse.application=org.eclipse.jdt.ls.core.id1",
        "-Dosgi.bundles.defaultStartLevel=4",
        "-Declipse.product=org.eclipse.jdt.ls.core.product",
        "-Djava.import.generatesMetadataFilesAtProjectRoot=false",
        "-Dfile.encoding=utf8",
        "-XX:+UseParallelGC",
        "-XX:GCTimeRatio=4",
        "-XX:AdaptiveSizePolicyWeight=90",
        "-Dsun.zip.disableMemoryMapping=true",
        "-Djava.lsp.joinOnCompletion=true",
        "-Xmx6G",
        "-Xms1G",
        "-Xlog:disable",
        "-Dlog.level=WARNING",
        `-javaagent:${lombokJarPath}`,
        `-Djdt.core.sharedIndexLocation=${sharedIndexDir}`,
        "-jar",
        launcherJarPath,
        "-configuration",
        configDir,
        "-data",
        dataDir,
      ]

      const proc = spawn(cmd[0], cmd.slice(1), {
        cwd: root,
        env: {
          ...process.env,
          JAVA_HOME: jreHomePath,
          syntaxserver: "false",
        },
      })

      return {
        process: proc,
        initialization: {
          jreHomePath,
          jrePath,
          lombokJarPath,
          launcherJarPath,
          configDir,
          dataDir,
          sharedIndexDir,
        },
      }
    },
    async setup({ initialize, connection }) {
      const jreHomePath = initialize.initializationOptions?.jreHomePath ?? ""

      // Merge JDTLS-specific capabilities and settings
      initialize.capabilities = {
        ...initialize.capabilities,
        workspace: {
          ...initialize.capabilities?.workspace,
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
            failureHandling: "textOnlyTransactional",
            normalizesLineEndings: true,
            changeAnnotationSupport: { groupsOnLabel: true },
          },
          didChangeConfiguration: { dynamicRegistration: true },
          didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
          symbol: {
            dynamicRegistration: true,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
            tagSupport: { valueSet: [1] },
            resolveSupport: { properties: ["location.range"] },
          },
          codeLens: { refreshSupport: true },
          executeCommand: { dynamicRegistration: true },
          configuration: true,
          workspaceFolders: true,
          semanticTokens: { refreshSupport: true },
          fileOperations: {
            dynamicRegistration: true,
            didCreate: true,
            didRename: true,
            didDelete: true,
            willCreate: true,
            willRename: true,
            willDelete: true,
          },
          inlineValue: { refreshSupport: true },
          inlayHint: { refreshSupport: true },
          diagnostics: { refreshSupport: true },
        },
        textDocument: {
          ...initialize.capabilities?.textDocument,
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: false,
            tagSupport: { valueSet: [1, 2] },
            codeDescriptionSupport: true,
            dataSupport: true,
          },
          synchronization: {
            dynamicRegistration: true,
            willSave: true,
            willSaveWaitUntil: true,
            didSave: true,
          },
          completion: {
            dynamicRegistration: true,
            contextSupport: true,
            completionItem: {
              snippetSupport: false,
              commitCharactersSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              deprecatedSupport: true,
              preselectSupport: true,
              tagSupport: { valueSet: [1] },
              insertReplaceSupport: false,
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
              insertTextModeSupport: { valueSet: [1, 2] },
              labelDetailsSupport: true,
            },
            insertTextMode: 2,
            completionItemKind: {
              valueSet: Array.from({ length: 25 }, (_, i) => i + 1),
            },
            completionList: {
              itemDefaults: ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode"],
            },
          },
          hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {
            dynamicRegistration: true,
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: { labelOffsetSupport: true },
              activeParameterSupport: true,
            },
          },
          definition: { dynamicRegistration: true, linkSupport: true },
          references: { dynamicRegistration: true },
          documentSymbol: {
            dynamicRegistration: true,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
            hierarchicalDocumentSymbolSupport: true,
            tagSupport: { valueSet: [1] },
            labelSupport: true,
          },
          rename: {
            dynamicRegistration: true,
            prepareSupport: true,
            prepareSupportDefaultBehavior: 1,
            honorsChangeAnnotations: true,
          },
          documentLink: { dynamicRegistration: true, tooltipSupport: true },
          typeDefinition: { dynamicRegistration: true, linkSupport: true },
          implementation: { dynamicRegistration: true, linkSupport: true },
          colorProvider: { dynamicRegistration: true },
          declaration: { dynamicRegistration: true, linkSupport: true },
          selectionRange: { dynamicRegistration: true },
          callHierarchy: { dynamicRegistration: true },
          semanticTokens: {
            dynamicRegistration: true,
            tokenTypes: [
              "namespace",
              "type",
              "class",
              "enum",
              "interface",
              "struct",
              "typeParameter",
              "parameter",
              "variable",
              "property",
              "enumMember",
              "event",
              "function",
              "method",
              "macro",
              "keyword",
              "modifier",
              "comment",
              "string",
              "number",
              "regexp",
              "operator",
              "decorator",
            ],
            tokenModifiers: [
              "declaration",
              "definition",
              "readonly",
              "static",
              "deprecated",
              "abstract",
              "async",
              "modification",
              "documentation",
              "defaultLibrary",
            ],
            formats: ["relative"],
            requests: { range: true, full: { delta: true } },
            multilineTokenSupport: false,
            overlappingTokenSupport: false,
            serverCancelSupport: true,
            augmentsSyntaxTokens: true,
          },
          typeHierarchy: { dynamicRegistration: true },
          inlineValue: { dynamicRegistration: true },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
        },
        general: {
          staleRequestSupport: {
            cancel: true,
            retryOnContentModified: [
              "textDocument/semanticTokens/full",
              "textDocument/semanticTokens/range",
              "textDocument/semanticTokens/full/delta",
            ],
          },
          regularExpressions: { engine: "ECMAScript", version: "ES2020" },
          positionEncodings: ["utf-16"],
        },
      }

      // Set Java-specific initialization options
      initialize.initializationOptions = {
        bundles: [],
        settings: {
          java: {
            home: null,
            jdt: {
              ls: {
                java: { home: null },
                vmargs:
                  "-XX:+UseParallelGC -XX:GCTimeRatio=4 -XX:AdaptiveSizePolicyWeight=90 -Dsun.zip.disableMemoryMapping=true -Xmx3G -Xms100m -Xlog:disable -Declipse.p2.unsignedPolicy=allow",
                lombokSupport: { enabled: true },
                protobufSupport: { enabled: false },
                androidSupport: { enabled: false },
              },
            },
            errors: {
              incompleteClasspath: { severity: "ignore" },
              unlikelyArgumentCheck: { severity: "ignore" },
            },
            problems: {
              unlikelyArgumentType: "ignore",
              unlikelyEqualsArgumentType: "ignore",
            },
            configuration: {
              checkProjectSettingsExclusions: false,
              updateBuildConfiguration: "interactive",
              maven: {
                userSettings: null,
                globalSettings: null,
                notCoveredPluginExecutionSeverity: "ignore",
                defaultMojoExecutionAction: "ignore",
                offline: { enabled: true },
              },
              workspaceCacheLimit: 1000,
              runtimes: [{ name: "JavaSE-21", path: jreHomePath, default: true }],
            },
            trace: { server: "off" },
            import: {
              maven: {
                enabled: true,
                offline: { enabled: false },
                disableTestClasspathFlag: true,
              },
              gradle: {
                enabled: true,
                wrapper: { enabled: true },
                version: null,
                home: null,
                java: { home: jreHomePath },
                offline: { enabled: false },
                arguments: null,
                jvmArguments: null,
                user: { home: null },
                annotationProcessing: { enabled: false },
              },
              exclusions: [
                "**/node_modules/**",
                "**/.metadata/**",
                "**/archetype-resources/**",
                "**/META-INF/maven/**",
              ],
              generatesMetadataFilesAtProjectRoot: false,
            },
            maven: { downloadSources: false, updateSnapshots: false },
            eclipse: { downloadSources: false },
            signatureHelp: { enabled: false, description: { enabled: false } },
            implementationsCodeLens: { enabled: false },
            format: {
              enabled: false,
              settings: { url: null, profile: null },
              comments: { enabled: false },
              onType: { enabled: false },
              insertSpaces: true,
              tabSize: 4,
            },
            saveActions: { organizeImports: false },
            project: {
              referencedLibraries: ["lib/**/*.jar"],
              importOnFirstTimeStartup: "automatic",
              importHint: false,
              resourceFilters: ["node_modules", "\\.git"],
              encoding: "ignore",
              exportJar: { targetPath: "${workspaceFolder}/${workspaceFolderBasename}.jar" },
            },
            contentProvider: { preferred: null },
            autobuild: { enabled: true },
            maxConcurrentBuilds: 8,
            selectionRange: { enabled: false },
            showBuildStatusOnStart: { enabled: "off" },
            server: { launchMode: "Standard" },
            sources: { organizeImports: { starThreshold: 99, staticStarThreshold: 99 } },
            imports: { gradle: { wrapper: { checksums: [] } } },
            templates: { fileHeader: [], typeComment: [] },
            references: { includeAccessors: false, includeDecompiledSources: false },
            typeHierarchy: { lazyLoad: true },
            settings: { url: null },
            symbols: { includeSourceMethodDeclarations: true },
            inlayHints: { parameterNames: { enabled: "none", exclusions: [] } },
            codeAction: { sortMembers: { avoidVolatileChanges: true } },
            compile: {
              nullAnalysis: { mode: "disabled" },
              unlikelyArgumentType: "ignore",
              unlikelyEqualsArgumentType: "ignore",
            },
            completion: {
              enabled: true,
              overwrite: false,
              guessMethodArguments: false,
              filteredTypes: [],
              favoriteStaticMembers: [],
              importOrder: [],
            },
            progressReports: { enabled: false },
            sharedIndexes: { enabled: "auto", location: "" },
            silentNotification: true,
            dependency: {
              showMembers: false,
              syncWithFolderExplorer: false,
              autoRefresh: false,
              refreshDelay: 2000,
              packagePresentation: "flat",
            },
            help: { firstView: "auto", showReleaseNotes: false, collectErrorLog: false },
            test: { defaultConfig: "", config: {} },
          },
        },
      }

      const do_nothing = (_params: any): void => {}

      // Register notification handlers for JDTLS
      connection.onNotification("window/logMessage", (params: any) => {
        log.info("JDTLS window/logMessage", params)
      })
      connection.onNotification("$/progress", do_nothing)
      connection.onNotification("language/actionableNotification", do_nothing)
      connection.onRequest("workspace/executeClientCommand", do_nothing)

      return {
        ready: () =>
          new Promise<void>((resolve) => {
            connection.onNotification("language/status", (params: any) => {
              if (params.type === "ServiceReady" && params.message === "ServiceReady") {
                resolve()
              }
            })
          }),
        async documentSymbol(input: { path: string; url?: URL }) {
          input.path = path.isAbsolute(input.path) ? input.path : path.resolve(Instance.directory, input.path)
          const rootSymbols = await connection
            .sendRequest("textDocument/documentSymbol", {
              textDocument: {
                uri: (input.url || pathToFileURL(input.path)).href,
              },
            })
            .then((r) => (Array.isArray(r) ? r : []) as LSPClient.DocumentSymbol[])
            .catch(() => [])

          // Note: name normalization (stripping parameter signatures and generic parameters)
          // and overload index assignment are handled universally in symbols.ts,
          // so no pre-processing of rootSymbols is needed here.

          return rootSymbols
        },
      }
    },
  }

  export const KotlinLS: Info = {
    id: "kotlin-ls",
    extensions: [".kt", ".kts"],
    root: async (file) => {
      // 1) Nearest Gradle root (multi-project or included build)
      const settingsRoot = await NearestRoot(["settings.gradle.kts", "settings.gradle"])(file)
      if (settingsRoot) return settingsRoot
      // 2) Gradle wrapper (strong root signal)
      const wrapperRoot = await NearestRoot(["gradlew", "gradlew.bat"])(file)
      if (wrapperRoot) return wrapperRoot
      // 3) Single-project or module-level build
      const buildRoot = await NearestRoot(["build.gradle.kts", "build.gradle"])(file)
      if (buildRoot) return buildRoot
      // 4) Maven fallback
      return NearestRoot(["pom.xml"])(file)
    },
    async spawn(root) {
      log.info("spawn kotlin-ls", { root })
      const distPath = path.join(Global.Path.bin, "kotlin-ls")
      const launcherScript =
        process.platform === "win32" ? path.join(distPath, "kotlin-lsp.cmd") : path.join(distPath, "kotlin-lsp.sh")
      const installed = await Filesystem.exists(launcherScript)
      if (!installed) {
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("Downloading Kotlin Language Server from GitHub.")

        const releaseResponse = await fetch("https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest")
        if (!releaseResponse.ok) {
          log.error("Failed to fetch kotlin-lsp release info")
          return
        }

        const release = await releaseResponse.json()
        const version = release.name?.replace(/^v/, "")

        if (!version) {
          log.error("Could not determine Kotlin LSP version from release")
          return
        }

        const platform = process.platform
        const arch = process.arch

        let kotlinArch: string = arch
        if (arch === "arm64") kotlinArch = "aarch64"
        else if (arch === "x64") kotlinArch = "x64"

        let kotlinPlatform: string = platform
        if (platform === "darwin") kotlinPlatform = "mac"
        else if (platform === "linux") kotlinPlatform = "linux"
        else if (platform === "win32") kotlinPlatform = "win"

        const supportedCombos = ["mac-x64", "mac-aarch64", "linux-x64", "linux-aarch64", "win-x64", "win-aarch64"]

        const combo = `${kotlinPlatform}-${kotlinArch}`

        if (!supportedCombos.includes(combo)) {
          log.error(`Platform ${platform}/${arch} is not supported by Kotlin LSP`)
          return
        }

        const assetName = `kotlin-lsp-${version}-${kotlinPlatform}-${kotlinArch}.zip`
        const releaseURL = `https://download-cdn.jetbrains.com/kotlin-lsp/${version}/${assetName}`

        await fs.mkdir(distPath, { recursive: true })
        const archivePath = path.join(distPath, "kotlin-ls.zip")
        const download = await fetch(releaseURL)
        if (!download.ok || !download.body) {
          log.error("Failed to download Kotlin Language Server", {
            status: download.status,
            statusText: download.statusText,
          })
          return
        }
        await Filesystem.writeStream(archivePath, download.body)
        const ok = await Archive.extractZip(archivePath, distPath)
          .then(() => true)
          .catch((error) => {
            log.error("Failed to extract Kotlin LS archive", { error })
            return false
          })
        if (!ok) return
        await fs.rm(archivePath, { force: true })
        if (process.platform !== "win32") {
          await fs.chmod(launcherScript, 0o755).catch(() => {})
        }
        log.info("Installed Kotlin Language Server", { path: launcherScript })
      }
      if (!(await Filesystem.exists(launcherScript))) {
        log.error(`Failed to locate the Kotlin LS launcher script in the installed directory: ${distPath}.`)
        return
      }
      return {
        process: spawn(launcherScript, ["--stdio"], {
          cwd: root,
        }),
      }
    },
  }

  export const YamlLS: Info = {
    id: "yaml-ls",
    extensions: [".yaml", ".yml"],
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    async spawn(root) {
      log.info("spawn yaml-ls", { root })
      let binary = which("yaml-language-server")
      const args: string[] = []
      if (!binary) {
        const js = path.join(
          Global.Path.bin,
          "node_modules",
          "yaml-language-server",
          "out",
          "server",
          "src",
          "server.js",
        )
        const exists = await Filesystem.exists(js)
        if (!exists) {
          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          await Process.spawn([BunProc.which(), "install", "yaml-language-server"], {
            cwd: Global.Path.bin,
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "pipe",
          }).exited
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = spawn(binary, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })
      return {
        process: proc,
      }
    },
  }

  export const LuaLS: Info = {
    id: "lua-ls",
    root: NearestRoot([
      ".luarc.json",
      ".luarc.jsonc",
      ".luacheckrc",
      ".stylua.toml",
      "stylua.toml",
      "selene.toml",
      "selene.yml",
    ]),
    extensions: [".lua"],
    async spawn(root) {
      log.info("spawn lua-ls", { root })
      let bin = which("lua-language-server", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading lua-language-server from GitHub releases")

        const releaseResponse = await fetch("https://api.github.com/repos/LuaLS/lua-language-server/releases/latest")
        if (!releaseResponse.ok) {
          log.error("Failed to fetch lua-language-server release info")
          return
        }

        const release = await releaseResponse.json()

        const platform = process.platform
        const arch = process.arch
        let assetName = ""

        let lualsArch: string = arch
        if (arch === "arm64") lualsArch = "arm64"
        else if (arch === "x64") lualsArch = "x64"
        else if (arch === "ia32") lualsArch = "ia32"

        let lualsPlatform: string = platform
        if (platform === "darwin") lualsPlatform = "darwin"
        else if (platform === "linux") lualsPlatform = "linux"
        else if (platform === "win32") lualsPlatform = "win32"

        const ext = platform === "win32" ? "zip" : "tar.gz"

        assetName = `lua-language-server-${release.tag_name}-${lualsPlatform}-${lualsArch}.${ext}`

        const supportedCombos = [
          "darwin-arm64.tar.gz",
          "darwin-x64.tar.gz",
          "linux-x64.tar.gz",
          "linux-arm64.tar.gz",
          "win32-x64.zip",
          "win32-ia32.zip",
        ]

        const assetSuffix = `${lualsPlatform}-${lualsArch}.${ext}`
        if (!supportedCombos.includes(assetSuffix)) {
          log.error(`Platform ${platform} and architecture ${arch} is not supported by lua-language-server`)
          return
        }

        const asset = release.assets.find((a: any) => a.name === assetName)
        if (!asset) {
          log.error(`Could not find asset ${assetName} in latest lua-language-server release`)
          return
        }

        const downloadUrl = asset.browser_download_url
        const downloadResponse = await fetch(downloadUrl)
        if (!downloadResponse.ok) {
          log.error("Failed to download lua-language-server")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        if (downloadResponse.body) await Filesystem.writeStream(tempPath, downloadResponse.body)

        // Unlike zls which is a single self-contained binary,
        // lua-language-server needs supporting files (meta/, locale/, etc.)
        // Extract entire archive to dedicated directory to preserve all files
        const installDir = path.join(Global.Path.bin, `lua-language-server-${lualsArch}-${lualsPlatform}`)

        // Remove old installation if exists
        const stats = await fs.stat(installDir).catch(() => undefined)
        if (stats) {
          await fs.rm(installDir, { force: true, recursive: true })
        }

        await fs.mkdir(installDir, { recursive: true })

        if (ext === "zip") {
          const ok = await Archive.extractZip(tempPath, installDir)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract lua-language-server archive", { error })
              return false
            })
          if (!ok) return
        } else {
          const ok = await run(["tar", "-xzf", tempPath, "-C", installDir])
            .then((result) => result.code === 0)
            .catch((error: unknown) => {
              log.error("Failed to extract lua-language-server archive", { error })
              return false
            })
          if (!ok) return
        }

        await fs.rm(tempPath, { force: true })

        // Binary is located in bin/ subdirectory within the extracted archive
        bin = path.join(installDir, "bin", "lua-language-server" + (platform === "win32" ? ".exe" : ""))

        if (!(await Filesystem.exists(bin))) {
          log.error("Failed to extract lua-language-server binary")
          return
        }

        if (platform !== "win32") {
          const ok = await fs
            .chmod(bin, 0o755)
            .then(() => true)
            .catch((error: unknown) => {
              log.error("Failed to set executable permission for lua-language-server binary", {
                error,
              })
              return false
            })
          if (!ok) return
        }

        log.info(`installed lua-language-server`, { bin })
      }

      return {
        process: spawn(bin, {
          cwd: root,
        }),
      }
    },
  }

  export const PHPIntelephense: Info = {
    id: "php intelephense",
    extensions: [".php"],
    root: NearestRoot(["composer.json", "composer.lock", ".php-version"]),
    async spawn(root) {
      log.info("spawn php-intelephense", { root })
      let binary = which("intelephense")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "intelephense", "lib", "intelephense.js")
        if (!(await Filesystem.exists(js))) {
          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          await Process.spawn([BunProc.which(), "install", "intelephense"], {
            cwd: Global.Path.bin,
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "pipe",
          }).exited
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = spawn(binary, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })
      return {
        process: proc,
        initialization: {
          telemetry: {
            enabled: false,
          },
        },
      }
    },
  }

  export const Prisma: Info = {
    id: "prisma",
    extensions: [".prisma"],
    root: NearestRoot(["schema.prisma", "prisma/schema.prisma", "prisma"], ["package.json"]),
    async spawn(root) {
      log.info("spawn prisma", { root })
      const prisma = which("prisma")
      if (!prisma) {
        log.info("prisma not found, please install prisma")
        return
      }
      return {
        process: spawn(prisma, ["language-server"], {
          cwd: root,
        }),
      }
    },
  }

  export const Dart: Info = {
    id: "dart",
    extensions: [".dart"],
    root: NearestRoot(["pubspec.yaml", "analysis_options.yaml"]),
    async spawn(root) {
      log.info("spawn dart", { root })
      const dart = which("dart")
      if (!dart) {
        log.info("dart not found, please install dart first")
        return
      }
      return {
        process: spawn(dart, ["language-server", "--lsp"], {
          cwd: root,
        }),
      }
    },
  }

  export const Ocaml: Info = {
    id: "ocaml-lsp",
    extensions: [".ml", ".mli"],
    root: NearestRoot(["dune-project", "dune-workspace", ".merlin", "opam"]),
    async spawn(root) {
      log.info("spawn ocamllsp", { root })
      const bin = which("ocamllsp")
      if (!bin) {
        log.info("ocamllsp not found, please install ocaml-lsp-server")
        return
      }
      return {
        process: spawn(bin, {
          cwd: root,
        }),
      }
    },
  }
  export const BashLS: Info = {
    id: "bash",
    extensions: [".sh", ".bash", ".zsh", ".ksh"],
    root: async () => Instance.directory,
    async spawn(root) {
      log.info("spawn bash-ls", { root })
      let binary = which("bash-language-server")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "bash-language-server", "out", "cli.js")
        if (!(await Filesystem.exists(js))) {
          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          await Process.spawn([BunProc.which(), "install", "bash-language-server"], {
            cwd: Global.Path.bin,
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "pipe",
          }).exited
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("start")
      const proc = spawn(binary, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })
      return {
        process: proc,
      }
    },
  }

  export const TerraformLS: Info = {
    id: "terraform",
    extensions: [".tf", ".tfvars"],
    root: NearestRoot([".terraform.lock.hcl", "terraform.tfstate", "*.tf"]),
    async spawn(root) {
      log.info("spawn terraform-ls", { root })
      let bin = which("terraform-ls", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading terraform-ls from HashiCorp releases")

        const releaseResponse = await fetch("https://api.releases.hashicorp.com/v1/releases/terraform-ls/latest")
        if (!releaseResponse.ok) {
          log.error("Failed to fetch terraform-ls release info")
          return
        }

        const release = (await releaseResponse.json()) as {
          version?: string
          builds?: { arch?: string; os?: string; url?: string }[]
        }

        const platform = process.platform
        const arch = process.arch

        const tfArch = arch === "arm64" ? "arm64" : "amd64"
        const tfPlatform = platform === "win32" ? "windows" : platform

        const builds = release.builds ?? []
        const build = builds.find((b) => b.arch === tfArch && b.os === tfPlatform)
        if (!build?.url) {
          log.error(`Could not find build for ${tfPlatform}/${tfArch} terraform-ls release version ${release.version}`)
          return
        }

        const downloadResponse = await fetch(build.url)
        if (!downloadResponse.ok) {
          log.error("Failed to download terraform-ls")
          return
        }

        const tempPath = path.join(Global.Path.bin, "terraform-ls.zip")
        if (downloadResponse.body) await Filesystem.writeStream(tempPath, downloadResponse.body)

        const ok = await Archive.extractZip(tempPath, Global.Path.bin)
          .then(() => true)
          .catch((error) => {
            log.error("Failed to extract terraform-ls archive", { error })
            return false
          })
        if (!ok) return
        await fs.rm(tempPath, { force: true })

        bin = path.join(Global.Path.bin, "terraform-ls" + (platform === "win32" ? ".exe" : ""))

        if (!(await Filesystem.exists(bin))) {
          log.error("Failed to extract terraform-ls binary")
          return
        }

        if (platform !== "win32") {
          await fs.chmod(bin, 0o755).catch(() => {})
        }

        log.info(`installed terraform-ls`, { bin })
      }

      return {
        process: spawn(bin, ["serve"], {
          cwd: root,
        }),
        initialization: {
          experimentalFeatures: {
            prefillRequiredFields: true,
            validateOnSave: true,
          },
        },
      }
    },
  }

  export const TexLab: Info = {
    id: "texlab",
    extensions: [".tex", ".bib"],
    root: NearestRoot([".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"]),
    async spawn(root) {
      log.info("spawn texlab", { root })
      let bin = which("texlab", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading texlab from GitHub releases")

        const response = await fetch("https://api.github.com/repos/latex-lsp/texlab/releases/latest")
        if (!response.ok) {
          log.error("Failed to fetch texlab release info")
          return
        }

        const release = (await response.json()) as {
          tag_name?: string
          assets?: { name?: string; browser_download_url?: string }[]
        }
        const version = release.tag_name?.replace("v", "")
        if (!version) {
          log.error("texlab release did not include a version tag")
          return
        }

        const platform = process.platform
        const arch = process.arch

        const texArch = arch === "arm64" ? "aarch64" : "x86_64"
        const texPlatform = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux"
        const ext = platform === "win32" ? "zip" : "tar.gz"
        const assetName = `texlab-${texArch}-${texPlatform}.${ext}`

        const assets = release.assets ?? []
        const asset = assets.find((a) => a.name === assetName)
        if (!asset?.browser_download_url) {
          log.error(`Could not find asset ${assetName} in texlab release`)
          return
        }

        const downloadResponse = await fetch(asset.browser_download_url)
        if (!downloadResponse.ok) {
          log.error("Failed to download texlab")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        if (downloadResponse.body) await Filesystem.writeStream(tempPath, downloadResponse.body)

        if (ext === "zip") {
          const ok = await Archive.extractZip(tempPath, Global.Path.bin)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract texlab archive", { error })
              return false
            })
          if (!ok) return
        }
        if (ext === "tar.gz") {
          await run(["tar", "-xzf", tempPath], { cwd: Global.Path.bin })
        }

        await fs.rm(tempPath, { force: true })

        bin = path.join(Global.Path.bin, "texlab" + (platform === "win32" ? ".exe" : ""))

        if (!(await Filesystem.exists(bin))) {
          log.error("Failed to extract texlab binary")
          return
        }

        if (platform !== "win32") {
          await fs.chmod(bin, 0o755).catch(() => {})
        }

        log.info("installed texlab", { bin })
      }

      return {
        process: spawn(bin, {
          cwd: root,
        }),
      }
    },
  }

  export const DockerfileLS: Info = {
    id: "dockerfile",
    extensions: [".dockerfile", "Dockerfile"],
    root: async () => Instance.directory,
    async spawn(root) {
      log.info("spawn dockerfile-ls", { root })
      let binary = which("docker-langserver")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "dockerfile-language-server-nodejs", "lib", "server.js")
        if (!(await Filesystem.exists(js))) {
          if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
          await Process.spawn([BunProc.which(), "install", "dockerfile-language-server-nodejs"], {
            cwd: Global.Path.bin,
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "pipe",
          }).exited
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = spawn(binary, args, {
        cwd: root,
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
        },
      })
      return {
        process: proc,
      }
    },
  }

  export const Gleam: Info = {
    id: "gleam",
    extensions: [".gleam"],
    root: NearestRoot(["gleam.toml"]),
    async spawn(root) {
      log.info("spawn gleam", { root })
      const gleam = which("gleam")
      if (!gleam) {
        log.info("gleam not found, please install gleam first")
        return
      }
      return {
        process: spawn(gleam, ["lsp"], {
          cwd: root,
        }),
      }
    },
  }

  export const Clojure: Info = {
    id: "clojure-lsp",
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    root: NearestRoot(["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"]),
    async spawn(root) {
      log.info("spawn clojure-lsp", { root })
      let bin = which("clojure-lsp")
      if (!bin && process.platform === "win32") {
        bin = which("clojure-lsp.exe")
      }
      if (!bin) {
        log.info("clojure-lsp not found, please install clojure-lsp first")
        return
      }
      return {
        process: spawn(bin, ["listen"], {
          cwd: root,
        }),
      }
    },
  }

  export const Nixd: Info = {
    id: "nixd",
    extensions: [".nix"],
    root: async (file) => {
      // First, look for flake.nix - the most reliable Nix project root indicator
      const flakeRoot = await NearestRoot(["flake.nix"])(file)
      if (flakeRoot && flakeRoot !== Instance.directory) return flakeRoot

      // If no flake.nix, fall back to git repository root
      if (Instance.worktree && Instance.worktree !== Instance.directory) return Instance.worktree

      // Finally, use the instance directory as fallback
      return Instance.directory
    },
    async spawn(root) {
      log.info("spawn nixd", { root })
      const nixd = which("nixd")
      if (!nixd) {
        log.info("nixd not found, please install nixd first")
        return
      }
      return {
        process: spawn(nixd, [], {
          cwd: root,
          env: {
            ...process.env,
          },
        }),
      }
    },
  }

  export const Tinymist: Info = {
    id: "tinymist",
    extensions: [".typ", ".typc"],
    root: NearestRoot(["typst.toml"]),
    async spawn(root) {
      log.info("spawn tinymist", { root })
      let bin = which("tinymist", {
        PATH: process.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        if (Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading tinymist from GitHub releases")

        const response = await fetch("https://api.github.com/repos/Myriad-Dreamin/tinymist/releases/latest")
        if (!response.ok) {
          log.error("Failed to fetch tinymist release info")
          return
        }

        const release = (await response.json()) as {
          tag_name?: string
          assets?: { name?: string; browser_download_url?: string }[]
        }

        const platform = process.platform
        const arch = process.arch

        const tinymistArch = arch === "arm64" ? "aarch64" : "x86_64"
        let tinymistPlatform: string
        let ext: string

        if (platform === "darwin") {
          tinymistPlatform = "apple-darwin"
          ext = "tar.gz"
        } else if (platform === "win32") {
          tinymistPlatform = "pc-windows-msvc"
          ext = "zip"
        } else {
          tinymistPlatform = "unknown-linux-gnu"
          ext = "tar.gz"
        }

        const assetName = `tinymist-${tinymistArch}-${tinymistPlatform}.${ext}`

        const assets = release.assets ?? []
        const asset = assets.find((a) => a.name === assetName)
        if (!asset?.browser_download_url) {
          log.error(`Could not find asset ${assetName} in tinymist release`)
          return
        }

        const downloadResponse = await fetch(asset.browser_download_url)
        if (!downloadResponse.ok) {
          log.error("Failed to download tinymist")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        if (downloadResponse.body) await Filesystem.writeStream(tempPath, downloadResponse.body)

        if (ext === "zip") {
          const ok = await Archive.extractZip(tempPath, Global.Path.bin)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract tinymist archive", { error })
              return false
            })
          if (!ok) return
        } else {
          await run(["tar", "-xzf", tempPath, "--strip-components=1"], { cwd: Global.Path.bin })
        }

        await fs.rm(tempPath, { force: true })

        bin = path.join(Global.Path.bin, "tinymist" + (platform === "win32" ? ".exe" : ""))

        if (!(await Filesystem.exists(bin))) {
          log.error("Failed to extract tinymist binary")
          return
        }

        if (platform !== "win32") {
          await fs.chmod(bin, 0o755).catch(() => {})
        }

        log.info("installed tinymist", { bin })
      }

      return {
        process: spawn(bin, { cwd: root }),
      }
    },
  }

  export const HLS: Info = {
    id: "haskell-language-server",
    extensions: [".hs", ".lhs"],
    root: NearestRoot(["stack.yaml", "cabal.project", "hie.yaml", "*.cabal"]),
    async spawn(root) {
      log.info("spawn haskell-language-server", { root })
      const bin = which("haskell-language-server-wrapper")
      if (!bin) {
        log.info("haskell-language-server-wrapper not found, please install haskell-language-server")
        return
      }
      return {
        process: spawn(bin, ["--lsp"], {
          cwd: root,
        }),
      }
    },
  }

  export const JuliaLS: Info = {
    id: "julials",
    extensions: [".jl"],
    root: NearestRoot(["Project.toml", "Manifest.toml", "*.jl"]),
    async spawn(root) {
      const julia = which("julia")
      if (!julia) {
        log.info("julia not found, please install julia first (https://julialang.org/downloads/)")
        return
      }
      return {
        process: spawn(julia, ["--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"], {
          cwd: root,
        }),
      }
    },
  }
}
