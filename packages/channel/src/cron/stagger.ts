import type { CronSchedule } from "./types.ts"

export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000

function parseCronFields(expr: string) {
  return expr.trim().split(/\s+/).filter(Boolean)
}

export function isTopOfHourCronExpr(expr: string) {
  const fields = parseCronFields(expr)
  if (fields.length === 5) {
    const [min, hr] = fields
    return min === "0" && hr.includes("*")
  }
  if (fields.length === 6) {
    const [sec, min, hr] = fields
    return sec === "0" && min === "0" && hr.includes("*")
  }
  return false
}

export function normalizeCronStaggerMs(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.floor(n))
}

export function resolveDefaultCronStaggerMs(expr: string): number | undefined {
  return isTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined
}

export function resolveCronStaggerMs(schedule: Extract<CronSchedule, { kind: "cron" }>): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs)
  if (explicit !== undefined) return explicit
  const expr = typeof (schedule as { expr?: unknown }).expr === "string" ? (schedule as { expr: string }).expr : ""
  return resolveDefaultCronStaggerMs(expr) ?? 0
}
