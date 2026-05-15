import { Pool } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"

export function init(connectionString: string) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 })
  const db = drizzle({ client: pool })
  return db
}
