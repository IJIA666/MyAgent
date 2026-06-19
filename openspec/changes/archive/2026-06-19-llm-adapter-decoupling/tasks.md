## 1. 接口 Ports 契约定义与 prompts.ts 物理重组

- [x] 1.1 在 `src/brain/ports/` 目录下创建 `LlmPort.ts`，定义不依赖特定模型库的 `ChatMessage` 类型、`LlmStreamEvent` 联合类型及 `LlmPort` 接口定义。
- [x] 1.2 在 `src/brain/ports/` 目录下创建 `TokenEstimatorPort.ts`，定义 `TokenEstimatorPort` 契约，剥离对 `js-tiktoken` 与 `openai` 的底层编译依赖。
- [x] 1.3 创建 `src/brain/prompts/` 物理子目录，将 `src/brain/prompts.ts` 移动为 `src/brain/prompts/prompts.ts`，并重构其入参为自定义的 `ChatMessage` 领域类型。

## 2. 基础设施层 LLM 适配器重组下沉

- [x] 2.1 创建物理基础设施层目录 `src/infrastructure/llm/`。
- [x] 2.2 在该目录下创建 `OpenAiLlmAdapter.ts` 并实现 `LlmPort` 接口。将原 `driver.ts` 中的流式与同步调用逻辑移植进该类，接管所有对 `openai` 库的依赖。
- [x] 2.3 在该目录下创建 `TiktokenEstimator.ts` 并实现 `TokenEstimatorPort`。将原 `TokenEstimator.ts` 的分词估算逻辑移植进该类，接管所有对 `js-tiktoken` 的依赖。
- [x] 2.4 在获得用户明确准许后，删除大脑根目录下遗留的 `src/brain/driver.ts` 与 `src/brain/TokenEstimator.ts` 物理文件，完成大脑层面的视觉与代码双重去污染。

<!-- checkpoint: npm run build -->

## 3. 大脑核心 Domain 控制反转与依赖注入

- [x] 3.1 修改 `src/brain/agent-loop.ts`：彻底移出对 `driver.ts`、`TokenEstimator.ts` 与 `prompts.ts` 的静态 import 依赖。修改构造器使其接收 `llmPort: LlmPort`。
- [x] 3.2 修改 `src/brain/session.ts` 与 `src/brain/contextLoader.ts` 等依赖方：将其改为面向 `TokenEstimatorPort` 契约，支持动态传入预估器。
- [x] 3.3 修改 `src/index.ts`（Composition Root）与系统引导入口：在此处实例化 `OpenAiLlmAdapter` 与 `TiktokenEstimator`，并将其通过构造函数逐级向下组装注入。
- [x] 3.4 修正其它受重构影响的编译点（如 `src/brain/plugins/TokenWatermarkPlugin.ts` 等插件的引用路径）。

<!-- checkpoint: npm run build && npm run lint -->

## 4. 测试套件回归与验证

- [x] 4.1 调整测试代码 `test/brain/models.test.ts`、`test/brain/plugins.test.ts`、`test/brain/context.test.ts` 以及相关集成测试中的 import 路径。
- [x] 4.2 调整测试用例中对 `LlmDriver` 的 Mock 行为，改为对 `LlmPort` 的 Mock，确保测试脱离具体 SDK 绑定。
- [x] 4.3 运行全量单元测试与集成测试，验证重构百分百成功且无故障引入。

<!-- checkpoint: npm run test && npm run test:integration -->
