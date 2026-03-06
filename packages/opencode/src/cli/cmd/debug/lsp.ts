import { LSP } from "../../../lsp"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"
import { Log } from "../../../util/log"
import { EOL } from "os"
import { setTimeout as sleep } from "node:timers/promises"

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

const DiagnosticsCommand = cmd({
  command: "diagnostics <file>",
  describe: "get diagnostics for a file",
  builder: (yargs) => yargs.positional("file", { type: "string", demandOption: true }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      await LSP.touchFile(args.file, true)
      await sleep(1000)
      process.stdout.write(JSON.stringify(await LSP.diagnostics(), null, 2) + EOL)
    })
  },
})

export const SymbolsCommand = cmd({
  command: "symbols <query>",
  describe: "search workspace symbols",
  builder: (yargs) => yargs.positional("query", { type: "string", demandOption: true }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      using _ = Log.Default.time("symbols")
      const results = await LSP.workspaceSymbol(args.query)
      process.stdout.write(JSON.stringify(results, null, 2) + EOL)
    })
  },
})

export const DocumentSymbolsCommand = cmd({
  command: "document-symbols <file>",
  describe: "get symbols from a document",
  builder: (yargs) => yargs.positional("file", { type: "string", demandOption: true }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      using _ = Log.Default.time("document-symbols")
      const results = await LSP.withFile({ path: args.file }, () => LSP.documentSymbol(args.file))
      process.stdout.write(JSON.stringify(results, null, 2) + EOL)
    })
  },
})

const BuildIndexCommand = cmd({
  command: "build-index",
  describe: "rebuild symbol index for the workspace",
  builder: (yargs) => yargs,
  async handler() {
    await bootstrap(process.cwd(), async () => {
      using _ = Log.Default.time("build-index")
      await LSP.rebuildIndex(true)
      process.stdout.write("Symbol index rebuilt successfully" + EOL)
    })
  },
})

const SearchSymbolsCommand = cmd({
  command: "search-symbols <pattern>",
  describe: "search symbols in the index by name path regex",
  builder: (yargs) =>
    yargs
      .positional("pattern", { type: "string", demandOption: true, describe: "name path regex pattern" })
      .option("search-in", { type: "string", describe: "file path regex filter" })
      .option("include-body", { type: "boolean", default: false, describe: "include symbol body" })
      .option("include-kinds", { type: "array", describe: "symbol kinds to include" })
      .option("exclude-kinds", { type: "array", describe: "symbol kinds to exclude" }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      using _ = Log.Default.time("search-symbols")
      const results = await LSP.searchSymbols({
        namePathRegex: args.pattern,
        relativePathRegex: args["search-in"],
        includeBody: args["include-body"],
        includeKinds: args["include-kinds"]?.map(Number),
        excludeKinds: args["exclude-kinds"]?.map(Number),
      })
      const prettyResults = await LSP.pretty(results, {
        kind: true,
        location: true,
        includeBody: args["include-body"],
        includeRelativePath: true,
        format: "xml",
      })
      process.stdout.write(prettyResults + EOL)
    })
  },
})
