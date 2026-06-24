# Effect Drizzle Postgres

This package exposes a Drizzle Effect Postgres adapter for this repo. It is the
Postgres analog of `@opencode-ai/effect-drizzle-sqlite`.

- Keep this package generic: Drizzle + Effect + Postgres only.
- Do not add opencode-specific tables, paths, migrations, post-commit hooks, or domain storage APIs here.
- Unlike the SQLite sibling, this package does NOT vendor Drizzle internals.
  `drizzle-orm@1.0.0-rc.2` publishes the full Effect Postgres adapter as
  `drizzle-orm/effect-postgres` (driver/session/migrator/codecs) plus
  `drizzle-orm/pg-core/effect` query builders. We re-export those directly and
  only mirror the package surface so callers can swap engines by import path.
- The concrete client is `@effect/sql-pg`'s `PgClient`, which extends the generic
  `effect/unstable/sql/SqlClient` consumed in `packages/core/src/database/sqlite.bun.ts`.
  `PgClient` is backed by node-postgres (`pg`); there is no postgres-js Effect 4 client.
- Concrete client wiring (`@effect/sql-pg`, PGlite) belongs in tests/examples and in
  `packages/core/src/database`, not in this generic package.
- If touching Drizzle internals' types, compare with current `drizzle-orm@1.0.0-rc.2` declarations.

Useful entry points:

- `src/effect-postgres/index.ts`: re-exports drizzle's `make` / `makeWithDefaults` /
  `DefaultServices` / `EffectPgDatabase`.
- `src/effect-postgres/migrator.ts`: re-exports drizzle's Effect Postgres `migrate`.
- `test/pg.test.ts`: spike proving a `PgClient` backed by PGlite (via `pglite-socket`)
  can run a migration + insert/select through the Drizzle Effect query builders.

## Client construction (for `packages/core/src/database`, Phase B1)

Production (from a connection URL):

```ts
import { PgClient } from "@effect/sql-pg"
import { Redacted } from "effect"

const layer = PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) })
// layer provides BOTH `PgClient | SqlClient`
```

Tests (PGlite over a unix-socket PG-wire server):

```ts
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { PgClient } from "@effect/sql-pg"

const db = await PGlite.create()
const server = new PGLiteSocketServer({ db, path: "/tmp/pglite.sock" })
await server.start()
const layer = PgClient.layer({ host: "/tmp/pglite.sock" }) // pg connects via unix socket
```
