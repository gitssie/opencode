/**
 * packages/channel/src/index.ts
 *
 * 独立 Bun 进程入口：
 *   1. 读取 ~/.config/opencode/openclaw.json（plugins + channels）
 *   2. 安装插件（bun add 到 ~/.cache/opencode）
 *   3. 注册 openclaw/plugin-sdk shim（通过 Bun.plugin）
 *   4. 动态导入插件，调用 register(fakeApi)，拦截 registerChannel
 *   5. 启动全局 /global/event 事件流
 *   6. 为每个 channel plugin 调用 gateway.startAccount(ctx) 启动连接
 */

import path from "node:path"
import { xdgConfig, xdgState } from "xdg-basedir"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { installPlugin } from "./install.ts"
import { buildRuntimeConfig } from "./runtime/config.ts"
import { buildRuntimeMedia } from "./runtime/media.ts"
import { buildRuntimePairing } from "./runtime/pairing.ts"
import { buildRuntimeRouting } from "./runtime/routing.ts"
import { buildRuntimeReply, buildClientFactory, startGlobalEventStream } from "./runtime/reply.ts"
import { buildRuntimeText } from "./runtime/text.ts"
import { getBinding, updateBinding } from "./bindings.ts"
import { CronService } from "./cron/service.ts"

// ── 环境变量 ──────────────────────────────────────────────────────────────────

const serverUrl = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
const password = process.env.OPENCODE_SERVER_PASSWORD ?? ""
const verbose = process.env.LOG_LEVEL === "debug"

// ── Bun plugin: 注册 openclaw/plugin-sdk shim ─────────────────────────────────

Bun.plugin({
  name: "openclaw-sdk-shim",
  setup(build) {
    build.onResolve({ filter: /^openclaw\/plugin-sdk/ }, () => ({
      path: new URL("./shims/openclaw-plugin-sdk.ts", import.meta.url).pathname,
    }))
  },
})

// ── 配置文件 ──────────────────────────────────────────────────────────────────

type OpenclawConfig = {
  plugins?: string[]
  channels?: Record<string, unknown>
  [k: string]: unknown
}

async function loadConfig(): Promise<OpenclawConfig> {
  const file = Bun.file(path.join(xdgConfig!, "opencode", "openclaw.json"))
  if (!(await file.exists())) return {}
  return file.json() as Promise<OpenclawConfig>
}

// ── Runtime ───────────────────────────────────────────────────────────────────

function buildRuntime(clientFor: ReturnType<typeof buildClientFactory>) {
  const mediaDir = path.join(xdgState!, "opencode", "channel", "media")
  return {
    config: buildRuntimeConfig(),
    channel: {
      reply: buildRuntimeReply(clientFor),
      media: buildRuntimeMedia(mediaDir),
      pairing: buildRuntimePairing(),
      routing: buildRuntimeRouting(),
      text: buildRuntimeText(),
    },
    log: verbose ? (...args: unknown[]) => console.log("[channel]", ...args) : undefined,
    error: (...args: unknown[]) => console.error("[channel]", ...args),
  }
}

// ── ChannelPlugin 类型（openclaw gateway 接口最小子集）────────────────────────

type GatewayCtx = {
  account: unknown
  cfg: OpenclawConfig
  runtime: ReturnType<typeof buildRuntime>
  abortSignal?: AbortSignal
}

type ChannelPlugin = {
  id: string
  config?: {
    resolveAccount?: (cfg: OpenclawConfig) => unknown
  }
  gateway?: {
    startAccount: (ctx: GatewayCtx) => void | Promise<void>
  }
}

// ── fakeApi ───────────────────────────────────────────────────────────────────

function buildFakeApi(runtime: ReturnType<typeof buildRuntime>) {
  const plugins: ChannelPlugin[] = []

  return {
    registerChannel({ plugin }: { plugin: ChannelPlugin }) {
      plugins.push(plugin)
    },
    on(_event: string, _handler: unknown) {
      // before_prompt_build 等 hook 暂不处理
    },
    get plugins() {
      return plugins
    },
    runtime,
  }
}

// ── CronService setup ─────────────────────────────────────────────────────────

