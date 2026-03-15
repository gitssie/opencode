# OpenClaw 业务需求与功能需求设计文档

**版本**：v0.3  
**日期**：2026-03-13  
**状态**：草稿

---

## 0. 架构决策：Fork vs 直接在 opencode 上修改

### 0.1 背景

OpenClaw 的 UI 新增功能（Agent/Skill/MCP 管理页）需要修改 `packages/app` 的源代码。Desktop 打包（Tauri）必须依赖 `packages/opencode` 构建产物（opencode-cli 二进制作为 sidecar）。因此在开发模式选择上需要做出决策。

### 0.2 Desktop 依赖结构

```
OpenCode Desktop (.exe / .dmg / .deb)
├── Tauri Webview（内嵌浏览器引擎）
│   └── packages/app 构建产物（HTML/JS/CSS，编译后打入 dist/）
│       └── 依赖 @opencode-ai/app, @opencode-ai/ui（构建时编译进去）
└── sidecar binary: opencode-cli
    └── 来自 packages/opencode 的构建产物
    └── Desktop 启动时用它拉起本地 HTTP 服务（默认 port 4096）
    └── 所有 Agent/MCP/Skill 等核心逻辑均在此二进制中
```

**结论：Desktop 打包时必须依赖 `packages/opencode` 的 CLI 二进制，不可剥离。**

### 0.3 两种开发模式对比

| 维度         | 方案 A：直接修改 opencode 仓库           | 方案 B：Fork 成独立仓库                   |
| ------------ | ---------------------------------------- | ----------------------------------------- |
| 开发维护     | ✅ 无需维护 fork，直接在原仓库开发       | ❌ 需要定期 rebase 上游更新，维护成本高   |
| 上游同步     | ✅ 自动跟随上游                          | ❌ 手动 cherry-pick 或 merge              |
| Desktop 打包 | ✅ 直接使用原有构建流程                  | ⚠️ 需要重新配置 opencode-cli sidecar 来源 |
| 定制程度     | ⚠️ 受 MIT 协议约束，修改需回馈社区或注明 | ✅ 可完全定制，包括 branding、私有功能    |
| 品牌独立性   | ❌ 仍基于 opencode 品牌                  | ✅ 完全独立品牌（OpenClaw）               |
| 适合场景     | 功能修改量小，长期跟随上游               | 大规模定制，商业产品，不希望上游干扰      |

### 0.4 推荐方案（当前阶段）

**推荐方案 B：Fork opencode 仓库，在 fork 上维护私有开发分支。**

理由：

1. **不能 copy 代码出来单独维护**：Desktop 打包依赖 monorepo 内的 workspace 依赖（`@opencode-ai/app`、`@opencode-ai/ui`），脱离 monorepo 结构后需要重新配置所有依赖关系，维护成本极高
2. **Fork + upstream 合并是最实际的做法**：可以定期拉取上游的功能优化和 bug 修复，同时保持自己的改动独立
3. **遵循最小侵入原则**：新功能尽量只新增文件，对现有文件的改动最小化（当前阶段唯一需要改动的现有文件是 `dialog-settings.tsx`，改动量约 10 行），大幅降低合并冲突概率

**操作流程：**

```bash
# 1. Fork opencode 到自己的 GitHub（一次性操作）
# 2. 添加上游 remote
git remote add upstream https://github.com/sst/opencode.git

# 3. 定期同步上游更新
git fetch upstream
git merge upstream/dev  # 处理冲突（通常极少，因为最小侵入）

# 4. OpenClaw 改动只在以下文件
# 新增：packages/app/src/components/settings-skills.tsx
# 修改（约10行）：packages/app/src/components/dialog-settings.tsx
# 填充（替换占位）：packages/app/src/components/settings-agents.tsx
#                  packages/app/src/components/settings-mcp.tsx
```

> **注：** 若后续需要修改 `packages/opencode` 后端（如新增 API），需评估是否提 PR 回上游。当前版本所有 OpenClaw 功能均通过现有 API 实现，不需要修改后端。

---

## 1. 产品概述

### 产品定位

OpenClaw 是基于 opencode 构建的 **AI 编程助手管理平台**，提供 Web 控制台，支持本地单用户模式，未来可扩展为团队云端部署模式。

它将 opencode 的核心能力（Agent 编排、MCP 工具集成、长期记忆）封装为可管理、可观测的可视化平台，让开发者无需手动编辑配置文件即可完整管理 AI 编程助手的各项配置。

> **当前版本范围**：本文档描述的功能均面向**本地单用户模式**。团队多用户管理功能（多用户账号、权限治理、团队共享 Agent 等）暂不在当前版本范围内。

---

### 目标用户

| 用户类型                | 场景描述                                  |
| ----------------------- | ----------------------------------------- |
| 个人开发者              | 本地安装，单用户模式，需要可视化管理界面  |
| 小型研发团队（5~50 人） | 共享 Agent 配置与知识库，各自独立 sandbox |
| 平台/基础设施团队       | 负责 OpenClaw 部署、用户管理与权限治理    |

---

### 核心价值主张

