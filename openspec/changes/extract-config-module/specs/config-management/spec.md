## 新增需求

### 需求: 集中式配置加载
系统必须（MUST）提供一个统一的配置加载入口函数 `loadConfig()`，在应用启动时一次性完成 `.env` 环境变量加载、`mcp_config.json` 配置文件读取、环境变量插值和必填项校验，返回一个类型安全的配置对象。

#### 场景: 正常启动时加载全部配置
- **WHEN** 用户执行 `npm run dev` 启动应用，且 `.env` 和 `mcp_config.json` 均存在且内容合法
- **THEN** `loadConfig()` 必须返回包含 `llm`（API Key、URL、模型名）、`workspace`（已 resolve 的绝对路径）、`mcp`（MCP Server 连接配置）三个字段的配置对象，且全部字段已填充完毕

### 需求: 必填环境变量校验
系统必须（MUST）在配置加载阶段对 `DEEPSEEK_API_KEY`、`DEEPSEEK_API_URL`、`DEEPSEEK_MODEL` 进行存在性校验。若任一变量缺失，必须立即抛出包含变量名称的明确错误信息并阻止启动，不得使用硬编码默认值静默回退。

#### 场景: 缺少必填环境变量时启动失败
- **WHEN** 用户的 `.env` 文件中缺少 `DEEPSEEK_API_KEY` 配置项
- **THEN** 系统必须在启动阶段抛出错误，错误信息中必须包含 `DEEPSEEK_API_KEY` 变量名称，且应用进程必须终止

### 需求: MCP 配置环境变量插值
系统必须（MUST）在加载 `mcp_config.json` 后，递归扫描所有字符串值，将其中的 `${VAR}` 格式占位符替换为 `process.env` 中对应变量的实际值。若对应的环境变量不存在，必须保留占位符原文不做替换。

#### 场景: MCP 配置中的 API Key 通过占位符引用 .env
- **WHEN** `mcp_config.json` 中某 Server 的 `env.TAVILY_API_KEY` 值为 `"${TAVILY_API_KEY}"`，且 `.env` 中配置了 `TAVILY_API_KEY=tvly-abc123`
- **THEN** 加载完成后，配置对象中该字段的值必须为 `"tvly-abc123"`

#### 场景: 未定义的环境变量占位符保留原文
- **WHEN** `mcp_config.json` 中存在 `"${UNDEFINED_VAR}"` 占位符，且 `process.env` 中不存在 `UNDEFINED_VAR`
- **THEN** 加载完成后，该字段的值必须仍为 `"${UNDEFINED_VAR}"`

### 需求: 配置对象不可变
系统必须（MUST）在 `loadConfig()` 返回配置对象前对其进行深度冻结（`Object.freeze`），防止业务代码在运行时意外修改配置值。

#### 场景: 业务代码尝试修改配置值时静默失败
- **WHEN** 业务代码获取配置对象后尝试执行 `config.llm.apiKey = "new-key"` 赋值操作
- **THEN** 该赋值操作必须不生效（在 strict mode 下抛出 TypeError），配置值保持不变

### 需求: 配置文件引导
系统必须（MUST）在 `.env` 或 `mcp_config.json` 文件不存在时，自动从对应的 `.example` 模板文件复制生成，并在终端输出提示信息通知用户。

#### 场景: 首次运行时自动创建配置文件
- **WHEN** 用户首次 clone 项目后执行启动命令，项目根目录不存在 `.env` 文件但存在 `.env.example`
- **THEN** 系统必须将 `.env.example` 复制为 `.env`，并在终端输出包含"从模板复制"含义的提示信息

### 需求: 依赖注入式配置传递
`SessionManager`、`McpToolManager` 及工具模块必须（MUST）通过构造函数参数或初始化函数接收配置，不得在模块内部直接读取 `process.env` 或配置文件。

#### 场景: SessionManager 通过构造参数获取模型配置
- **WHEN** `index.ts` 实例化 `SessionManager` 时传入 `LlmConfig` 对象
- **THEN** `SessionManager` 内部必须使用该参数中的 `apiKey`、`baseUrl`、`model` 初始化 OpenAI 客户端，其源码中不得出现 `process.env` 读取语句