function buildRunAgentJob(clientFor: ReturnType<typeof buildClientFactory>) {
  return async function runAgentJob({
    job,
    sessionKey,
    abortSignal,
  }: {
    job: import("./cron/types.ts").CronJob
    sessionKey: string
    abortSignal?: AbortSignal
  }) {
    const binding = await getBinding(sessionKey)
    if (!binding) return { text: "", status: "error" as const, error: `no binding: ${sessionKey}` }

    const client = clientFor(binding.directory)
    let sid = binding.sessionID
    if (!sid) {
      const res = await client.session.create()
      if (res.error) return { text: "", status: "error" as const, error: "create session failed" }
      sid = res.data.id
      await updateBinding(sessionKey, { sessionID: sid })
    }

    if (abortSignal?.aborted) return { text: "", status: "error" as const, error: "aborted" }

    const payload = job.payload
    if (payload.kind !== "agentTurn") return { text: "", status: "error" as const, error: "not agentTurn" }

    const res = await client.session.prompt({
      sessionID: sid,
      parts: [{ type: "text", text: payload.message }],
    })
    if (res.error) return { text: "", status: "error" as const, error: "prompt failed" }

    const text = res.data.parts
      .filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
    return { text, status: "ok" as const }
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = await loadConfig()
  const pkgs = cfg.plugins ?? []

  if (pkgs.length === 0) {
    console.log("[channel] No plugins configured in ~/.config/opencode/openclaw.json")
    return
  }

  // 全局 client（用于 /global/event SSE，无 directory header）
  const globalClient = createOpencodeClient({
    baseUrl: serverUrl,
    headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
  })

  const clientFor = buildClientFactory(serverUrl, username, password)
  const runtime = buildRuntime(clientFor)
  const api = buildFakeApi(runtime)

  // 安装并加载插件
  for (const pkg of pkgs) {
    console.log(`[channel] Installing plugin: ${pkg}`)
    const modPath = await installPlugin(pkg)
    const mod = await import(path.join(modPath, "dist", "index.esm.js"))
    const register = mod.default?.register ?? mod.register
    if (typeof register === "function") {
      await register(api)
    } else {
      console.warn(`[channel] Plugin ${pkg} has no register() export`)
    }
  }

  console.log(`[channel] Loaded ${api.plugins.length} channel plugin(s)`)

  // 启动全局事件流（后台，不 await）
  startGlobalEventStream(globalClient).catch((err) => {
    console.error("[channel] Global event stream error:", err)
  })

  // 为每个 channel plugin 启动 gateway
  // openclaw 的启动入口是 plugin.gateway.startAccount(ctx)，不是 plugin.start()
  for (const plugin of api.plugins) {
    if (!plugin.gateway?.startAccount) {
      console.warn(`[channel] Plugin ${plugin.id} has no gateway.startAccount, skipping`)
      continue
    }
    const account = plugin.config?.resolveAccount?.(cfg)
    const ac = new AbortController()
    Promise.resolve(plugin.gateway.startAccount({ account, cfg, runtime, abortSignal: ac.signal })).catch(
      (err: unknown) => {
        console.error(`[channel] Plugin ${plugin.id} gateway error:`, err)
      },
    )
    console.log(`[channel] Started gateway for plugin: ${plugin.id}`)
  }

  // 启动 CronService
  const cron = new CronService({
    storePath: path.join(xdgConfig!, "opencode", "cron", "jobs.json"),
    runAgentJob: buildRunAgentJob(clientFor),
    sendText: async ({ to, text, accountId }) => {
      const pluginId = to.split(":")[0]
      const plugin = api.plugins.find((p) => p.id === pluginId) as
        | (ChannelPlugin & {
            outbound?: { sendText?: (p: { to: string; text: string; accountId?: string }) => Promise<void> }
          })
        | undefined
      if (!plugin?.outbound?.sendText) throw new Error(`no outbound.sendText for plugin ${pluginId}`)
      await plugin.outbound.sendText({ to, text, accountId })
    },
    onEvent: (evt) => {
      const extra =
        evt.action === "finished"
          ? `${evt.status} ${evt.nextRunAtMs ? `next=${new Date(evt.nextRunAtMs).toISOString()}` : ""}`
          : evt.action === "alert"
            ? `to=${evt.to}`
            : evt.action === "missed"
              ? `count=${evt.count}`
              : ""
      console.log("[cron]", evt.action, evt.jobId, extra)
    },
  })
  await cron.start()
  console.log("[channel] CronService started")
}

main().catch((err) => {
  console.error("[channel] Fatal error:", err)
  process.exit(1)
})