- **可视化管理**：通过 Web UI 替代纯配置文件，降低 opencode 的使用门槛
- **团队共享**：统一的 Agent 配置与共享知识库，减少重复设置
- **权限隔离**：每个用户独立 sandbox，彼此不干扰
- **记忆沉淀**：个人记忆与团队知识库分层管理，AI 能力随使用积累

---

## 2. Agent 管理功能需求

### 2.0 Agent 来源类型说明

opencode 中的 Agent 按来源分为三类，各类的读写权限不同：

| 来源类型           | 标识     | 说明                                                                          | 可编辑性                                |
| ------------------ | -------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| **内置 Agent**     | `native` | 代码硬编码（build / plan / general / explore / compaction / title / summary） | 完全只读，不可修改或删除                |
| **Markdown 文件**  | `file`   | 来自 `.opencode/agents/*.md` 文件                                             | Web 端只读；Desktop 端可编辑文件内容    |
| **全局配置 Agent** | `config` | 来自 `config.agent` 字段（全局 `~/.config/opencode/config.json`）             | Web 端可通过 `updateConfig()` 全量 CRUD |

> **注：** 当前版本 Web 端重点支持"全局配置 Agent"的 CRUD 操作；内置 Agent 和 Markdown 文件 Agent 仅提供只读展示。

---

### 2.1 Agent 列表页

#### 业务需求

开发者需要快速了解当前 opencode 实例中有哪些可用 Agent，以便选择合适的 Agent 执行编程任务。三种来源类型的 Agent 有不同的操作权限，需在界面上清晰区分。

#### 功能需求

**列表展示**

页面以卡片或表格形式展示所有 Agent，每个 Agent 展示以下信息：

| 字段                | 说明                                                   |
| ------------------- | ------------------------------------------------------ |
| 名称（name）        | Agent 唯一标识                                         |
| 描述（description） | 可选，Agent 用途说明                                   |
| 模式（mode）        | `primary` / `subagent` / `all` 三种角色标签            |
| 来源标识            | `native`（内置）/ `file`（文件）/ `config`（全局配置） |
| 可见性              | `hidden: true` 的 Agent 显示为"隐藏"标记               |
| 颜色标识            | 若配置了 `color`，以色块形式展示                       |
| 使用模型            | 展示 `modelID / providerID`，未配置时显示"继承全局"    |
| 操作按钮            | 来源为 `config` 的 Agent 显示编辑/删除按钮；其余仅查看 |

**筛选与搜索**

- 支持按名称关键字搜索
- 支持按 `mode` 过滤：全部 / primary / subagent / all
- 支持按来源过滤：全部 / 内置（native）/ 文件（file）/ 配置（config）
- 支持按可见性过滤：显示全部（含隐藏）/ 仅显示可见

**新建入口**

- 列表页右上角提供"新建 Agent"按钮
- 点击后进入创建表单（见 2.3）
- 新建的 Agent 始终写入全局配置（`config` 来源）

**数据来源**

列表数据通过 `GET /agent` 接口获取，操作权限依据来源类型判断。

---

### 2.2 Agent 详情页

#### 业务需求

用户点击某个 Agent 后，需要查看其完整配置，以便了解该 Agent 的能力边界、权限设置与使用场景。来源为 `config` 的 Agent 可直接在详情页编辑。

#### 功能需求

**基本信息展示**

- 名称、描述、模式（mode）、来源标识（带颜色区分的徽章）
- 颜色配置（色块 + 色值）
- 是否为隐藏 Agent

**模型配置展示**

- 展示绑定的 `modelID` 和 `providerID`
- 若未指定，显示说明文案：primary agent 继承全局设置，subagent 继承调用方的模型

**Prompt 展示**

- 展示 Agent 的系统 prompt 内容（Markdown 渲染）
- 若 prompt 引用外部文件（如 `{file:./prompts/build.txt}`），展示文件路径而非解析后内容

**Permission 信息展示**

Permission 以结构化方式呈现：

| 维度            | 说明                                       |
| --------------- | ------------------------------------------ |
| `edit` 权限     | `allow` / `ask` / `deny`                   |
| `bash` 权限     | 全局规则或逐条命令规则列表（含 glob 模式） |
| `webfetch` 权限 | `allow` / `ask` / `deny`                   |
| `task` 权限     | 可调用的 subagent 列表及对应规则           |

Bash 命令级别的规则需以列表形式逐条展示，包括命令模式和对应的权限值。

**编辑入口**

- 来源为 `config` 的 Agent：页面右上角显示"编辑"按钮，点击进入编辑表单（见 2.3）
- 来源为 `native` 或 `file` 的 Agent：整个详情页为只读，不显示编辑按钮

---

### 2.3 创建与编辑 Agent

#### 业务需求

用户需要通过可视化表单创建自定义 Agent 或修改已有的全局配置 Agent，配置保存后立即生效，无需重启 opencode。

#### 功能需求

**触发入口**

- 创建：列表页"新建 Agent"按钮
- 编辑：来源为 `config` 的 Agent 详情页"编辑"按钮，或列表行操作菜单"编辑"

**表单字段**

