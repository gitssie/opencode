import { pgTable, text, bigint } from "drizzle-orm/pg-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import { ProjectV2 } from "../project"
import { WorkspaceV2 } from "../workspace"

export const WorkspaceTable = pgTable("workspace", {
  id: text().$type<WorkspaceV2.ID>().primaryKey(),
  type: text().notNull(),
  name: text().notNull().default(""),
  branch: text(),
  directory: text(),
  extra: DatabasePath.jsonColumn<unknown>(),
  project_id: text()
    .$type<ProjectV2.ID>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  time_used: bigint({ mode: "number" })
    .notNull()
    .$default(() => Date.now()),
})
