# Channel Adapter — Cron/Schedule 功能设计文档

## 目标

在 `packages/channel` 中实现与 openclaw CronService 功能最大程度兼容的定时任务系统，
支持三种 schedule 模式（at / every / cron）、两种 payload 类型（agentTurn / systemEvent）、
cron stagger、启动追赶、错误退避、failureAlert，
并通过 `outbound.sendText` 主动推送结果。

---

## openclaw CronService 核心机制（深度分析）

### 架构层次

```
CronService (service.ts, 60行)
  └── CronServiceState
        ├── store.ts          — 加载/保存 jobs.json（原子写 + .bak 备份）
        ├── jobs.ts (900行)   — nextRunAtMs 计算（含 stagger）、job 增删改查
        ├── timer.ts (1261行) — tick loop、执行引擎、启动追赶、错误退避
        └── ops.ts (593行)    — add/update/remove/run API
```

### sessionTarget 的两种模式

| sessionTarget | payload              | 执行方式                                                                            |
| ------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `"main"`      | 只支持 `systemEvent` | 往主 session 注入系统事件 → heartbeat 触发 AI 响应 → `delivery.channel="last"` 推送 |
| `"isolated"`  | 只支持 `agentTurn`   | 独立 AI 会话执行 → delivery 推送                                                    |

**我们只实现 `isolated` 模式**（active prompt → active push）。`main` 模式依赖 openclaw 主会话和 heartbeat 机制，无法移植。

### delivery.channel="last" 语义

openclaw 的 `"last"` 表示「推送到该 session 上次收到消息的 channel」，通过 `SessionEntry.lastChannel`（存在 sessions.json 里）来追踪。

**我们的实现**：`delivery.channel` 字段不支持 `"last"`；默认从 `job.sessionKey` 派生推送目标，或显式在 `delivery.to` 中指定。

### Cron Stagger（cron 表达式的随机抖动）

问题：所有 cron 任务在整点触发时会同时涌入。

openclaw 的解法：

- `job.schedule.staggerMs`（显式配置）或自动规则（`* * * * *` 整点 → 默认 5 分钟抖动窗口）
- 每个 job 的抖动量 = `SHA-256(jobId) % staggerMs`（确定性，重启不变）
- 效果：`cron "0 * * * *"` 的 jobA 在 :00:32，jobB 在 :02:17，不会同时执行

**我们完整实现 stagger**（从 `jobs.ts` 移植 `computeStaggeredCronNextRunAtMs`）。

### 启动追赶（Missed Jobs Catchup）

进程重启后，检查哪些 job 在停机期间应该执行了但没执行：

- 最多立即追赶 5 个（`maxMissedJobsPerRestart`）
- 超出部分按 `missedJobStaggerMs=5000ms` 错开执行（防止网关过载）
- 判断依据：`computePreviousRunAtMs(schedule) > job.state.lastRunAtMs`（已有运行记录才追赶）

**我们实现相同策略**。

### 错误退避策略

```
consecutiveErrors: 1 → 延迟 30 秒
consecutiveErrors: 2 → 延迟 1 分钟
consecutiveErrors: 3 → 延迟 5 分钟
consecutiveErrors: 4 → 延迟 15 分钟
consecutiveErrors: 5+ → 延迟 60 分钟
```

`at`（一次性）任务：

- 瞬时错误模式（rate limit / 网络 / 5xx）：最多重试 3 次，退避用前 3 个值
- 永久错误或重试耗尽：`job.enabled = false`（不删除，保留错误状态）

`every` / `cron` 任务：

- 失败后 `nextRunAtMs = lastRunAtMs + backoff[consecutiveErrors]`，不 disable

### failureAlert

连续失败 N 次（默认 2 次）后，发告警消息到指定目标，并有冷却时间（默认 1 小时）：

