/* oxlint-disable */
// Re-export drizzle's published Effect Postgres migrator so the package surface
// mirrors `@opencode-ai/effect-drizzle-sqlite`'s `effect-sqlite/migrator`.
export { migrate } from "drizzle-orm/effect-postgres/migrator"
