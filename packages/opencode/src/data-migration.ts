import { Context, Effect, Layer } from "effect"
import { Database } from "./storage/db"
import { DataMigrationTable } from "./data-migration.sql"
import * as Log from "@opencode-ai/core/util/log"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { MessageTable, SessionTable } from "./session/session.sql"
import type { SessionID } from "./session/schema"

export type Migration<R = never> = {
  name: string
  run: Effect.Effect<void, unknown, R>
}

const log = Log.create({ service: "data-migration" })

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/DataMigration") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const migrations: Migration[] = [
      {
        name: "session_usage_from_messages",
        run: Effect.gen(function* () {
          type Usage = {
            cost: number
            tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
          }

          for (let cursor: SessionID | undefined, page = 1; ; page++) {
            const next = yield* Effect.gen(function* () {
              const sessions = yield* Effect.promise(() =>
                Database.use((db) =>
                  (db as any)
                    .select({ id: SessionTable.id })
                    .from(SessionTable)
                    .where(cursor ? gt(SessionTable.id, cursor) : undefined)
                    .orderBy(asc(SessionTable.id))
                    .limit(100),
                ),
              )
              if ((sessions as any[]).length === 0) return

              yield* Effect.promise(() =>
                Database.use((db) =>
                  (db as any).transaction(async (tx: any) => {
                    const rows = (sessions as any[])
                    const usageBySession = new Map<SessionID, Usage>(
                      rows.map((s: any) => [
                        s.id as SessionID,
                        { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
                      ]),
                    )

                    const aggRows: any[] = await tx
                      .select({
                        session_id: MessageTable.session_id,
                        // PostgreSQL jsonb operators: ->> extracts as text, cast to numeric
                        cost: sql<number>`coalesce(sum(coalesce((${MessageTable.data}->>'cost')::numeric, 0)), 0)`,
                        tokens_input: sql<number>`coalesce(sum(coalesce((${MessageTable.data}->'tokens'->>'input')::numeric, 0)), 0)`,
                        tokens_output: sql<number>`coalesce(sum(coalesce((${MessageTable.data}->'tokens'->>'output')::numeric, 0)), 0)`,
                        tokens_reasoning: sql<number>`coalesce(sum(coalesce((${MessageTable.data}->'tokens'->>'reasoning')::numeric, 0)), 0)`,
                        tokens_cache_read: sql<number>`coalesce(sum(coalesce((${MessageTable.data}->'tokens'->'cache'->>'read')::numeric, 0)), 0)`,
                        tokens_cache_write: sql<number>`coalesce(sum(coalesce((${MessageTable.data}->'tokens'->'cache'->>'write')::numeric, 0)), 0)`,
                      })
                      .from(MessageTable)
                      .where(
                        and(
                          inArray(
                            MessageTable.session_id,
                            rows.map((s: any) => s.id),
                          ),
                          // PostgreSQL jsonb: ->> returns text
                          sql`${MessageTable.data}->>'role' = 'assistant'`,
                        ),
                      )
                      .groupBy(MessageTable.session_id)

                    for (const row of aggRows) {
                      const current = usageBySession.get(row.session_id)
                      if (!current) continue
                      current.cost = Number(row.cost)
                      current.tokens.input = Number(row.tokens_input)
                      current.tokens.output = Number(row.tokens_output)
                      current.tokens.reasoning = Number(row.tokens_reasoning)
                      current.tokens.cache.read = Number(row.tokens_cache_read)
                      current.tokens.cache.write = Number(row.tokens_cache_write)
                    }

                    for (const [sessionID, value] of usageBySession) {
                      await tx
                        .update(SessionTable)
                        .set({
                          cost: value.cost,
                          tokens_input: value.tokens.input,
                          tokens_output: value.tokens.output,
                          tokens_reasoning: value.tokens.reasoning,
                          tokens_cache_read: value.tokens.cache.read,
                          tokens_cache_write: value.tokens.cache.write,
                          time_updated: sql`${SessionTable.time_updated}`,
                        })
                        .where(eq(SessionTable.id, sessionID))
                    }
                  }),
                ),
              )

              return (sessions as any[]).at(-1)?.id as SessionID | undefined
            }).pipe(
              Effect.withSpan("DataMigration.sessionUsage.page", {
                attributes: {
                  "data_migration.name": "session_usage_from_messages",
                  "data_migration.page": page,
                  "data_migration.cursor": cursor ?? "",
                },
              }),
            )
            if (!next) return
            cursor = next
            yield* Effect.sleep("10 millis")
          }
        }),
      },
    ]

    yield* Effect.gen(function* () {
      if (migrations.length === 0) return

      for (const migration of migrations) {
        const rows: any[] = yield* Effect.promise(() =>
          Database.use((db) =>
            (db as any)
              .select({ name: DataMigrationTable.name })
              .from(DataMigrationTable)
              .where(eq(DataMigrationTable.name, migration.name)),
          ),
        )
        if (rows.length > 0) continue

        log.info("running data migration", { name: migration.name })
        yield* migration.run.pipe(Effect.withSpan("DataMigration", { attributes: { name: migration.name } }))
        yield* Effect.promise(() =>
          Database.use((db) =>
            (db as any)
              .insert(DataMigrationTable)
              .values({ name: migration.name, time_completed: Date.now() })
              .onConflictDoNothing(),
          ),
        )
      }
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("failed to run data migrations").pipe(Effect.annotateLogs("cause", cause)),
      ),
      Effect.ignore,
      Effect.forkScoped,
    )
    return Service.of({})
  }),
)

export const defaultLayer = layer

export * as DataMigration from "./data-migration"
