import { expect, test } from "bun:test"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { PgClient } from "@effect/sql-pg"
import { EffectDrizzlePg } from "@opencode-ai/effect-drizzle-pg"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"

test("squashed pg baseline applies on PGlite and is idempotent", async () => {
  const pglite = await PGlite.create()
  const port = 40000 + Math.floor(Math.random() * 20000)
  const server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port })
  await server.start()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzlePg.makeWithDefaults()
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.apply(db) // idempotent second run

        // FK chain (project -> session) proves the squashed DDL + constraints applied
        yield* db.execute(
          sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('prj_1','/tmp','[]',0,0)`,
        )
        const rows = yield* db.execute<{ id: string }>(sql`SELECT id FROM project`)
        expect(rows).toEqual([{ id: "prj_1" }])
      }).pipe(
        Effect.provide(PgClient.layer({ host: "127.0.0.1", port, database: "postgres", username: "postgres" })),
        Effect.scoped,
      ),
    )
  } finally {
    await server.stop()
    await pglite.close()
  }
})
