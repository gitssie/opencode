import type { Argv } from "yargs"
import { Database } from "@/storage/db"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { JsonMigration } from "@/storage/json-migration"
import { EOL } from "os"
import { errorMessage } from "../../util/error"

const QueryCommand = cmd({
  command: "$0 [query]",
  describe: "run a SQL query against the PostgreSQL database",
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: async (args: { query?: string; format: string }) => {
    const query = args.query
    if (!query) {
      UI.error("A SQL query is required. Interactive psql shell: psql \"$OPENCODE_DB_URL\"")
      process.exit(1)
    }
    try {
      const db = Database.Client()
      const result = await (db as any).execute(query)
      const rows: Record<string, unknown>[] = result.rows ?? result
      if (args.format === "json") {
        console.log(JSON.stringify(rows, null, 2))
      } else if (rows.length > 0) {
        const keys = Object.keys(rows[0])
        console.log(keys.join("\t"))
        for (const row of rows) {
          console.log(keys.map((k) => row[k]).join("\t"))
        }
      }
    } catch (err) {
      UI.error(errorMessage(err))
      process.exit(1)
    }
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print the database connection URL (redacted)",
  handler: () => {
    try {
      const url = new URL(Database.Path)
      if (url.password) url.password = "***"
      console.log(url.toString())
    } catch {
      console.log(Database.Path)
    }
  },
})

const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate JSON data to PostgreSQL (merges with existing data)",
  handler: async () => {
    const tty = process.stderr.isTTY
    const width = 36
    const orange = "\x1b[38;5;214m"
    const muted = "\x1b[0;2m"
    const reset = "\x1b[0m"
    let last = -1
    if (tty) process.stderr.write("\x1b[?25l")
    try {
      const stats = await JsonMigration.run(Database.Client() as any, {
        progress: (event) => {
          const percent = Math.floor((event.current / event.total) * 100)
          if (percent === last) return
          last = percent
          if (tty) {
            const fill = Math.round((percent / 100) * width)
            const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
            process.stderr.write(
              `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.current}/${event.total}${reset} `,
            )
          } else {
            process.stderr.write(`pg-migration:${percent}${EOL}`)
          }
        },
      })
      if (tty) process.stderr.write("\n")
      if (tty) process.stderr.write("\x1b[?25h")
      else process.stderr.write(`pg-migration:done${EOL}`)
      UI.println(
        `Migration complete: ${stats.projects} projects, ${stats.sessions} sessions, ${stats.messages} messages`,
      )
      if (stats.errors.length > 0) {
        UI.println(`${stats.errors.length} errors occurred during migration`)
      }
    } catch (err) {
      if (tty) process.stderr.write("\x1b[?25h")
      UI.error(`Migration failed: ${errorMessage(err)}`)
      process.exit(1)
    }
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(MigrateCommand).demandCommand()
  },
  handler: () => {},
})