| 字段               | 类型                         | 必填 | 说明                                                     |
| ------------------ | ---------------------------- | ---- | -------------------------------------------------------- |
| `name`             | 文本输入                     | ✅   | Agent 唯一标识，仅允许字母、数字、中横线；创建后不可修改 |
| `description`      | 文本输入                     | ❌   | 简短描述，展示在列表和选择器中                           |
| `mode`             | 单选（primary/subagent/all） | ❌   | 默认 `all`                                               |
| `model.modelID`    | 文本输入（或下拉选择）       | ❌   | 绑定特定模型 ID；留空表示继承全局设置                    |
| `model.providerID` | 文本输入（或下拉选择）       | ❌   | 绑定特定 Provider；留空表示继承全局设置                  |
| `prompt`           | 多行文本（Markdown 编辑器）  | ❌   | 系统 prompt；支持 `{file:./path}` 引用外部文件           |
| `temperature`      | 数字滑块（0.0 ~ 2.0）        | ❌   | 模型温度参数；留空继承全局                               |
| `top_p`            | 数字滑块（0.0 ~ 1.0）        | ❌   | 模型 top_p 参数；留空继承全局                            |
| `color`            | 颜色选择器                   | ❌   | Agent 代表色，用于视觉区分                               |
| `hidden`           | 开关（boolean）              | ❌   | 开启后该 Agent 不出现在默认选择器中，仍可通过 API 调用   |
| `maxSteps`         | 数字输入                     | ❌   | 单次会话最大执行步数；留空继承全局默认值                 |

> **注：** Permission 配置（edit/bash/webfetch/task）较为复杂，当前版本暂不在创建/编辑表单中提供，后续版本迭代补充。

**保存逻辑**

1. 前端对 `name` 进行格式校验（仅字母、数字、中横线，且不与现有 Agent 重名）
2. 点击"保存"后，调用 `globalSync.updateConfig()` 将整个 `config.agent` 对象（含新增/修改项）写回
3. 保存成功后跳转至对应 Agent 详情页
4. 保存失败时展示错误提示，表单内容保留

**删除逻辑**

- 仅 `config` 来源的 Agent 可删除
- 删除前弹出确认对话框，提示操作不可撤销
- 确认后从 `config.agent` 对象中移除该条目，调用 `updateConfig()` 写回
- 删除成功后跳转至 Agent 列表页

**平台差异说明**

| 功能                          | Web 端 | Desktop 端             |
| ----------------------------- | ------ | ---------------------- |
| 创建/编辑 `config` Agent      | ✅     | ✅                     |
| 编辑 `file` Agent（.md 文件） | ❌     | ✅（直接编辑文件系统） |
| 删除 `config` Agent           | ✅     | ✅                     |
| 查看内置（native）Agent 详情  | ✅     | ✅                     |

---

### 2.4 Agent 与 Skill 的关联展示

#### 业务需求

用户需要了解某个 Agent 是否依赖特定 Skill 以提供专项能力，以便评估是否需要预先安装对应 Skill。

#### 功能需求

- Agent 详情页底部展示"关联 Skill"区块
- 通过对比 Agent 的 prompt 内容中的 Skill 引用关键词与 `GET /skill` 返回的已安装 Skill 列表，呈现关联关系
- 关联 Skill 展示名称、描述和安装状态（已安装 / 未安装）
- 点击关联 Skill 可跳转至 Skill 详情页

---

## 3. Skill 管理功能需求

### 3.1 已安装 Skill 列表

#### 业务需求

用户需要查看当前 opencode 实例中已加载的所有 Skill，了解每个 Skill 的来源和用途，以便维护和审计知识能力配置。

#### 功能需求

**列表展示**

通过 `GET /skill` 接口获取数据，每个 Skill 展示：

| 字段                 | 说明                                   |
| -------------------- | -------------------------------------- |
| 名称（name）         | Skill 唯一标识                         |
| 描述（description）  | Skill 用途说明                         |
| 来源标识             | 根据 `location` 字段推断（见下方规则） |
| 磁盘路径（location） | 实际存储路径                           |

**来源标识规则**

根据 `location` 路径前缀推断 Skill 来源：

| 来源类型          | 判断规则                                             |
| ----------------- | ---------------------------------------------------- |
| 全局（Global）    | 路径以 `~/.config/opencode/` 或系统全局目录开头      |
| 项目级（Project） | 路径以 `.opencode/` 相对路径或项目根目录开头         |
| Hub 拉取（Hub）   | 路径位于 Hub 缓存目录，或能在 Hub 目录中找到对应条目 |

**内容预览**

- 列表项支持展开内联预览，展示 Skill 的 Markdown 内容（`content` 字段）前 300 字符
- 支持点击进入 Skill 详情页，查看完整 Markdown 内容（渲染后展示）

**搜索**

- 支持按名称或描述关键字搜索

---

### 3.2 Skill Hub（技能市场）

#### 业务需求

用户希望从中央 Skill 目录中发现、安装和管理技能，以扩展 Agent 的专项能力，而无需手动编写和部署 Skill 文件。

#### 功能需求

**浏览页面**

- 展示 Skill Hub 中所有可用 Skill 的目录列表
- 每个条目展示：名称、描述、作者/来源、版本（若有）
- 支持按名称/描述关键字搜索
- 支持按标签/分类筛选（若 Hub 提供分类信息）

**安装状态标识**

通过对比 Hub 目录与 `GET /skill` 返回列表，为每个 Hub Skill 标注状态：

