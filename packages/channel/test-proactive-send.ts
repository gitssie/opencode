/**
 * test-proactive-send.ts
 *
 * 测试 wecom 插件是否支持主动发送消息（不依赖 request/reply 流程）
 *
 * 运行方式:
 *   TO=<wecom:userId 或 userId>  TEXT=<消息内容>  bun run test-proactive-send.ts
 *
 * 例如:
 *   TO=wecom:liming  TEXT="Hello from opencode"  bun run test-proactive-send.ts
 *
 * 前提：channel 进程已经把 gateway 启动好（wsClient 已连接），否则会报 WSClient not connected。
 * 本脚本通过动态导入插件并调用 outbound.sendText 来测试。
 */

import path from "node:path"
import { xdgConfig } from "xdg-basedir"
import { xdgCache } from "xdg-basedir"

// ── Shim: openclaw/plugin-sdk ─────────────────────────────────────────────────

Bun.plugin({
  name: "openclaw-sdk-shim",
  setup(build) {
    build.onResolve({ filter: /^openclaw\/plugin-sdk/ }, () => ({
      path: new URL("./src/shims/openclaw-plugin-sdk.ts", import.meta.url).pathname,
    }))
  },
})

// ── Config ────────────────────────────────────────────────────────────────────

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

// ── Minimal fake runtime (no server needed) ───────────────────────────────────

function buildFakeRuntime() {
  return {
    config: {
      read: async () => ({}),
      write: async () => {},
    },
    channel: {
      text: {
        chunkMarkdownText: (text: string, _limit: number) => [text],
      },
      media: {} as never,
      pairing: {} as never,
      routing: {} as never,
      reply: {} as never,
    },
    error: (...args: unknown[]) => console.error("[test]", ...args),
  }
}

// ── Plugin loader ─────────────────────────────────────────────────────────────

type ChannelPlugin = {
  id: string
  config?: { resolveAccount?: (cfg: OpenclawConfig) => unknown }
  gateway?: { startAccount: (ctx: unknown) => void | Promise<void> }
  outbound?: {
    sendText?: (params: { to: string; text: string; accountId?: string }) => Promise<unknown>
    sendMedia?: (params: { to: string; text?: string; mediaUrl?: string; accountId?: string }) => Promise<unknown>
  }
}

type FakeApi = {
  registerChannel: (opts: { plugin: ChannelPlugin }) => void
  on: (_event: string, _handler: unknown) => void
  plugins: ChannelPlugin[]
  runtime: ReturnType<typeof buildFakeRuntime>
}

function buildFakeApi(runtime: ReturnType<typeof buildFakeRuntime>): FakeApi {
  const plugins: ChannelPlugin[] = []
  return {
    registerChannel({ plugin }) {
      plugins.push(plugin)
    },
    on(_e, _h) {},
    get plugins() {
      return plugins
    },
    runtime,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const to = process.env.TO
  const text = process.env.TEXT ?? "Hello from opencode channel test"

  if (!to) {
    console.error("Usage: TO=<userId> TEXT=<message> bun run test-proactive-send.ts")
    process.exit(1)
  }

  const cfg = await loadConfig()
  const pkgs = cfg.plugins ?? []
  if (pkgs.length === 0) {
    console.error("No plugins in ~/.config/opencode/openclaw.json")
    process.exit(1)
  }

  const runtime = buildFakeRuntime()
  const api = buildFakeApi(runtime)

  // Load plugins
  for (const pkg of pkgs) {
    const modPath = path.join(xdgCache!, "opencode", "node_modules", pkg)
    console.log(`[test] Loading plugin from: ${modPath}`)
    try {
      const mod = await import(path.join(modPath, "dist", "index.esm.js"))
      const register = mod.default?.register ?? mod.register
      if (typeof register === "function") await register(api)
    } catch (err) {
      console.error(`[test] Failed to load plugin ${pkg}:`, err)
      process.exit(1)
    }
  }

  console.log(`[test] Loaded ${api.plugins.length} plugin(s)`)

  // Find wecom plugin
  const wecom = api.plugins.find((p) => p.id === "wecom")
  if (!wecom) {
    console.error("[test] wecom plugin not found")
    process.exit(1)
  }

  // Start gateway (establishes wsClient connection)
  const account = wecom.config?.resolveAccount?.(cfg)
  console.log("[test] Resolved account:", JSON.stringify(account, null, 2))

  if (!wecom.gateway?.startAccount) {
    console.error("[test] wecom plugin has no gateway.startAccount")
    process.exit(1)
  }

  const ac = new AbortController()
  console.log("[test] Starting gateway (connecting WebSocket)...")

  // We need to wait for wsClient to connect before sending.
  // The gateway runs indefinitely; we just need the initial connect, so we give it 5s.
  const gatewayPromise = Promise.resolve(wecom.gateway.startAccount({ account, cfg, runtime, abortSignal: ac.signal }))
  gatewayPromise.catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.name !== "AbortError") {
      console.error("[test] Gateway error:", err)
    }
  })

  await new Promise((r) => setTimeout(r, 3000))
  console.log("[test] Gateway started (3s wait). Attempting proactive send...")

  if (!wecom.outbound?.sendText) {
    console.error("[test] wecom.outbound.sendText not available")
    ac.abort()
    process.exit(1)
  }

  try {
    const result = await wecom.outbound.sendText({ to, text })
    console.log("[test] ✅ sendText succeeded:", JSON.stringify(result, null, 2))
  } catch (err) {
    console.error("[test] ❌ sendText failed:", err)
  }

  ac.abort()
  process.exit(0)
}

main().catch((err) => {
  console.error("[test] Fatal:", err)
  process.exit(1)
})
