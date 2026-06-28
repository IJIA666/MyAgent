## 1. 套娃路径重组与工具/适配器/接口层测试同构

- [x] 1.1 将 `src/adapters/tools/tools/` 物理目录重命名为 `src/adapters/tools/impl/`
- [x] 1.2 修正 `src/adapters/tools/` 下适配器（如 `toolRegistry.ts`, `mcp-client.ts`, `index.ts` 等）对原生工具的相对导入语句（以 `impl/` 代替 `tools/`）
- [x] 1.3 创建 `test/adapters/tools/` 目录，将 `test/action/` 下的所有 11 个工具单元测试文件物理移动到该新目录中：
  - `browser-action.test.ts`
  - `browser-action-multitenant.test.ts`
  - `browser-detector.test.ts`
  - `dangerous-intercept.test.ts`
  - `mcp-client.test.ts`
  - `new-tools.test.ts`
  - `safety-and-concurrency.test.ts`
  - `search.test.ts`
  - `terminal.test.ts`
  - `time.test.ts`
  - `tools.test.ts`
- [x] 1.4 创建 `test/adapters/llm/`、`test/adapters/context/`、`test/adapters/vectordb/` 目录，将适配器相关的 4 个测试文件物理移动到对应同构目录：
  - `test/brain/adapters/OpenAiLlmAdapter.test.ts` -> `test/adapters/llm/OpenAiLlmAdapter.test.ts`
  - `test/session/EmbeddingAdapter.test.ts` -> `test/adapters/llm/EmbeddingAdapter.test.ts`
  - `test/brain/adapters/DefaultContextAdapter.test.ts` -> `test/adapters/context/DefaultContextAdapter.test.ts`
  - `test/brain/adapters/JsonVectorDbAdapter.test.ts` -> `test/adapters/vectordb/JsonVectorDbAdapter.test.ts`
- [x] 1.5 创建 `test/adapters/input/interface/` 目录，将输入接口层相关的 2 个测试文件物理移动到对应同构目录：
  - `test/interface/CliFacade.test.ts` -> `test/adapters/input/interface/CliFacade.test.ts`
  - `test/interface/input-listener.test.ts` -> `test/adapters/input/interface/input-listener.test.ts`
- [x] 1.6 全局排查并修正第一批次移动的所有 17 个测试文件内部的相对导入语句（重点校准 `.js` 强后缀的相对路径）
- [x] 1.7 临时更新 `package.json` 中 `test` 脚本的目录扫描配置，使 Vitest 能覆盖新物理路径下的工具和适配器测试

<!-- checkpoint: npm test -->

## 2. 核心业务用例测试同构及边缘辅助文件规整

- [x] 2.1 将安全子域单元测试文件（共 2 个）物理迁移至 `test/core/usecases/security/`：
  - `test/brain/ApprovalService.test.ts` -> `test/core/usecases/security/ApprovalService.test.ts`
  - `test/brain/SecurityService.test.ts` -> `test/core/usecases/security/SecurityService.test.ts`
- [x] 2.2 将公共工具与全局配置单元测试文件（共 2 个）物理迁移至各自同构目录：
  - `test/brain/purify.test.ts` -> `test/common/purify.test.ts`
  - `test/brain/models.test.ts` -> `test/config/models.test.ts`
- [x] 2.3 将大脑记忆与事实子域单元测试文件（共 6 个）物理迁移至 `test/core/usecases/brain/`：
  - `test/brain/CompactionService.test.ts` -> `test/core/usecases/brain/CompactionService.test.ts`
  - `test/brain/ContextRepository.test.ts` -> `test/core/usecases/brain/ContextRepository.test.ts`
  - `test/brain/contextLoader.test.ts` -> `test/core/usecases/brain/contextLoader.test.ts`
  - `test/brain/RuleManager.test.ts` -> `test/core/usecases/brain/RuleManager.test.ts`
  - `test/session/prompt.test.ts` -> `test/core/usecases/brain/prompt.test.ts`
  - `test/session/MemoryService.test.ts` -> `test/core/usecases/brain/MemoryService.test.ts`
- [x] 2.4 将插件子域单元测试文件（共 1 个）物理迁移至 `test/core/usecases/plugins/`：
  - `test/brain/plugins.test.ts` -> `test/core/usecases/plugins/plugins.test.ts`
- [x] 2.5 将引擎执行子域单元测试文件（共 3 个）物理迁移至 `test/core/usecases/engine/`：
  - `test/brain/ToolDispatcher.test.ts` -> `test/core/usecases/engine/ToolDispatcher.test.ts`
  - `test/session/SessionManager.test.ts` -> `test/core/usecases/engine/SessionManager.test.ts`
  - `test/session/loopback.test.ts` -> `test/core/usecases/engine/loopback.test.ts`
- [x] 2.6 将核心领域对象测试文件（共 1 个）物理迁移至 `test/core/domain/`：
  - `test/brain/context.test.ts` -> `test/core/domain/context.test.ts`
- [x] 2.7 将根测试目录下的 `test/mock-factory.ts` 物理移动到 `test/helpers/mock-factory.ts`
- [x] 2.8 全局修正第二批次移动的所有 16 个用例测试及 Mock 工厂相关的相对导入语句
- [x] 2.9 最终更新 `package.json` 中的 `scripts.test` 脚本配置（适配全新的同构路径），并运行 Lint 进行全局质量复核

<!-- checkpoint: npm test -->