```ts
job.failureAlert = {
  after: 2, // 连续失败几次后告警
  channel: "wecom", // 告警发到哪个 channel
  to: "wecom:admin", // 告警接收者
  cooldownMs: 3600_000, // 冷却时间（避免持续轰炸）
}
```

---

## 可直接复用的文件（无 openclaw 特定依赖）

| 文件                   | 行数 | 外部依赖                                  | 处理方式                                   |
| ---------------------- | ---- | ----------------------------------------- | ------------------------------------------ |
| `cron/parse.ts`        | 31   | 无                                        | ✅ 直接复制                                |
| `cron/types-shared.ts` | 18   | 无                                        | ✅ 直接复制                                |
| `cron/schedule.ts`     | 170  | `croner`                                  | ✅ 直接复制                                |
| `cron/stagger.ts`      | 60   | `./types`                                 | ✅ 直接复制                                |
| `cron/store.ts`        | 131  | `expandHomePrefix`、`CONFIG_DIR`、`JSON5` | ✅ 改路径常量（用 xdg-basedir + Bun.file） |

### 需要重写的部分

| openclaw 组件                            | 原因                                                                                     | 我们的替代                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| `service/timer.ts` (1261行)              | 依赖 `agents/`、`infra/heartbeat-wake`、`infra/outbound/deliver`（多 channel send 系统） | 重写执行核心（~300行）                 |
| `service/jobs.ts` (900行)                | 依赖 `process/command-queue`、`routing/session-key`                                      | 移植 stagger/nextRunAt 逻辑，简化 CRUD |
| `service/ops.ts` (593行)                 | 同上                                                                                     | 简化为 add/update/remove/list          |
| `cron/delivery.ts` (301行)               | 依赖完整 outbound 系统                                                                   | 直接调 `plugin.outbound.sendText`      |
| `cron/isolated-agent/delivery-target.ts` | 依赖 session store + allowFrom + whatsapp 特殊处理                                       | 用 bindings.ts 派生 to                 |

---

## 我们的实现方案

### 文件结构

```
packages/channel/src/cron/
  parse.ts     — parseAbsoluteTimeMs（直接复制 openclaw）
  schedule.ts  — computeNextRunAtMs/computePreviousRunAtMs（直接复制 openclaw）
  stagger.ts   — resolveCronStaggerMs（直接复制 openclaw）
  types.ts     — 数据类型（与 openclaw 兼容）
  store.ts     — JSON 读写（简化版，Bun.file + xdg-basedir）
  jobs.ts      — nextRunAtMs 计算（含 stagger），job 增删改查
  service.ts   — CronService 主类（tick loop + 执行引擎）
```

### 数据类型（types.ts）

与 openclaw 完全兼容的字段（不含 main sessionTarget 相关）：

```ts
type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }

type CronPayload =
  | { kind: "systemEvent"; text: string } // 直接推送固定文本
  | { kind: "agentTurn"; message: string; model?: string; timeoutSeconds?: number }

type CronDelivery = {
  mode: "none" | "announce"
  channel?: string // "wecom" | ... （不支持 "last"）
  to?: string // userId or chatId，可含 channel 前缀
  accountId?: string
}

type CronFailureAlert = {
  after?: number // 连续失败后告警（默认 2）
  channel?: string
  to?: string
  cooldownMs?: number // 冷却时间（默认 3600_000）
  accountId?: string
}

type CronJob = {
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
  sessionKey?: string // 关联 bindings 中的 key（agentTurn 执行目标 + 推送目标默认值）
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

type CronStoreFile = { version: 1; jobs: CronJob[] }
```

### jobs.ts — nextRunAtMs 计算（含 stagger）

从 openclaw `service/jobs.ts` 移植核心函数，去掉与主进程的耦合：

