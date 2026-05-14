# OpenCode PostgreSQL 改造方案

## 目标

当前 `packages/opencode` 的持久化层建立在 SQLite + Drizzle SQLite 方言之上。目标是把这套实现改造成 PostgreSQL 版本，并明确哪些内容可以复用、哪些必须重写。

这个文档先聚焦 `packages/opencode` 当前代码，而不是泛泛讨论数据库迁移。

## 设计经验与落地原则

### 1. Drizzle 只能减少“查询构建”的改动，不能消除同步/异步差异

这次迁移中最重要的经验是：Drizzle 的确让大部分查询构建代码可以复用，例如：

- `db.select().from(Table).where(...)`
- `db.insert(Table).values(...)`
- `db.update(Table).set(...).where(...)`
- `eq` / `and` / `or` / `inArray` 等条件组合

但 SQLite 与 PostgreSQL 的执行模型不同：

| 场景 | SQLite Drizzle | PostgreSQL Drizzle |
|---|---|---|
| 查询多行 | `.all()` 同步返回数组 | 查询对象本身是 Promise，需要 `await` |
| 查询单行 | `.get()` 同步返回单行 | `await rows` 后取 `rows[0]` |
| 执行写入 | `.run()` 同步执行 | 直接 `await insert/update/delete` |
| 事务 | 同步 transaction callback | async transaction callback |

因此不能把这次迁移理解成“只换连接串”。真正需要改的是 **数据库执行边界**。

### 2. `pg` 没有可用的同步查询模式

不要再尝试寻找 `pg` 的同步查询能力。Node.js 的 `pg`/`node-postgres` 是异步网络驱动，不提供可用于该项目的同步查询接口。

这意味着：

- `Database.use(...)` 必须允许返回 Promise
- `Database.transaction(...)` 必须允许 async callback
- Effect 代码中要用 `Effect.promise(...)` 包裹 DB 调用
- 原先依赖同步 DB 的 helper / projector / test 需要传播 async

### 3. 最小改动策略：只改执行边界，不重写业务查询

推荐迁移方式不是大规模重构，而是机械替换执行尾部：

1. `.all()`：删除，直接 `await query`
2. `.get()`：改为 `await query.then(rows => rows[0])` 或先 `const rows = await query`
3. `.run()`：删除，直接 `await mutation`
4. `Effect.sync(() => Database.use(...))`：改成 `Effect.promise(() => Database.use(...))`
5. 同步 projector callback：改为允许 `void | Promise<void>`

这个策略能最大限度保留现有业务逻辑，避免把 PostgreSQL 迁移扩大成业务重构。

### 4. SyncEvent / projector 是关键异步边界

`src/sync/index.ts` 和 `src/session/projectors*.ts` 原本强依赖 SQLite 同步事务。迁移 PostgreSQL 时必须同步改造：

- `ProjectorFunc` 从同步函数变成 `void | Promise<void>`
- `process(...)` 变成 async
- projector 内部所有 insert/update/delete/select 都要 await
- 事件持久化和业务 projector 仍保持在同一个 transaction 中

这是整个迁移里最容易漏的地方，因为它不是 schema 问题，而是运行时执行顺序问题。

### 5. 不要保留启动期 JSON 自动迁移

PostgreSQL 版本不再需要 `src/index.ts` 启动时自动执行 `JsonMigration.run(...)`。

原因：

- SQLite 时代可以通过本地 `opencode.db` 文件存在性推断是否迁移
- PostgreSQL 没有本地 DB 文件，这个判断失效
- 启动时隐式扫描/导入 JSON 会让服务启动依赖历史文件状态，增加不可控副作用

结论：JSON 历史数据迁移应当是显式命令或独立脚本，不应该在主 CLI 启动 middleware 中自动执行。

### 6. 测试环境要显式提供 PostgreSQL 连接串

原测试预加载文件 `test/preload.ts` 会设置 `OPENCODE_DB=":memory:"`，这是 SQLite 时代的配置。PostgreSQL 迁移后需要改成：

