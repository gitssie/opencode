import { computeNextRunAtMs, computePreviousRunAtMs } from "./schedule.ts"
import { resolveCronStaggerMs } from "./stagger.ts"
import type { CronJob } from "./types.ts"

// SHA-256 based deterministic stagger offset per job
async function staggerOffsetMs(jobId: string, staggerMs: number): Promise<number> {
  if (staggerMs <= 0) return 0
  const buf = new TextEncoder().encode(jobId)
  const hash = await crypto.subtle.digest("SHA-256", buf)
  const view = new DataView(hash)
  // use first 4 bytes as uint32
  const n = view.getUint32(0, false)
  return n % staggerMs
}

export async function computeJobNextRunAtMs(job: CronJob, nowMs: number): Promise<number | undefined> {
  const { schedule } = job
  if (schedule.kind === "cron") {
    const staggerMs = resolveCronStaggerMs(schedule)
    if (staggerMs > 0) {
      const base = computeNextRunAtMs(schedule, nowMs)
      if (base === undefined) return undefined
      const offset = await staggerOffsetMs(job.id, staggerMs)
      return base + offset
    }
  }
  return computeNextRunAtMs(schedule, nowMs)
}

export async function computeJobPreviousRunAtMs(job: CronJob, nowMs: number): Promise<number | undefined> {
  const { schedule } = job
  if (schedule.kind !== "cron") return undefined
  const staggerMs = resolveCronStaggerMs(schedule)
  const base = computePreviousRunAtMs(schedule, nowMs)
  if (base === undefined) return undefined
  if (staggerMs <= 0) return base
  const offset = await staggerOffsetMs(job.id, staggerMs)
  return base + offset
}

export function isRunnableJob(
  job: CronJob,
  nowMs: number,
  opts: { skipAtIfAlreadyRan?: boolean; allowCronMissedRun?: boolean } = {},
): boolean {
  if (!job.enabled) return false
  if (job.state.runningAtMs !== undefined) return false // already running

  const { nextRunAtMs, lastRunAtMs } = job.state

  if (opts.skipAtIfAlreadyRan && job.schedule.kind === "at" && lastRunAtMs !== undefined) {
    return false
  }

  if (opts.allowCronMissedRun && job.schedule.kind === "cron") {
    // isRunnable if nextRunAtMs is set (regardless of whether it's in the future)
    return nextRunAtMs !== undefined
  }

  if (nextRunAtMs === undefined) return false
  return nextRunAtMs <= nowMs
}