```ts
// 含 stagger 的 nextRunAtMs（cron 表达式 job 专用）
export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined
// previousRunAtMs（用于 missed job 检测）
export function computeJobPreviousRunAtMs(job: CronJob, nowMs: number): number | undefined
// isRunnableJob（是否 due）
export function isRunnableJob(
  job: CronJob,
  nowMs: number,
  opts?: { skipAtIfAlreadyRan?: boolean; allowCronMissedRun?: boolean },
): boolean
```

### store.ts

```ts
const DEFAULT_STORE_PATH = path.join(xdgConfig!, "opencode", "cron", "jobs.json")

export async function loadCronStore(p?: string): Promise<CronStoreFile>
export async function saveCronStore(p: string, store: CronStoreFile): Promise<void>
// 原子写：写 .tmp → rename，写前保存 .bak 备份（与 openclaw 一致）
```

### service.ts — CronService 类

```ts
class CronService {
  constructor(deps: CronServiceDeps)

  // 生命周期
  start(): void // 启动追赶 + armTimer
  stop(): void // clearTimeout

  // CRUD（与 openclaw CronService 接口对齐）
  async add(input: CronJobCreate): Promise<CronJob>
  async update(id: string, patch: CronJobPatch): Promise<CronJob | undefined>
  async remove(id: string): Promise<boolean>
  async list(): Promise<CronJob[]>
  getJob(id: string): CronJob | undefined
  async runNow(id: string): Promise<void> // 强制立即执行

  status(): {
    enabled: boolean
    storePath: string
    jobs: number
    nextWakeAtMs: number | null
  }
}
```

### CronServiceDeps

```ts
type CronServiceDeps = {
  storePath?: string
  maxConcurrentRuns?: number // 默认 1
  maxMissedJobsPerRestart?: number // 默认 5
  missedJobStaggerMs?: number // 默认 5000ms

  // agentTurn 执行（在 index.ts 注入）
  runAgentJob: (params: {
    job: CronJob
    sessionKey: string
    abortSignal?: AbortSignal
  }) => Promise<{ text: string; status: "ok" | "error" | "skipped"; error?: string }>

  // 主动推送文本（在 index.ts 注入，调 plugin.outbound.sendText）
  sendText: (params: { to: string; text: string; accountId?: string }) => Promise<void>

  // 可选
  nowMs?: () => number
  onEvent?: (evt: CronEvent) => void
  log?: (...args: unknown[]) => void
}
```

### 执行流程（service.ts 内部）

```
start()
  → runMissedJobs()    // 启动追赶（最多 5 个，其余 stagger 到未来）
  → armTimer()

armTimer()
  → nextWakeAtMs = min(job.state.nextRunAtMs) for all enabled jobs
  → setTimeout(tick, clamp(nextWakeAtMs - now, 0, 60_000))

tick()
  → loadCronStore()（支持外部修改文件）
  → jobs = collectRunnableJobs(nowMs)  // enabled && nextRunAtMs <= now
  → 并发执行（受 maxConcurrentRuns 限制）
  → for each job: executeJob(job)
  → armTimer()

executeJob(job)
  → emit("started")
  → coreResult = await executeJobCoreWithTimeout(job)  // 含 AbortController 超时
  → if coreResult.status !== "skipped" && delivery.mode === "announce":
      to = resolveTo(job)
      await deps.sendText({ to, text: coreResult.text, accountId: delivery.accountId })
  → applyJobResult(job, coreResult)  // 更新 state + 退避 + deleteAfterRun + failureAlert
  → saveCronStore()
  → emit("finished")

executeJobCore(job)
  → if payload.kind === "agentTurn":
      sessionKey = job.sessionKey ?? resolveFromDelivery(job)
      return deps.runAgentJob({ job, sessionKey })
  → if payload.kind === "systemEvent":
      return { text: job.payload.text, status: "ok" }

applyJobResult(job, result)
  → job.state.lastRunAtMs = startedAt
  → job.state.lastRunStatus = status
  → job.state.lastDurationMs = endedAt - startedAt
  → if error:
      consecutiveErrors++
      if failureAlert && consecutiveErrors >= alert.after:
        if !inCooldown: deps.sendText(alertTo, alertText); lastFailureAlertAtMs = now
      nextRunAtMs = lastRunAtMs + backoff[consecutiveErrors]  // 退避
      if schedule.kind === "at" && (!transient || consecutive > maxRetries):
        job.enabled = false                                    // 永久失败 → disable
  → else:
      consecutiveErrors = 0
      if schedule.kind === "at":
        if deleteAfterRun: removeFromStore  // 一次性 + deleteAfterRun → 删除
        else: job.enabled = false           // 一次性成功 → disable（防止重复触发）
      else:
        nextRunAtMs = computeJobNextRunAtMs(job.schedule, now)  // 含 stagger

runMissedJobs()（启动追赶）
  → missed = jobs where isRunnableJob(skipAtIfAlreadyRan=true, allowCronMissedRun=true)
  → 按 nextRunAtMs 排序
  → immediate = first maxMissedJobsPerRestart
  → deferred = rest → nextRunAtMs = now + stagger * i（每隔 5s 错开）
  → 依次执行 immediate jobs
```

