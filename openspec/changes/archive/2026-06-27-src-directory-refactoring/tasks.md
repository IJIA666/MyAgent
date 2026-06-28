## 1. 重构 usecases 下的 plugins 子域文件

- [x] 1.1 物理创建 `src/core/usecases/plugins` 目录。
- [x] 1.2 将 `HumanApprovalPlugin.ts`、`JitRulesPlugin.ts`、`LongTermMemoryPlugin.ts`、`LoopPreventionPlugin.ts`、`TokenWatermarkPlugin.ts`、`TracerLogPlugin.ts`、`plugin-registry.ts`、`plugin-runner.ts`、`plugin-types.ts` 等 9 个文件物理移动至该目录下。
- [x] 1.3 修正这 9 个搬迁文件内部，以及 `src` 下其它调用它们的源文件引用的相对导入路径（以 `./` 或 `../` 开头且以 `.js` 结尾，绝对禁止改动第三方 npm 包及内置模块如 'path' 的绝对导入）。
- [x] 1.4 级联修正 `test/` 下对应的单测用例文件对这 9 个插件文件的相对引入路径（仅限以 `./` 或 `../` 开头的导入）。
- [x] 1.5 执行单测全量跑，验证 plugins 重组无报错编译，且单测全部绿灯。

<!-- checkpoint: npm test -->

## 2. 重构 usecases 下的其余子域（engine, brain, security）文件

- [x] 2.1 物理创建 `src/core/usecases/engine`、`src/core/usecases/brain`、`src/core/usecases/security` 目录。
- [x] 2.2 将 `agent-loop.ts`、`session.ts`、`ToolDispatcher.ts`、`LifecycleManager.ts` 等 4 个文件移动至 `engine/` 目录。
- [x] 2.3 将 `MemoryService.ts`、`RuleManager.ts`、`prompts.ts`、`ContextRepository.ts`、`contextLoader.ts`、`CompactionService.ts` 等 6 个文件移动至 `brain/` 目录。
- [x] 2.4 将 `SecurityService.ts`、`ApprovalService.ts`、`FileLockManager.ts` 等 3 个文件移动至 `security/` 目录。
- [x] 2.5 修正这 13 个搬迁文件本身以及整个 `src` 源码中其它引用它们的相对导入路径（仅限以 `./` 或 `../` 开头且以 `.js` 结尾，绝对禁止改动第三方 npm 包的绝对导入）。
- [x] 2.6 级联修正 `test/` 下单测文件对这 13 个文件的相对引入路径（仅限以 `./` 或 `../` 开头的导入）。
- [x] 2.7 运行全量测试进行阶段二验证，确保单测绿灯。

<!-- checkpoint: npm test -->

## 3. 重构 driven 契约端口层子域文件

- [x] 3.1 物理创建 `src/ports/driven/` 下的 `llm`、`db`、`tools`、`session`、`security` 五个子域目录。
- [x] 3.2 将 `LlmPort.ts`、`EmbeddingPort.ts`、`TokenEstimatorPort.ts` 等 3 个文件物理移动至 `llm/` 目录。
- [x] 3.3 将 `VectorDbPort.ts` 移动至 `db/` 目录。
- [x] 3.4 将 `AgentPlugin.ts`、`ToolRegistryPort.ts`、`McpManagerPort.ts`、`TaskAborterPort.ts` 等 4 个文件移动至 `tools/` 目录。
- [x] 3.5 将 `SessionEventPort.ts`、`EventNotificationPort.ts`、`ContextAdapter.ts`、`ApprovalPort.ts` 等 4 个文件移动至 `session/` 目录。
- [x] 3.6 将 `QualityCheckPort.ts` 移动至 `security/` 目录。
- [x] 3.7 修正这 13 个搬迁端口文件本身，以及整个 `src/` 和 `test/` 下对其引用的全部相对导入路径（仅限以 `./` 或 `../` 开头且以 `.js` 结尾，绝对禁止触碰绝对导入）。
- [x] 3.8 终审质检：运行 ripgrep 工具全局扫描 `src` 和 `test` 目录下所有的被移动文件名，确认无一处遗留的死链接和后缀破裂，并确保全量 205 个测试全部绿灯通过。

<!-- checkpoint: npm test -->
