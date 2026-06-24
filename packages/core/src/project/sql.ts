import { pgTable, text, bigint, primaryKey } from "drizzle-orm/pg-core"
import * as DatabasePath from "../database/path"
import { Timestamps } from "../database/schema.sql"
import { ProjectSchema } from "./schema"

export const ProjectTable = pgTable("project", {
  id: text().$type<ProjectSchema.ID>().primaryKey(),
  worktree: DatabasePath.absoluteColumn().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: bigint({ mode: "number" }),
  sandboxes: DatabasePath.absoluteArrayColumn().notNull(),
  commands: DatabasePath.jsonColumn<{ start?: string }>(),
})

export const ProjectDirectoryTable = pgTable(
  "project_directory",
  {
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: DatabasePath.absoluteColumn().notNull(),
    type: text().$type<"main" | "root" | "git_worktree">(),
    strategy: text(),
    time_created: bigint({ mode: "number" })
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.directory] })],
)
