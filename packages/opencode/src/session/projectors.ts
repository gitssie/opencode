import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { sql } from "drizzle-orm"
import type { TxOrDb } from "@/storage/db"
import { SyncEvent } from "@/sync"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { WorkspaceTable } from "@/control-plane/workspace.sql"
import { Log } from "@opencode-ai/core/util/log"
import nextProjectors from "./projectors-next"

const log = Log.create({ service: "session.projector" })

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof err.message === "string" && err.message.includes("FOREIGN KEY constraint failed")
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T

type Usage = Pick<MessageV2.StepFinishPart, "cost" | "tokens">

function usage(part: MessageV2.Part | (typeof PartTable.$inferSelect)["data"]): Usage | undefined {
  if (part.type !== "step-finish") return undefined
  if (!("cost" in part) || !("tokens" in part)) return undefined
  return { cost: part.cost, tokens: part.tokens }
}

async function applyUsage(db: TxOrDb, sessionID: Session.Info["id"], value: Usage, sign = 1) {
  await db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
}

function grab<T extends object, K1 extends keyof T, X>(
  obj: T,
  field1: K1,
  cb?: (val: NonNullable<T[K1]>) => X,
): X | undefined {
  if (obj == undefined || !(field1 in obj)) return undefined

  const val = obj[field1]
  if (val && typeof val === "object" && cb) {
    return cb(val)
  }
  if (val === undefined) {
    throw new Error(
      "Session update failure: pass `null` to clear a field instead of `undefined`: " + JSON.stringify(obj),
    )
  }
  return val as X | undefined
}

export function toPartialRow(info: DeepPartial<Session.Info>) {
  const obj = {
    id: grab(info, "id"),
    project_id: grab(info, "projectID"),
    workspace_id: grab(info, "workspaceID"),
    parent_id: grab(info, "parentID"),
    slug: grab(info, "slug"),
    directory: grab(info, "directory"),
    path: grab(info, "path"),
    title: grab(info, "title"),
    version: grab(info, "version"),
    share_url: grab(info, "share", (v) => grab(v, "url")),
    summary_additions: grab(info, "summary", (v) => grab(v, "additions")),
    summary_deletions: grab(info, "summary", (v) => grab(v, "deletions")),
    summary_files: grab(info, "summary", (v) => grab(v, "files")),
    summary_diffs: grab(info, "summary", (v) => grab(v, "diffs")),
    cost: grab(info, "cost"),
    tokens_input: grab(info, "tokens", (v) => grab(v, "input")),
    tokens_output: grab(info, "tokens", (v) => grab(v, "output")),
    tokens_reasoning: grab(info, "tokens", (v) => grab(v, "reasoning")),
    tokens_cache_read: grab(info, "tokens", (v) => grab(v, "cache", (cache) => grab(cache, "read"))),
    tokens_cache_write: grab(info, "tokens", (v) => grab(v, "cache", (cache) => grab(cache, "write"))),
    revert: grab(info, "revert"),
    permission: grab(info, "permission"),
    time_created: grab(info, "time", (v) => grab(v, "created")),
    time_updated: grab(info, "time", (v) => grab(v, "updated")),
    time_compacting: grab(info, "time", (v) => grab(v, "compacting")),
    time_archived: grab(info, "time", (v) => grab(v, "archived")),
  }

  return Object.fromEntries(Object.entries(obj).filter(([_, val]) => val !== undefined))
}

export default [
  SyncEvent.project(Session.Event.Created, async (db, data) => {
    await db.insert(SessionTable).values(Session.toRow(data.info as Session.Info))

    if (data.info.workspaceID) {
      await db.update(WorkspaceTable).set({ time_used: Date.now() }).where(eq(WorkspaceTable.id, data.info.workspaceID))
    }
  }),

  SyncEvent.project(Session.Event.Updated, async (db, data) => {
    const info = data.info
    const rows = await db
      .update(SessionTable)
      .set({ time_updated: sql`${SessionTable.time_updated}`, ...toPartialRow(info as Session.Patch) })
      .where(eq(SessionTable.id, data.sessionID))
      .returning()
    if (!rows[0]) throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
  }),

  SyncEvent.project(Session.Event.Deleted, async (db, data) => {
    await db.delete(SessionTable).where(eq(SessionTable.id, data.sessionID))
  }),

  SyncEvent.project(MessageV2.Event.Updated, async (db, data) => {
    const time_created = data.info.time.created
    const { id, sessionID, ...rest } = data.info

    try {
      await db
        .insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          time_created,
          data: rest,
        })
        .onConflictDoUpdate({ target: MessageTable.id, set: { data: rest } })
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late message update", { messageID: id, sessionID })
    }
  }),

  SyncEvent.project(MessageV2.Event.Removed, async (db, data) => {
    const parts = await db
      .select()
      .from(PartTable)
      .where(and(eq(PartTable.message_id, data.messageID), eq(PartTable.session_id, data.sessionID)))
    for (const row of parts) {
      const previous = usage(row.data)
      if (previous) await applyUsage(db, data.sessionID, previous, -1)
    }
    await db
      .delete(MessageTable)
      .where(and(eq(MessageTable.id, data.messageID), eq(MessageTable.session_id, data.sessionID)))
  }),

  SyncEvent.project(MessageV2.Event.PartRemoved, async (db, data) => {
    const rows = await db
      .select()
      .from(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
    const row = rows[0]
    const previous = row && usage(row.data)
    if (previous) await applyUsage(db, data.sessionID, previous, -1)

    await db
      .delete(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
  }),

  SyncEvent.project(MessageV2.Event.PartUpdated, async (db, data) => {
    const { id, messageID, sessionID, ...rest } = data.part
    const rows = await db.select().from(PartTable).where(eq(PartTable.id, id))
    const row = rows[0]

    try {
      await db
        .insert(PartTable)
        .values({
          id,
          message_id: messageID,
          session_id: sessionID,
          time_created: data.time,
          data: rest,
        })
        .onConflictDoUpdate({ target: PartTable.id, set: { data: rest } })
      const previous = row && usage(row.data)
      const next = usage(data.part)
      if (previous) await applyUsage(db, row.session_id, previous, -1)
      if (next) await applyUsage(db, sessionID, next)
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late part update", { partID: id, messageID, sessionID })
    }
  }),

  ...nextProjectors,
]
