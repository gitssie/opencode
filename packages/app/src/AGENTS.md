# packages/app 编码规范

**版本**：v1.0  
**日期**：2026-03-14  
**适用范围**：`packages/app/src` 所有新增及修改代码

---

## 目录

1. [i18n / 多语言规范（强制）](#1-i18n--多语言规范强制)
2. [组件开发规范](#2-组件开发规范)
3. [状态管理规范](#3-状态管理规范)
4. [样式规范](#4-样式规范)
5. [平台差异处理](#5-平台差异处理)
6. [UI 组件选型](#6-ui-组件选型)
7. [错误处理规范](#7-错误处理规范)
8. [表单处理规范](#8-表单处理规范)
9. [TypeScript 类型规范](#9-typescript-类型规范)
10. [Import 顺序规范](#10-import-顺序规范)
11. [SolidJS 特有写法](#11-solidjs-特有写法)
12. [常见错误模式](#12-常见错误模式)

---

## 1. i18n / 多语言规范（强制）

### 1.1 核心原则

**所有用户可见的文本，必须使用 `language.t()` 翻译，禁止将文字硬编码在 TSX 中。**

本项目支持 17 种语言（en / zh / zht / ko / de / es / fr / da / ja / pl / ru / ar / no / br / th / bs / tr），所有翻译 key 定义在 `src/i18n/en.ts`（英文为基准），其他语言文件平行存放在同目录。

### 1.2 在组件中使用翻译

```tsx
import { useLanguage } from "@/context/language"

export const MyComponent: Component = () => {
  const language = useLanguage()

  return (
    <div>
      <h2>{language.t("settings.section.manage")}</h2>
      <p>{language.t("settings.mcp.description")}</p>
    </div>
  )
}
```

**带变量插值：**

```tsx
// en.ts 中定义：
// "toast.mcp.connected": "Connected to {{name}}"

language.t("toast.mcp.connected", { name: server.name })
```

### 1.3 翻译 key 命名规范

使用 `.` 分隔的命名空间层级结构：

```
<命名空间>.<子命名空间>.<描述>
```

**现有命名空间参考：**

| 命名空间               | 用途                                          |
| ---------------------- | --------------------------------------------- |
| `settings.*`           | 设置页面文本                                  |
| `settings.tab.*`       | 设置 Tab 标题                                 |
| `settings.section.*`   | 设置分区标题                                  |
| `settings.providers.*` | Provider 相关文本                             |
| `settings.mcp.*`       | MCP 相关文本（新增）                          |
| `settings.agents.*`    | Agent 相关文本（新增）                        |
| `settings.skills.*`    | Skill 相关文本（新增）                        |
| `toast.*`              | Toast 通知文本                                |
| `common.*`             | 通用操作文本（disconnect / save / cancel 等） |
| `provider.*`           | Provider 操作文本                             |
| `command.*`            | 命令面板条目文本                              |
| `language.*`           | 语言名称                                      |
| `error.*`              | 错误提示文本                                  |

**命名示例：**

```typescript
// en.ts 中添加新 key（同时需在所有语言文件中添加对应翻译）
"settings.mcp.title": "MCP Servers",
"settings.mcp.section.connected": "Connected",
"settings.mcp.section.available": "Available",
"settings.mcp.empty": "No MCP servers configured",
"settings.mcp.add.title": "Add MCP Server",
"settings.mcp.status.connected": "Connected",
"settings.mcp.status.failed": "Failed",
"settings.mcp.status.disabled": "Disabled",
"settings.mcp.status.needs_auth": "Needs Auth",
"toast.mcp.connected.title": "Connected",
"toast.mcp.connected.description": "Connected to {{name}}",
"toast.mcp.disconnected.title": "Disconnected",
"toast.mcp.error.title": "Connection Failed",
```

### 1.4 添加新翻译 key 的流程

1. **在 `src/i18n/en.ts` 中添加英文原文**（en.ts 是唯一的 source of truth）
2. **在所有其他语言文件中添加翻译**（或先用英文占位，后续补充）
3. 其他语言文件路径：`src/i18n/{locale}.ts`（共 16 个文件）

**最低要求**：至少在 `en.ts` 和 `zh.ts` 中完成翻译，其他语言可暂用英文占位。

### 1.5 语言文件结构

```typescript
// src/i18n/en.ts
export const dict = {
  // 按命名空间分组，组之间用空行分隔
  "settings.tab.general": "General",
  "settings.tab.shortcuts": "Shortcuts",

  "settings.mcp.title": "MCP Servers",
  "settings.mcp.empty": "No MCP servers configured",
  // ...
}
```

### 1.6 LanguageProvider 的上下文层级

`LanguageProvider` 已在 `app.tsx` 的根层级挂载，所有组件无需额外配置即可使用 `useLanguage()`。

```tsx
// app.tsx（已存在，不需要修改）
<LanguageProvider>
  <UiI18nBridge>{/* 所有子组件均可使用 useLanguage() */}</UiI18nBridge>
</LanguageProvider>
```

---

## 2. 组件开发规范

### 2.1 文件命名

| 类型       | 命名规则   | 示例               |
| ---------- | ---------- | ------------------ |
| 组件文件   | kebab-case | `settings-mcp.tsx` |
| 上下文文件 | kebab-case | `global-sdk.tsx`   |
| Hook 文件  | kebab-case | `use-providers.ts` |
| 工具函数   | kebab-case | `persist.ts`       |

### 2.2 组件声明

```tsx
import { type Component } from "solid-js"

// 具名导出，不使用 default export
export const SettingsMcp: Component = () => {
  // ...
}
```

### 2.3 组件结构顺序

```tsx
export const SettingsMcp: Component = () => {
  // 1. Context hooks
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const platform = usePlatform()

  // 2. 本地状态（createStore / createSignal）
  const [store, setStore] = createStore({ view: "list" as "list" | "add" })

  // 3. 异步资源（createResource）
  const [data, actions] = createResource(() => sdk.client.mcp.status())

  // 4. 派生计算（createMemo）
  const list = createMemo(() => Object.entries(data() ?? {}))

  // 5. 副作用（createEffect）— 尽量避免

  // 6. 事件处理函数
  const connect = async (name: string) => {
    /* ... */
  }

  // 7. JSX return
  return <div>...</div>
}
```

### 2.4 目录结构规范

```
src/
├── components/           # 功能组件（按功能前缀分组）
│   ├── dialog-*.tsx      # 弹窗类
│   ├── settings-*.tsx    # 设置页 Tab
│   └── session/          # 子目录（复杂功能模块）
├── context/              # 全局上下文 Provider
├── hooks/                # 可复用的自定义 Hook
├── i18n/                 # 多语言翻译文件
├── pages/                # 路由页面
└── utils/                # 工具函数
```

### 2.5 data 属性

为便于调试和 E2E 测试，关键交互元素使用 `data-action` 属性，容器使用 `data-component` 属性：

```tsx
<Button data-action="mcp-connect">Connect</Button>
<div data-component="mcp-server-list">...</div>
```

---

## 3. 状态管理规范

### 3.1 本地状态

优先使用 `createStore`（而非多个 `createSignal`）管理有多个字段的组件状态：

```tsx
// ✅ 推荐
const [store, setStore] = createStore({
  view: "list" as "list" | "add",
  selected: null as string | null,
  loading: false,
})

// ❌ 避免
const [view, setView] = createSignal<"list" | "add">("list")
const [selected, setSelected] = createSignal<string | null>(null)
const [loading, setLoading] = createSignal(false)
```

### 3.2 异步数据

使用 `createResource` 处理所有 SDK 调用：

```tsx
const sdk = useGlobalSDK()
const sync = useGlobalSync()

// 读取数据
const [mcpStatus] = createResource(() => sdk.client.mcp.status())
const [agents] = createResource(() => sdk.client.app.agents())
const [skills] = createResource(() => sdk.client.app.skills())

// 在 JSX 中处理加载和错误状态
<Show when={mcpStatus()} fallback={<div>Loading...</div>}>
  {(status) => <For each={Object.entries(status())}>{/* ... */}</For>}
</Show>
```

### 3.3 写入配置

通过 `useGlobalSync().updateConfig()` 写回全局配置：

```tsx
const sync = useGlobalSync()

async function saveAgent(name: string, cfg: AgentConfig) {
  const current = sync.config()
  await sync.updateConfig({
    ...current,
    agent: { ...current.agent, [name]: cfg },
  })
}

async function deleteAgent(name: string) {
  const current = sync.config()
  const agent = { ...current.agent }
  delete agent[name]
  await sync.updateConfig({ ...current, agent })
}
```

### 3.4 派生计算

对需要从原始数据推导的值，使用 `createMemo`：

```tsx
const connected = createMemo(() => Object.entries(mcpStatus() ?? {}).filter(([, s]) => s.status === "connected"))
```

---

## 4. 样式规范

### 4.1 使用 Tailwind 工具类

```tsx
// ✅ 推荐
<div class="flex flex-col gap-4 px-4 py-6">

// ❌ 禁止内联样式
<div style={{ display: "flex", "flex-direction": "column" }}>
```

### 4.2 文字大小类名规范

项目使用自定义 Tailwind 文字大小类，不使用 `text-sm`、`text-base` 等默认尺寸：

| 类名              | 用途                |
| ----------------- | ------------------- |
| `text-16-medium`  | 区块标题（h2 级别） |
| `text-14-medium`  | 子标题（h3 级别）   |
| `text-14-regular` | 正文内容            |
| `text-12-medium`  | 辅助信息标签        |
| `text-12-regular` | 辅助信息正文        |
| `text-11-regular` | 版本号等最小文字    |

### 4.3 颜色语义 Token

不使用 Tailwind 的颜色字面值（如 `text-gray-500`），使用语义化 token：

| Token                           | 用途                         |
| ------------------------------- | ---------------------------- |
| `text-text-strong`              | 主要文字（标题）             |
| `text-text-base`                | 正文文字                     |
| `text-text-weak`                | 辅助文字、说明文字           |
| `border-border-weak-base`       | 列表分隔线                   |
| `bg-surface-base`               | 基础背景                     |
| `bg-surface-stronger-non-alpha` | 较深背景（sticky header 用） |

### 4.4 布局惯用模式

**设置页面基本布局：**

```tsx
<div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
  {/* Sticky 标题区 */}
  <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
    <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
      <h2 class="text-16-medium text-text-strong">{language.t("settings.mcp.title")}</h2>
    </div>
  </div>

  {/* 内容区 */}
  <div class="flex flex-col gap-8 max-w-[720px]">{/* ... */}</div>
</div>
```

**列表行惯用模式：**

```tsx
<div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
  <div class="flex items-center gap-3 min-w-0">{/* 左侧内容 */}</div>
  <div class="flex items-center gap-2">{/* 右侧操作按钮 */}</div>
</div>
```

---

## 5. 平台差异处理

### 5.1 获取平台信息

```tsx
import { usePlatform } from "@/context/platform"

const platform = usePlatform()
// platform.platform: "web" | "desktop"
// platform.os: "macos" | "windows" | "linux" | undefined（仅 Desktop）
// platform.openPath: (path: string) => void（仅 Desktop）
// platform.openFilePickerDialog: () => Promise<string>（仅 Desktop）
```

### 5.2 条件渲染（仅 Desktop 显示）

```tsx
<Show when={platform.platform === "desktop"}>
  <Button onClick={() => platform.openPath?.(location)}>{language.t("common.openDirectory")}</Button>
</Show>
```

### 5.3 降级处理（Web 端替代方案）

能力缺失时优先降级，而非完全隐藏：

```tsx
<Button
  onClick={() => {
    if (platform.platform === "desktop") {
      platform.openPath?.(location)
    } else {
      navigator.clipboard.writeText(location)
      showToast({ title: language.t("common.pathCopied") })
    }
  }}
>
  {platform.platform === "desktop" ? language.t("common.openDirectory") : language.t("common.copyPath")}
</Button>
```

---

## 6. UI 组件选型

所有 UI 组件必须来自 `@opencode-ai/ui/*`，**禁止引入新的 npm 包**。

| 需求       | 组件           | 导入路径                        |
| ---------- | -------------- | ------------------------------- |
| 按钮       | `Button`       | `@opencode-ai/ui/button`        |
| 标签/徽章  | `Tag`          | `@opencode-ai/ui/tag`           |
| 图标       | `Icon`         | `@opencode-ai/ui/icon`          |
| 加载中     | `Spinner`      | `@opencode-ai/ui/spinner`       |
| 文本输入   | `TextField`    | `@opencode-ai/ui/text-field`    |
| 下拉选择   | `Select`       | `@opencode-ai/ui/select`        |
| 开关       | `Switch`       | `@opencode-ai/ui/switch`        |
| 弹窗       | `Dialog`       | `@opencode-ai/ui/dialog`        |
| Toast 通知 | `showToast`    | `@opencode-ai/ui/toast`         |
| 提供商图标 | `ProviderIcon` | `@opencode-ai/ui/provider-icon` |

**设置页本地组件（`components/settings-list.tsx`）：**

```tsx
import { SettingsList } from "./settings-list"

// 用于包裹设置列表的容器
;<SettingsList>
  <For each={items}>{/* 列表行 */}</For>
</SettingsList>
```

### 6.1 Toast 用法

```tsx
import { showToast } from "@opencode-ai/ui/toast"

// 成功
showToast({
  variant: "success",
  icon: "circle-check",
  title: language.t("toast.mcp.connected.title"),
  description: language.t("toast.mcp.connected.description", { name }),
})

// 失败
showToast({
  title: language.t("common.requestFailed"),
  description: err instanceof Error ? err.message : String(err),
})
```

### 6.2 SolidJS 条件/列表渲染

```tsx
import { For, Show, Switch, Match } from "solid-js"

// 列表
<For each={items}>{(item) => <div>{item.name}</div>}</For>

// 条件
<Show when={condition} fallback={<EmptyState />}>
  <Content />
</Show>

// 多条件分支
<Switch fallback={<Default />}>
  <Match when={status === "connected"}><Connected /></Match>
  <Match when={status === "failed"}><Failed /></Match>
</Switch>
```

---

## 12. 常见错误模式

### ❌ 硬编码文字

```tsx
// 错误：直接写中文或英文
<h2>MCP 服务器</h2>
<Button>连接</Button>

// 正确
<h2>{language.t("settings.mcp.title")}</h2>
<Button>{language.t("common.connect")}</Button>
```

### ❌ 使用 any 类型

```tsx
// 错误
const data = result as any
const handler = (e: any) => {}

// 正确：使用具体类型或 unknown
const handler = (e: unknown) => {}
```

### ❌ 不必要的变量拆包

```tsx
// 错误
const { name, description } = item

// 正确：保留上下文
item.name
item.description
```

### ❌ 单次使用的中间变量

```tsx
// 错误
const path = item.location
const label = language.t("common.openDirectory")
return <Button onClick={() => platform.openPath?.(path)}>{label}</Button>

// 正确：直接内联
return <Button onClick={() => platform.openPath?.(item.location)}>{language.t("common.openDirectory")}</Button>
```

### ❌ 多个 createSignal 代替 createStore

```tsx
// 错误
const [name, setName] = createSignal("")
const [loading, setLoading] = createSignal(false)
const [error, setError] = createSignal<string | null>(null)

// 正确
const [form, setForm] = createStore({ name: "", loading: false, error: null as string | null })
```

### ❌ else 语句

```tsx
// 错误
function connect() {
  if (isConnected) return disconnect()
  else return doConnect()
}

// 正确
function connect() {
  if (isConnected) return disconnect()
  return doConnect()
}
```

---

## 7. 错误处理规范

### 7.1 异步操作——使用 `.catch()` 而非 try/catch

```tsx
// ✅ 推荐：.then().catch().finally() 链式调用
void sdk.client.mcp
  .connect({ name })
  .then(() => {
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("toast.mcp.connected.title"),
    })
    actions.refetch()
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  })
  .finally(() => setStore("loading", false))
```

### 7.2 错误消息提取

```tsx
const message = err instanceof Error ? err.message : String(err)
showToast({ title: language.t("common.requestFailed"), description: message })
```

### 7.3 内联错误（表单字段）

字段级别的校验错误存在 store 中，在 JSX 内联展示：

```tsx
const [form, setForm] = createStore({
  name: "",
  error: undefined as string | undefined,
})

// 提交时校验
if (!form.name.trim()) {
  setForm("error", language.t("settings.mcp.add.name.required"))
  return
}
setForm("error", undefined)

// JSX 展示
<Show when={form.error}>
  <p class="text-12-regular text-text-error">{form.error}</p>
</Show>
```

---

## 8. 表单处理规范

### 8.1 受控组件模式

使用 `createStore` 管理表单状态，onChange 即时更新：

```tsx
const [form, setForm] = createStore({
  name: "",
  command: "",
  error: undefined as string | undefined,
  saving: false,
})

<TextField
  type="text"
  label={language.t("settings.mcp.add.name.label")}
  value={form.name}
  onChange={(v) => setForm("name", v)}
/>
```

### 8.2 表单提交函数

```tsx
const handleSubmit = async (e: SubmitEvent) => {
  e.preventDefault()
  if (form.saving) return // 防止重复提交

  if (!form.name.trim()) {
    setForm("error", language.t("settings.mcp.add.name.required"))
    return
  }

  setForm({ error: undefined, saving: true })

  await sdk.client.mcp
    .add({ name: form.name, config: { type: "local", command: form.command.split(" ") } })
    .then(async () => {
      await sdk.client.mcp.connect({ name: form.name })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.mcp.connected.title"),
      })
      setStore("view", "list")
      actions.refetch()
    })
    .catch((err: unknown) => {
      setForm("error", err instanceof Error ? err.message : String(err))
    })
    .finally(() => setForm("saving", false))
}
```

### 8.3 批量 store 更新

```tsx
import { batch } from "solid-js"

// 同时更新多个字段时使用 batch 减少重渲染
batch(() => {
  setForm("error", undefined)
  setForm("saving", false)
  setForm("name", "")
})

// 或使用对象形式（等价）
setForm({ error: undefined, saving: false, name: "" })
```

---

## 9. TypeScript 类型规范

### 9.1 Props 类型定义

```tsx
import { type Component, type ParentProps, type JSX } from "solid-js"

// Props 用 interface
interface McpRowProps {
  name: string
  status: McpStatus
  onConnect: () => void
}

// 扩展 Props
interface CardProps extends ParentProps {
  class?: string
  title: string
}

// 复杂状态用 type
type View = "list" | "add" | "edit"
```

### 9.2 组件类型标注

```tsx
// 无 Props 的组件
export const SettingsMcp: Component = () => {
  /* ... */
}

// 有 Props 的组件
export const McpRow: Component<McpRowProps> = (props) => {
  /* ... */
}

// 带子元素的组件
export const SettingsList: Component<{ children: JSX.Element }> = (props) => {
  /* ... */
}
```

### 9.3 联合类型替代枚举

```tsx
// ✅ 联合类型
type Mode = "primary" | "subagent" | "all"

// ❌ enum（项目不使用）
enum Mode {
  Primary = "primary",
}
```

### 9.4 常量数组

```tsx
const COLORS = ["pink", "mint", "orange", "purple"] as const
type Color = (typeof COLORS)[number]
```

---

## 10. Import 顺序规范

```tsx
// 1. 第三方类型（type-only imports）
import type { McpStatus } from "@opencode-ai/sdk/v2/client"

// 2. SolidJS 基础
import { createMemo, createResource, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"

// 3. UI 组件库（按字母顺序）
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"

// 4. 项目 Context
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"

// 5. 工具函数
import { formatBytes } from "@/utils/format"

// 6. 本地组件
import { SettingsList } from "./settings-list"
```

---

## 11. SolidJS 特有写法

### 11.1 createResource 完整用法

```tsx
const [data, actions] = createResource(() => sdk.client.mcp.status())

// 加载/空状态处理
<Show when={!data.loading} fallback={<Spinner />}>
  <Show when={data()} fallback={<EmptyState />}>
    {(status) => <For each={Object.entries(status())}>{/* ... */}</For>}
  </Show>
</Show>

// refetch：操作成功后刷新列表
await sdk.client.mcp.connect({ name }).then(() => actions.refetch())

// mutate：直接更新缓存，无需重新请求
actions.mutate(newValue)

// 条件触发（返回 undefined 时不请求）
const [result] = createResource(
  () => condition() ? true : undefined,
  async () => { /* fetcher */ }
)
```

### 11.2 createEffect + onCleanup

```tsx
import { createEffect, on, onCleanup, onMount } from "solid-js"

// 响应特定 signal 变化
createEffect(
  on(
    () => store.selectedId,
    (id) => {
      if (!id) return /* 副作用 */
    },
  ),
)

// 清理定时器
createEffect(() => {
  const interval = setInterval(refresh, 10_000)
  onCleanup(() => clearInterval(interval))
})

// 清理事件监听
onMount(() => {
  window.addEventListener("keydown", onKeyDown, { capture: true })
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
})
```

### 11.3 Show 组件的 accessor 模式

```tsx
// accessor 函数保证类型排除 undefined/null/false
<Show when={data()}>{(item) => <span>{item().name}</span>}</Show>
```

### 11.4 Dynamic 组件

```tsx
import { Dynamic } from "solid-js/web"
;<Dynamic component={props.as ?? "div"} class="..." {...rest}>
  {props.children}
</Dynamic>
```

---

## 附录：参考实现文件

新增 Tab 组件时，参考以下现有文件的完整实现：

| 参考文件                                     | 说明                                                           |
| -------------------------------------------- | -------------------------------------------------------------- |
| `src/components/settings-providers.tsx`      | **最重要参考**：列表展示、createResource、showToast、多语言    |
| `src/components/settings-general.tsx`        | 设置行（SettingsRow）、下拉/开关用法、createResource + refetch |
| `src/components/dialog-connect-provider.tsx` | 表单处理、字段校验、.then().catch() 错误处理                   |
| `src/components/dialog-settings.tsx`         | Tab 体系集成方式                                               |
| `src/components/settings-list.tsx`           | SettingsList 组件实现（极简包装）                              |
| `src/context/language.tsx`                   | LanguageProvider 实现                                          |
| `src/i18n/en.ts`                             | 所有可用翻译 key（约 900+ 条）                                 |
