import { pgTable, text, bigint, index, uniqueIndex } from "drizzle-orm/pg-core"
import * as DatabasePath from "../database/path"
import type { EventV2 } from "../event"

export const EventSequenceTable = pgTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: bigint({ mode: "number" }).notNull(),
  owner_id: text(),
})

export const EventTable = pgTable(
  "event",
  {
    id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: bigint({ mode: "number" }).notNull(),
    type: text().notNull(),
    data: DatabasePath.jsonColumn<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
  ],
)