- 优先使用调用方提供的 `OPENCODE_DB_URL`
- 没有提供时才使用默认 PostgreSQL 测试连接串

否则 `Flag.OPENCODE_DB` 会覆盖 `OPENCODE_DB_URL`，导致 pg 把 `:memory:` 当成连接信息解析，引发 `getaddrinfo ESERVFAIL` 之类错误。

### 7. 远程 PostgreSQL 下测试超时不一定代表逻辑错误

全量测试或大数据量测试跑远程 PostgreSQL 会明显慢于本地 SQLite。例如 `session-messages.test.ts` 中写入 520 条消息/part 的用例，在远程 PG 下 `30s` 超时，但 `120s` 超时时间下可以通过。

判断测试失败时要区分：

- 类型错误：必须修
- SQL/连接错误：检查 schema push、连接串、测试 preload
- 超时：先用更长 timeout 验证是否逻辑正确，再决定是否优化批量写入
- `Cannot use a pool after calling end on the pool`：通常说明还有后台异步任务在 DB pool close 后继续访问数据库，需要等待任务结束或调整测试清理顺序

### 8. `Effect.runSync` 不能执行带异步 DB 的 Effect

迁移后所有 DB 访问都可能异步，因此旧代码里如果有：

- `Effect.runSync(dbEffect)`
- 同步 generator 中调用异步分页/查询

都必须改成：

- `Effect.runPromise(...)`
- async generator
- `Array.fromAsync(...)`

实际案例：`MessageV2.stream(...)` 原先用 `Effect.runSync(page(...))`，迁移 PostgreSQL 后会抛出 `AsyncFiberError: An asynchronous Effect was executed with Effect.runSync`。正确做法是把 `stream` 改成 async generator，并让调用方用 `Array.fromAsync(...)` 或在 Effect 中 `Effect.promise(...)`。

## 当前实现结论

当前实现不是“通用 SQL 层”，而是“SQLite 专用实现”，主要体现在：

1. 连接驱动绑定 SQLite：
   - `src/storage/db.bun.ts` 使用 `bun:sqlite` + `drizzle-orm/bun-sqlite`
   - `src/storage/db.node.ts` 使用 `node:sqlite` + `drizzle-orm/node-sqlite`
2. 核心 DB 层绑定 SQLite：
   - `src/storage/db.ts` 使用 `SQLiteBunDatabase`
   - `src/storage/db.ts` 使用 `drizzle-orm/bun-sqlite/migrator`
   - `src/storage/db.ts` 使用 `SQLiteTransaction`
3. Schema 绑定 SQLite 方言：
   - 所有 `src/**/*.sql.ts` 都从 `drizzle-orm/sqlite-core` 导入
   - 所有表都使用 `sqliteTable`
4. 运行期包含 SQLite 专属语句：
   - `PRAGMA journal_mode`
   - `PRAGMA synchronous`
   - `PRAGMA busy_timeout`
   - `PRAGMA cache_size`
   - `PRAGMA foreign_keys`
   - `PRAGMA wal_checkpoint`
5. 迁移配置绑定 SQLite：
   - `packages/opencode/drizzle.config.ts` 的 `dialect` 是 `sqlite`
   - `dbCredentials.url` 指向本地 `.db` 文件

所以 PostgreSQL 改造不是只替换连接字符串，而是要重新定义“方言、驱动、迁移、类型映射、初始化策略”。

## 受影响文件

### 一、数据库初始化与事务层

- `packages/opencode/src/storage/db.ts`
- `packages/opencode/src/storage/db.bun.ts`
- `packages/opencode/src/storage/db.node.ts`

### 二、Schema 定义

- `packages/opencode/src/account/account.sql.ts`
- `packages/opencode/src/project/project.sql.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/share/share.sql.ts`
- `packages/opencode/src/control-plane/workspace.sql.ts`
- `packages/opencode/src/sync/event.sql.ts`
- `packages/opencode/src/data-migration.sql.ts`
- `packages/opencode/src/storage/schema.sql.ts`

