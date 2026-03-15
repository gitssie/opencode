# OpenCode Channel 适配层设计文档

**版本**：v4.0  
**日期**：2026-03-14  
**状态**：已确认，待实现

---

## 1. 目标

构建 `packages/channel`，一个**独立 Node.js（Bun）进程**，作为通用 Channel Plugin 适配层：

- 复用任意实现了 openclaw `ChannelPlugin` 接口的插件（企业微信、钉钉、飞书等）
- 无需重写 WebSocket/消息处理逻辑
- 与 opencode 服务通过 HTTP API（`x-opencode-directory` header）通信
- 支持多目录（multi-directory）路由

---

## 2. 系统架构

```
packages/channel/src/index.ts  ← 独立 Bun 进程（进程级单例）
    │
    ├── 读配置：~/.config/opencode/opencode.json { channel: { plugins: [...] } }
    │
    ├── 安装 plugins：bun add --cwd ~/.cache/opencode @wecom/wecom-openclaw-plugin
    │
    ├── 加载 plugins：import('~/.cache/opencode/node_modules/@wecom/wecom-openclaw-plugin')
    │
    ├── 传入模拟 OpenClawPluginApi（runtime 实现）
    │
    ├── 拦截 registerChannel → 获取 channelPlugin 定义
    │
    └── 启动 gateway（WebSocket 连接 × N 个 channel）
            │
            └── 收到消息
                    ↓
                查 ~/.config/opencode/channel-bindings.json
                    ↓
                HTTP POST /session/{id}/message
                headers: { x-opencode-directory: <dir>, Authorization: Basic ... }
                    ↓
                opencode server（sidecar，单一进程管理所有 directory）
```

---

## 3. 目录结构

```
packages/channel/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                  ← 主入口：加载 plugins，启动 gateways
    ├── bindings.ts               ← 绑定表 CRUD（channel-bindings.json）
    ├── install.ts                ← Plugin 自动安装（复用 bun add）
    ├── shims/
    │   └── openclaw-plugin-sdk.ts  ← openclaw/plugin-sdk 的最小 shim
    └── runtime/
        ├── config.ts             ← runtime.config.writeConfigFile
        ├── media.ts              ← runtime.channel.media.*
        ├── pairing.ts            ← runtime.channel.pairing.*
        ├── routing.ts            ← runtime.channel.routing.resolveAgentRoute
        ├── reply.ts              ← runtime.channel.reply.*（核心）
        └── text.ts               ← runtime.channel.text.chunkMarkdownText
```

---

## 4. 配置文件格式

### 4.1 openclaw.json（主配置，用户编辑）

与 openclaw 使用**相同的配置文件名和格式**，位于 `~/.config/opencode/openclaw.json`：

```json
// ~/.config/opencode/openclaw.json
{
  "plugins": ["@wecom/wecom-openclaw-plugin", "@xxx/dingtalk-openclaw-plugin"],
  "channels": {
    "wecom": {
      "botId": "aib-xxx",
      "secret": "xxx",
      "enabled": true,
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

wecom 插件通过 `runtime.config.writeConfigFile(cfg)` 写回此文件（保存登录状态等），我们的适配层只负责读取 `plugins` 字段并转发写操作。

### 4.2 channel-bindings.json（绑定表，程序读写）

```json
// ~/.config/opencode/channel-bindings.json
{
  "pending": {
    "wecom:default:userId123": {
      "code": "D7FJ6399",
      "userId": "userId123",
      "accountId": "default",
      "channel": "wecom",
      "meta": {},
      "createdAt": 1710000000000
    }
  },
  "approved": {
    "wecom:default": ["userId123", "userId456"]
  },
  "bindings": {
    "wecom:default:direct:userId123": {
      "directory": "/home/user/myproject",
      "sessionID": null,
      "pairedAt": 1710000000000
    }
  }
}
```

---

## 5. Plugin 安装机制

```typescript
// src/install.ts
import { $ } from "bun"
import path from "path"
import { xdgCache } from "xdg-basedir"

const cacheDir = path.join(xdgCache!, "opencode")

