import { randomUUID } from "node:crypto"
import { computeJobNextRunAtMs, computeJobPreviousRunAtMs, isRunnableJob } from "./jobs.ts"
import { DEFAULT_STORE_PATH, findJob, loadCronStore, removeJob, saveCronStore, upsertJob } from "./store.ts"
import type { CronEvent, CronJob, CronJobCreate, CronJobPatch, CronStoreFile } from "./types.ts"

// Error backoff table (index = consecutiveErrors - 1, capped at last)
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000]
const MAX_AT_RETRIES = 3
const TRANSIENT_ERROR_PATTERNS = [/rate.?limit/i, /timeout/i, /network/i, /5\d\d/i, /ECONNRESET/i]

function isTransientError(msg: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(msg))
}

function backoffMs(consecutive: number): number {
  return BACKOFF_MS[Math.min(Math.max(consecutive - 1, 0), BACKOFF_MS.length - 1)]!
}

function resolveTo(job: CronJob): string | undefined {
  if (job.delivery?.to) return job.delivery.to
  if (job.sessionKey) {
    const parts = job.sessionKey.split(":")
    const [ch, , type, id] = parts
    if (ch && id) return type === "group" ? `${ch}:group:${id}` : `${ch}:${id}`
  }
  return undefined
}

export type AgentJobResult = { text: string; status: "ok" | "error" | "skipped"; error?: string }

export type CronServiceDeps = {
  storePath?: string
  maxConcurrentRuns?: number
  maxMissedJobsPerRestart?: number
  missedJobStaggerMs?: number
  runAgentJob: (params: { job: CronJob; sessionKey: string; abortSignal?: AbortSignal }) => Promise<AgentJobResult>
  sendText: (params: { to: string; text: string; accountId?: string }) => Promise<void>
  nowMs?: () => number
  onEvent?: (evt: CronEvent) => void
  log?: (...args: unknown[]) => void
}

export class CronService {
  private deps: Required<
    Pick<CronServiceDeps, "maxConcurrentRuns" | "maxMissedJobsPerRestart" | "missedJobStaggerMs" | "nowMs" | "log">
  > &
    CronServiceDeps
  private storePath: string
  private store: CronStoreFile = { version: 1, jobs: [] }
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = new Set<string>() // jobIds currently executing