### resolveTo — 推送目标解析

```ts
function resolveTo(job: CronJob): string {
  // 1. delivery.to 显式指定（最高优先级）
  if (job.delivery?.to) return job.delivery.to
  // 2. sessionKey 派生
  //    "wecom:default:direct:yinyousong" → "wecom:yinyousong"
  //    "wecom:default:group:groupId"     → "wecom:group:groupId"
  if (job.sessionKey) {
    const [ch, , type, id] = job.sessionKey.split(":")
    if (ch && id) return type === "group" ? `${ch}:group:${id}` : `${ch}:${id}`
  }
  throw new Error(`cannot resolve delivery target for job ${job.id}`)
}
```

### runAgentJob 实现（在 index.ts 注入）

```ts
async function runAgentJob({ job, sessionKey, abortSignal }) {
  const binding = await getBinding(sessionKey)
  if (!binding) return { text: "", status: "error", error: `no binding: ${sessionKey}` }

  const client = clientFor(binding.directory)
  let sid = binding.sessionID
  if (!sid) {
    const res = await client.session.create()
    if (res.error) return { text: "", status: "error", error: "create session failed" }
    sid = res.data.id
    await updateBinding(sessionKey, { sessionID: sid })
  }

  if (abortSignal?.aborted) return { text: "", status: "error", error: "aborted" }

  const sent = await client.session.promptAsync({
    sessionID: sid,
    parts: [{ type: "text", text: job.payload.message }],
  })
  if (sent.error) return { text: "", status: "error", error: "promptAsync failed" }

  const parts: string[] = []
  for await (const chunk of sessionEvents(binding.directory, sid, false)) {
    if (abortSignal?.aborted) return { text: parts.join("\n"), status: "error", error: "aborted" }
    if (chunk.type === "text") parts.push(chunk.text)
    else if (chunk.type === "idle") break
    else if (chunk.type === "error") return { text: "", status: "error", error: chunk.message }
  }
  return { text: parts.join("\n"), status: "ok" }
}
```

---

## 与 openclaw 的功能对齐表