| 状态   | 含义                                               |
| ------ | -------------------------------------------------- |
| 已安装 | 当前 `/skill` 列表中存在同名 Skill                 |
| 未安装 | Hub 中有但未出现在 `/skill` 列表中                 |
| 可更新 | 已安装但 Hub 中存在更新版本（若 Hub 提供版本信息） |

**安装流程**

1. 用户点击"安装"按钮
2. 系统将该 Skill 的 URL 追加到 opencode 配置的 `config.skills.urls` 列表中
3. 触发 opencode 重新加载 Skill 配置
4. 页面刷新后，该 Skill 状态更新为"已安装"
5. 安装过程中展示加载状态，成功/失败给出对应提示

**卸载流程**

1. 用户点击"卸载"按钮
2. 系统从 `config.skills.urls` 中移除该 Skill 的 URL
3. 触发 opencode 重新加载 Skill 配置
4. 页面刷新后，该 Skill 状态更新为"未安装"
5. 提示用户卸载成功，并说明依赖此 Skill 的 Agent 可能受影响

**Hub 不可用处理**

- 若 Skill Hub 服务无法访问，列表页显示离线提示
- 已安装的 Skill 列表仍可正常浏览（数据来自本地 `/skill` 接口）

---

## 4. MCP 服务器管理功能需求

### 4.1 MCP 服务器列表

#### 业务需求

用户需要了解当前所有 MCP 服务器的接入状态，以便快速定位连接问题、管理工具集成。

#### 功能需求

**列表展示**

通过 `GET /mcp` 接口获取数据，每个 MCP 服务器展示：

| 字段         | 说明                                      |
| ------------ | ----------------------------------------- |
| 名称（name） | 服务器唯一标识                            |
| 类型         | `stdio`（本地进程）或 `http`（远程 HTTP） |
| 状态         | 见下方状态说明                            |
| 操作入口     | 根据状态展示可用操作按钮                  |

**服务器状态说明**

| 状态值                      | 中文说明         | 可用操作           |
| --------------------------- | ---------------- | ------------------ |
| `connected`                 | 已连接，正常运行 | 断开               |
| `disabled`                  | 已禁用           | 连接               |
| `failed`                    | 连接失败         | 重试连接、查看错误 |
| `needs_auth`                | 需要完成授权     | 前往授权           |
| `needs_client_registration` | 需要客户端注册   | 前往注册           |

- `failed` 状态展示最近一次的错误信息摘要，支持查看完整错误详情
- 状态以颜色标签形式直观展示（绿色/灰色/红色/橙色）

---

### 4.2 添加/连接/断开 MCP 服务器

#### 业务需求

用户需要通过 UI 接入外部工具服务（如数据库、知识库、浏览器控制等），扩展 Agent 的可用工具集。

#### 功能需求

**添加 MCP 服务器**

提供添加表单，支持两种类型：

**本地 stdio 类型**

| 字段            | 说明                           |
| --------------- | ------------------------------ |
| 名称            | 服务器唯一标识，字母数字中横线 |
| 命令（command） | 可执行文件路径                 |
| 参数（args）    | 命令行参数列表，支持动态增删   |
| 环境变量（env） | 键值对形式，支持动态增删       |

**远程 HTTP 类型**

| 字段              | 说明                               |
| ----------------- | ---------------------------------- |
| 名称              | 服务器唯一标识                     |
| URL               | 远程服务地址（需通过基础格式校验） |
| 请求头（headers） | 可选，键值对形式（用于认证等）     |

**表单提交**

- 点击"保存"调用 `POST /mcp` 接口添加服务器配置
- 添加成功后自动调用 `POST /mcp/{name}/connect` 尝试连接
- 若连接失败，在列表中展示 `failed` 状态并保留服务器条目

**连接操作**

- 对处于 `disabled` 或 `failed` 状态的服务器，提供"连接"按钮
- 点击后调用 `POST /mcp/{name}/connect`，期间展示加载状态
- 连接结果反映到列表状态

**断开操作**

- 对处于 `connected` 状态的服务器，提供"断开"按钮
- 点击后调用 `POST /mcp/{name}/disconnect`
- 断开后状态更新为 `disabled`

**授权引导**

- `needs_auth` 状态：展示说明文案，提供外链跳转至授权页（若服务器提供 OAuth 地址）
- `needs_client_registration` 状态：展示客户端注册引导信息

---

> **注：** 知识库（MuninnDB）集成功能暂不在当前版本范围内。当前版本 Agent 可通过 MCP 工具使用 MuninnDB 进行个人记忆管理，UI 管理界面待后续版本规划。

---

## 5. 移动端接入（Channel 模式）

### 5.1 背景与场景

用户希望在手机端通过消息通道（如 Telegram、WhatsApp）与 opencode 的 Agent 对话，在移动端发送指令、查看进度、回答 Agent 的权限请求，而后端 Agent 仍在 PC/服务器上运行并操作真实代码仓库。

这与 "openclaw channel" 开源项目（openclawlab.com）的 Channel Routing 思路类似：

- 手机端 = 消息通道入口（Telegram/WhatsApp Bot）
- 后端 = opencode 运行在本地/服务器，真正执行代码任务
- 两端通过 **会话绑定** 关联起来

---

