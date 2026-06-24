export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzlePg } from "@opencode-ai/effect-drizzle-pg"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzlePg.EffectPgDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      // `to_regclass` resolves a table name to its OID (or NULL) without raising
      // when the table is absent — the postgres analog of probing sqlite_master.
      const [existing] = yield* db.execute<{ regclass: string | null }>(
        sql`SELECT to_regclass('public.session') AS regclass`,
      )
      if (existing?.regclass) return yield* applyOnly(db, migrations)

      const [{ count }] = yield* db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`,
      )
      if (count > 0) return yield* Effect.die("Database is not empty and has no session table")

      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.execute(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed BIGINT NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.execute(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.execute(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed BIGINT NOT NULL)`,
    )
    const completed = new Set(
      (yield* db.execute<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.execute(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
