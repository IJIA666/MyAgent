# Config Management

## Purpose
管理应用程序的环境变量、配置文件加载以及依赖注入。

## Requirements

### Requirement: 集中式配置加载
系统必须（MUST）提供一个统一的配置加载入口函数 `loadConfig()`，在应用启动时一次性完成 `.env` 环境变量加载、`mcp_config.json` 配置文件读取、环境变量插值和必填项校验，返回一个类型安全的配置对象。

#### Scenario: 正常启动时加载全部配置
- **WHEN** 用户执行 `npm run dev` 启动应用，且 `.env` 和 `mcp_config.json` 均存在且内容合法
- **THEN** `loadConfig()` 必须返回包含 `llm`（API Key、URL、模型名）、`workspace`（已 resolve 的绝对路径）、`mcp`（MCP Server 连接配置）三个字段的配置对象，且全部字段已填充完毕

#### Scenario: 正常的配置读取
- **WHEN** 应用启动或重新拉起 MCP 进程
- **THEN** 系统能够从打散后的各个门面模块中正确组装完整的配置树

### Requirement: 必填环境变量校验
系统必须（MUST）在配置加载阶段确定一个默认的内置模型，并根据该模型的凭据配置要求（如对应的 API Key 和 URL 环境变量名）进行存在性校验。若该默认模型对应的环境凭据缺失，必须立即抛出明确错误信息并阻止启动；非默认模型对应的环境变量可以为空，但在尝试切换到该模型时系统将进行校验。

#### Scenario: 缺少默认模型必填环境变量时启动失败
- **WHEN** 用户的 `.env` 文件中缺少默认内置模型（如 deepseek-v4-flash）对应的 `AGENT_LLM_API_KEY` 配置项
- **THEN** 系统必须在启动阶段抛出错误，且应用进程必须终止

#### Scenario: 缺少非默认模型的环境变量但正常启动
- **WHEN** 用户的 `.env` 文件中包含了默认模型的配置，但缺少其他专有 API 密钥环境配置
- **THEN** 系统必须正常启动，直到用户主动尝试通过命令切换到该模型且缺失对应 Key 时才提示错误

### Requirement: MCP 配置环境变量插值
系统必须（MUST）在加载 `mcp_config.json` 后，递归扫描所有字符串值，将其中的 `${VAR}` 格式占位符替换为 `process.env` 中对应变量的实际值。若对应的环境变量不存在，必须保留占位符原文不做替换。

#### Scenario: MCP 配置中的 API Key 通过占位符引用 .env
- **WHEN** `mcp_config.json` 中某 Server 的 `env.TAVILY_API_KEY` 值为 `"${TAVILY_API_KEY}"`，且 `.env` 中配置了 `TAVILY_API_KEY=tvly-abc123`
- **THEN** 加载完成后，配置对象中该字段的值必须为 `"tvly-abc123"`

#### Scenario: 未定义的环境变量占位符保留原文
- **WHEN** `mcp_config.json` 中存在 `"${UNDEFINED_VAR}"` 占位符，且 `process.env` 中不存在 `UNDEFINED_VAR`
- **THEN** 加载完成后，该字段的值必须仍为 `"${UNDEFINED_VAR}"`

### Requirement: 配置对象不可变
系统必须（MUST）在 `loadConfig()` 返回配置对象前对其进行深度冻结（`Object.freeze`），防止业务代码在运行时意外修改配置值。

#### Scenario: 业务代码尝试修改配置值时静默失败
- **WHEN** 业务代码获取配置对象后尝试执行 `config.llm.apiKey = "new-key"` 赋值操作
- **THEN** 该赋值操作必须不生效（在 strict mode 下抛出 TypeError），配置值保持不变

### Requirement: 配置文件引导
系统必须（MUST）在 `.env` 或 `mcp_config.json` 文件不存在时，自动从对应的 `.example` 模板文件复制生成，并在终端输出提示信息通知用户。

#### Scenario: 首次运行时自动创建配置文件
- **WHEN** 用户首次 clone 项目后执行启动命令，项目根目录不存在 `.env` 文件但存在 `.env.example`
- **THEN** 系统必须将 `.env.example` 复制为 `.env`，并在终端输出包含"从模板复制"含义的提示信息

### Requirement: 依赖注入式配置传递
`SessionManager`、`McpToolManager` 及工具模块必须（MUST）通过构造函数参数或初始化函数接收配置，不得在模块内部直接读取 `process.env` 或配置文件。