### 5.2 Session 绑定设计

opencode 的 session 绑定了特定的 `directory`（工作目录路径），手机端无法直接操作本地路径，因此需要一层映射：

**绑定关系：**

```
Channel Session（消息通道侧）  ←→  opencode Session（工作目录侧）
  Telegram Chat ID: 12345678         directory: /home/user/myproject
  Channel Session Key: tg:12345678   Session ID: sess_abc123
```

**Session 状态：**

| 状态          | 说明                                              |
| ------------- | ------------------------------------------------- |
| `unbound`     | 移动端刚发消息，尚未绑定到任何 opencode session   |
| `bound`       | 已绑定到某个 opencode session，消息双向同步       |
| `idle`        | opencode session 处于等待状态，Agent 可接受新指令 |
| `running`     | Agent 正在执行任务，移动端可查看进度              |
| `needs_input` | Agent 需要用户回应（权限请求 / 提问）             |

**绑定方式（两种）：**

1. **自动新建**：移动端首次发消息时，自动在配置的默认工作目录调用 `POST /session` 创建新 session，并绑定
2. **手动选择**：移动端发送 `/session` 命令，Bot 调用 `GET /session?directory=<dir>` 列出所有活跃 session，用户通过 Telegram inline keyboard 选择绑定目标

> **关键约束**：opencode SDK **没有**"获取当前活跃 session"的专用 API——`GET /session` 仅返回按更新时间排序的 session 列表。Bot 无法自动探知用户在 Desktop UI 中当前打开的是哪个 session，因此只能依赖用户主动绑定（选择方式二）或预配置默认目录（方式一）。

---

#### SDK 接口对应关系

| 操作                | SDK 方法                                             | HTTP                                    |
| ------------------- | ---------------------------------------------------- | --------------------------------------- |
| 列出所有 sessions   | `client.session.list({ directory? })`                | `GET /session`                          |
| 创建新 session      | `client.session.create({ directory, title })`        | `POST /session`                         |
| 向 session 发送消息 | `client.session.promptAsync({ sessionID, parts })`   | `POST /session/{id}/prompt_async`       |
| 订阅事件流（SSE）   | `client.event.subscribe()`                           | `GET /event`（全局，含 directory 字段） |
| 批准/拒绝权限请求   | `client.permission.respond({ permissionID, reply })` | `PUT /session/{id}/permissions/{pid}`   |
| 回答 Agent 提问     | `client.question.reply({ requestID, answers })`      | `POST /question/{id}/reply`             |

#### 事件流过滤

Bot 订阅 `GET /event` 后，接收 `GlobalEvent { directory: string, payload: Event }`，需按以下事件类型处理：

| 事件类型           | 处理动作                                       |
| ------------------ | ---------------------------------------------- |
| `session.idle`     | Agent 完成回复，将最终消息发送给 Telegram 用户 |
| `message.updated`  | （可选）流式转发 Agent 消息片段                |
| `permission.asked` | 向 Telegram 发送带"批准/拒绝"按钮的消息        |
| `question.asked`   | 向 Telegram 发送带选项按钮的问题消息           |
| `session.error`    | 向 Telegram 发送错误通知                       |

---

### 5.3 消息路由规则

参考 openclaw channel 的 SessionKey 路由设计，路由规则如下：

```
消息来源（Channel）  →  路由规则                 →  绑定 opencode Session
─────────────────────────────────────────────────────────────────────
Telegram DM         →  一个用户一个 session       →  user:{userId} → session_id
Telegram Group      →  一个群组一个 session       →  group:{groupId} → session_id
WhatsApp DM         →  一个号码一个 session       →  wa:{phone} → session_id
用户 /new 命令       →  强制新建 session           →  新 session_id 替换旧绑定
```

---

### 5.4 技术实现思路

**当前版本（MVP）：只做 Telegram Bot**

集成方案：在 `packages/opencode` 后端（或作为独立 sidecar 服务）运行一个 Telegram Bot Polling 进程：

1. Bot 收到用户消息 → 查找对应 session 绑定
2. 将消息内容注入到对应 opencode session（通过内部 API `POST /session/{id}/message`）
3. 监听 opencode SSE 事件流，将 Agent 回复、进度更新推送回 Telegram
4. 当 opencode 发出 `permission.asked` / `question.asked` 事件时，向 Telegram 发送带按钮的消息，用户点击即可回应

**关键配置（用户在 Desktop 设置页完成）：**

| 配置项             | 说明                               |
| ------------------ | ---------------------------------- |
| Telegram Bot Token | 用户在 @BotFather 创建 Bot 后获取  |
| 允许的 Chat ID     | 白名单，防止陌生人发消息触发 Agent |
| 默认工作目录       | 新消息自动绑定的 opencode 工作目录 |

**实现位置：**

- 配置 UI：`packages/app/src/components/settings-channels.tsx`（新建，Desktop 设置 Tab）
- Bot 进程：作为 opencode MCP Server 或独立进程，由 Desktop 管理其生命周期

> **注：** Channel 接入功能涉及对 `packages/opencode` 后端的修改（新增 session 注入 API）或独立服务，属于较大的功能模块，**暂不在当前版本范围内**，本节仅记录设计思路供后续开发参考。

---

