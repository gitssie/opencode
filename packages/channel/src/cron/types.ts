// Data types for the cron/schedule system.
// Compatible with openclaw CronService format (isolated sessionTarget only).

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; model?: string; timeoutSeconds?: number }

export type CronDelivery = {
  mode: "none" | "announce"
  channel?: string
  to?: string
  accountId?: string
}

export type CronFailureAlert = {
  after?: number
  channel?: string
  to?: string
  cooldownMs?: number
  accountId?: string
}

export type CronJob = {
  id: string
  name: string
  description?: string
  enabled: boolean
  deleteAfterRun?: boolean
  createdAtMs: number
  updatedAtMs: number
  schedule: CronSchedule
  payload: CronPayload
  delivery?: CronDelivery
  failureAlert?: CronFailureAlert | false
  sessionKey?: string
  state: {
    nextRunAtMs?: number
    runningAtMs?: number
    lastRunAtMs?: number
    lastRunStatus?: "ok" | "error" | "skipped"
    lastError?: string
    lastDurationMs?: number
    consecutiveErrors?: number
    lastFailureAlertAtMs?: number
  }
}

export type CronStoreFile = { version: 1; jobs: CronJob[] }

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state">

export type CronJobPatch = Partial<
  Pick<
    CronJob,
    | "name"
    | "description"
    | "enabled"
    | "deleteAfterRun"
    | "schedule"
    | "payload"
    | "delivery"
    | "failureAlert"
    | "sessionKey"
  >
>

export type CronEvent =
  | { action: "started"; jobId: string }
  | { action: "finished"; jobId: string; status: "ok" | "error" | "skipped"; nextRunAtMs?: number }
  | { action: "alert"; jobId: string; to: string }
  | { action: "missed"; jobId: string; count: number }
