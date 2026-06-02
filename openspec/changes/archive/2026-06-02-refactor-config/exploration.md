# 探索主题: 系统高内聚架构重构 (阶段一：解耦 Config 层)

## 1. 问题定义
目前 `src/config.ts` 承担了过多的职责（类型声明、常量存储、文件读写、环境变量插值等），已近 400 行，成为一个典型的“God Object”，违背了单一职责原则。任何关于模型的添加、配置加载逻辑的调整都必须修改这个巨型文件。

## 2. 关键发现与调研结果
通过对 `src/config.ts` 及其在全项目中的引用进行追踪：
- **上游依赖者**：`index.ts`（需 `loadConfig`）、`session.ts`（需 `LlmConfig`）、`mcp-client.ts`（需 `McpConfig`、`buildSubprocessEnv`）、`command.ts`（需 `getModelConfig`、`BUILTIN_MODELS`）。
- **职责散落分析**：
  1. **类型层**：`AppConfig`, `McpConfig`, `LlmConfig`, `ModelProfile` 等纯接口。
  2. **常量层**：硬编码的 `BUILTIN_MODELS` 字典以及 `SAFE_ENV_WHITELIST` 白名单。
  3. **工具层**：环境变量插值 (`interpolateEnvVars`) 和必填检查 (`requireEnv`) 可以统一沉淀到已有的 `src/utils/env.ts` 中。
  4. **核心逻辑层**：`ensureConfigFiles`、`loadMcpConfig` 和最终聚合的 `loadConfig`。

## 3. 业界竞品架构调研
通过跨项目的索引追踪，我对 4 个头部 Agent 项目的配置管理进行了横向对比，证实了我们上述拆解思路的必要性：
- **OpenClaw (常驻网关模式)**：极度强调类型的解耦。专门使用 `types.openclaw.ts`、`types.plugins.ts` 隔离类型，将“启动配置 (`server-startup-config.ts`)”与“重载配置 (`config-reload.ts`)”的加载逻辑物理分离。
- **Claude-Code (终端沙盒模式)**：将具体领域的配置抽离成了碎片模块（如 `caCertsConfig.ts`、`shellConfig.ts`），以及将纯环境变量相关的函数放置在独立的 `env.ts` 和 `envUtils.ts` 中。
- **Tinypace-AI-Desktop (桌面客户端模式)**：拆分策略更为极致。它直接将原本聚合的“配置管理器”拆成了多个领域自治的服务：`ModelConfigManager.ts` (模型层)、`MCPConfigManager.ts` (工具侧)、`ServiceEnvConfigManager.ts` (环境侧) 以及 `GeneralConfigManager.ts` (通用属性)。这种基于领域的切分完全避免了 God Object 的产生。
- **Hermes-Agent (混合模式/Python)**：区分了“状态/持久化配置 (State)”与“环境应用配置 (Config)”。通过重量级的 `hermes_state.py` 统管 SQLite，而系统和连接层配置则交由 `cli-config.yaml` 或底层环境变量独立解耦维护。

## 4. 方案对比与推荐方向
为实现无缝替换，推荐采用**门面模式 (Facade)**重构：创建一个 `src/config/` 目录，将逻辑打散到细分文件中，再通过 `src/config/index.ts` 统一导出，以保证其他引用该模块的代码无需大规模修改。

**推荐拆分路径**（吸收了 OpenClaw 与 Claude-Code 的架构灵感）：
- `src/config/types.ts`：放置所有 `interface`（对标 OpenClaw 的 `types.openclaw.ts`）。
- `src/config/models.ts`：放置 `BUILTIN_MODELS` 及模型特定的工厂方法。
- `src/config/loader.ts`：专注实际的文件 I/O 加载与聚合组装（对标 OpenClaw 的 `server-startup-config.ts`）。
- `src/config/mcp-env.ts`：专注子进程环境变量及安全隔离逻辑（对标 Claude-Code 的 `envUtils.ts` 等）。
- `src/utils/env.ts`：复用既有的系统级环境变量提取与插值工具。

## 5. 约束、风险与未知项
- 需确保重构后，`config/index.ts` 原样导出了此前外部所依赖的全部函数和类型，否则会引发大规模编译错误。
- 环境变量加载 (`dotenvConfig`) 的时序必须严格保证在任何访问环境变量的逻辑之前触发。
