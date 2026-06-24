import { PgClient } from "@effect/sql-pg"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Redacted } from "effect"
import { disposeAllInstances } from "./fixture"

/**
 * Reset the shared test database to a clean state between tests.
 *
 * The old sqlite fixture deleted the database file. On postgres (embedded PGlite)
 * we instead TRUNCATE every base table in the `public` schema, which clears all
 * rows (and resets identity sequences) while preserving the migrated schema —
 * far cheaper than dropping and re-migrating.
 */
export async function resetDatabase() {
  await disposeAllInstances().catch(() => undefined)
  const url = Database.path()
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient
      const tables = yield* client<{ tablename: string }>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `
      if (tables.length === 0) return
      const list = tables.map((t) => `"${t.tablename}"`).join(", ")
      yield* client.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
    }).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(url) })),
      Effect.scoped,
      Effect.catch(() => Effect.void),
    ),
  )
}