## 5. 开发环境管理（Desktop 专属）

### 5.1 功能背景

AI Agent 在本地执行编程任务时，通常需要 Node.js、Bun、Python（uv）等运行时环境。普通用户往往不具备手动安装和配置这些工具的能力，导致 Agent 执行任务失败。

Desktop 版 OpenClaw 可通过 Tauri 的 sidecar/shell 能力直接管理本地运行时环境，为用户提供一键安装和环境配置功能，显著降低使用门槛。

> ⚠️ **本章功能仅适用于 Desktop 环境，Web 端不提供。**

---

### 5.2 支持的运行时

| 运行时          | 用途                              | 安装方式                           |
| --------------- | --------------------------------- | ---------------------------------- |
| **Node.js**     | JS/TS 项目执行、npm 生态          | 通过 nvm（Windows）/ volta 安装    |
| **Bun**         | 高性能 JS 运行时，opencode 依赖   | 官方一键安装脚本                   |
| **Python + uv** | Python 项目执行、数据科学任务     | uv 自带 Python 版本管理            |
| **npm / pnpm**  | 包管理器（随 Node.js 安装后配置） | npm 随 Node.js 捆绑，pnpm 可选安装 |

---

### 5.3 环境状态检测页

#### 功能需求

- 展示每个运行时的当前状态：**已安装（含版本号）** / **未安装** / **版本过旧**
- 检测方式：通过 Tauri shell 执行 `node -v`、`bun -v`、`uv -V` 等命令，解析输出
- 状态以颜色标签显示（绿色=正常 / 橙色=版本过旧 / 红色=未安装）
- 提供"刷新检测"按钮，重新检测所有运行时状态

**检测结果展示示例：**

| 运行时  | 状态      | 版本    | 安装路径        | 操作     |
| ------- | --------- | ------- | --------------- | -------- |
| Node.js | ✅ 已安装 | v22.4.0 | D:\tools\node\  | 重新安装 |
| Bun     | ✅ 已安装 | v1.1.21 | D:\tools\bun\   | 重新安装 |
| Python  | ❌ 未安装 | —       | —               | 立即安装 |
| uv      | ❌ 未安装 | —       | —               | 立即安装 |

---

### 5.4 一键安装

#### 功能需求

- 用户点击"立即安装"后，通过 Tauri shell 执行对应的官方安装脚本
- 安装过程在 UI 中实时展示输出日志（流式输出）
- 安装完成后自动刷新状态检测
- 安装失败时展示错误信息，并提供"查看日志"和"手动安装指引"链接

**安装脚本来源（官方）：**

| 运行时  | Windows 安装命令                                      | macOS/Linux 安装命令                               |
| ------- | ----------------------------------------------------- | -------------------------------------------------- |
| Bun     | `powershell -c "irm bun.sh/install.ps1 \| iex"`       | `curl -fsSL https://bun.sh/install \| bash`        |
| uv      | `powershell -c "irm astral.sh/uv/install.ps1 \| iex"` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Node.js | 通过 nvm-windows 安装，再 `nvm install lts`           | `brew install node` 或 volta                       |

---

### 5.5 安装目录与环境变量管理

#### 业务需求

Windows 用户的 C 盘空间通常有限，且系统默认安装路径（`%AppData%`、`C:\Users\...`）容易造成权限问题。OpenClaw 应允许用户自定义安装目录，并自动配置必要的环境变量。

#### 功能需求

**安装目录设置**

