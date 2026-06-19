# 探索主题: 扩展配置系统以支持最大迭代次数等参数的灵活配置

## 1. 问题定义
目前 Agent 系统中存在多处硬编码的执行行为和资源消耗控制限制（例如：最大思考循环次数 20 轮、工具单次返回字符数限制 8000 字符、批量读取文件总字符限制 50000 字符、检索匹配结果最大限制 100 条、Token 水位自动压缩阈值比例 0.8）。这些限制对于不同复杂度的任务和不同性能/成本特性的模型而言需要灵活定制。我们需要将这些参数提取为全局配置，并在缺省时使用原常量作为默认值，同时支持通过环境变量及 `.env` 配置文件进行动态覆写。

## 2. 关键发现与调研结果
- **代码库现状**：
  1. **最大迭代次数限制**：硬编码在 `src/brain/session.ts`（`private maxIterations = 20;`）和 `src/brain/agent-loop.ts`（`options.maxIterations ?? 20;`）。
  2. **工具返回超长自动落盘限制**：硬编码在 `src/brain/services/ToolDispatcher.ts`（`const LIMIT = 8000;`）。
  3. **批量读取文件体积熔断限制**：硬编码在 `src/action/tools/filesystem/read-many-files.ts`（`totalChars > 50000`）。
  4. **全局文件与文本搜索匹配数展示限制**：硬编码在 `src/action/tools/filesystem/search.ts`（`GrepSearchTool` 与 `GlobSearchTool` 均限制为最多展示 100 条）。
  5. **Token 压缩水位阈值比例**：硬编码在 `src/brain/plugins/TokenWatermarkPlugin.ts`（`const threshold = this.tokenEstimator.getCompactionThreshold(llmConfig, 0.8);`）。

- **主流做法与参考调研（核实与洞察）**：
  我们对主流 Agent 框架（CrewAI、LangChain）以及 `Agents` 目录下的优秀参考项目进行了深度调研：
  
  1. **最大迭代次数配置**：
     - **LangChain / CrewAI**：将 `max_iterations` / `max_iter` 作为 Agent 构造函数或执行器（`AgentExecutor`）的标准可选属性暴露出来，默认值一般为 15 到 20。
     - **Claude Code (Anthropic)**：将最大迭代轮数命名为 `maxTurns`，采用高度参数化的分场景设计。普通运行任务、子 Agent（`forkSubagent` 限制 200）、压缩任务（限制 1）或记忆提取（限制 5）拥有不同的默认上限。
     - **Opencode**：在配置文件中声明代理人的执行预算 `steps`（废弃旧版 `maxSteps`，底层 LLM 循环默认为 25）。在进行到最后一步时，会在提示词中追加 `MAX_STEPS` 警告，**强力引导模型在当前轮收敛并输出最终回复，不要再继续调用工具**。
     - **Hermes Agent**：提供精细的多级配置覆盖。不仅在 `config.yaml` 中配置 `agent.max_turns`（默认 90 轮）和辅助目标的 `goals.max_turns`（默认 20 轮），还支持通过环境变量 `HERMES_MAX_ITERATIONS` 覆写全局默认。另外，命令行参数 `--max-turns <N>` 能直接即时覆写；对派生的子 agent 执行预算单独控制（`delegation.max_iterations`，默认 50），保证子 agent 的消耗不会耗尽父 agent 的限制。
     - **Openclaw**：除了常规运行参数外，它更倾向于将迭代限制 (`maxTurns`) 权限下放到工具或扩展插件（如 `xAI Code Execution`，`xSearch`）本身。工具配置解析器支持单独配置并验证该工具内部的迭代轮数限制（通过 `resolvePositiveIntegerToolConfig` 校验）。
  
  2. **大工具输出与溢出落盘限制**：
     - **Claude Code**：支持 **Spill to Disk（溢出落盘）** 机制。在 `toolResultStorage.ts` 中，如果单次工具输出超过阈值（如 50k 字符），会自动写入临时目录下的文件，并向模型返回一个 `<persisted-output>` 包含文件路径及 preview。这些限制同样支持工具级自定义或 GrowthBook/环境变量覆写。

- **系统架构适配性判定**：
  - 各 NativeTool 在 `execute(args, sessionContext)` 执行时，都会接收到 `sessionContext`（即 `SessionContext` 的实例）。
  - `ToolDispatcher` 本身也持有 `SessionContext`。
  - 核心拦截器插件在 hooks（如 `BeforeModel`）执行时能访问 `HookContext`，其 `context.sessionContext` 也就是 `SessionContext`。
  - 因此，可以通过在 `SessionContext` 内部添加 `appConfig` 字段，实现配置参数向所有工具、服务及拦截器插件的平滑注入与解耦。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (定义独立常量文件) | 方案 B (接入全局配置系统) | 结论 |
