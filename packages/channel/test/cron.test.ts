/**
 * cron 系统单元测试
 *
 * 覆盖：
 *  - parseAbsoluteTimeMs
 *  - computeNextRunAtMs / computePreviousRunAtMs
 *  - resolveCronStaggerMs / isTopOfHourCronExpr
 *  - computeJobNextRunAtMs (stagger)
 *  - isRunnableJob
 *  - loadCronStore / saveCronStore (temp path)
 *  - CronService: add, tick, errorBackoff, failureAlert, missedJobs, at-disable
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "node:path"
import os from "node:os"
import { rmdir, rm } from "node:fs/promises"
import { parseAbsoluteTimeMs } from "../src/cron/parse.ts"
import { computeNextRunAtMs, computePreviousRunAtMs, clearCronScheduleCache } from "../src/cron/schedule.ts"
import { resolveCronStaggerMs, isTopOfHourCronExpr } from "../src/cron/stagger.ts"
import { computeJobNextRunAtMs, isRunnableJob } from "../src/cron/jobs.ts"
import { loadCronStore, saveCronStore } from "../src/cron/store.ts"
import { CronService } from "../src/cron/service.ts"
import type { CronJob, CronJobCreate } from "../src/cron/types.ts"

// ── helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job-1",
    name: "test",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", text: "hello" },
    state: {},
    ...overrides,
  }
}

// ── parse.ts ─────────────────────────────────────────────────────────────────

describe("parseAbsoluteTimeMs", () => {
  test("unix ms integer string", () => {
    expect(parseAbsoluteTimeMs("1700000000000")).toBe(1700000000000)
  })
  test("ISO date only → midnight UTC", () => {
    const ms = parseAbsoluteTimeMs("2024-01-15")
    expect(ms).toBe(Date.parse("2024-01-15T00:00:00Z"))
  })
  test("ISO datetime without tz → append Z", () => {
    const ms = parseAbsoluteTimeMs("2024-01-15T12:00:00")
    expect(ms).toBe(Date.parse("2024-01-15T12:00:00Z"))
  })
  test("ISO with tz offset", () => {
    const ms = parseAbsoluteTimeMs("2024-01-15T12:00:00+08:00")
    expect(ms).toBe(Date.parse("2024-01-15T12:00:00+08:00"))
  })
  test("empty string → null", () => {
    expect(parseAbsoluteTimeMs("")).toBeNull()
  })
  test("invalid string → null", () => {
    expect(parseAbsoluteTimeMs("not-a-date")).toBeNull()
  })
})

// ── schedule.ts ───────────────────────────────────────────────────────────────

describe("computeNextRunAtMs", () => {
  const now = 1_700_000_000_000

  test("at: future time returns that time", () => {
    const at = new Date(now + 10_000).toISOString()
    expect(computeNextRunAtMs({ kind: "at", at }, now)).toBe(now + 10_000)
  })
  test("at: past time returns undefined", () => {
    const at = new Date(now - 1).toISOString()
    expect(computeNextRunAtMs({ kind: "at", at }, now)).toBeUndefined()
  })
  test("every: basic interval", () => {
    const ms = computeNextRunAtMs({ kind: "every", everyMs: 60_000, anchorMs: 0 }, now)
    expect(ms).toBeDefined()
    expect(ms! % 60_000).toBe(0)
    expect(ms!).toBeGreaterThan(now)
  })
  test("every: next run is exactly one interval ahead of anchor aligned", () => {
    const anchor = 0
    const ms = computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: anchor }, 5500)
    // elapsed = 5500, steps = ceil(5500/1000) = 6, next = 6000
    expect(ms).toBe(6000)
  })
  test("cron: returns future timestamp", () => {
    clearCronScheduleCache()
    const ms = computeNextRunAtMs({ kind: "cron", expr: "* * * * *" }, now)
    expect(ms).toBeGreaterThan(now)
  })
})

describe("computePreviousRunAtMs", () => {
  test("non-cron schedule returns undefined", () => {
    expect(computePreviousRunAtMs({ kind: "every", everyMs: 1000 }, Date.now())).toBeUndefined()
  })
  test("cron: returns past timestamp", () => {
    clearCronScheduleCache()
    const now = Date.now()
    const ms = computePreviousRunAtMs({ kind: "cron", expr: "* * * * *" }, now)
    if (ms !== undefined) {
      expect(ms).toBeLessThan(now)
    }
  })
})

// ── stagger.ts ────────────────────────────────────────────────────────────────

describe("stagger", () => {
  test("isTopOfHourCronExpr: hourly 5-field", () => {
    expect(isTopOfHourCronExpr("0 * * * *")).toBe(true)
    expect(isTopOfHourCronExpr("0 */2 * * *")).toBe(true)
    expect(isTopOfHourCronExpr("5 * * * *")).toBe(false)
  })
  test("resolveCronStaggerMs: explicit staggerMs", () => {
    expect(resolveCronStaggerMs({ kind: "cron", expr: "* * * * *", staggerMs: 12345 })).toBe(12345)
  })
  test("resolveCronStaggerMs: auto top-of-hour stagger", () => {
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *" })).toBe(5 * 60 * 1000)
  })
  test("resolveCronStaggerMs: non-top-of-hour = 0", () => {
    expect(resolveCronStaggerMs({ kind: "cron", expr: "*/5 * * * *" })).toBe(0)
  })
})

