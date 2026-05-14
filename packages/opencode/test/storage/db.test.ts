import { describe, expect, test } from "bun:test"
import { Database } from "@/storage/db"

describe("Database.Path", () => {
  test("returns database connection URL", () => {
    // In PostgreSQL mode, Path is a connection string (from OPENCODE_DB_URL or default)
    expect(typeof Database.Path).toBe("string")
    expect(Database.Path.length).toBeGreaterThan(0)
  })
})
