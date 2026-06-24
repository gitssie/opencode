export * as Database from "./database"

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
 */
export function layerFromUrl(url: string) {
  return layer.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })))
}

/**
 * @deprecated Postgres has no on-disk file path. This now accepts a postgres
 * connection URL and is kept only so existing call sites resolve while Phase B4
 * migrates them to PGlite-backed test layers. Prefer {@link layerFromUrl}.
 */
export const layerFromPath = layerFromUrl

/**
 * Resolve the postgres connection URL.
 *
 * `OPENCODE_DB` is a postgres connection URL (no longer a file path). When unset,
 * fall back to the standard `DATABASE_URL`. There is intentionally no hardcoded
 * default so the active connection is always explicit in configuration.
 */
export function path() {
  const url = Flag.OPENCODE_DB ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "No postgres connection URL configured. Set OPENCODE_DB (or DATABASE_URL) to a postgres connection string.",
    )
  }
  return url
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