| :--- | :--- | :--- | :--- |
| **可配置性** | 弱 ✗（修改必须重新构建代码） | 强 ✓（通过修改 `.env` 即可动态生效，适合各种模型及生产部署） | 方案 B 占优 |
| **集成度** | 低 ✗（产生孤立配置文件，无法与现有的配置加载机制和安全冻结结合） | 高 ✓（无缝融入现有的 `loadConfig()` 及安全冻结逻辑） | 方案 B 占优 |
| **可维护性** | 中等 | 高 ✓（所有参数在 `.env.example` 中集中解释，对开发者及用户更透明）| 方案 B 占优 |

**推荐路径**：
选择方案 B。在现有的全局配置中加入对应的配置项，并支持环境变量加载，在缺省时使用内置常量作为降级兜底。

新增环境变量与字段对照：
1. `AGENT_MAX_ITERATIONS`（默认 `20`） -> `maxIterations`
2. `AGENT_LARGE_TOOL_OUTPUT_LIMIT`（默认 `8000`） -> `largeToolOutputLimit`
3. `AGENT_READ_MANY_FILES_LIMIT`（默认 `50000`） -> `readManyFilesLimit`
4. `AGENT_SEARCH_LIMIT`（默认 `100`） -> `searchLimit`
5. `AGENT_COMPACTION_WATERMARK_FACTOR`（默认 `0.8`） -> `compactionWatermarkFactor`

### 技术实施细节
#### 1. 全局配置层扩展
在 `src/config/types.ts` 的 `AppConfig` 接口中加入上述字段，并在 `src/config/loader.ts` 的 `loadConfig()` 中进行安全解析（类型转换为 `number` 并防范 `NaN`）以及防御性冻结。

#### 2. 上下文依赖注入机制 (Context Injection)
各 Native 工具和拦截插件无法直接引用单例配置，为避免层层构造传递 `AppConfig` 破坏架构，我们通过 `SessionContext` 实现平滑的注入传参：
- **注入**：在 `src/brain/context.ts` 的 `SessionContext` 类中新增一个成员 `public appConfig?: AppConfig;`。在 `SessionManager` 构造时，将加载出的 `appConfig` 实例赋予 `this.context.appConfig = appConfig;`。
- **消费**：
  - **大工具输出拦截**：在 `src/brain/services/ToolDispatcher.ts` 内部直接通过 `this.context.appConfig?.largeToolOutputLimit` 读取限制。
  - **拦截器插件**：在 `src/brain/plugins/TokenWatermarkPlugin.ts` 中通过 `context.sessionContext.appConfig?.compactionWatermarkFactor` 动态计算安全阈值。
  - **本地 Native 工具**：工具执行时，`LocalFileSystemMcpServer` 会将 `SessionContext` 传入工具的 `execute(_, sessionContext)` 方法。
    - 在 `src/action/tools/filesystem/read-many-files.ts` 中通过 `sessionContext.appConfig?.readManyFilesLimit` 动态判断是否超限。
    - 在 `src/action/tools/filesystem/search.ts` 的搜索工具（Glob/Grep）中通过 `sessionContext.appConfig?.searchLimit` 限制最大输出条数。

#### 3. 运行主循环适配
- 扩展 `SessionManager` 构造函数签名，使其能够接收全局 `appConfig`（为向后兼容保留原有 `llmConfig`）。
- 在创建底层 `AgentLoop` 实例时，将 `appConfig.maxIterations ?? 20` 传递给 `AgentLoop` 的 `maxIterations` 参数，从而动态接管 Agent 推理大循环的最大轮数限制。

## 4. 约束、风险与未知项
- **环境隔离**：在自动化评测靶场（测试用例环境）中可能没有 `.env` 中的新增变量，必须确保所有配置项在解析时都有合理的 Default 常量值兜底。
- **类型转换**：环境变量读取的均为 `string` 类型，需在 `loadConfig()` 阶段安全地将其转换为 `number` 类型并校验。

## 5. 否决方案
- **通过每个 Tool 构造函数进行配置注入**：该方案会导致虚拟 MCP 服务 `LocalFileSystemMcpServer` 实例化时的依赖链路变得极其复杂，因为需要层层传递 `AppConfig`，破坏了虚拟服务器的简洁性。