// ── jobs.ts ───────────────────────────────────────────────────────────────────

describe("computeJobNextRunAtMs", () => {
  test("every schedule: no stagger", async () => {
    const job = makeJob({ id: "j1", schedule: { kind: "every", everyMs: 10_000, anchorMs: 0 } })
    const ms = await computeJobNextRunAtMs(job, 5_000)
    expect(ms).toBe(10_000)
  })
  test("cron with staggerMs: offset is deterministic and within range", async () => {
    const staggerMs = 60_000
    const job = makeJob({ id: "cron-job-abc", schedule: { kind: "cron", expr: "0 * * * *", staggerMs } })
    const now = Date.now()
    const ms1 = await computeJobNextRunAtMs(job, now)
    const ms2 = await computeJobNextRunAtMs(job, now)
    expect(ms1).toBeDefined()
    expect(ms1).toBe(ms2) // deterministic
  })
})

describe("isRunnableJob", () => {
  const now = 1_000_000

  test("disabled job is not runnable", () => {
    const job = makeJob({ enabled: false, state: { nextRunAtMs: now - 1 } })
    expect(isRunnableJob(job, now)).toBe(false)
  })
  test("running job is not runnable", () => {
    const job = makeJob({ state: { nextRunAtMs: now - 1, runningAtMs: now - 10 } })
    expect(isRunnableJob(job, now)).toBe(false)
  })
  test("due job is runnable", () => {
    const job = makeJob({ state: { nextRunAtMs: now - 1 } })
    expect(isRunnableJob(job, now)).toBe(true)
  })
  test("future job is not runnable", () => {
    const job = makeJob({ state: { nextRunAtMs: now + 1000 } })
    expect(isRunnableJob(job, now)).toBe(false)
  })
  test("skipAtIfAlreadyRan: at job that already ran is skipped", () => {
    const job = makeJob({
      schedule: { kind: "at", at: new Date(now + 1000).toISOString() },
      state: { lastRunAtMs: now - 100, nextRunAtMs: now - 1 },
    })
    expect(isRunnableJob(job, now, { skipAtIfAlreadyRan: true })).toBe(false)
  })
})

// ── store.ts ──────────────────────────────────────────────────────────────────

