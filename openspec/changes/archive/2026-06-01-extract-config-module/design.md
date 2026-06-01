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

### 决策 6：MCP 子进程环境变量继承策略——白名单 vs 黑名单 vs 全量继承

**选择：白名单过滤（参照 hermes-agent 方案）**

调研了 4 个标杆项目的实际做法：

| 项目 | 策略 | 做法 | 安全性 | 兼容性 |
|------|------|------|--------|--------|
| tinypace-ai-desktop | 全量继承 + 平台增强 | `...process.env` 全量透传，额外补齐 Python 编码和 Windows 系统变量 | 低 | 高 |
| claude-code | 全量继承 + 黑名单脱敏 | `...process.env` 后遍历删除敏感凭证（`ANTHROPIC_API_KEY` 等 20+ 项） | 中 | 高 |
| openclaw | 纯净映射 | 只传递配置文件中显式声明的 `env` 字段，不继承宿主环境 | 高 | 低 |
| hermes-agent | 严格白名单 | 只允许 `PATH`、`HOME`、`XDG_*` 等基础系统变量通过，再合并用户自定义 `env` | 高 | 中 |

选择白名单方案的理由：
- 本项目作为 Agent 系统，MCP 子进程可能执行第三方代码，环境隔离是安全底线
- 白名单的维护成本远低于黑名单（只需列出 10 个左右的系统必要变量，而黑名单需要不断追加新出现的敏感 Key）
- 用户仍可通过 `mcp_config.json` 的 `env` 字段显式传递所需变量，灵活性不受限

实现方式：在 `config.ts` 中新增 `buildSubprocessEnv(userEnv?)` 函数，内部维护一个 `SAFE_ENV_WHITELIST` 常量数组（包含 `PATH`、`PATHEXT`、`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`SystemRoot`、`LANG`、`LC_ALL` 等跨平台基础变量）。同时强制注入 `PYTHONIOENCODING=utf-8` 和 `PYTHONUTF8=1` 以解决 Windows 下 Python MCP 服务器的编码问题（参照 tinypace-ai-desktop 的实践经验）。

### 决策 7：配置优先级约定

**选择：建立明确的三层优先级体系**

参照 Spring Boot 的外部化配置优先级思路，为本项目确立如下配置覆盖规则（后者覆盖前者）：

1. **`config.ts` 内置默认值**（最低优先级）：如白名单系统变量、Python 编码设置等
2. **`.env` 文件中的环境变量**：通过 `dotenv` 加载，包含 API Key 等敏感配置
3. **`mcp_config.json` 中的 `env` 字段**（最高优先级）：用户针对特定 MCP 服务器的显式配置

这保证了用户在 `mcp_config.json` 中的显式声明永远有效，同时系统能提供合理的默认运行环境。

## 风险与权衡

- **模块顶层求值消除** → `tools.ts` 中 `authorizedDir` 从模块常量改为延迟初始化，增加了"未初始化就调用"的可能性。通过在 `secureResolvePath()` 中加入防护检查来缓解。
- **构造函数签名变更** → `SessionManager` 和 `McpToolManager` 的构造函数参数发生 breaking change。当前无外部消费者，风险可控。
- **`mcp_config.json` 加入 `.gitignore`** → 新用户 clone 后没有此文件，需要从 example 复制。通过 `config.ts` 中的文件引导逻辑（自动从模板复制）来处理。
- **白名单过于严格** → 某些 MCP 服务器可能依赖白名单之外的环境变量（如 `HTTP_PROXY`、`NODE_EXTRA_CA_CERTS` 等）。通过在 `mcp_config.json` 的 `env` 字段中显式配置来解决。后续如果发现常见遗漏，再扩充白名单即可。