#### Scenario: SessionManager 通过构造参数获取模型配置
- **WHEN** `index.ts` 实例化 `SessionManager` 时传入 `LlmConfig` 对象
- **THEN** `SessionManager` 内部必须使用该参数中的 `apiKey`、`baseUrl`、`model` 初始化 OpenAI 客户端，其源码中不得出现 `process.env` 读取语句

### Requirement: MCP 子进程环境隔离机制
系统必须（MUST）对拉起的 MCP 子进程实施严格的环境变量"白名单"（Whitelist）过滤机制。在启动 MCP Server 时，绝不允许透传宿主机的完整 `process.env`（防止泄露敏感的 API Keys 或系统凭据）。
配置模块必须仅传递：
1. **基础白名单变量**（如 `PATH`, `HOME`, `USERPROFILE`, `TEMP` 等维持进程运转的必需项）。
2. **强制注入变量**（如解决 Windows 编码异常的 `PYTHONIOENCODING=utf-8` 和 `PYTHONUTF8=1`）。
3. **用户自定义变量**（从 `mcp_config.json` 显式指定的变量）。

#### 场景: 启动 MCP 子进程时不泄露系统环境变量
- **WHEN** `McpToolManager` 调用 `buildSubprocessEnv(config.env)` 构造子进程环境变量并拉起 MCP Server
- **THEN** 传递给子进程的最终 `env` 对象中，不得包含系统中存在但未在白名单中的变量（如 `DEEPSEEK_API_KEY`），必须包含操作系统运行所需的 `PATH` 以及显式定义的 `TAVILY_API_KEY`。

### Requirement: 配置的持久化写入
系统必须（MUST）提供将关键运行时配置（如用户指定的全局默认模型名及思考等级）持久化回 `.env` 文件的能力。此操作必须（MUST）采用基于正则表达式的非破坏性替换策略，以确保原有 `.env` 文件中的注释、空白行等人工排版结构不受损害。如果待修改的键不存在，系统应当将其追加至文件末尾。

#### Scenario: 安全覆盖默认模型配置
- **WHEN** 用户在模型向导中选择了将 `deepseek-v4-pro` 设为默认配置并触发保存
- **THEN** 系统必须读取 `.env` 文本，使用正则进行局部行替换（包括 `AGENT_LLM_MODEL` 和 `AGENT_LLM_REASONING_EFFORT`），修改后的 `.env` 文件必须原样保留其它全部注释与非目标键值。

### Requirement: 运行时超时统一装配

系统必须（MUST）由 `loadConfig()` 统一装配 AgentLoop 单次模型调用超时。该超时字段必须存在于返回的 `runtimeLimits` 中，运行时消费方不得自行定义回落默认值。旧记忆子智能体总超时配置必须退出配置树。

#### Scenario: 从环境变量装配自定义模型调用超时

- **WHEN** `AGENT_MODEL_TIMEOUT_MS` 为 `45000`
- **THEN** `loadConfig()` 返回的 `runtimeLimits.modelTimeoutMs` 必须为 `45000`
- **THEN** 返回的 `runtimeLimits` 中不得包含 `subAgentTimeoutMs`

#### Scenario: 未提供安全有效的环境变量时使用统一默认值

- **WHEN** `AGENT_MODEL_TIMEOUT_MS` 缺失、为空白、无法解析为整数、不是正数或超出 Node.js 定时器安全范围
- **THEN** `loadConfig()` 返回的 `modelTimeoutMs` 必须为 `60000`

#### Scenario: 旧记忆子智能体超时变量退出

- **WHEN** 部署环境仍提供 `AGENT_SUB_AGENT_TIMEOUT_MS`
- **THEN** `loadConfig()` 必须忽略该变量，且不得在 `runtimeLimits` 中生成 `subAgentTimeoutMs`

### Requirement: 超时配置单一来源

系统必须（MUST）将 `loadConfig()` 装配后的模型调用超时原样传递给 AgentLoop；AgentLoop 到达模型调用边界时必须使用会话配置中的单次调用超时。

#### Scenario: AgentLoop 使用已装配的单次调用超时

- **WHEN** 会话配置中的 `runtimeLimits.modelTimeoutMs` 为 `45000`，且 AgentLoop 发起模型请求
- **THEN** AgentLoop 必须使用 `45000` 创建该次请求的超时信号，不得改用消费方本地默认值

#### Scenario: AgentLoop 执行前配置尚未注入

- **WHEN** AgentLoop 到达模型调用边界时 `SessionContext` 尚未注入 `AppConfig`
- **THEN** 系统必须抛出能够定位配置初始化问题的明确错误，不得静默回落到硬编码超时
