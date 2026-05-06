import { LSP } from "@/lsp/lsp"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import * as Log from "@opencode-ai/core/util/log"
import { EOL } from "os"
import { pathToFileURL } from "url"
import type { LSPClient } from "@/lsp/client"
import path from "path"

export const LSPCommand = cmd({
  command: "lsp",
  describe: "LSP debugging utilities",
  builder: (yargs) =>
    yargs
      .command(DiagnosticsCommand)
      .command(SymbolsCommand)
      .command(DocumentSymbolsCommand)
      .command(BuildIndexCommand)
      .command(SearchSymbolsCommand)
      .demandCommand(),
  async handler() {},
})

const DiagnosticsCommand = effectCmd({
  command: "diagnostics <file>",
  describe: "get diagnostics for a file",
  builder: (yargs) => yargs.positional("file", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.debug.lsp.diagnostics")(function* (args) {
    const file = path.isAbsolute(args.file) ? args.file : path.resolve(process.cwd(), args.file)
    const out = yield* LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        yield* lsp.touchFile(file, "full")
        return yield* lsp.diagnostics()
      }),
    )
    process.stdout.write(JSON.stringify(out, null, 2) + EOL)
  }),
})

export const SymbolsCommand = effectCmd({
  command: "symbols <query>",
  describe: "search workspace symbols",
  builder: (yargs) => yargs.positional("query", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.debug.lsp.symbols")(function* (args) {
    using _ = Log.Default.time("symbols")
    const results = yield* LSP.Service.use((lsp) => lsp.workspaceSymbol(args.query))
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  }),
})

export const DocumentSymbolsCommand = effectCmd({
  command: "document-symbols <file>",
  describe: "get symbols from a document",
  builder: (yargs) => yargs.positional("file", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.debug.lsp.documentSymbols")(function* (args) {
    using _ = Log.Default.time("document-symbols")
    const file = path.isAbsolute(args.file) ? args.file : path.resolve(process.cwd(), args.file)
    const results = yield* LSP.Service.use((lsp) => lsp.documentSymbol(pathToFileURL(file).href))
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  }),
})

const BuildIndexCommand = effectCmd({
  command: "build-index",
  describe: "rebuild symbol index for the workspace",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.lsp.buildIndex")(function* () {
    using _ = Log.Default.time("build-index")
    yield* LSP.Service.use((lsp) => lsp.rebuildIndex(true))
    process.stdout.write("Symbol index rebuilt successfully" + EOL)
  }),
})

const SearchSymbolsCommand = effectCmd({
  command: "search-symbols <pattern>",
  describe: "search symbols in the index by name path regex",
  builder: (yargs) =>
    yargs
      .positional("pattern", { type: "string", demandOption: true, describe: "name path regex pattern" })
      .option("search-in", { type: "string", describe: "file path regex filter" })
      .option("include-body", { type: "boolean", default: false, describe: "include symbol body" })
      .option("include-kinds", { type: "array", describe: "symbol kinds to include" })
      .option("exclude-kinds", { type: "array", describe: "symbol kinds to exclude" }),
  handler: Effect.fn("Cli.debug.lsp.searchSymbols")(function* (args) {
    using _ = Log.Default.time("search-symbols")
    const results = yield* LSP.Service.use((lsp) =>
      lsp.searchSymbols({
        namePathRegex: args.pattern,
        relativePathRegex: args["search-in"],
        includeBody: args["include-body"],
        includeKinds: args["include-kinds"]?.map(Number),
        excludeKinds: args["exclude-kinds"]?.map(Number),
      }),
    )
    const prettyResults = yield* Effect.promise(() =>
      LSP.Format.pretty(results as LSPClient.DocumentSymbol[], {
        kind: true,
        location: true,
        includeBody: args["include-body"],
        includeRelativePath: true,
        format: "xml",
      }),
    )
    process.stdout.write(prettyResults + EOL)
  }),
})