export async function installPlugin(pkg: string, version = "latest") {
  // 检查是否已安装
  const modPath = path.join(cacheDir, "node_modules", pkg)
  if (await Bun.file(path.join(modPath, "package.json")).exists()) {
    return modPath
  }
  // 安装到 opencode 的 cache 目录（与 opencode 内置 plugin 复用同一目录）
  await $`bun add --exact --cwd ${cacheDir} ${pkg}@${version}`
  return modPath
}
```

---

## 6. openclaw/plugin-sdk Shim

wecom 插件从 `openclaw/plugin-sdk` 导入以下函数，通过 Bun module alias 替换为 shim：

| 函数                       | 实现                       |
| -------------------------- | -------------------------- |
| `DEFAULT_ACCOUNT_ID`       | 常量 `"default"`           |
| `emptyPluginConfigSchema`  | 返回 `{}`                  |
| `formatPairingApproveHint` | 构建提示文本               |
| `addWildcardAllowFrom`     | 追加 `"*"` 到列表          |
| `readJsonFileWithFallback` | `fs.readFile` + JSON.parse |
| `writeJsonFileAtomically`  | 原子写文件（tmp + rename） |
| `withFileLock`             | 进程内 mutex               |

```typescript
// 通过 Bun plugin 在 import 前注册 alias
Bun.plugin({
  name: "openclaw-sdk-shim",
  setup(build) {
    build.onResolve({ filter: /^openclaw\/plugin-sdk/ }, () => ({
      path: new URL("./shims/openclaw-plugin-sdk.ts", import.meta.url).pathname,
    }))
  },
})
```

---

## 7. 模拟 OpenClawPluginApi（fakeApi）

wecom 插件的 `register(api)` 调用：

```typescript
api.registerChannel({ plugin: wecomPlugin }) // 注册 channel
api.on("before_prompt_build", handler) // 注册 hook（暂不使用）
```

wecom 插件通过 `setWeComRuntime(api.runtime)` 存储 runtime，后续通过 `getWeComRuntime()` 调用。

```typescript
function buildFakeApi(serverUrl: string, creds: { username: string; password: string }) {
  const registeredPlugins: ChannelPlugin[] = []

  return {
    registerChannel({ plugin }) {
      registeredPlugins.push(plugin)
    },
    on(_event, _handler) {
      // before_prompt_build hook 暂不处理（不影响核心消息流）
    },
    get registeredPlugins() {
      return registeredPlugins
    },
    runtime: buildRuntime(serverUrl, creds),
  }
}
```

---

## 8. Runtime 实现

### 8.1 runtime.config

```typescript
// 持久化配置（wecom 插件在登出时调用）
async writeConfigFile(cfg) {
  await writeJsonFileAtomically(configPath, cfg)
}
```

### 8.2 runtime.channel.media

```typescript
// 下载远程媒体
async fetchRemoteMedia({ url }) {
  const res = await fetch(url)
  return { buffer: await res.arrayBuffer(), contentType: res.headers.get("content-type") }
}

