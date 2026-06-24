import type { DatabaseMigration } from "./migration"

// Phase B3: the ~35 historical SQLite migrations were squashed into the single
// fresh PostgreSQL baseline in `schema.gen.ts`. New incremental migrations are
// appended here as `DatabaseMigration.Migration` entries.
export const migrations: DatabaseMigration.Migration[] = []