### 三、迁移与导入逻辑

- `packages/opencode/drizzle.config.ts`
- `packages/opencode/src/storage/json-migration.ts`
- `packages/opencode/migration/**/migration.sql`

### 四、潜在依赖点

- `packages/opencode/src/index.ts`
- `packages/opencode/src/cli/cmd/db.ts`
- 其他直接依赖 Drizzle SQLite 类型或连接实例的调用点

### 五、这次补充分析发现的遗漏点

除了前面的驱动、schema、migration 之外，还有几类容易漏掉但实际上必须处理的耦合点：

1. `src/data-migration.ts` 使用了 SQLite JSON 函数 `json_extract(...)`
2. `src/index.ts` 用 `opencode.db` 文件是否存在，作为“是否需要执行一次性导入”的判断条件
3. `src/cli/cmd/db.ts` 整个命令是围绕 SQLite shell 和 `.db` 文件设计的
4. `src/storage/db.ts` 的 `OPENCODE_DB` 语义是“SQLite 文件路径或 :memory:”
5. `src/storage/db.ts` 的事务选项暴露了 SQLite 风格的 `deferred/immediate/exclusive`
6. `package.json` 的 `#db` import map 目前只指向 SQLite 实现
7. 仓库里有少量 SQLite 使用并不属于 opencode 主数据库，需要区分处理

## 为什么不能“直接兼容”

SQLite 与 PostgreSQL 都是 SQL 数据库，但当前代码依赖的是各自方言和驱动 API，不是 ANSI SQL 抽象层。

### 1. 表定义 API 不兼容

当前所有表定义都使用：

- `sqliteTable`
- `text`
- `integer`
- `real`
- `primaryKey`
- `index`

这些来自 `drizzle-orm/sqlite-core`。

如果迁移到 PostgreSQL，通常要切换到：

- `pgTable`
- `text`
- `integer`
- `doublePrecision` / `real`
- `boolean`
- `jsonb`
- `timestamp`

也就是：**不是 SQL 语法兼容性问题，而是 Drizzle schema DSL 已经选了 SQLite 方言。**

### 2. SQLite 特有 PRAGMA 不能用于 PostgreSQL

`src/storage/db.ts` 和 `src/storage/json-migration.ts` 里存在多个 `PRAGMA`：

- WAL
- busy timeout
- cache size
- temp store

这些是 SQLite 运行参数，在 PostgreSQL 中没有等价写法可直接替代。

### 3. 类型映射需要重做

当前 schema 中几个地方虽然“语义上”看起来通用，但在 PostgreSQL 里需要换成更合适的列定义：

#### 时间字段

当前大量字段用 `integer()` 存 Unix 毫秒，例如：

- `time_created`
- `time_updated`
- `time_initialized`
- `time_used`
- `token_expiry`

PostgreSQL 可以继续用 `bigint/integer` 存 epoch 毫秒，也可以切到 `timestamp`。这不是“必须改业务语义”，但**必须重新确认 pg 侧列类型**。

建议：第一阶段继续保留 epoch 毫秒，避免业务层一起改。

#### 布尔字段

`ControlAccountTable.active` 目前是：

- `integer({ mode: "boolean" })`

这是 SQLite 常见写法。PostgreSQL 应改成真正的 `boolean()`。

#### JSON 字段

当前多个字段写成：

- `text({ mode: "json" })`

例如：

- `project.sandboxes`
- `project.commands`
- `session.summary_diffs`
- `session.revert`
- `session.permission`
- `session.model`
- `message.data`
- `part.data`
- `permission.data`
- `workspace.extra`
- `event.data`

这在 PostgreSQL 更适合切成 `jsonb()`，否则会失去 PostgreSQL 原生 JSON 能力。

#### 浮点字段

