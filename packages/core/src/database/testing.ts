export * as DatabaseTesting from "./testing"

import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer } from "effect"
import { layer as databaseLayer } from "./database"

/**
 * Test-only PGlite client layer (the embedded-postgres analog of sqlite
 * `:memory:`). Each built layer owns a fresh in-memory PGlite instance exposed
 * over an ephemeral loopback PG-wire server, so node-postgres (which backs
 * `@effect/sql-pg`'s `PgClient`) connects exactly as it would to production
 * postgres. The instance and server are torn down when the layer's scope closes,
 * giving per-layer isolation.
 *
 * Use `Layer.fresh` at a call site to force a brand-new database for that test.
 */
const pgliteClient = Effect.gen(function* () {
  const pglite = yield* Effect.acquireRelease(
    Effect.promise(() => PGlite.create()),
    (db) => Effect.promise(() => db.close()),
  )
  const server = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      // Allow concurrent connections so the node-postgres pool (and nested
      // transactions, which reserve a separate connection) can operate.
      const s = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0, maxConnections: 20 })
      await s.start()
      return s
    }),
    (s) => Effect.promise(() => s.stop()),
  )

  // `getServerConn()` reports the actual bound port even when started with port 0.
  const [host, portText] = server.getServerConn().split(":")
  const port = Number(portText)
  return { host, port }
})

const pgliteClientLayer = Layer.unwrap(
  pgliteClient.pipe(
    Effect.map(({ host, port }) =>
      PgClient.layer({ host, port, database: "postgres", username: "postgres" }),
    ),
  ),
)

/**
 * A fully-wired `Database.Service` layer backed by an ephemeral PGlite instance,
 * with the squashed baseline migration already applied (via `Database.layer`).
 *
 * The `PgClient` connection errors (`SqlError`) are folded into defects with
 * `Layer.orDie` so test call sites can provide this layer without threading an
 * error channel — matching how the old sqlite `:memory:` layer behaved.
 */
export const layer = databaseLayer.pipe(Layer.provide(pgliteClientLayer), Layer.orDie)

/**
 * Boot a long-lived shared PGlite instance and return a postgres connection URL
 * pointing at it. Intended for test preloads to set `OPENCODE_DB` so that any
 * `*.defaultLayer` (which resolves the connection via `Database.path()`) works
 * during tests — the embedded-postgres analog of the old shared sqlite `:memory:`
 * default.
 *
 * The old sqlite default rebuilt a fresh `:memory:` database for every test, so
 * shared-default state never leaked between tests. A single PGlite instance is
 * long-lived, so `reset()` truncates every base table between tests to reproduce
 * that clean-slate behavior. Returns `dispose` to tear the server down after the run.
 */
export async function startSharedPglite(): Promise<{
  url: string
  reset: () => Promise<void>
  dispose: () => Promise<void>
}> {
  const pglite = await PGlite.create()
  const server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0, maxConnections: 20 })
  await server.start()
  const [host, portText] = server.getServerConn().split(":")
  const url = `postgres://postgres@${host}:${portText}/postgres`
  return {
    url,
    reset: async () => {
      const result = await pglite.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      )
      if (result.rows.length === 0) return
      const list = result.rows.map((r) => `"${r.tablename}"`).join(", ")
      await pglite.exec(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
    },
    dispose: async () => {
      await server.stop()
      await pglite.close()
    },
  }
}
