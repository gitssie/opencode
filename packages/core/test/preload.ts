// Boot a shared embedded PGlite instance for the test run and point OPENCODE_DB
// at it. This is the postgres analog of the old shared sqlite `:memory:` default:
// any `*.defaultLayer` (resolving the connection via `Database.path()`) works in
// tests without per-test wiring. Tests that need an isolated database use
// `DatabaseTesting.layer` instead.
import { afterAll, afterEach } from "bun:test"
import { DatabaseTesting } from "../src/database/testing"

const shared = await DatabaseTesting.startSharedPglite()
process.env["OPENCODE_DB"] = shared.url

// Truncate the shared default database between tests so `*.defaultLayer` state
// never leaks across tests — matching the old fresh-per-test sqlite `:memory:`.
afterEach(async () => {
  await shared.reset()
})

afterAll(async () => {
  await shared.dispose()
})