`session.cost` 目前用 `real()`。在 PostgreSQL 里要明确是否继续使用 `real`，还是改成 `double precision` / `numeric`。

建议：

- 若只是近似展示：`double precision`
- 若要做账务精度：`numeric`

### 4. 迁移 SQL 不能直接复用

当前 migration 目录下的 SQL 是 SQLite 方言产物，例如：

- 反引号包裹标识符
- SQLite 类型系统
- SQLite DDL 行为

即使有部分语句“看起来像 SQL”，也不应直接拿去跑 PostgreSQL。

正确做法是：

1. 把 schema 改成 pg 版本
2. 把 `drizzle.config.ts` 切到 PostgreSQL dialect
3. 重新生成 PostgreSQL migration

### 5. 业务 SQL 中也有 SQLite 专有写法

之前只看 schema 和连接层还不够，`src/data-migration.ts` 里还有这种聚合：

- `json_extract(message.data, '$.cost')`
- `json_extract(message.data, '$.tokens.input')`
- `json_extract(message.data, '$.role') = 'assistant'`

这不是 schema 问题，而是**运行期查询方言**问题。

PostgreSQL 下要改成对应的 JSON/JSONB 提取表达式，例如基于 `->`、`->>`、cast、聚合函数来重写。

这意味着：

- 不是只有 `*.sql.ts` 要改
- 任何内联 `sql\`...\`` 片段都要重新审查

### 6. 启动期“一次性迁移”判定依赖 SQLite 文件存在性

`src/index.ts` 当前用：

- `path.join(Global.Path.data, "opencode.db")`
- 如果文件不存在，则自动执行 `JsonMigration.run(...)`

这个逻辑到了 PostgreSQL 就失效，因为：

1. PostgreSQL 不再有本地 `.db` 文件
2. “数据库是否已初始化” 需要改成别的判定方式

更合理的做法通常是：

- 检查某张迁移状态表是否存在
- 或检查 `data_migration` / schema migration 表
- 或把 JSON 导入变成显式命令，而不是启动时通过文件存在性隐式触发

### 7. CLI 数据库工具也需要重新设计

`src/cli/cmd/db.ts` 当前直接绑定 SQLite：

1. `bun:sqlite`
2. `drizzle-orm/bun-sqlite`
3. `sqlite3 <db-file>` 交互 shell
4. 命令描述里就写着 `interactive sqlite3 shell`

所以 PostgreSQL 改造不能只改底层，还要处理 CLI：

- `db path` 可能要改成打印 connection info 的脱敏版本，或者直接删除
- `db` 查询命令要改成通过 pg 客户端执行查询
- 交互 shell 不再是 `sqlite3`，可能变成 `psql`，或者只保留非交互 query 模式
- `migrate` 命令文案也不能再写 “migrate JSON data to SQLite”

### 8. 数据库配置语义需要重定义

`src/storage/db.ts` 当前的 `OPENCODE_DB` 语义是：

- `:memory:`
- 绝对路径
- 相对路径拼到 `Global.Path.data`

这是典型的 SQLite 文件数据库配置。

PostgreSQL 下要重新设计，例如：

- `OPENCODE_DB_URL`
- `OPENCODE_DB_HOST`
- `OPENCODE_DB_PORT`
- `OPENCODE_DB_USER`
- `OPENCODE_DB_PASSWORD`
- `OPENCODE_DB_NAME`
- `OPENCODE_DB_SSL`

如果还想保留 `OPENCODE_DB` 这个名字，也必须重新定义它的含义，不然与现有“文件路径”语义冲突。

### 9. 事务行为枚举也带有 SQLite 语义

`src/storage/db.ts` 当前事务接口暴露：

- `deferred`
- `immediate`
- `exclusive`

`src/sync/index.ts` 还明确依赖了 `behavior: "immediate"`。

这在 SQLite 中很关键，因为它决定锁获取时机；但 PostgreSQL 的事务模型不是这个接口语义。

