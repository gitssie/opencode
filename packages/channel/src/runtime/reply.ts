/**
 * runtime/reply.ts
 *
 * 实现两个核心函数：
 *   - finalizeInboundContext  (文本规范化 + BodyForAgent 解析)
 *   - dispatchReplyWithBufferedBlockDispatcher
 *     (查绑定表 → opencode session → 事件流 → deliver 回调)
 *
 * 注意：dispatchReplyWithBufferedBlockDispatcher 的 cfg 参数在 openclaw 里是
 * OpenClawConfig（AI 引擎配置），在本适配层里完全不使用——我们直接调 opencode SDK。
 */

import EventEmitter from "node:events"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type {
  EventMessagePartDelta,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventSessionError,
  EventSessionIdle,
  GlobalEvent,
} from "@opencode-ai/sdk/v2"
import { getBinding, updateBinding } from "../bindings.ts"
import { Identifier } from "@opencode-ai/util/id"

// ── Types ─────────────────────────────────────────────────────────────────────

export type MsgContext = {
  SessionKey: string
  BodyForAgent?: string
  BodyForCommands?: string
  Body?: string
  RawBody?: string
  CommandBody?: string
  Transcript?: string
  ThreadStarterBody?: string
  ThreadHistoryBody?: string
  UntrustedContext?: string[]
  ChatType?: string
  ConversationLabel?: string
  CommandAuthorized?: boolean
  MediaPaths?: string[]
  MediaUrls?: string[]
  MediaPath?: string
  MediaUrl?: string
  MediaType?: string
  MediaTypes?: (string | undefined)[]
  [k: string]: unknown
}

type DeliverInfo = { kind: "text" | "final" | "error" | string }
type DeliverPayload = { text?: string; mediaUrl?: string; mediaUrls?: string[] }

export type DispatcherOptions = {
  deliver: (payload: DeliverPayload, info: DeliverInfo) => Promise<void>
  onError?: (err: unknown, info: DeliverInfo) => void
}

type SessionChunk =
  | { type: "delta"; text: string } // streaming char-by-char
  | { type: "text"; text: string } // complete text part (non-delta mode)
  | { type: "idle" }
  | { type: "error"; message: string }

// ── Global event bus (process singleton) ─────────────────────────────────────
// key = directory, value = Event payload

export const eventBus = new EventEmitter()
eventBus.setMaxListeners(200)

// ── Global event stream (started once from index.ts) ─────────────────────────