| 功能                    | openclaw             | 我们的实现         | 备注                            |
| ----------------------- | -------------------- | ------------------ | ------------------------------- |
| **Schedule**            |                      |                    |                                 |
| at（一次性）            | ✅                   | ✅                 | 复用 schedule.ts                |
| every（固定间隔）       | ✅                   | ✅                 | 复用 schedule.ts                |
| cron（表达式 + tz）     | ✅                   | ✅                 | 复用 schedule.ts + croner       |
| staggerMs（cron 抖动）  | ✅                   | ✅                 | 移植 stagger.ts + jobs.ts       |
| 整点自动 stagger        | ✅ 5分钟             | ✅                 |                                 |
| **Payload**             |                      |                    |                                 |
| agentTurn（AI 执行）    | ✅                   | ✅                 | promptAsync + sessionEvents     |
| systemEvent（固定文本） | ✅ 注入主 session    | ✅ 直接 sendText   | 语义略不同：我们直接推，不走 AI |
| **Delivery**            |                      |                    |                                 |
| delivery.mode=announce  | ✅                   | ✅                 | plugin.outbound.sendText        |
| delivery.mode=webhook   | ✅                   | ❌ 暂不实现        | HTTP POST，可后续加             |
| delivery.channel=显式   | ✅                   | ✅                 | 由 sendText 路由到对应 plugin   |
| delivery.channel="last" | ✅                   | ❌ 不实现          | 需要 session lastChannel 追踪   |
| delivery.accountId      | ✅                   | ✅                 | 透传到 sendText                 |
| **生命周期**            |                      |                    |                                 |
| deleteAfterRun          | ✅                   | ✅                 | ok 后删除 job                   |
| at 成功后 disable       | ✅                   | ✅                 | 防止重复触发                    |
| **错误处理**            |                      |                    |                                 |
| 指数退避（5档）         | ✅                   | ✅                 | 相同退避表                      |
| at 瞬时错误重试（≤3次） | ✅                   | ✅                 | 相同重试逻辑                    |
| at 永久失败 disable     | ✅                   | ✅                 |                                 |
| failureAlert            | ✅                   | ✅                 | N 次失败后发告警到指定 to       |
| failureAlert 冷却       | ✅                   | ✅                 | 默认 1 小时                     |
| **运维**                |                      |                    |                                 |
| 启动追赶（missed jobs） | ✅ 最多 5 个         | ✅                 |                                 |
| 超量追赶 stagger        | ✅ 5s/个             | ✅                 |                                 |
| runNow（强制执行）      | ✅                   | ✅                 |                                 |
| 原子存储（.bak 备份）   | ✅                   | ✅                 |                                 |
| 并发控制                | ✅ maxConcurrentRuns | ✅ 默认 1          |                                 |
| 超时保护                | ✅ timeoutSeconds    | ✅ AbortController |                                 |
| 存储格式兼容 openclaw   | —                    | ✅ 相同 JSON 结构  |                                 |
| **不实现**              |                      |                    |                                 |
| sessionTarget=main      | ✅                   | ❌                 | 依赖 openclaw heartbeat         |
| delivery.channel="last" | ✅                   | ❌                 | 需要 session lastChannel        |
| delivery.mode=webhook   | ✅                   | ❌ 可后续          |                                 |
| session-reaper          | ✅                   | ❌ 可后续          |                                 |

---

## index.ts 集成点

```ts
const cron = new CronService({
  storePath: path.join(xdgConfig!, "opencode", "cron", "jobs.json"),
  runAgentJob,
  sendText: async ({ to, text, accountId }) => {
    const pluginId = to.split(":")[0] // "wecom"
    const plugin = api.plugins.find((p) => p.id === pluginId)
    if (!plugin?.outbound?.sendText) throw new Error(`no outbound.sendText for plugin ${pluginId}`)
    await plugin.outbound.sendText({ to, text, accountId })
  },
  onEvent: (evt) =>
    console.log(
      "[cron]",
      evt.action,
      evt.jobId,
      evt.status ?? "",
      evt.nextRunAtMs ? `next=${new Date(evt.nextRunAtMs).toISOString()}` : "",
    ),
})

cron.start()
```

---

## 存储文件位置

| 文件 | 路径                                    |
| ---- | --------------------------------------- |
| Jobs | `~/.config/opencode/cron/jobs.json`     |
| 备份 | `~/.config/opencode/cron/jobs.json.bak` |
| 格式 | `{ "version": 1, "jobs": [...] }`       |

格式与 openclaw 的 `~/.config/openclaw/cron/jobs.json` 结构相同，可互相参考。
