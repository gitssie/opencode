/* oxlint-disable */
// Thin re-export of Drizzle's published Effect Postgres adapter.
//
// Unlike the SQLite sibling package (which had to vendor `sqlite-core/effect/*`
// because drizzle-orm@1.0.0-rc.2 does not publish those internals), the Postgres
// adapter IS shipped by drizzle as `drizzle-orm/effect-postgres` plus the full
// `drizzle-orm/pg-core/effect` query-builder machinery. We re-export it directly
// and only mirror the package surface so callers can swap engines by changing the
// import path (`@opencode-ai/effect-drizzle-sqlite` -> `@opencode-ai/effect-drizzle-pg`).
//
// The underlying `SqlClient` is `@effect/sql-pg`'s `PgClient`, which extends the
// generic `effect/unstable/sql/SqlClient` (the same interface consumed in
// packages/core/src/database/sqlite.bun.ts).
export {
  DefaultServices,
  type EffectDrizzlePgConfig,
  EffectLogger,
  EffectPgDatabase,
  EffectPgSession,
  EffectPgTransaction,
  type EffectPgQueryEffectHKT,
  type EffectPgQueryResultHKT,
  type EffectPgSessionOptions,
  effectPgCodecs,
  make,
  makeWithDefaults,
} from "drizzle-orm/effect-postgres"