所以这里不能只是“类型改一下”，而是要重新定义：

1. PostgreSQL 下 `Database.transaction(..., options)` 如何表达并发语义
2. `sync/index.ts` 当前依赖的“先锁住再读写”需求，应该如何在 pg 中保证

很可能需要：

- `SELECT ... FOR UPDATE`
- 更明确的唯一约束/冲突更新
- 或提高隔离级别

这是一个**行为一致性**风险点，不只是编译问题。

### 10. `#db` import map 也要一起调整

`packages/opencode/package.json` 里：

- `#db.bun` → `./src/storage/db.bun.ts`
- `#db.node` → `./src/storage/db.node.ts`

这两个实现现在都绑定 SQLite。

如果做 PostgreSQL 版，至少要同步调整：

- import map 指向新的 pg 实现
- 或新增更清晰的 `db.pg.ts` / `db.sqlite.ts` 分发结构

否则顶层 `src/storage/db.ts` 即使改了，运行时入口还是可能走到旧的 SQLite 文件。

### 11. 不是所有 SQLite 依赖都属于这次迁移范围

例如 `src/cli/cmd/tui/context/editor-zed.ts` 使用 `bun:sqlite`，但它访问的是 **Zed 编辑器自己的 SQLite 数据库**，不是 opencode 主数据库。

这个文件不应该被误判为 PostgreSQL 改造目标。

所以要区分两类内容：

1. **必须改**：opencode 自己的持久化数据库实现
2. **不必改**：只是为了读取第三方工具的 SQLite 文件

## 推荐改造策略

不建议直接在现有 SQLite 文件上硬切 PostgreSQL。建议采用“两阶段”方案。

---

## 方案 A：直接替换为 PostgreSQL（不保留 SQLite）

适合场景：

- 你就是要做一个长期维护的 `dev-postgre` 分支
- 不要求同一套代码同时兼容 SQLite
- 允许迁移目录和 schema 全量切方言

### 改造步骤

#### 步骤 1：替换驱动层

把以下文件改成 PostgreSQL 驱动：

- `src/storage/db.bun.ts`
- `src/storage/db.node.ts`
- `src/storage/db.ts`

建议目标：

- 使用 `pg` 驱动
- 使用 `drizzle-orm/node-postgres`

需要调整的点：

1. `init(path: string)` 改为 `init(connection: string)` 或配置对象
2. `Path` 不再是 `.db` 文件路径，而是 PostgreSQL connection string
3. `Client` 类型改成 pg 对应 Drizzle database 类型
4. `Transaction` 类型改成 pg 对应 transaction 类型
5. `close()` 改成关闭 pg pool/client
6. `package.json` 的 `#db` 映射同步切换

#### 步骤 2：移除 SQLite 初始化语句

从 `src/storage/db.ts` 删除或替换：

- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA cache_size = -64000`
- `PRAGMA foreign_keys = ON`
- `PRAGMA wal_checkpoint(PASSIVE)`

PostgreSQL 连接池配置应该放到驱动或部署参数，不在 SQL 初始化里做这些事。

同时要重做这两个入口逻辑：

1. `getChannelPath()` 这类基于文件名的路径策略
2. `Path` 常量的含义 —— PostgreSQL 下更像“连接配置”而不是文件路径

#### 步骤 3：全量迁移 schema 到 pg-core

把所有 `src/**/*.sql.ts`：

- `drizzle-orm/sqlite-core` → `drizzle-orm/pg-core`
- `sqliteTable` → `pgTable`

同时逐个确认字段类型：

1. `integer({ mode: "boolean" })` → `boolean()`
2. `text({ mode: "json" })` → `jsonb()`
3. 时间字段继续用整数，或统一改 `timestamp`
4. `real()` 改为 `doublePrecision()` 或 `numeric()`

#### 步骤 4：重建 migrations

调整 `packages/opencode/drizzle.config.ts`：

- `dialect: "postgresql"`
- `dbCredentials` 改为 PostgreSQL 连接信息

然后重新生成迁移，不复用原 SQLite migration。

#### 步骤 5：重写 JSON 导入逻辑

`src/storage/json-migration.ts` 需要改：

1. 删除 SQLite `PRAGMA`
2. 检查 `db.run("BEGIN TRANSACTION")` / `COMMIT` 是否改成 pg 驱动支持的事务方式
3. 校验 `insert(...).onConflictDoNothing().run()` 在 pg 驱动下的行为一致性
4. 评估批量写入大小与网络往返问题
5. 重新设计启动时自动迁移触发条件，不能再依赖 `opencode.db` 文件是否存在
6. 同步改 `src/cli/cmd/db.ts` 的 `migrate` 子命令实现与文案

#### 步骤 6：重写运行期 SQLite 方言 SQL

至少包括：

- `src/data-migration.ts` 中所有 `json_extract(...)`
- 任何其他通过 `sql\`...\`` 写死 SQLite JSON 语法的查询

