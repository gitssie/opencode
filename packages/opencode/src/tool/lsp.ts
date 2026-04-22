import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "../lsp"
import DESCRIPTION from "./lsp.txt"
import { Instance } from "../project/instance"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        operation: z.enum(operations).describe("The LSP operation to perform"),
        filePath: z.string().describe("The absolute or relative path to the file"),
        line: z.number().int().min(1).describe("The line number (1-based, as shown in editors)"),
        character: z.number().int().min(1).describe("The character offset (1-based, as shown in editors)"),
      }),
      execute: (
        args: { operation: (typeof operations)[number]; filePath: string; line: number; character: number },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(Instance.directory, args.filePath)
          yield* assertExternalDirectoryEffect(ctx, file)
          yield* ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })

          const uri = pathToFileURL(file).href
          const position = { file, line: args.line - 1, character: args.character - 1 }
          const relPath = path.relative(Instance.worktree, file)
          const title = `${args.operation} ${relPath}:${args.line}:${args.character}`

          const exists = yield* fs.existsSafe(file)
          if (!exists) throw new Error(`File not found: ${file}`)

          const available = yield* lsp.hasClients(file)
          if (!available) throw new Error("No LSP server available for this file type.")

          yield* lsp.touchFile(file, true)

          const result: unknown = yield* (() => {
            switch (args.operation) {
              case "goToDefinition":
                return lsp.definition(position)
              case "findReferences":
                return lsp.references(position)
              case "hover":
                return lsp.hover(position)
              case "documentSymbol":
                return lsp.documentSymbol(uri)
              case "workspaceSymbol":
                return lsp.workspaceSymbol("")
              case "goToImplementation":
                return lsp.implementation(position)
              case "prepareCallHierarchy":
                return lsp.prepareCallHierarchy(position)
              case "incomingCalls":
                return lsp.incomingCalls(position)
              case "outgoingCalls":
                return lsp.outgoingCalls(position)
            }
          })()

          return {
            title,
            metadata: { result },
            output:
              Array.isArray(result) && result.length === 0
                ? `No results found for ${args.operation}`
                : JSON.stringify(result, null, 2),
          }
        }),
    }
  }),
)

export const LspDiagnosticsTool = Tool.define(
  "lsp_diagnostics",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service

    return {
      description:
        "Get LSP diagnostics (errors and warnings) for a file. This tool checks the file for compilation errors, type errors, and other issues reported by the language server.",
      parameters: z.object({
        filePath: z.string().describe("The relative path to the file to check for diagnostics"),
      }),
      execute: (args: { filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const filepath = path.isAbsolute(args.filePath) ? args.filePath : path.join(Instance.directory, args.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)
          yield* ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })

          const exists = yield* Effect.promise(() => Bun.file(filepath).exists())
          if (!exists) throw new Error(`File not found: ${filepath}`)

          const relPath = path.relative(Instance.worktree, filepath)
          const title = `diagnostics ${relPath}`
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)

          let output = ""
          let projectDiagnosticsCount = 0

          for (const [file, issues] of Object.entries(diagnostics)) {
            const errors = issues.filter((item) => item.severity === 1)
            if (errors.length === 0) continue
            const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
            const suffix =
              errors.length > MAX_DIAGNOSTICS_PER_FILE
                ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more`
                : ""
            if (file === normalizedFilepath) {
              output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filepath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
              continue
            }
            if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
          }

          return {
            title,
            metadata: { diagnostics },
            output: output === "" ? "No LSP errors detected." : output.trim(),
          }
        }),
    }
  }),
)

export const LspFindSymbolTool = Tool.define(
  "lsp_find_symbol",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service

    return {
      description:
        "Search for symbols (classes, functions, methods, variables) using regex patterns. Returns matched symbols with their locations. Use pattern to match symbol name paths like 'MyClass/myMethod'.",
      parameters: z.object({
        pattern: z.string().describe("Regular expression to match symbol name paths (what to search for)"),
        search_in: z
          .string()
          .optional()
          .describe("Where to search (file path, directory, or regex). Empty = search everywhere."),
        include_body: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include symbol source code in results (use carefully, increases size)"),
        include_kinds: z
          .array(z.number())
          .optional()
          .describe(
            "List of LSP symbol kinds to include. Common: 5=class, 6=method, 12=function, 13=variable, 10=enum, 11=interface. Full list: 1=file, 2=module, 3=namespace, 4=package, 5=class, 6=method, 7=property, 8=field, 9=constructor, 10=enum, 11=interface, 12=function, 13=variable, 14=constant, 22=enum member, 23=struct. Empty = include all.",
          ),
        exclude_kinds: z
          .array(z.number())
          .optional()
          .describe("Symbol kinds to exclude (takes precedence over include_kinds)"),
        max_answer_chars: z
          .number()
          .optional()
          .default(50000)
          .describe("Max result size in characters (default 50000)"),
      }),
      execute: (
        args: {
          pattern: string
          search_in?: string
          include_body?: boolean
          include_kinds?: number[]
          exclude_kinds?: number[]
          max_answer_chars?: number
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })

          const title = `find_symbol ${args.pattern}${args.search_in ? ` in ${args.search_in}` : ""}`
          const symbols = yield* lsp.searchSymbols({
            namePathRegex: args.pattern,
            relativePathRegex: args.search_in,
            includeBody: args.include_body,
            includeKinds: args.include_kinds,
            excludeKinds: args.exclude_kinds,
          })

          const prettyResult = yield* Effect.promise(() =>
            LSP.Format.pretty(symbols, {
              kind: true,
              location: true,
              includeBody: args.include_body,
              includeRelativePath: true,
              format: "xml",
            }),
          )

          let output = typeof prettyResult === "string" ? prettyResult : JSON.stringify(prettyResult, null, 2)
          const maxChars = args.max_answer_chars ?? 50000
          if (output.length > maxChars) output = output.slice(0, maxChars) + "\n... (truncated)"

          return {
            title,
            metadata: { count: symbols.length },
            output: symbols.length === 0 ? "No symbols found matching the pattern." : output,
          }
        }),
    }
  }),
)
