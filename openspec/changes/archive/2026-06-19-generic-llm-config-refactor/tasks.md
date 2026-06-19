## 1. 静态类型保障与配置逻辑解耦

- [x] 1.1 修改 `src/config/types.ts`，定义并导出只读常量数组 `VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'max', 'disabled'] as const`，并通过 `typeof` 推导导出联合类型 `ReasoningEffort`。将 `LlmConfig.reasoningEffort` 的类型由 `string` 调整为 `ReasoningEffort`。
- [x] 1.2 修改 `src/config/models.ts`，引入 `VALID_REASONING_EFFORTS` 和 `ReasoningEffort`。在 `getModelConfig` 中读取环境变量 `env.AGENT_LLM_REASONING_EFFORT`，进行非空检测以及基于 `VALID_REASONING_EFFORTS` 的 Fail-Fast 值域校验，校验合法后将值绑定 to 返回的 `LlmConfig.reasoningEffort` 属性。
- [x] 1.3 修改 `src/config/loader.ts`，彻底移除 `loadConfig` 函数内对 `DEEPSEEK_REASONING_EFFORT` 的所有局部硬编码读取和值域校验代码。
- [x] 1.4 修改 `src/config/loader.ts`，在 `loadConfig` 内读取 `env.AGENT_LLM_MODEL` 代替原先的 `env.DEEPSEEK_MODEL`，将其传给 `getModelConfig`。

<!-- checkpoint: npm run build -->

## 2. 去厂商化环境变量前缀重构

- [x] 2.1 修改 `src/config/models.ts` 中的 `BUILTIN_MODELS`，将 `deepseek-v4-flash` 和 `deepseek-v4-pro` 的 `envKeyName` 修改为 `'AGENT_LLM_API_KEY'`，`envUrlName` 修改为 `'AGENT_LLM_BASE_URL'`。
- [x] 2.2 修改 `src/config/models.ts` 中的 `getModelConfig`，将内部所有的 `DEEPSEEK_` 环境变量（如 `DEEPSEEK_MODEL`、`DEEPSEEK_MAX_TOKENS`、`DEEPSEEK_CONTEXT_WINDOW`、`DEEPSEEK_TEMPERATURE`、`DEEPSEEK_TIMEOUT`、`DEEPSEEK_MAX_RETRIES`、`DEEPSEEK_HEADERS`）替换为对应的 `AGENT_LLM_` 变量名称进行提取。
- [x] 2.3 修改 `src/interface/commands/model.ts`，在保存默认配置写回 `.env` 时，将写入的键名调整为 `AGENT_LLM_MODEL` 和 `AGENT_LLM_REASONING_EFFORT`。
- [x] 2.4 修改 `src/utils/env.ts`，更新其中的 JSDoc 注释和示例，将 `DEEPSEEK_MODEL` 等示例替换为 `AGENT_LLM_MODEL`。

<!-- checkpoint: npm run build -->

## 3. 配置文件与单元测试适配

- [x] 3.1 修改 `.env` 和 `.env.example` 文件，将所有 `DEEPSEEK_` 前缀的环境变量名称与描述信息替换为 `AGENT_LLM_` 系列，确保模板和现存配置完全对齐。
- [x] 3.2 修改 `test/config/loader.test.ts`，将测试用例中模拟的局部配置环境字典（`mockEnv` 等）的键名全部从 `DEEPSEEK_` 替换为 `AGENT_LLM_`。
- [x] 3.3 修改 `test/brain/models.test.ts`，将测试套件中通过全局 `process.env` 进行覆写测试的环境变量全部替换为对应的 `AGENT_LLM_` 前缀。

<!-- checkpoint: npm run build && npm run lint && npm run test -->
