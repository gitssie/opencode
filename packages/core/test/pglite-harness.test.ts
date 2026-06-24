import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { DatabaseTesting } from "../src/database/testing"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>, layer: Layer.Layer<Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E, never>)

test("PGlite harness provides a migrated, isolated Database.Service", async () => {
  const a = DatabaseTesting.layer.pipe(Layer.fresh)
  const b = DatabaseTesting.layer.pipe(Layer.fresh)

  await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.execute(
        sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('prj_a','/a','[]',0,0)`,
      )
      const rows = yield* db.execute<{ id: string }>(sql`SELECT id FROM project`)
      expect(rows).toEqual([{ id: "prj_a" }])
    }),
    a,
  )

  // A separately-built fresh layer is a clean, isolated database.
  await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = yield* db.execute<{ id: string }>(sql`SELECT id FROM project`)
      expect(rows).toEqual([])
    }),
    b,
  )
})