这是最容易漏掉的一类问题，因为它们不在 schema 文件里。

### 优点

- 目标明确
- 代码更干净
- 不必维持双方言复杂度

### 缺点

- 分支与主线差异较大
- 很难低成本回合并到 SQLite 主线

---

## 方案 B：抽象数据库方言，同时支持 SQLite 与 PostgreSQL

适合场景：

- 你希望主线还能继续跑 SQLite
- PostgreSQL 是可选后端
- 后续希望通过配置切换数据库

### 这个方案的难点

这不是简单加一个 `if`。难点在于：

1. Drizzle schema 是方言相关的
2. migration 目录会分裂
3. runtime 初始化逻辑也不同
4. JSON/boolean/timestamp 类型定义要做一层抽象

### 推荐设计

#### 1. 增加数据库方言配置

例如新增：

- `OPENCODE_DB_DIALECT=sqlite|postgres`

#### 2. 拆分 schema

可能需要形成：

- `src/storage/schema/sqlite/*.ts`
- `src/storage/schema/postgres/*.ts`

或者按模块平铺：

- `project.sqlite.sql.ts`
- `project.pg.sql.ts`

#### 3. 拆分 DB 初始化

例如：

- `db.sqlite.ts`
- `db.postgres.ts`

再由统一入口选择。

#### 4. migration 分目录

例如：

- `migration/sqlite/**`
- `migration/postgres/**`

#### 5. JSON 导入逻辑抽象成方言无关 + 方言相关两层

- 上层负责读取 JSON 文件和组装 values
- 下层负责事务和批量写入策略

### 优点

- 长期最灵活
- 主线与 PostgreSQL 都能保留

### 缺点

- 改造量明显更大
- 测试矩阵翻倍
- schema/migration 维护成本更高

---

## 建议采用的落地路线

如果当前目标只是做一个 `dev-postgre` 分支，我建议优先走 **方案 A**。

原因：

1. 当前代码对 SQLite 绑定很深
2. 双方言会引入大量分支逻辑
3. 先在分支上做单方言 PostgreSQL，更容易验证数据模型和运行稳定性

## 具体实施清单

### Phase 1：建立 PostgreSQL 最小可运行版本

1. 引入 PostgreSQL 驱动与 Drizzle pg 驱动
2. 改 `db.ts` / `db.bun.ts` / `db.node.ts`
3. 去掉所有 `PRAGMA`
4. 改 `drizzle.config.ts` 为 PostgreSQL
5. 先把 schema 全量切到 `pg-core`
6. 生成首版 pg migration
7. 去掉基于 `opencode.db` 文件存在性的启动判定

**验收标准：**

- 可以连接 PostgreSQL
- 可以执行 migration
- 应用能正常启动
- 启动流程不再依赖本地 SQLite 文件

### Phase 2：修正类型映射

