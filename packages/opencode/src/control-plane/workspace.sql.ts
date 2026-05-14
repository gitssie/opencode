import { pgTable, text, bigint, jsonb } from "drizzle-orm/pg-core"
import { ProjectTable } from "../project/project.sql"
import type { ProjectID } from "../project/schema"
import type { WorkspaceID } from "./schema"

export const WorkspaceTable = pgTable("workspace", {
  id: text().$type<WorkspaceID>().primaryKey(),
  type: text().notNull(),
  name: text().notNull().default(""),
  branch: text(),
  directory: text(),
  extra: jsonb(),
  project_id: text()
    .$type<ProjectID>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  time_used: bigint({ mode: "number" })
    .notNull()
    .$default(() => Date.now()),
})
