import { Cron } from "croner"
import { parseAbsoluteTimeMs } from "./parse.ts"
import type { CronSchedule } from "./types.ts"

const CACHE_MAX = 512
const cache = new Map<string, Cron>()

function resolveTz(tz?: string) {
  const t = typeof tz === "string" ? tz.trim() : ""
  return t || Intl.DateTimeFormat().resolvedOptions().timeZone
}

function cachedCron(expr: string, tz: string): Cron {
  const key = `${tz}\0${expr}`
  if (cache.has(key)) return cache.get(key)!
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  const c = new Cron(expr, { timezone: tz, catch: false })
  cache.set(key, c)
  return c
}

function cronFromSchedule(schedule: { tz?: string; expr?: unknown; cron?: unknown }): Cron | undefined {
  const src = typeof schedule.expr === "string" ? schedule.expr : schedule.cron
  if (typeof src !== "string") throw new Error("invalid cron schedule: expr is required")
  const expr = src.trim()
  if (!expr) return undefined
  return cachedCron(expr, resolveTz(schedule.tz))
}

export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const t = value.trim()
    if (!t) return undefined
    const n = Number(t)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    const s = schedule as { at?: string; atMs?: number | string }
    const atMs =
      typeof s.atMs === "number" && Number.isFinite(s.atMs) && s.atMs > 0
        ? s.atMs
        : typeof s.atMs === "string"
          ? parseAbsoluteTimeMs(s.atMs)
          : typeof s.at === "string"
            ? parseAbsoluteTimeMs(s.at)
            : null
    if (atMs === null) return undefined
    return atMs > nowMs ? atMs : undefined
  }

  if (schedule.kind === "every") {
    const raw = coerceFiniteScheduleNumber(schedule.everyMs)
    if (raw === undefined) return undefined
    const ms = Math.max(1, Math.floor(raw))
    const anchorRaw = coerceFiniteScheduleNumber(schedule.anchorMs)
    const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs))
    if (nowMs < anchor) return anchor
    const elapsed = nowMs - anchor
    const steps = Math.max(1, Math.floor((elapsed + ms - 1) / ms))
    return anchor + steps * ms
  }

  const cron = cronFromSchedule(schedule as { tz?: string; expr?: unknown; cron?: unknown })
  if (!cron) return undefined
  const next = cron.nextRun(new Date(nowMs))
  if (!next) return undefined
  let ms = next.getTime()
  if (!Number.isFinite(ms)) return undefined

  if (ms <= nowMs) {
    const retry = cron.nextRun(new Date(Math.floor(nowMs / 1000) * 1000 + 1000))
    if (retry) {
      const r = retry.getTime()
      if (Number.isFinite(r) && r > nowMs) return r
    }
    const retry2 = cron.nextRun(new Date(new Date(nowMs).setUTCHours(24, 0, 0, 0)))
    if (retry2) {
      const r2 = retry2.getTime()
      if (Number.isFinite(r2) && r2 > nowMs) return r2
    }
    return undefined
  }

  return ms
}

export function computePreviousRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind !== "cron") return undefined
  const cron = cronFromSchedule(schedule as { tz?: string; expr?: unknown; cron?: unknown })
  if (!cron) return undefined
  const prev = cron.previousRuns(1, new Date(nowMs))[0]
  if (!prev) return undefined
  const ms = prev.getTime()
  if (!Number.isFinite(ms) || ms >= nowMs) return undefined
  return ms
}

export function clearCronScheduleCache(): void {
  cache.clear()
}