// 保存媒体到本地
async saveMediaBuffer(buf, mime, dir, maxBytes, filename?) {
  const name = filename ?? `media-${Date.now()}.bin`
  const dest = path.join(dir, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(dest, Buffer.from(buf))
  return { path: dest, contentType: mime }
}
```

### 8.3 runtime.channel.pairing

wecom 插件内置了完整配对流程，当 `dmPolicy = "pairing"` 时自动处理：

1. 用户首次发消息 → 插件调用 `upsertPairingRequest()` 生成配对码
2. 插件调用 `buildPairingReply()` 构建回复文本并发回用户
3. 管理员在 Desktop 配对审批 UI 审批 → 写入 `approved` + `bindings`
4. 用户再次发消息 → `readAllowFromStore()` 返回白名单 → 正常处理

```typescript
// 读取白名单（每条消息前调用）
async readAllowFromStore({ channel, accountId }) {
  const data = await loadBindings()
  return data.approved[`${channel}:${accountId}`] ?? []
}

// 写入配对请求
async upsertPairingRequest({ channel, id, accountId, meta }) {
  const data = await loadBindings()
  const key = `${channel}:${accountId}:${id}`
  if (data.pending[key]) {
    return { code: data.pending[key].code, created: false }
  }
  const code = generateCode()  // 随机 8 位
  data.pending[key] = { code, userId: id, accountId, channel, meta, createdAt: Date.now() }
  await saveBindings(data)
  return { code, created: true }
}

// 构建配对回复文本
buildPairingReply({ channel, idLine, code }) {
  return [
    "OpenCode: access not configured.",
    "",
    idLine,
    "",
    `Pairing code: ${code}`,
    "",
    "Ask the bot owner to approve with:",
    `openclaw pairing approve ${channel} ${code}`,
  ].join("\n")
}
```

### 8.4 runtime.channel.routing

```typescript
// 生成 sessionKey（用于绑定表查找）
resolveAgentRoute({ channel, accountId, peer }) {
  const key = `${channel}:${accountId}:${peer.kind}:${peer.id}`.toLowerCase()
  return { sessionKey: key, agentId: "main" }
}
```

### 8.5 runtime.channel.reply（核心）

#### finalizeInboundContext

此函数并非原样透传，而是对 `MsgContext` 执行一系列规范化处理后返回 `FinalizedMsgContext`：

- **文本字段**：对 `Body`、`RawBody`、`CommandBody`、`Transcript`、`ThreadStarterBody`、`ThreadHistoryBody`、`UntrustedContext` 统一做换行规范化（`normalizeInboundTextNewlines`）和系统标签过滤（`sanitizeInboundSystemTags`）
- **BodyForAgent**：优先使用上游设置的 `BodyForAgent`，否则依次回退到 `CommandBody` → `RawBody` → `Body`，最终写回 `ctx.BodyForAgent`
- **BodyForCommands**：同理从 `CommandBody` → `RawBody` → `Body` 回退
- **ChatType**：通过 `normalizeChatType` 规范化（如 `"group"` / `"direct"` 等）
- **ConversationLabel**：若上游未提供则通过 `resolveConversationLabel` 自动推导
- **CommandAuthorized**：强制设为 `boolean`（默认 `false`，默认拒绝）
- **MediaType / MediaTypes**：有媒体时确保 `MediaType` 已设置，并将 `MediaTypes` 数组补齐到与 `MediaPaths` 等长（缺失项填 `"application/octet-stream"`）

```typescript
finalizeInboundContext(ctx) {
  // 委托给 openclaw 的 finalizeInboundContext 实现
  // 实际逻辑见 openclaw/src/auto-reply/reply/inbound-context.ts
  return finalizeInboundContextImpl(ctx)
}
```

#### dispatchReplyWithBufferedBlockDispatcher（最复杂，核心）

这是适配层的心脏：把 wecom 消息路由到 opencode session，监听事件流等待回复，通过 `deliver` 回调发回给用户。

**关于 opencode SDK 事件机制**：

opencode SDK 使用 `/global/event` SSE 端点，返回 `GlobalEvent { directory, payload }` 格式，所有目录的事件混在同一条流中。进程启动时创建一个全局 `eventBus`（Node.js `EventEmitter`），**以 `directory` 作为事件 key** 广播 payload，监听者通过目录路径订阅所属事件：

```typescript
// 进程级单例：启动一次，全局复用
const eventBus = new EventEmitter()

async function startGlobalEventStream(globalClient: OpencodeClient) {
  while (true) {
    const res = await globalClient.global.event({})
    for await (const event of res.stream) {
      // event = { directory: "/home/user/proj", payload: Event }
      // key 是 directory，payload 是具体事件
      eventBus.emit(event.directory ?? "global", event.payload)
    }
  }
}
```

**关于多目录 client**：

需要为每个 directory 单独创建 client（directory 写入 `x-opencode-directory` header），而不是通过 API 参数传递。建议用 `Map` 缓存：

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
const clients = new Map<string, OpencodeClient>()

function clientFor(dir: string) {
  if (!clients.has(dir)) {
    clients.set(
      dir,
      createOpencodeClient({
        baseUrl: serverUrl,
        directory: dir,
        headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
      }),
    )
  }
  return clients.get(dir)!
}
```

#### dispatchReplyWithBufferedBlockDispatcher 实现

> **注意**：函数签名中的 `cfg` 参数在 openclaw 里是 `OpenClawConfig`（整个 openclaw AI 引擎的配置），在我们的适配层里**完全不使用**——我们不跑 openclaw 的 LLM，而是直接调 opencode SDK。接收但忽略即可。

```typescript
async dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg: _cfg, dispatcherOptions }) {
  const { deliver } = dispatcherOptions
  const key = ctx.SessionKey  // "wecom:default:direct:userId"

  // 1. 查绑定表
  const binding = await getBinding(key)
  if (!binding) {
    await deliver({ text: "⚠️ 尚未配对。请在 OpenCode Desktop → 设置 → Channel 中完成配对。" }, { kind: "final" })
    return
  }

  // 2. 获取或创建 session（使用该 directory 专属的 client）
  //    注意：opencode SDK 的 session.create() 不接受 title 参数
  const client = clientFor(binding.directory)
  let sid = binding.sessionID
  if (!sid) {
    const res = await client.session.create()
    sid = res.data!.id
    await updateBinding(key, { sessionID: sid })
  }

  // 3. 用 promptAsync 发消息（立即返回，不阻塞）
  //    使用 ctx.BodyForAgent（finalizeInboundContext 已规范化），而非原始 ctx.Body
  //    FilePartInput 必须包含 mime 字段
  const parts = [
    { type: "text" as const, text: ctx.BodyForAgent },
    ...(ctx.MediaPaths ?? []).map((p, i) => ({
      type: "file" as const,
      url: p,
      mime: ctx.MediaTypes?.[i] ?? "application/octet-stream",
    })),
  ]
  const sent = await client.session.promptAsync({ sessionID: sid, parts })
  if (sent.error) {
    await deliver({ text: "⚠️ 处理失败" }, { kind: "error" })
    return
  }

  // 4. 通过全局 eventBus 流式监听该 session 的事件
  //    监听 key = binding.directory（GlobalEvent 以 directory 作为 emit key）
  //    使用 AsyncIterator 逐 delta 实时回传，实现流式 deliver
  for await (const chunk of sessionEvents(binding.directory, sid)) {
    if (chunk.type === "delta") {
      await deliver({ text: chunk.text }, { kind: "text" })
    } else if (chunk.type === "idle") {
      break
    } else if (chunk.type === "error") {
      await deliver({ text: `⚠️ 处理失败：${chunk.message}` }, { kind: "error" })
      return
    }
  }

  // 5. 标记完成
  await deliver({}, { kind: "final" })
}
```

**关键设计要点**：

| 方案                                   | 说明                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `session.prompt`（同步）               | HTTP 长轮询，等 Agent 完成才返回。简单但不支持流式输出，且 channel 进程会阻塞等待 |
| `session.promptAsync` + 事件流（推荐） | 立即返回，通过全局 eventBus 监听 `session.idle` 事件得知完成，支持流式 deliver    |

**`sessionEvents` AsyncIterator 实现**：

将 `eventBus`（key = directory）的事件包装为 AsyncIterator，实现流式 deliver。

参考 Desktop App 的事件订阅方式（`global-sync.tsx`）：

- `eventBus.on(directory, handler)`：监听特定目录，handler 直接接收 `Event payload`
- `eventBus.listen(handler)`：监听所有目录，handler 接收 `{ name: directory, details: payload }`

channel 进程用 Node.js `EventEmitter` 模拟，key 为 directory：

```typescript
type SessionChunk = { type: "delta"; text: string } | { type: "idle" } | { type: "error"; message: string }

// eventBus.on(directory, (event: Event) => void)
// event.type 区分具体事件类型，event.properties 包含 sessionID 等信息

async function* sessionEvents(dir: string, sid: string): AsyncGenerator<SessionChunk> {
  const buf: SessionChunk[] = []
  let wake: (() => void) | undefined
  let done = false

  const push = (chunk: SessionChunk) => {
    buf.push(chunk)
    wake?.()
    wake = undefined
  }

  // 监听该 directory 下的所有事件 payload（与 global-sync.tsx 的 event.on(directory) 对应）
  const onEvent = (e: Event) => {
    if (e.type === "message.part.delta") {
      if (e.properties.sessionID !== sid || e.properties.field !== "text") return
      push({ type: "delta", text: e.properties.delta })
    } else if (e.type === "session.idle") {
      if (e.properties.sessionID !== sid) return
      done = true
      push({ type: "idle" })
    } else if (e.type === "session.error") {
      if (e.properties.sessionID && e.properties.sessionID !== sid) return
      done = true
      const err = e.properties.error
      const msg =
        err && typeof err === "object" && "message" in err ? String((err as { message: string }).message) : "unknown"
      push({ type: "error", message: msg })
    }
  }

  eventBus.on(dir, onEvent)

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
  }
}
```

**事件流架构说明**（与 Desktop App 共用机制）：

opencode 的 Desktop App（`packages/app/src/context/global-sdk.tsx`）使用完全相同的模式：

- 单一 `/global/event` SSE 流，返回 `GlobalEvent { directory, payload }`
- 全局 `emitter.emit(event.directory, event.payload)` 广播
- 各目录订阅方通过 `emitter.on(directory, handler)` 过滤自己关心的事件

channel 适配层采用一致的架构，用 Node.js `EventEmitter` 替代 SolidJS 的 `createGlobalEmitter`，行为完全对等。

### 8.6 runtime.channel.text

```typescript
chunkMarkdownText(text, limit) {
  if (text.length <= limit) return [text]
  const chunks = []
  let i = 0
  while (i < text.length) {
    chunks.push(text.slice(i, i + limit))
    i += limit
  }
  return chunks
}
```

---

## 9. 多 Directory 路由

### 9.1 问题

opencode 是以 directory 为核心的系统。WeCom bot 需要知道：收到某个用户的消息，应该在哪个 directory 下操作 session？

### 9.2 opencode Server 的 directory 机制

```
opencode serve（单一进程）
    └── 每个 HTTP 请求携带 x-opencode-directory header
            └── 服务器中间件根据 directory 激活对应 Instance（项目上下文）
                    └── 同一 directory 的 Session 共享同一个 project/db
```

SDK 层面：`directory` 写入 client 的固定 header，而非每次 API 调用的参数：

```typescript
// 为每个 directory 创建独立 client（directory → x-opencode-directory header）
const client = createOpencodeClient({
  baseUrl: "http://127.0.0.1:4096",
  directory: "/home/user/myproject",
  headers: { Authorization: "Basic ..." },
})

// 调用时不再需要传 directory 参数
await client.session.create({ title: "..." })
await client.session.promptAsync({ sessionID: sid, parts })
```

**事件流独立于 client**：事件通过 `/global/event`（无 directory 参数）统一推送，channel 进程全局只有一个 `eventBus`，通过 `directory` key 路由 payload。

### 9.3 Directory 来源

通过**配对流程**确定：

```
1. 用户首次发 WeCom 消息 → 收到配对码
2. 管理员在 Desktop 审批 UI：
   - 看到配对请求（userId + 配对码）
   - 从已打开的项目列表中选择绑定哪个 directory
   - 点击"批准"
3. 适配层将 { userId → directory } 写入 channel-bindings.json
4. 后续消息 → 查绑定表 → 用 clientFor(directory) 操作 session
```

### 9.4 clientFor 实现

```typescript
const clients = new Map<string, OpencodeClient>()

function clientFor(dir: string) {
  if (clients.has(dir)) return clients.get(dir)!
  const client = createOpencodeClient({
    baseUrl: serverUrl,
    directory: dir,
    headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
  })
  clients.set(dir, client)
  return client
}
```

---

## 10. 进程启动方式

### 10.1 由 Rust (Tauri) 启动

```rust
// src-tauri/src/lib.rs initialize() 里，sidecar 启动后
tokio::spawn(async move {
    if let Err(e) = spawn_channel_process(&url, &password).await {
        tracing::error!("Failed to start channel process: {e}");
    }
});
```

通过环境变量传递 server 信息：

```
OPENCODE_SERVER_URL=http://127.0.0.1:4096
OPENCODE_SERVER_PASSWORD=<uuid>
OPENCODE_SERVER_USERNAME=opencode
```

### 10.2 手动启动（CLI / 开发调试）

```bash
OPENCODE_SERVER_URL=http://127.0.0.1:4096 \
OPENCODE_SERVER_PASSWORD=xxx \
bun run packages/channel/src/index.ts
```

---

## 11. Desktop 配对审批 UI

在 `packages/app/src/` 里新增配对管理界面，通过 opencode 的自定义 API 端点或本地文件实现：

```
设置 → Channel Tab（新增）
    ├── 待审批列表
    │   └── 配对请求卡片：
    │       ├── 用户 ID：userId123
    │       ├── 配对码：D7FJ6399
    │       ├── 申请时间：2 分钟前
    │       ├── 绑定目录：[下拉选择] /home/user/myproject ▼
    │       └── [批准] [拒绝]
    └── 已绑定列表
        └── userId123 → /home/user/myproject  [解绑]
```

**审批操作**（前端通过 Tauri command 或直接读写 channel-bindings.json）：

```typescript
async function approvePairing(code: string, directory: string) {
  const data = await loadBindings()
  const entry = Object.values(data.pending).find((p) => p.code === code)
  if (!entry) throw new Error("配对码不存在或已过期")

  // 加入白名单
  const approvedKey = `${entry.channel}:${entry.accountId}`
  data.approved[approvedKey] = [...(data.approved[approvedKey] ?? []), entry.userId]

  // 写入绑定
  const bindingKey = `${entry.channel}:${entry.accountId}:direct:${entry.userId}`
  data.bindings[bindingKey] = { directory, sessionID: null, pairedAt: Date.now() }

  // 清除待审批
  delete data.pending[`${entry.channel}:${entry.accountId}:${entry.userId}`]
  await saveBindings(data)
}
```

---

## 12. 实现优先级

| 阶段              | 内容                                                                                              | 预估代码量 |
| ----------------- | ------------------------------------------------------------------------------------------------- | ---------- |
| **阶段一（MVP）** | 文本消息端到端：WeCom → opencode session → 回复；pairing = open（无配对，直接使用默认 directory） | ~400 行    |
| **阶段二**        | 配对流程（pairing = pairing）；Desktop 审批 UI                                                    | ~300 行    |
| **阶段三**        | 媒体文件（图片/文件）；流式回复                                                                   | ~200 行    |
| **阶段四**        | 群聊支持；多 channel（钉钉/飞书同时运行）                                                         | ~100 行    |

---

## 13. 关键文件清单

| 文件                                                | 作用                                     |
| --------------------------------------------------- | ---------------------------------------- |
| `packages/channel/src/index.ts`                     | 进程入口                                 |
| `packages/channel/src/install.ts`                   | Plugin 自动安装                          |
| `packages/channel/src/bindings.ts`                  | 绑定表读写                               |
| `packages/channel/src/shims/openclaw-plugin-sdk.ts` | openclaw/plugin-sdk shim                 |
| `packages/channel/src/runtime/reply.ts`             | dispatchReplyWithBufferedBlockDispatcher |
| `packages/channel/src/runtime/pairing.ts`           | 配对流程                                 |
| `packages/channel/src/runtime/routing.ts`           | resolveAgentRoute                        |
| `~/.config/opencode/opencode.json`                  | 用户配置（channel.plugins）              |
| `~/.config/opencode/channel-bindings.json`          | 绑定表（运行时读写）                     |

---

## 14. 参考

- wecom 插件源码：`/opt/node-v22.17.1-linux-x64/lib/node_modules/@wecom/wecom-openclaw-plugin/dist/index.esm.js`
- Slack bot 参考实现：`packages/slack/src/index.ts`（145 行）
- opencode SDK：`packages/sdk/js/src/`
- opencode Plugin 系统：`packages/opencode/src/plugin/index.ts`
- opencode BunProc.install：`packages/opencode/src/bun/index.ts`
- openclaw plugin-sdk 源码：`/root/workspace/github/openclaw/src/plugin-sdk/`
- Desktop Tauri 主进程：`packages/desktop/src-tauri/src/lib.rs`
