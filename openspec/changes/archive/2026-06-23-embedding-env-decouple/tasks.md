## 1. 配置加载与接口定义重构

- [x] 1.1 修改 `src/config/types.ts`，定义 `EmbeddingConfig` 接口，并向 `AppConfig` 接口添加该平级配置字段。
- [x] 1.2 修改 `src/config/loader.ts`，在 `loadConfig` 中实现提取 `AGENT_EMBEDDING_*`、向 `llmConfig` 降级、当且仅当没有配置独立的 `AGENT_EMBEDDING_API_KEY` 时才向 `embedding.headers` 透传 `llm.headers` 等逻辑，并在返回前对 `embedding` 及其子对象进行 `Object.freeze` 防御性冻结。
- [x] 1.3 在 `src/config/index.ts` 中导出 `EmbeddingConfig`，确保外部模块可以正常引入类型。
- [x] 1.4 更新 `.env.example`，在 LLM 配置区域附近新增 `AGENT_EMBEDDING_*` 环境变量的说明及默认示例。
- [x] 1.5 修改 `test/mock-factory.ts`，在 `createMockAppConfig()` 方法中为 Mock 的 `AppConfig` 补齐平级必填字段 `embedding`，保证相关测试文件正常编译。

<!-- checkpoint: npm run build -->

## 2. 适配器重构与依赖注入对齐

- [x] 2.1 修改 `src/adapters/llm/OpenAiEmbeddingAdapter.ts` 构造函数签名，使其仅接收 `EmbeddingConfig`，删除其内部所有 `process.env` 的访问 and `eslint-disable` 标记。
- [x] 2.2 修改 `src/index.ts`，在第 53 行实例化 `OpenAiEmbeddingAdapter` 时，将传入的参数从 `appConfig.llm` 替换为新解耦的 `appConfig.embedding`。
- [x] 2.3 执行项目编译、全量单元测试与代码规范检查，确保没有由于配置改动引起的编译、测试报错或规范违规。

<!-- checkpoint: npm run build -->
<!-- checkpoint: npm run test -->
<!-- checkpoint: npm run lint -->
