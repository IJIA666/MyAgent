## 改造原因

MyAgent 当前同时使用 workspace 下的 `.agent/` 与 `.myagent/`：项目配置、规则和技能分散在两个命名空间，日志、会话、浏览器状态、工具输出和备份又直接写入项目目录。各模块分别依据 `process.cwd()`、`appConfig.workspace`、构造参数或 `homedir()` 拼装持久化路径，已经造成启动目录不一致、测试产物污染真实项目以及现行规格与生产实现相互矛盾。

长期记忆等后续能力需要稳定的项目身份和应用数据边界，因此应先统一目录作用域与路径解析契约，避免继续在不确定的存储根上扩展功能。

## 变更内容

- **BREAKING**：移除 `.agent` 项目目录，项目配置、规则和技能统一迁移到 `<workspace>/.myagent/`。
- **BREAKING**：将运行日志、trace、audit、会话、浏览器状态、工具输出、截图和备份从 workspace 移至 `~/.myagent/projects/<workspace-key>/`，并按日志、状态、产物和临时数据分层。
- **BREAKING**：统一 `.agent/config.json` 与现有 settings 契约，由用户、项目、项目本机三级 settings 管理终端及权限设置；退役的 `.agent/allowed_commands.json` 不再读取或迁移。
- 新增统一的应用路径解析边界，所有持久化消费者使用规范化 workspace 与可注入应用数据根生成的路径对象，不再自行拼装 `.agent`、`.myagent`、`process.cwd()` 或 `homedir()` 路径。
- 将文件日志初始化调整为 workspace 确认后的两阶段启动，并将 run log、trace 与 audit 分离到各自目录。
- 启动时只检测旧 `.agent` 与旧 workspace 运行数据的目录形状；若存在则每个进程输出一次迁移警告和指引，但不读取、迁移或删除旧内容。
- 更新规则、技能、权限、会话、浏览器、回滚、工具输出和诊断能力的路径契约以及相关测试；测试必须使用隔离的临时应用数据根。
- 采用零兼容迁移：运行时只读取新路径，不双读、双写或自动删除旧目录；变更说明提供人工迁移映射。

## 业务能力

### 新增业务能力

- `application-data-layout`: 定义项目配置、用户配置和按 workspace 隔离的运行数据目录、路径解析、作用域优先级及测试隔离契约。

### 修改业务能力

- `base-stability`: 技能热重载监听目录从 `.agent/skills` 切换为项目 `.myagent/skills`。
- `browser-multi-tenant`: 浏览器持久状态改由项目应用数据目录中的租户状态目录隔离。
- `context-injection-engine`: 项目规则与技能的发现路径切换到 `.myagent/rules` 和 `.myagent/skills`。
- `context-rollback`: 文件回滚备份迁移到项目应用数据的临时备份目录。
- `diagnostic-data-governance`: 诊断数据按 run log、trace 和 audit 独立目录及保留策略治理。
- `logging-observability-and-naming`: 历史诊断文件的定位与命名适配新的项目应用数据目录。
- `rules-injection-caching`: 规则与技能缓存、监听和失效路径切换到项目 `.myagent` 配置目录。
- `security-modes`: 项目权限模式与规则统一写入分层 settings，移除 `allowed_commands.json` 契约。
- `session-persistence`: 会话文件迁移到项目应用数据的持久状态目录。
- `tool-output-offloading`: 完整工具输出迁移到项目应用数据的产物目录，并保持会话引用可解析。
- `trace-logging`: trace 与 audit 改用独立日志目录，并通过统一路径对象定位。
- `unified-logger`: 文件日志在 workspace 解析后写入项目应用数据的日志目录。
- `web-automation`: 默认浏览器 profile 与截图迁移到项目应用数据目录，同时保留显式外部路径覆盖。

## 影响范围

- 配置与启动：`src/config/loader.ts`、终端配置、权限 settings 仓储、logger 初始化和应用组合根。
- 上下文与会话：`RuleManager`、`contextLoader`、`ContextRepository`、history 命令和 session/tracer 构造。
- 工具与运行数据：浏览器 action、`ToolDispatcher`、`FileBackupManager`、trace/audit 写入及其清理逻辑。
- 测试与工程配置：相关单元、契约、集成测试的临时目录注入，以及 `.gitignore` 对项目 `.myagent` 配置的跟踪策略。
- 不改变外部模型协议、工具业务行为或权限判定优先级；不包含长期记忆内容、召回策略、跨 worktree 数据共享、多进程 settings 并发协调或旧目录自动迁移工具。
