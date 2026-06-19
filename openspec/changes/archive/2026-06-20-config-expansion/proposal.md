## 改造原因

目前系统中的多项核心运行限制（如 Agent 最大迭代轮数 20 轮、工具大文本拦截阈值 8000 字符、批量文件读取体积熔断 50000 字符、文件检索结果最多展示 100 条以及自动压缩水位比例 0.8）均为硬编码。在对接具有不同速率限制或不同成本结构的各种大模型，以及处理不同复杂度的任务时，这些硬编码限制无法进行精细化调优。因此，需要扩展现有的全局配置系统，使这些参数可以通过 `.env` 和环境变量进行灵活覆写，从而提高 Agent 的生产环境适应能力和任务执行成功率。

## 变更内容

- 扩展全局配置机制，通过环境变量读取 5 项关键参数（最大迭代次数、大工具输出限制、批量读取熔断阈值、检索最大结果条数、Token 水位自动压缩比率），并在配置解析阶段进行类型转换和安全兜底。
- 在 `SessionContext` 中维护并共享全局 `AppConfig` 的引用，使得所有的本地虚拟工具、中间件插件以及领域服务均能动态读取相应的配置参数，避免了复杂的组件实例化依赖链。
- 适配 `SessionManager` 及底层的 ReAct 循环引擎，使用配置中的 `maxIterations` 动态控制推理的退出阈值。

## 业务能力

### 新增业务能力

- `config-expansion`: 提供了全局执行资源和工具交互行为参数的集中化加载与精细化配置能力，解耦代码库硬编码常数限制。

### 修改业务能力

<!-- 无需求规格发生变化的既有业务能力 -->

## 影响范围

- **配置解析层**：`.env.example` 示例配置文件、`src/config/types.ts` 和 `src/config/loader.ts`。
- **会话上下文管理**：`src/brain/context.ts` 与 `src/brain/session.ts`。
- **执行循环与工具服务**：`src/brain/agent-loop.ts`，`src/brain/services/ToolDispatcher.ts`。
- **中间件与插件**：`src/brain/plugins/TokenWatermarkPlugin.ts`。
- **内置 Native 工具**：`src/action/tools/filesystem/read-many-files.ts` 和 `src/action/tools/filesystem/search.ts`。