1. 逐表确认 JSON 列改 `jsonb`
2. 确认 `boolean`
3. 确认 `real/cost`
4. 确认时间列策略（保留 epoch 或改 timestamp）
5. 确认 `bigint` 与 TypeScript/Bun 序列化兼容性

**验收标准：**

- schema 与业务读写匹配
- 无明显类型不一致

### Phase 3：重做数据迁移

1. 重写 `json-migration.ts` 的事务控制
2. 调整批量写入策略
3. 校验冲突处理与外键约束
4. 验证历史 `storage/` JSON 可成功导入 PostgreSQL
5. 重写 `data-migration.ts` 中的 SQLite JSON 查询

**验收标准：**

- JSON 历史数据可迁移
- 统计结果与 SQLite 迁移预期一致
- 运行期数据修复脚本在 PostgreSQL 下可执行

### Phase 4：补齐运维与配置

1. 设计环境变量：连接串、池大小、SSL 等
2. 更新启动文档
3. 补充开发/测试说明

## 风险点

### 1. `integer` 时间戳是否溢出

如果继续用 PostgreSQL `integer` 存毫秒时间戳，容量可能不足。更稳妥的是：

- 使用 `bigint`
- 或改成 `timestamp`

这是 PostgreSQL 版本里要优先确认的一个点。

### 1.1 如果保留 epoch 毫秒，优先考虑 `bigint`

当前很多地方直接写 `Date.now()`，而 PostgreSQL 若继续存毫秒时间戳，更安全的是 `bigint` 而不是 `integer`。

但这会引入另一个问题：

- pg 驱动返回 `bigint` 时，TypeScript 侧可能拿到 `string` 或 `bigint`

所以这里需要在“DB 精度安全”和“现有业务层 number 使用习惯”之间做取舍。

### 2. JSON 查询能力变化

如果迁移到 `jsonb`，未来可以做更强查询；但如果业务层仍假设它只是字符串 blob，需要确认读写序列化行为。

### 3. 事务语义不同

SQLite 本地单文件事务与 PostgreSQL 网络连接事务不是一个性能模型。`json-migration.ts` 的批量导入参数可能需要重新调优。

同时 `sync/index.ts` 里现在依赖 `immediate` 事务防止并发竞争，这部分在 PostgreSQL 中要重新证明其正确性。

### 4. 本地单机部署体验变化

现在 SQLite 只依赖本地 `.db` 文件。切 PostgreSQL 后，开发与运行都要依赖外部数据库服务，部署模型会变复杂。

## 我建议的第一批代码改动顺序

如果下一步开始实施，建议按这个顺序改：

1. `packages/opencode/src/storage/db.ts`
2. `packages/opencode/src/storage/db.bun.ts`
3. `packages/opencode/src/storage/db.node.ts`
4. `packages/opencode/drizzle.config.ts`
5. `packages/opencode/src/storage/schema.sql.ts`
6. `packages/opencode/src/project/project.sql.ts`
7. `packages/opencode/src/session/session.sql.ts`
8. `packages/opencode/src/account/account.sql.ts`
9. `packages/opencode/src/share/share.sql.ts`
10. `packages/opencode/src/control-plane/workspace.sql.ts`
11. `packages/opencode/src/sync/event.sql.ts`
12. `packages/opencode/src/data-migration.sql.ts`
13. `packages/opencode/src/storage/json-migration.ts`
14. `packages/opencode/src/data-migration.ts`
15. `packages/opencode/src/index.ts`
16. `packages/opencode/src/cli/cmd/db.ts`

## 最终结论

PostgreSQL 改造在这个仓库里是一个**真实的存储层迁移工程**，不是连接串切换。

最小必要改动包括：

- 替换 SQLite 驱动
- 替换 Drizzle 方言
- 重写 schema 定义
- 重建 migrations
- 重写 SQLite 专属初始化与 JSON 导入逻辑

如果目标是先在 `dev-postgre` 分支上跑通，我建议先只做 PostgreSQL 单方言版本，不要一开始就追求双数据库兼容。
