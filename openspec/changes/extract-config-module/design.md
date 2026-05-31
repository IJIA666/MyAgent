## 背景

当前项目有 4 个源码文件（`index.ts`、`session.ts`、`mcp-client.ts`、`tools.ts`），配置加载逻辑散布其中：

- `session.ts` 在模块顶层调用 `dotenvConfig()`，构造函数中读取 3 个 `process.env.DEEPSEEK_*` 并硬编码默认值
- `tools.ts` 在模块顶层读取 `process.env.AUTHORIZED_WORKSPACE_DIR`
- `mcp-client.ts` 在 `connectConfig()` 中读取文件系统、解析 JSON、执行三层配置合并
- `index.ts` 负责配置文件存在性检查、模板复制、二次 `dotenv` 加载

两套配置源（`.env` 和 `mcp_config.json`）之间没有桥接机制，MCP 配置中的 API Key 无法引用 `.env` 中的值。

## 目标与非目标

**目标:**
- 将全部配置加载逻辑集中到独立的 `config.ts` 模块
- 业务模块通过构造函数参数（依赖注入）获取配置，不直接读取 `process.env` 或配置文件
- 引入 `${VAR}` 环境变量插值机制，桥接 `.env` 和 `mcp_config.json`
- 必填配置项缺失时 fail-fast 报错，不用硬编码默认值掩盖问题
- 配置对象在加载后冻结，防止业务代码意外修改

**非目标:**
- 不引入远程配置中心或热加载机制（当前为单用户本地项目，不需要）
- 不做完整的模块职责重构（`session.ts` 的工具调度逻辑、`tools.ts` 的工具定义混杂等问题留待后续处理）
- 不引入配置校验框架（如 zod），手动校验足够

## 架构决策

### 决策 1：新建独立配置模块 vs 在 index.ts 中内联

**选择：新建 `src/config.ts` 独立模块**

理由：`index.ts` 的职责是 REPL 交互循环，配置管理是正交的关注点。独立模块便于单元测试和后续扩展。如果内联在 `index.ts` 中，随着配置项增多，入口文件会变得臃肿。

### 决策 2：工作区路径初始化——模块函数 vs 参数传递

**选择：`initWorkspace(rootDir)` 模块函数（方案 A）**

`authorizedDir` 在整个应用生命周期内只设置一次不会变化，属于"启动时初始化"的范畴。每个工具函数都传 `rootDir` 参数（方案 B）虽然更纯粹，但改动量大且每次调用都要传参，收益不足。`initWorkspace()` 配合防护检查（未初始化时抛出明确错误）足够安全。

### 决策 3：MCP 配置合并策略——三层合并 vs 单文件

**选择：简化为单文件加载**

当前的三层合并（`mcp_config.json` → `mcp_config.${NODE_ENV}.json` → `mcp_config.local.json`）从未被实际使用。`NODE_ENV` 没有被设置，中间层和本地覆盖层文件也不存在。移除这层复杂度，只加载 `mcp_config.json` 一个文件。

### 决策 4：配置文件路径确定方式——约定 vs 环境变量

**选择：约定固定路径，不通过环境变量指定**

配置文件路径采用约定优于配置：`.env` 在项目根目录，`mcp_config.json` 也在项目根目录。这与 `package.json`、`tsconfig.json` 等 Node.js 生态约定一致。不需要额外的 `MCP_CONFIG_PATH` 环境变量。

### 决策 5：必填项校验策略——默认值回退 vs fail-fast

**选择：fail-fast，缺失时直接抛出启动错误**

当前 `session.ts` 中 API Key 的硬编码默认值是安全隐患（会被提交到版本库）。改为必填校验后，用户漏配时能立即发现，而非在运行时出现难以排查的 API 调用失败。

## 风险与权衡

- **模块顶层求值消除** → `tools.ts` 中 `authorizedDir` 从模块常量改为延迟初始化，增加了"未初始化就调用"的可能性。通过在 `secureResolvePath()` 中加入防护检查来缓解。
- **构造函数签名变更** → `SessionManager` 和 `McpToolManager` 的构造函数参数发生 breaking change。当前无外部消费者，风险可控。
- **`mcp_config.json` 加入 `.gitignore`** → 新用户 clone 后没有此文件，需要从 example 复制。通过 `config.ts` 中的文件引导逻辑（自动从模板复制）来处理。
