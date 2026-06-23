## 1. 核心限额配置项抽提与环境加载改造

- [x] 1.1 修改 `src/config/types.ts`，在 `AppConfig.runtimeLimits` 中定义 `ragEnabled`、`ragScoreThreshold`、`ragRecallLimit`、`ragRefinementThreshold`、`loopPreventionLimit`、`compactionRetainCount`、`compactionTriggerDelta`、`compactionFailureLimit`、`compactionRecentFilesLimit` 等 9 个配置项的类型声明。
- [x] 1.2 修改 `src/config/loader.ts`，支持从环境变量（`.env`）中解析这 9 个新增的配置项，并在未配置时提供对应的硬编码默认值作为降级兜底，深度冻结这些属性防止篡改。
- [x] 1.3 修改 `test/mock-factory.ts` 的 `createMockAppConfig()` 辅助函数，补全这 9 个新增属性的 Mock 默认值，消除单元测试中的配置缺失类型报错。
- [x] 1.4 更新 `.env.example` 配置文件，在文件末尾追加并详细说明这 9 个新增的环境变量及其系统默认注释值。

<!-- checkpoint: npm run build -->

## 2. 插件与领域服务重构及 RAG 防击穿改造

- [x] 2.1 修改 `src/core/usecases/prompts.ts`，在 `buildSystemPrompt` 提示词模板方法中的固定 instructions 内容里，追加绝对不变的静态引导句以指引模型参考 User 消息中的 `<long-term-memory>` 事实，同时保持前缀哈希一致。
- [x] 2.2 修改 `src/core/usecases/LongTermMemoryPlugin.ts`，重构构造函数使其接受 `AppConfig` 实例。在 `handleBeforeModel` 中读取并遵循 `ragEnabled`，将 RAG 召回事实注入到最新一条 User 消息中以锁定系统提示词前缀，分别在过滤和截取处使用 `ragScoreThreshold` 和 `ragRecallLimit` 替换硬编码原值；在 `handleSessionEndAsync` 中，使用 `ragRefinementThreshold` 配置值替换硬编码原值。
- [x] 2.3 修改 `src/core/usecases/LoopPreventionPlugin.ts`，重构其构造函数及 `BeforeTool` 钩子，使其接受 `AppConfig` 实例或直接从配置中读取 `loopPreventionLimit`（相同参数连续调用上限）替换硬编码的 `3` 次校验逻辑。
- [x] 2.4 修改 `src/core/usecases/CompactionService.ts`，重构构造函数，在服务内直接从 context 绑定的 appConfig 中获取并使用 `compactionRetainCount`（硬截断保留历史条数）、`compactionTriggerDelta`（触发摘要的 Token 差额）、`compactionFailureLimit`（提炼连续失败上限次数）及 `compactionRecentFilesLimit`（记录的最近读写文件最大条数）等配置属性，彻底取代原硬编码逻辑。
- [x] 2.5 修改 `src/core/usecases/session.ts`，在实例化各领域服务和插件（`LongTermMemoryPlugin`、`LoopPreventionPlugin` 等）时，按改造后的签名将 `appConfig` 或相应的配置属性正确传入。
- [x] 2.6 编写或补充对应的测试用例（如在 `test/session/MemoryService.test.ts`、`test/brain/plugins.test.ts` 中验证新增的配置参数 and RAG 的新注入路径是否正确工作），并执行全量项目编译、测试和代码 Lint 回归。

<!-- checkpoint: npm run build -->
<!-- checkpoint: npm run test -->
<!-- checkpoint: npm run lint -->
