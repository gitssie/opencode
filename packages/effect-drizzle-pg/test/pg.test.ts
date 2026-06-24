import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { PgClient } from "@effect/sql-pg"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { eq, sql } from "drizzle-orm"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { EffectDrizzlePg } from "../src"

// One pgTable for the spike (the whole point: prove a real Drizzle pg schema works).
const users = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
})

// PGlite exposed over a real PG-wire TCP server so node-postgres (`pg`, which backs
// @effect/sql-pg's PgClient) can connect to it exactly as it would to production Postgres.
let pglite: PGlite
let server: PGLiteSocketServer
let port: number

const pickPort = () => 30000 + Math.floor(Math.random() * 20000)

beforeAll(async () => {
  pglite = await PGlite.create()
  port = pickPort()
  server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port })
  await server.start()
})

afterAll(async () => {
  await server.stop()
  await pglite.close()
})

// Build the SAME PgClient layer that production (Phase B1) will use, only pointed at
// the embedded PGlite server instead of a real DATABASE_URL.
const clientLayer = () =>
  PgClient.layer({
    host: "127.0.0.1",
    port,
    database: "postgres",
    username: "postgres",
  })

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService | PgClient.PgClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(clientLayer()), Effect.scoped) as Effect.Effect<A, E, never>)

const createMigrationsFolder = async () => {
  const migrationsFolder = await mkdtemp(join(tmpdir(), "effect-drizzle-pg-"))
  await mkdir(join(migrationsFolder, "20240101000000_create_migrated_users"), { recursive: true })
  await Bun.write(
    join(migrationsFolder, "20240101000000_create_migrated_users", "migration.sql"),
    "create table migrated_users (id integer generated always as identity primary key, name text not null);",
  )
  return migrationsFolder
}

test("runs a migration then inserts and selects through Drizzle Effect query builders", async () => {
  const migrationsFolder = await createMigrationsFolder()
  try {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzlePg.makeWithDefaults()

        yield* EffectDrizzlePg.migrate(db, { migrationsFolder })
        // idempotent: running twice must not re-apply
        yield* EffectDrizzlePg.migrate(db, { migrationsFolder })

        // raw migrated table works
        yield* db.execute(sql`insert into migrated_users (name) values ('Margaret')`)
        expect(yield* db.execute(sql`select name from migrated_users`)).toEqual([{ name: "Margaret" }])

        // migration recorded exactly once despite migrate() being called twice (idempotent)
        expect(
          yield* db.execute(sql`select name from drizzle.__drizzle_migrations order by id`),
        ).toEqual([{ name: "20240101000000_create_migrated_users" }])

        // and the typed pgTable round-trips via the Effect query builders
        yield* db.execute(sql`create table users (id integer generated always as identity primary key, name text not null)`)
        const inserted = yield* db.insert(users).values({ name: "Ada" }).returning({ id: users.id, name: users.name })
        expect(inserted).toEqual([{ id: 1, name: "Ada" }])

        expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "Ada" }])
        expect(yield* db.select({ id: users.id }).from(users).where(eq(users.name, "Ada"))).toEqual([{ id: 1 }])
      }),
    )
  } finally {
    await rm(migrationsFolder, { recursive: true, force: true })
  }
})
