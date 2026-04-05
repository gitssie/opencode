import z from "zod"
import { Tool } from "./tool"
import path from "path"
import { LSP } from "../lsp"
import DESCRIPTION from "./lsp.txt"
import { Instance } from "../project/instance"
import { pathToFileURL } from "url"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"

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

export const LspTool = Tool.define("lsp", {
  description: DESCRIPTION,
  parameters: z.object({
    operation: z.enum(operations).describe("The LSP operation to perform"),
    filePath: z.string().describe("The absolute or relative path to the file"),
    line: z.number().int().min(1).describe("The line number (1-based, as shown in editors)"),
    character: z.number().int().min(1).describe("The character offset (1-based, as shown in editors)"),
  }),
  execute: async (args, ctx) => {
    const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(Instance.directory, args.filePath)
    await assertExternalDirectory(ctx, file)

    await ctx.ask({
      permission: "lsp",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })
    const uri = pathToFileURL(file).href
    const position = {
      file,
      line: args.line - 1,
      character: args.character - 1,
    }

    const relPath = path.relative(Instance.worktree, file)
    const title = `${args.operation} ${relPath}:${args.line}:${args.character}`

    const exists = await Filesystem.exists(file)
    if (!exists) {
      throw new Error(`File not found: ${file}`)
    }

    const available = await LSP.hasClients(file)
    if (!available) {
      throw new Error("No LSP server available for this file type.")
    }

    await LSP.touchFile(file, true)

    const result = await (async (): Promise<unknown> => {
      switch (args.operation) {
        case "goToDefinition":
          return LSP.definition(position)
        case "findReferences":
          return LSP.references(position)
        case "hover":
          return LSP.hover(position)
        case "documentSymbol":
          return LSP.documentSymbol(uri)
        case "workspaceSymbol":
          return LSP.workspaceSymbol("")
        case "goToImplementation":
          return LSP.implementation(position)
        case "prepareCallHierarchy":
          return LSP.prepareCallHierarchy(position)
        case "incomingCalls":
          return LSP.incomingCalls(position)
        case "outgoingCalls":
          return LSP.outgoingCalls(position)
      }
    })()

    const output = (() => {
      if (Array.isArray(result) && result.length === 0) return `No results found for ${args.operation}`
      return JSON.stringify(result, null, 2)
    })()

    return {
      title,
      metadata: { result },
      output,
    }
  },
})

export const LspDiagnosticsTool = Tool.define("lsp_diagnostics", {
  description:
    "Get LSP diagnostics (errors and warnings) for a file. This tool checks the file for compilation errors, type errors, and other issues reported by the language server.",
  parameters: z.object({
    filePath: z.string().describe("The relative path to the file to check for diagnostics"),
  }),
  execute: async (args, ctx) => {
    const filepath = path.isAbsolute(args.filePath) ? args.filePath : path.join(Instance.directory, args.filePath)
    await assertExternalDirectory(ctx, filepath)

    await ctx.ask({
      permission: "lsp",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const exists = await Bun.file(filepath).exists()
    if (!exists) {
      throw new Error(`File not found: ${filepath}`)
    }

    const relPath = path.relative(Instance.worktree, filepath)
    const title = `diagnostics ${relPath}`

    //await LSP.touchFile(filepath, true, 5000)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilepath = Filesystem.normalizePath(filepath)

    let output = ""
    let projectDiagnosticsCount = 0

    for (const [file, issues] of Object.entries(diagnostics)) {
      const errors = issues.filter((item) => item.severity === 1)
      if (errors.length === 0) continue
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      if (file === normalizedFilepath) {
        output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filepath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
        continue
      }
      if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      projectDiagnosticsCount++
      output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    if (output === "") {
      output = "No LSP errors detected."
    }

    return {
      title,
      metadata: { diagnostics },
      output: output.trim(),
    }
  },
})

export const LspFindSymbolTool = Tool.define("lsp_find_symbol", {
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
        `List of LSP symbol kinds to include. Common: 5=class, 6=method, 12=function, 13=variable, 10=enum, 11=interface. Full list: 1=file, 2=module, 3=namespace, 4=package, 5=class, 6=method, 7=property, 8=field, 9=constructor, 10=enum, 11=interface, 12=function, 13=variable, 14=constant, 22=enum member, 23=struct. Empty = include all.`,
      ),
    exclude_kinds: z
      .array(z.number())
      .optional()
      .describe("Symbol kinds to exclude (takes precedence over include_kinds)"),
    max_answer_chars: z.number().optional().default(50000).describe("Max result size in characters (default 50000)"),
  }),
  execute: async (args, ctx) => {
    await ctx.ask({
      permission: "lsp",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const title = `find_symbol ${args.pattern}${args.search_in ? ` in ${args.search_in}` : ""}`

    const symbols = await LSP.searchSymbols({
      namePathRegex: args.pattern,
      relativePathRegex: args.search_in,
      includeBody: args.include_body,
      includeKinds: args.include_kinds,
      excludeKinds: args.exclude_kinds,
    })

    const prettyResult = await LSP.Format.pretty(symbols, {
      kind: true,
      location: true,
      includeBody: args.include_body,
      includeRelativePath: true,
      format: "xml",
    })

    let output = typeof prettyResult === "string" ? prettyResult : JSON.stringify(prettyResult, null, 2)

    // 限制输出长度
    const maxChars = args.max_answer_chars ?? 50000
    if (output.length > maxChars) {
      output = output.slice(0, maxChars) + "\n... (truncated)"
    }

    return {
      title,
      metadata: { count: symbols.length },
      output: symbols.length === 0 ? "No symbols found matching the pattern." : output,
    }
  },
})