export async function startGlobalEventStream(
  globalClient: ReturnType<typeof createOpencodeClient>,
  log: (...args: unknown[]) => void = (...args) => console.log("[channel]", ...args),
): Promise<never> {
  while (true) {
    try {
      log("connecting to event stream...")
      const res = await globalClient.global.event({})
      log("event stream connected")
      for await (const raw of res.stream) {
        const ev = raw as unknown as GlobalEvent
        const dir = ev.directory
        if (dir) eventBus.emit(dir, ev.payload)
      }
      log("event stream ended, reconnecting...")
    } catch (err) {
      log("event stream error, reconnecting...", err)
    }
    eventBus.emit("__disconnect")
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// ── Per-directory client cache ────────────────────────────────────────────────

const clients = new Map<string, ReturnType<typeof createOpencodeClient>>()

export function buildClientFactory(serverUrl: string, username: string, password: string) {
  return function clientFor(dir: string) {
    if (clients.has(dir)) return clients.get(dir)!
    const c = createOpencodeClient({
      baseUrl: serverUrl,
      directory: dir,
      headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
    })
    clients.set(dir, c)
    return c
  }
}

// ── sessionEvents AsyncIterator ───────────────────────────────────────────────

export async function* sessionEvents(params: {
  directory: string
  sessionID: string
  messageID: string
  delta?: boolean
}): AsyncGenerator<SessionChunk> {
  const { directory: dir, sessionID: sid, messageID, delta = true } = params
  const buf: SessionChunk[] = []
  let wake: (() => void) | undefined
  let done = false
  // assistant message IDs whose parentID === messageID (shared by both modes)
  const assistantMsgIds = new Set<string>()
  // delta mode only: text partIDs to forward deltas for
  const partIds = new Set<string>()

  const push = (chunk: SessionChunk) => {
    buf.push(chunk)
    wake?.()
    wake = undefined
  }

  const onEvent = (raw: unknown) => {
    const e = raw as
      | EventMessageUpdated
      | EventMessagePartUpdated
      | EventMessagePartDelta
      | EventSessionIdle
      | EventSessionError
      | { type: string }

    if (e.type === "message.updated") {
      // collect assistant message IDs that belong to this prompt (both modes)
      const msg = (e as EventMessageUpdated).properties.info
      if (msg.sessionID === sid && msg.role === "assistant" && msg.parentID === messageID) {
        assistantMsgIds.add(msg.id)
      }
    } else if (e.type === "message.part.updated") {
      const part = (e as EventMessagePartUpdated).properties.part
      if (part.sessionID !== sid || !assistantMsgIds.has(part.messageID)) return
      if (part.type === "text") {
        if (part.synthetic || part.ignored) return
        partIds.add(part.id)
        if (!delta && part.text && part.time?.end) {
          push({ type: "text", text: part.text })
        }
      }
    } else if (delta && e.type === "message.part.delta") {
      const { sessionID, messageID: mid, partID, delta: text } = (e as EventMessagePartDelta).properties
      if (sessionID !== sid) return
      if (!assistantMsgIds.has(mid)) return
      if (!partIds.has(partID)) return
      push({ type: "delta", text })
    }

    if (e.type === "session.idle") {
      const ev = e as EventSessionIdle
      if (ev.properties.sessionID !== sid) return
      done = true
      push({ type: "idle" })
    } else if (e.type === "session.error") {
      const ev = e as EventSessionError
      if (ev.properties.sessionID && ev.properties.sessionID !== sid) return
      done = true
      const err = ev.properties.error
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "unknown error"
      push({ type: "error", message: msg })
    }
  }

  const onDisconnect = () => {
    if (!done) {
      done = true
      push({ type: "error", message: "server disconnected" })
    }
  }

  eventBus.on(dir, onEvent)
  eventBus.on("__disconnect", onDisconnect)
  try {
    while (true) {
      if (buf.length === 0 && !done) {
        await new Promise<void>((r) => {
          wake = r
        })
      }
      while (buf.length > 0) yield buf.shift()!
      if (done) break
    }
  } finally {
    eventBus.off(dir, onEvent)
    eventBus.off("__disconnect", onDisconnect)
  }
}

// ── normalizeTextField ────────────────────────────────────────────────────────

function normalizeTextField(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  return v.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

// ── finalizeInboundContext ────────────────────────────────────────────────────

export function finalizeInboundContext<T extends MsgContext>(ctx: T): T {
  const c = ctx

  c.Body = normalizeTextField(c.Body) ?? ""
  c.RawBody = normalizeTextField(c.RawBody)
  c.CommandBody = normalizeTextField(c.CommandBody)
  c.Transcript = normalizeTextField(c.Transcript)
  c.ThreadStarterBody = normalizeTextField(c.ThreadStarterBody)
  c.ThreadHistoryBody = normalizeTextField(c.ThreadHistoryBody)
  if (Array.isArray(c.UntrustedContext)) {
    c.UntrustedContext = c.UntrustedContext.map((entry) => normalizeTextField(entry)).filter((entry): entry is string =>
      Boolean(entry),
    )
  }

  // BodyForAgent: 优先上游显式设置，否则 CommandBody → RawBody → Body
  c.BodyForAgent = normalizeTextField(c.BodyForAgent ?? c.CommandBody ?? c.RawBody ?? c.Body) ?? c.Body

  // BodyForCommands: CommandBody → RawBody → Body
  c.BodyForCommands = normalizeTextField(c.BodyForCommands ?? c.CommandBody ?? c.RawBody ?? c.Body) ?? c.Body

  // CommandAuthorized: 默认拒绝
  c.CommandAuthorized = c.CommandAuthorized === true

  // ConversationLabel: trim
  if (typeof c.ConversationLabel === "string") c.ConversationLabel = c.ConversationLabel.trim()

  // MediaType / MediaTypes 对齐
  const pathCount = Array.isArray(c.MediaPaths) ? c.MediaPaths.length : 0
  const urlCount = Array.isArray(c.MediaUrls) ? c.MediaUrls.length : 0
  const single = c.MediaPath || c.MediaUrl ? 1 : 0
  const mediaCount = Math.max(pathCount, urlCount, single)
  if (mediaCount > 0) {
    const DEFAULT = "application/octet-stream"
    const mt = typeof c.MediaType === "string" && c.MediaType.trim() ? c.MediaType.trim() : undefined
    const mts = Array.isArray(c.MediaTypes)
      ? c.MediaTypes.map((v) => (typeof v === "string" && v.trim() ? v.trim() : DEFAULT))
      : undefined
    const filled: string[] =
      mts && mts.length > 0
        ? [...mts, ...Array<string>(Math.max(0, mediaCount - mts.length)).fill(DEFAULT)]
        : Array<string>(mediaCount).fill(mt ?? DEFAULT)
    c.MediaTypes = filled
    c.MediaType = mt ?? filled[0] ?? DEFAULT
  }

  return c
}

// ── dispatchReplyWithBufferedBlockDispatcher ──────────────────────────────────

export function buildRuntimeReply(clientFor: (dir: string) => ReturnType<typeof createOpencodeClient>) {
  return {
    finalizeInboundContext,

    async dispatchReplyWithBufferedBlockDispatcher(params: {
      ctx: MsgContext
      cfg: unknown // openclaw OpenClawConfig — 本适配层不使用
      dispatcherOptions: DispatcherOptions
    }) {
      const {
        ctx,
        dispatcherOptions: { deliver },
      } = params
      const key = ctx.SessionKey

      // 1. 查绑定表
      const binding = await getBinding(key)
      if (!binding) {
        await deliver({ text: "⚠️ 尚未配对。请在 OpenCode Desktop → 设置 → Channel 中完成配对。" }, { kind: "final" })
        return
      }

      // 2. 获取或创建 opencode session
      const client = clientFor(binding.directory)
      let sid = binding.sessionID
      if (!sid) {
        const res = await client.session.create()
        if (res.error) {
          await deliver({ text: "⚠️ 创建 session 失败" }, { kind: "error" })
          return
        }
        sid = res.data.id
        await updateBinding(key, { sessionID: sid })
      }

      // 3. 发消息（promptAsync 立即返回，不阻塞）
      const body = ctx.BodyForAgent ?? ctx.Body ?? ""
      const messageID = Identifier.ascending("message")
      const mimes = ctx.MediaTypes as string[] | undefined
      const fileParts = await Promise.all(
        (ctx.MediaPaths ?? []).map(async (p, i) => {
          const mime = mimes?.[i] ?? "application/octet-stream"
          const buf = await Bun.file(p).arrayBuffer()
          const b64 = Buffer.from(buf).toString("base64")
          return { type: "file" as const, url: `data:${mime};base64,${b64}`, mime }
        }),
      )
      const parts = [{ type: "text" as const, text: body }, ...fileParts]
      const sent = await client.session.promptAsync({ sessionID: sid, messageID, parts })
      if (sent.error) {
        await deliver({ text: "⚠️ 处理失败" }, { kind: "error" })
        return
      }

      // 4. 流式监听事件，通过 deliver 回调实时回传
      for await (const chunk of sessionEvents({
        directory: binding.directory,
        sessionID: sid,
        messageID,
        delta: false,
      })) {
        if (chunk.type === "delta" || chunk.type === "text") {
          await deliver({ text: chunk.text }, { kind: "text" })
        } else if (chunk.type === "idle") {
          break
        } else if (chunk.type === "error") {
          await deliver({ text: `⚠️ 处理失败：${chunk.message}` }, { kind: "error" })
          return
        }
      }

      // 5. 完成
      await deliver({}, { kind: "final" })
    },
  }
}