  constructor(deps: CronServiceDeps) {
    this.storePath = deps.storePath ?? DEFAULT_STORE_PATH
    this.deps = {
      maxConcurrentRuns: 1,
      maxMissedJobsPerRestart: 5,
      missedJobStaggerMs: 5_000,
      nowMs: () => Date.now(),
      log: (...args) => console.log("[cron]", ...args),
      ...deps,
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.store = await loadCronStore(this.storePath)
    await this.runMissedJobs()
    this.armTimer()
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async add(input: CronJobCreate): Promise<CronJob> {
    this.store = await loadCronStore(this.storePath)
    const now = this.deps.nowMs()
    const job: CronJob = {
      ...input,
      id: randomUUID(),
      createdAtMs: now,
      updatedAtMs: now,
      state: {},
    }
    job.state.nextRunAtMs = await computeJobNextRunAtMs(job, now)
    upsertJob(this.store, job)
    await saveCronStore(this.store, this.storePath)
    this.armTimer()
    return job
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob | undefined> {
    this.store = await loadCronStore(this.storePath)
    const job = findJob(this.store, id)
    if (!job) return undefined
    Object.assign(job, patch, { updatedAtMs: this.deps.nowMs() })
    // recompute nextRunAtMs if schedule changed
    if (patch.schedule) {
      job.state.nextRunAtMs = await computeJobNextRunAtMs(job, this.deps.nowMs())
    }
    upsertJob(this.store, job)
    await saveCronStore(this.store, this.storePath)
    this.armTimer()
    return job
  }

  async remove(id: string): Promise<boolean> {
    this.store = await loadCronStore(this.storePath)
    const removed = removeJob(this.store, id)
    if (removed) await saveCronStore(this.store, this.storePath)
    return removed
  }

  async list(): Promise<CronJob[]> {
    this.store = await loadCronStore(this.storePath)
    return [...this.store.jobs]
  }

  getJob(id: string): CronJob | undefined {
    return findJob(this.store, id)
  }

  async runNow(id: string): Promise<void> {
    this.store = await loadCronStore(this.storePath)
    const job = findJob(this.store, id)
    if (!job) throw new Error(`cron job not found: ${id}`)
    await this.executeJob(job)
    await saveCronStore(this.store, this.storePath)
  }

  status() {
    const next = this.store.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs !== undefined)
      .map((j) => j.state.nextRunAtMs!)
      .reduce((a, b) => Math.min(a, b), Infinity)
    return {
      enabled: this.timer !== undefined,
      storePath: this.storePath,
      jobs: this.store.jobs.length,
      nextWakeAtMs: Number.isFinite(next) ? next : null,
    }
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  private armTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    const now = this.deps.nowMs()
    const next = this.store.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs !== undefined)
      .map((j) => j.state.nextRunAtMs!)
      .reduce((a, b) => Math.min(a, b), Infinity)

    const delay = Number.isFinite(next) ? Math.max(0, Math.min(next - now, 60_000)) : 60_000
    this.timer = setTimeout(() => this.tick(), delay)
  }

  private async tick(): Promise<void> {
    this.timer = undefined
    this.store = await loadCronStore(this.storePath)

    const now = this.deps.nowMs()
    const runnable = this.store.jobs.filter((j) => isRunnableJob(j, now) && !this.running.has(j.id))

    const slots = this.deps.maxConcurrentRuns - this.running.size
    const batch = runnable.slice(0, Math.max(0, slots))

    await Promise.all(batch.map((j) => this.executeJob(j)))

    if (batch.length > 0) await saveCronStore(this.store, this.storePath)
    this.armTimer()
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  private async executeJob(job: CronJob): Promise<void> {
    const now = this.deps.nowMs()
    this.running.add(job.id)
    job.state.runningAtMs = now
    this.deps.onEvent?.({ action: "started", jobId: job.id })
    this.deps.log("started", job.id, job.name)

    let result: AgentJobResult
    try {
      result = await this.executeJobCore(job)
    } catch (err) {
      result = { text: "", status: "error", error: err instanceof Error ? err.message : String(err) }
    }

    const ended = this.deps.nowMs()
    this.running.delete(job.id)
    job.state.runningAtMs = undefined
    job.state.lastRunAtMs = now
    job.state.lastRunStatus = result.status
    job.state.lastDurationMs = ended - now

    if (result.status === "error") {
      job.state.lastError = result.error
      job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1
      await this.maybeAlert(job, now)
      this.applyErrorBackoff(job, now)
    } else {
      job.state.consecutiveErrors = 0
      job.state.lastError = undefined

      // deliver if announce mode
      if (job.delivery?.mode === "announce" && result.status !== "skipped" && result.text) {
        const to = resolveTo(job)
        if (to) {
          try {
            await this.deps.sendText({ to, text: result.text, accountId: job.delivery.accountId })
          } catch (err) {
            this.deps.log("sendText error", job.id, err)
          }
        }
      }

      await this.applySuccess(job, now)
    }

    this.deps.onEvent?.({
      action: "finished",
      jobId: job.id,
      status: result.status,
      nextRunAtMs: job.state.nextRunAtMs,
    })
    this.deps.log(
      "finished",
      job.id,
      result.status,
      job.state.nextRunAtMs ? `next=${new Date(job.state.nextRunAtMs).toISOString()}` : "",
    )
  }

  private async executeJobCore(job: CronJob): Promise<AgentJobResult> {
    const { payload } = job
    if (payload.kind === "systemEvent") {
      return { text: payload.text, status: "ok" }
    }
    // agentTurn
    const key = job.sessionKey ?? resolveTo(job)
    if (!key) return { text: "", status: "error", error: "no sessionKey or delivery.to for agentTurn" }

    let ctrl: AbortController | undefined
    if (payload.timeoutSeconds) {
      ctrl = new AbortController()
      setTimeout(() => ctrl!.abort(), payload.timeoutSeconds * 1000)
    }

    return this.deps.runAgentJob({ job, sessionKey: key, abortSignal: ctrl?.signal })
  }

  private async applySuccess(job: CronJob, now: number): Promise<void> {
    const { schedule } = job
    if (schedule.kind === "at") {
      if (job.deleteAfterRun) {
        removeJob(this.store, job.id)
      } else {
        job.enabled = false
        job.state.nextRunAtMs = undefined
      }
    } else {
      job.state.nextRunAtMs = await computeJobNextRunAtMs(job, now)
    }
  }

  private applyErrorBackoff(job: CronJob, now: number): void {
    const consecutive = job.state.consecutiveErrors ?? 1
    const delay = backoffMs(consecutive)
    const { schedule } = job

    if (schedule.kind === "at") {
      if (!isTransientError(job.state.lastError ?? "") || consecutive > MAX_AT_RETRIES) {
        job.enabled = false
        job.state.nextRunAtMs = undefined
      } else {
        job.state.nextRunAtMs = now + delay
      }
    } else {
      job.state.nextRunAtMs = now + delay
    }
  }

  private async maybeAlert(job: CronJob, now: number): Promise<void> {
    if (!job.failureAlert) return
    const alert = job.failureAlert
    const after = alert.after ?? 2
    const cooldown = alert.cooldownMs ?? 3_600_000
    const consecutive = job.state.consecutiveErrors ?? 0

    if (consecutive < after) return

    const lastAlert = job.state.lastFailureAlertAtMs ?? 0
    if (now - lastAlert < cooldown) return

    const to = alert.to ?? resolveTo(job)
    if (!to) return

    job.state.lastFailureAlertAtMs = now
    const text = `⚠️ Cron job "${job.name}" has failed ${consecutive} consecutive times.\nLast error: ${job.state.lastError ?? "unknown"}`
    try {
      await this.deps.sendText({ to, text, accountId: alert.accountId })
      this.deps.onEvent?.({ action: "alert", jobId: job.id, to })
    } catch (err) {
      this.deps.log("alert sendText error", job.id, err)
    }
  }

  // ── Startup catchup ────────────────────────────────────────────────────────

  private async runMissedJobs(): Promise<void> {
    const now = this.deps.nowMs()
    const max = this.deps.maxMissedJobsPerRestart
    const stagger = this.deps.missedJobStaggerMs

    // Collect jobs where previousRunAtMs > lastRunAtMs (missed while down)
    const missed: CronJob[] = []
    for (const job of this.store.jobs) {
      if (!job.enabled) continue
      if (job.state.lastRunAtMs === undefined) continue // never ran, skip catchup
      const prev = await computeJobPreviousRunAtMs(job, now)
      if (prev !== undefined && prev > job.state.lastRunAtMs) {
        missed.push(job)
      }
    }

    // sort by nextRunAtMs ascending
    missed.sort((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0))

    const immediate = missed.slice(0, max)
    const deferred = missed.slice(max)

    // stagger deferred
    for (let i = 0; i < deferred.length; i++) {
      deferred[i].state.nextRunAtMs = now + stagger * (i + 1)
    }

    if (missed.length > 0) {
      this.deps.log(`startup catchup: ${immediate.length} immediate, ${deferred.length} deferred`)
      this.deps.onEvent?.({ action: "missed", jobId: "*", count: missed.length })
    }

    await Promise.all(immediate.map((j) => this.executeJob(j)))
    if (immediate.length > 0) await saveCronStore(this.store, this.storePath)
  }
}