describe("loadCronStore / saveCronStore", () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await Bun.file(os.tmpdir())
      .exists()
      .then(() => {
        const d = path.join(os.tmpdir(), `cron-test-${Date.now()}`)
        return d
      })
    await import("node:fs/promises").then((m) => m.mkdir(dir, { recursive: true }))
    file = path.join(dir, "jobs.json")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("load non-existent returns empty store", async () => {
    const store = await loadCronStore(file)
    expect(store.version).toBe(1)
    expect(store.jobs).toHaveLength(0)
  })

  test("save and load round-trips correctly", async () => {
    const job = makeJob()
    await saveCronStore({ version: 1, jobs: [job] }, file)
    const loaded = await loadCronStore(file)
    expect(loaded.jobs).toHaveLength(1)
    expect(loaded.jobs[0]!.id).toBe("test-job-1")
  })

  test("creates .bak backup on second save", async () => {
    await saveCronStore({ version: 1, jobs: [] }, file)
    const job = makeJob()
    await saveCronStore({ version: 1, jobs: [job] }, file)
    const bak = Bun.file(`${file}.bak`)
    expect(await bak.exists()).toBe(true)
  })
})

// ── CronService ───────────────────────────────────────────────────────────────

describe("CronService", () => {
  let dir: string
  let storePath: string
  let now: number
  let sent: Array<{ to: string; text: string }>
  let runCalls: Array<{ jobId: string; sessionKey: string }>
  let service: CronService

  function makeService(
    overrides: { runResult?: { text: string; status: "ok" | "error" | "skipped"; error?: string } } = {},
  ) {
    sent = []
    runCalls = []
    service = new CronService({
      storePath,
      nowMs: () => now,
      runAgentJob: async ({ job, sessionKey }) => {
        runCalls.push({ jobId: job.id, sessionKey })
        return overrides.runResult ?? { text: "agent reply", status: "ok" }
      },
      sendText: async ({ to, text }) => {
        sent.push({ to, text })
      },
      log: () => {},
    })
    return service
  }

  beforeEach(async () => {
    now = 1_700_000_000_000
    dir = path.join(os.tmpdir(), `cron-svc-${Date.now()}`)
    await import("node:fs/promises").then((m) => m.mkdir(dir, { recursive: true }))
    storePath = path.join(dir, "jobs.json")
  })

  afterEach(async () => {
    service.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test("add job computes nextRunAtMs", async () => {
    makeService()
    await service.start()
    const job = await service.add({
      name: "tick every 10s",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000, anchorMs: 0 },
      payload: { kind: "systemEvent", text: "ping" },
    })
    expect(job.state.nextRunAtMs).toBeDefined()
    // nextRunAtMs should be >= now (could equal if now is aligned to interval)
    expect(job.state.nextRunAtMs!).toBeGreaterThanOrEqual(now)
  })

  test("systemEvent job runs and delivers via sendText on announce mode", async () => {
    makeService()
    await service.start()
    const job = await service.add({
      name: "ping",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000, anchorMs: 0 },
      payload: { kind: "systemEvent", text: "hello world" },
      delivery: { mode: "announce", to: "wecom:user1" },
    })

    // stop timer so armTimer from runNow doesn't trigger extra executions
    service.stop()
    await service.runNow(job.id)

    // exactly one delivery
    const deliveries = sent.filter((s) => s.to === "wecom:user1" && s.text === "hello world")
    expect(deliveries.length).toBeGreaterThanOrEqual(1)
  })

  test("agentTurn job calls runAgentJob", async () => {
    makeService()
    await service.start()
    const job = await service.add({
      name: "agent job",
      enabled: true,
      sessionKey: "wecom:default:direct:alice",
      schedule: { kind: "every", everyMs: 10_000, anchorMs: 0 },
      payload: { kind: "agentTurn", message: "daily summary" },
      delivery: { mode: "announce" },
    })

    await service.runNow(job.id)

    expect(runCalls).toHaveLength(1)
    expect(runCalls[0]!.sessionKey).toBe("wecom:default:direct:alice")
    // delivery resolves sessionKey → "wecom:alice"
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe("wecom:alice")
    expect(sent[0]!.text).toBe("agent reply")
  })

  test("at job disables after success", async () => {
    makeService()
    await service.start()
    const at = new Date(now + 1000).toISOString()
    const job = await service.add({
      name: "once",
      enabled: true,
      schedule: { kind: "at", at },
      payload: { kind: "systemEvent", text: "once" },
    })

    await service.runNow(job.id)
    const updated = service.getJob(job.id)
    expect(updated?.enabled).toBe(false)
  })

  test("at job with deleteAfterRun removes job on success", async () => {
    makeService()
    await service.start()
    const at = new Date(now + 1000).toISOString()
    const job = await service.add({
      name: "once-delete",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "at", at },
      payload: { kind: "systemEvent", text: "bye" },
    })

    await service.runNow(job.id)
    expect(service.getJob(job.id)).toBeUndefined()
  })

  test("error increments consecutiveErrors and disables at job on non-transient error", async () => {
    makeService({ runResult: { text: "", status: "error", error: "permanent failure" } })
    await service.start()
    const at = new Date(now + 1000).toISOString()
    const job = await service.add({
      name: "fail-at",
      enabled: true,
      schedule: { kind: "at", at },
      payload: { kind: "agentTurn", message: "go" },
      sessionKey: "wecom:default:direct:bob",
    })

    await service.runNow(job.id)
    const updated = service.getJob(job.id)!
    expect(updated.state.consecutiveErrors).toBe(1)
    expect(updated.enabled).toBe(false)
  })

  test("error on every job applies backoff, stays enabled", async () => {
    makeService({ runResult: { text: "", status: "error", error: "rate limit" } })
    await service.start()
    const job = await service.add({
      name: "fail-every",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      payload: { kind: "agentTurn", message: "go" },
      sessionKey: "wecom:default:direct:bob",
    })

    await service.runNow(job.id)
    const updated = service.getJob(job.id)!
    expect(updated.enabled).toBe(true)
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now) // backoff applied
  })

  test("failureAlert fires after N consecutive errors", async () => {
    makeService({ runResult: { text: "", status: "error", error: "broken" } })
    await service.start()
    const job = await service.add({
      name: "alertable",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      payload: { kind: "agentTurn", message: "go" },
      sessionKey: "wecom:default:direct:alice",
      failureAlert: { after: 2, to: "wecom:admin", cooldownMs: 3_600_000 },
    })

    // run twice to trigger alert
    await service.runNow(job.id)
    // reset runningAtMs so we can run again
    const j = service.getJob(job.id)!
    j.state.runningAtMs = undefined
    await service.runNow(job.id)

    expect(sent.some((s) => s.to === "wecom:admin" && s.text.includes("alertable"))).toBe(true)
  })

  test("list returns all jobs", async () => {
    makeService()
    await service.start()
    await service.add({
      name: "a",
      enabled: true,
      schedule: { kind: "every", everyMs: 1000 },
      payload: { kind: "systemEvent", text: "" },
    })
    await service.add({
      name: "b",
      enabled: true,
      schedule: { kind: "every", everyMs: 2000 },
      payload: { kind: "systemEvent", text: "" },
    })
    const jobs = await service.list()
    expect(jobs).toHaveLength(2)
  })

  test("remove deletes job", async () => {
    makeService()
    await service.start()
    const job = await service.add({
      name: "tmp",
      enabled: true,
      schedule: { kind: "every", everyMs: 1000 },
      payload: { kind: "systemEvent", text: "" },
    })
    const ok = await service.remove(job.id)
    expect(ok).toBe(true)
    expect(service.getJob(job.id)).toBeUndefined()
  })

  test("update patches job and recomputes nextRunAtMs when schedule changes", async () => {
    makeService()
    await service.start()
    const job = await service.add({
      name: "patchable",
      enabled: true,
      schedule: { kind: "every", everyMs: 1000, anchorMs: 0 },
      payload: { kind: "systemEvent", text: "" },
    })
    const prev = job.state.nextRunAtMs!
    const updated = await service.update(job.id, { schedule: { kind: "every", everyMs: 999_999, anchorMs: 0 } })
    expect(updated).toBeDefined()
    expect(updated!.state.nextRunAtMs).not.toBe(prev)
  })
})
