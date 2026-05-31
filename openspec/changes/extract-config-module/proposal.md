## 改造原因

当前项目的配置加载逻辑分散在 `session.ts`、`mcp-client.ts`、`tools.ts`、`index.ts` 四个业务文件中，各自直接读取 `process.env` 或配置文件，违反单一职责原则。导致的具体问题包括：`dotenv` 被重复加载且存在时序竞争、API Key 硬编码在源码中作为默认回退值、`.env` 与 `mcp_config.json` 两套配置体系完全割裂（MCP 配置中的 API Key 无法引用 `.env`）、业务模块不可独立测试。

## 变更内容

- 新建 `src/config.ts` 配置管理模块，集中承担 `.env` 加载、`mcp_config.json` 读取与解析、`${VAR}` 环境变量插值、必填项校验、配置对象冻结导出等全部配置职责
- `session.ts` 移除顶层 `dotenv` 调用和 `process.env` 读取，改为通过构造函数接收类型化的 `LlmConfig`
- `mcp-client.ts` 移除文件读取和三层配置合并逻辑，改为通过构造函数接收已加载的 `McpConfig`
- `tools.ts` 移除模块顶层的 `process.env.AUTHORIZED_WORKSPACE_DIR` 求值，改为延迟初始化
- `index.ts` 移除 `ensureConfigFilesExist()` 和手动 `dotenv` 加载，改为调用 `loadConfig()` 并注入依赖
- `mcp_config.example.json` 的 API Key 值改为 `${TAVILY_API_KEY}` 占位符格式
- `.gitignore` 新增 `mcp_config.json` 忽略规则

## 业务能力

### 新增业务能力
- `config-management`: 统一配置管理能力——提供集中式的配置加载、校验、环境变量插值和类型安全的配置对象导出

### 修改业务能力
- `simple-agent-core`: "动态模型配置切换"需求的实现方式发生变化——从各模块自行读取 `process.env` 改为由 `config.ts` 统一加载后通过依赖注入传递

## 影响范围

- **代码文件**：`src/` 下全部 4 个现有文件均需修改，新增 1 个 `config.ts`
- **配置文件**：`.env.example`、`mcp_config.example.json`、`.gitignore` 需同步更新
- **依赖**：无新增运行时依赖（`dotenv` 已在使用中，仅调用位置变更）
- **对外接口**：`SessionManager` 和 `McpToolManager` 的构造函数签名变更（**BREAKING**，但当前无外部消费者）
