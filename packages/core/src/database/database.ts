export * as Database from "./database"

import { existsSync, readFileSync } from "fs"
import nodePath from "path"
import { EffectDrizzlePg } from "@opencode-ai/effect-drizzle-pg"
import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer, Redacted } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { DatabaseMigration } from "./migration"
import { LayerNode } from "../effect/layer-node"

const makeDatabase = EffectDrizzlePg.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    // Postgres needs no journal/synchronous/foreign-key PRAGMAs (those are sqlite-only).
    // Foreign keys are always enforced in postgres.
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

/**
 * Build the Database layer from a postgres connection URL.
 *
 * The URL is provided to `@effect/sql-pg`'s `PgClient.layer`, which yields both
 * `PgClient` and the generic `effect/unstable/sql/SqlClient` that the drizzle pg
 * adapter consumes.
 *
 * A failed `PgClient` connection (`SqlError`) is an unrecoverable startup fault,
 * so it is folded into a defect with `Layer.orDie` — the resulting layer has a
 * `never` error channel, matching how the rest of the app provides the database.
 */
export function layerFromUrl(url: string) {
  return layer.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })), Layer.orDie)
}

/**
 * Shape of the optional `db.json` config file in the data directory.
 *
 * Either a full `url`, or discrete connection fields. No hidden defaults: only
 * what is written here (or via env) takes effect.
 */
export interface DbConfig {
  readonly url?: string
  readonly host?: string
  readonly port?: number
  readonly database?: string
  readonly user?: string
  readonly password?: string
}

function dbConfigPath() {
  return nodePath.join(Global.Path.data, "db.json")
}

function readDbConfig(): DbConfig | undefined {
  const file = dbConfigPath()
  if (!existsSync(file)) return undefined
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as DbConfig
  return parsed
}

function urlFromDiscrete(config: DbConfig): string | undefined {
  if (!config.host) return undefined
  const auth = config.user
    ? `${encodeURIComponent(config.user)}${config.password ? `:${encodeURIComponent(config.password)}` : ""}@`
    : ""
  const port = config.port ? `:${config.port}` : ""
  const database = config.database ? `/${config.database}` : ""
  return `postgres://${auth}${config.host}${port}${database}`
}

/**
 * Resolve the postgres connection URL.
 *
 * Resolution order (no hidden defaults — fail loudly if nothing is configured):
 *   1. `OPENCODE_DB` env (a postgres connection URL)
 *   2. `db.json` in the data directory (`{ url }` or discrete `host`/`port`/...)
 *   3. `DATABASE_URL` env
 */
export function path() {
  if (Flag.OPENCODE_DB) return Flag.OPENCODE_DB

  const config = readDbConfig()
  if (config) {
    if (config.url) return config.url
    const url = urlFromDiscrete(config)
    if (url) return url
    throw new Error(
      `db.json at ${dbConfigPath()} must provide either "url" or a "host" (with optional port/database/user/password).`,
    )
  }

  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  throw new Error(
    "No postgres connection configured. Set OPENCODE_DB, create db.json in the data directory, or set DATABASE_URL.",
  )
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromUrl(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = LayerNode.make(
  Layer.unwrap(Effect.sync(() => layerFromUrl(path()))),
  [],
)