- 提供安装根目录配置，默认建议值：
  - Windows：`D:\tools\openclaw-env\`（引导用户选 D 盘或自定义）
  - macOS/Linux：`~/.openclaw/env/`
- 通过 `platform.openDirectoryPickerDialog` 弹出目录选择对话框
- 各运行时子目录自动规划（如 `D:\tools\openclaw-env\node\`、`D:\tools\openclaw-env\bun\`）

**环境变量自动配置**

安装完成后，自动将以下变量写入系统/用户级环境变量（通过 Tauri shell 执行 PowerShell / export 命令）：

| 变量名                  | 作用                      | 示例值                            |
| ----------------------- | ------------------------- | --------------------------------- |
| `PATH`                  | 将 bin 目录加入 PATH      | `D:\tools\openclaw-env\node\bin`  |
| `BUN_INSTALL`           | Bun 安装目录              | `D:\tools\openclaw-env\bun`       |
| `UV_PYTHON_INSTALL_DIR` | uv 管理的 Python 目录     | `D:\tools\openclaw-env\python`    |
| `NPM_CONFIG_CACHE`      | npm 缓存目录（避免 C 盘） | `D:\tools\openclaw-env\npm-cache` |

**Windows PATH 修改策略**

- **不使用 `setx`**（`setx` 对 PATH 有 1024 字符截断限制，可能损坏现有 PATH）
- 使用 PowerShell `[Environment]::SetEnvironmentVariable()` 写入**用户级 PATH**（HKCU 注册表），不需要管理员权限：
  ```powershell
  $current = [Environment]::GetEnvironmentVariable("PATH", "User")
  [Environment]::SetEnvironmentVariable("PATH", "$current;D:\tools\openclaw-env\node\bin", "User")
  ```
- 仅写入**用户级环境变量**，不触碰系统级（HKLM），无需管理员权限
- Agent 通过 MCP `bash` 工具执行命令时，opencode 每次新开 shell 子进程，新 shell 会自动读取最新的用户级 PATH，**无需重启任何服务**，写入后即时生效

---

### 5.6 路径说明与集成方式

**前端集成**

- 在 `dialog-settings.tsx` 中新增"开发环境"Tab（Desktop 专属）
- 使用 `<Show when={platform.platform === "desktop"}>` 条件渲染，Web 端完全不显示该 Tab
- 对应新建文件：`packages/app/src/components/settings-devenv.tsx`

**Tauri 后端**

- 所有 shell 执行操作通过 Tauri `tauri-plugin-shell` 实现
- 环境变量写入通过自定义 Tauri command（Rust 侧）实现，确保跨平台兼容性
- 这部分需要修改 `packages/desktop/src-tauri/src/` 中的 Rust 代码（新增 command）

> **注：** 本章功能属于 Desktop 新增能力，需要在 `packages/desktop` 中新增 Rust 代码。这是 OpenClaw 中**唯一需要修改 Desktop 后端代码**的功能，其余功能均只修改前端。

---

## 6. 前端集成方案

### 6.0 现有代码结构

`packages/app` 的核心结构：

```
src/
  app.tsx                       # 路由定义，顶层 Provider 树
  pages/
    layout.tsx                  # 主布局（侧边栏 + 内容区），挂载所有 Dialog
    home.tsx                    # 首页
    session.tsx                 # 会话页
  components/
    dialog-settings.tsx         # 设置弹窗（Tab 导航 + 各 Tab 内容）
    settings-agents.tsx         # Agent Tab 占位（TODO）
    settings-mcp.tsx            # MCP Tab 占位（TODO）
    settings-providers.tsx      # Provider Tab 完整实现（参考范例）
  context/
    global-sdk.tsx              # SDK client 访问（useGlobalSDK）
    global-sync.tsx             # 配置读写（useGlobalSync → updateConfig）
    settings.tsx                # 本地设置状态
```

现有设置弹窗（`dialog-settings.tsx`）已有 `settings-agents.tsx` 和 `settings-mcp.tsx` 两个**占位文件**，但内容为空。

---

### 6.1 集成策略：复用设置弹窗 Tab 体系

**结论：不新增路由页面。将管理 UI 实现为设置弹窗内的新 Tab。**

理由：

- 当前设置弹窗（`Dialog + Tabs`）已是全局可访问的管理入口
- Agent 和 MCP Tab 占位文件已存在，只需填充实现
- 与现有 UI 框架（`@opencode-ai/ui/tabs`、`@opencode-ai/ui/dialog`）完全兼容
- 不改变任何路由和布局结构，对现有页面零影响

---

### 6.2 需要实现/修改的文件

| 文件                             | 操作     | 说明                                          |
| -------------------------------- | -------- | --------------------------------------------- |
| `components/settings-agents.tsx` | **实现** | Agent 列表 + 详情 + 创建/编辑表单（替换占位） |
| `components/settings-mcp.tsx`    | **实现** | MCP 服务器列表 + 添加/连接/断开（替换占位）   |
| `components/settings-skills.tsx` | **新建** | Skill 列表 + Hub 浏览页                       |
| `components/dialog-settings.tsx` | **修改** | 新增 Agents / MCP / Skills 三个 Tab 入口      |

---

### 6.3 dialog-settings.tsx 修改说明

在现有 `server` 分组的 Tabs 下新增一个 `"管理"` 分组，包含 3 个新 Tab：

```tsx
<div class="flex flex-col gap-1.5">
  <Tabs.SectionTitle>管理</Tabs.SectionTitle>
  <div class="flex flex-col gap-1.5 w-full">
    <Tabs.Trigger value="agents">
      <Icon name="agent" />
      Agents
    </Tabs.Trigger>
    <Tabs.Trigger value="mcp">
      <Icon name="server" />
      MCP 服务器
    </Tabs.Trigger>
    <Tabs.Trigger value="skills">
      <Icon name="skill" />
      Skills
    </Tabs.Trigger>
  </div>
</div>
```

对应 Tab Content：

```tsx
<Tabs.Content value="agents" class="no-scrollbar"><SettingsAgents /></Tabs.Content>
<Tabs.Content value="mcp" class="no-scrollbar"><SettingsMcp /></Tabs.Content>
<Tabs.Content value="skills" class="no-scrollbar"><SettingsSkills /></Tabs.Content>
```

---

### 6.4 数据访问模式

各管理 Tab 统一遵循以下模式（参照 `settings-providers.tsx`）：

**读取数据**

```tsx
// 通过 globalSDK 调用 SDK 接口
const sdk = useGlobalSDK()
const [agents] = createResource(() => sdk.client.app.agents())
const [mcp] = createResource(() => sdk.client.mcp.status())
const [skills] = createResource(() => sdk.client.app.skills())
```

**写入配置（Agent CRUD）**

```tsx
// 通过 globalSync.updateConfig 写回全局配置
const sync = useGlobalSync()
async function saveAgent(name: string, cfg: AgentConfig) {
  const current = sync.config()
  await sync.updateConfig({
    ...current,
    agent: { ...current.agent, [name]: cfg },
  })
}
```

**MCP 操作**

```tsx
// 直接调用 SDK MCP 方法
await sdk.client.mcp.add({ name, config })
await sdk.client.mcp.connect({ name })
await sdk.client.mcp.disconnect({ name })
```

---

### 6.5 组件内部结构（以 settings-agents.tsx 为例）

Agent 管理 Tab 内部使用**主从布局（Master-Detail）**：

```
SettingsAgents
├── 左侧列表区（含搜索栏、筛选器、新建按钮）
│   └── AgentListItem × N（按来源类型显示徽章和操作菜单）
└── 右侧内容区（createSignal 控制当前视图）
    ├── AgentDetail（查看详情，仅 config 来源显示编辑按钮）
    ├── AgentForm（创建 / 编辑表单）
    └── AgentEmpty（未选中时的空态）
