import { boolean, pgTable, text } from "drizzle-orm/pg-core"
import * as DatabasePath from "../database/path"
import { Timestamps } from "../database/schema.sql"
import type { IntegrationSchema } from "../integration/schema"
import type { Credential } from "../credential"

export const CredentialTable = pgTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<IntegrationSchema.ID>(),
  label: text().notNull(),
  value: DatabasePath.jsonColumn<Credential.Info>().notNull(),
  connector_id: text(),
  method_id: text(),
  active: boolean(),
  ...Timestamps,
})