```

所有子视图均为同一 Tab 内部切换，不产生路由跳转。

---

### 6.6 UI 组件选型

全部使用项目已有的 `@opencode-ai/ui` 组件库，禁止引入新的组件库依赖：

| 需求            | 使用组件                                               |
| --------------- | ------------------------------------------------------ |
| 列表/表格       | 原生 `<For>` + Tailwind 样式                           |
| 表单输入        | `@opencode-ai/ui/input`（若有）或原生 input + Tailwind |
| 开关（boolean） | `@opencode-ai/ui/switch`（若有）                       |
| 确认对话框      | `@opencode-ai/ui/dialog`（嵌套弹窗）                   |
| 状态徽章        | 原生 span + Tailwind 颜色工具类                        |
| 颜色选择        | 原生 `<input type="color">`                            |
| 加载状态        | 参照 settings-providers.tsx 中的 skeleton 实现         |
| Toast 提示      | `showToast` from `@opencode-ai/ui/toast`               |

> **注：** 实现前需先检查 `@opencode-ai/ui` 实际导出的组件列表，以上为预估，实际以包内容为准。

---

### 6.7 Web 端与 Desktop 端的功能差异处理

#### 6.7.1 平台判断方式

通过 `usePlatform()` 上下文获取平台信息：

```tsx
const platform = usePlatform()

// 判断是否为 Desktop（Tauri）环境
const isDesktop = platform.platform === "desktop"
```

`Platform` 类型定义（`context/platform.tsx`）：

- `platform.platform`：`"web"` | `"desktop"`
- `platform.openPath`：仅 Desktop 可用，用于打开本地路径（如文件夹）
- `platform.openFilePickerDialog`：仅 Desktop 可用，原生文件选择对话框
- `platform.os`：仅 Desktop 有，值为 `"macos"` | `"windows"` | `"linux"`

#### 6.7.2 各功能模块的平台差异汇总

| 功能                                      | Web 端        | Desktop 端                                               |
| ----------------------------------------- | ------------- | -------------------------------------------------------- |
| **Agent 管理**                            |               |                                                          |
| 查看所有 Agent 列表和详情                 | ✅            | ✅                                                       |
| 创建/编辑/删除 `config` 来源 Agent        | ✅            | ✅                                                       |
| 编辑 `file` 来源 Agent（.md 文件）        | ❌ 不支持     | ✅ 通过 `platform.openPath` 用外部编辑器打开             |
| **Skill 管理**                            |               |                                                          |
| 查看已安装 Skill 列表                     | ✅            | ✅                                                       |
| 安装/卸载 Skill（修改 config）            | ✅            | ✅                                                       |
| 查看 Skill 文件所在目录                   | ❌ 仅展示路径 | ✅ 提供"打开目录"按钮，调用 `platform.openPath`          |
| **MCP 管理**                              |               |                                                          |
| 查看 MCP 服务器列表和状态                 | ✅            | ✅                                                       |
| 添加/连接/断开 MCP 服务器                 | ✅            | ✅                                                       |
| 添加本地 stdio 服务器时选择可执行文件路径 | ❌ 手动输入   | ✅ 可调用 `platform.openFilePickerDialog` 弹出原生选择器 |

#### 6.7.3 UI 条件渲染规范

对于仅 Desktop 可用的功能，按以下方式处理：

**方式 A：操作按钮仅在 Desktop 显示**

```tsx
<Show when={platform.platform === "desktop"}>
  <Button onClick={() => platform.openPath?.(location)}>打开目录</Button>
</Show>
```

**方式 B：按钮始终显示，Desktop 执行原生操作，Web 降级处理**

```tsx
<Button
  onClick={() => {
    if (platform.platform === "desktop") {
      platform.openPath?.(location)
    } else {
      // Web 降级：复制路径到剪贴板
      navigator.clipboard.writeText(location)
      showToast({ title: "路径已复制" })
    }
  }}
>
  {platform.platform === "desktop" ? "打开目录" : "复制路径"}
</Button>
```

**方式 C：文本说明（不提供操作按钮）**

```tsx
<p class="text-text-weak">
  存储路径：{vaultPath}
  <Show when={platform.platform !== "desktop"}>（在 Desktop 版可直接打开）</Show>
</p>
```

> **原则：** 能力缺失时优先降级而非完全隐藏，保持 Web 端功能完整性，同时在 Desktop 端提供更好的原生体验。
