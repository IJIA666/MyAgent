# Implementation Tasks: fix-low-defects

本清单用于跟踪低危技术债务治理开发过程中的任务节点。

## 1. 底层支撑与隔离机制重构

- [x] 1.1 新增 [QualityCheckPort.ts](file:///d:/projects/MyAgent/src/ports/driven/QualityCheckPort.ts) 端口契约；并在 [ShellQualityCheckAdapter.ts](file:///d:/projects/MyAgent/src/adapters/tools/ShellQualityCheckAdapter.ts) 中实现它，调用子进程执行自测命令。
- [x] 1.2 重构 [SecurityService.ts](file:///d:/projects/MyAgent/src/core/usecases/SecurityService.ts)，将临时读写白名单改为 `Map<string, Set<string>>` 并引入 `sessionId` 做多会话隔离。
- [x] 1.3 重构 [context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts)，新增 `addTemporaryReadWhitelist`、`addTemporaryWriteWhitelist` 和 `clearTemporaryWhitelists` 方法，方法内部引入 busy 锁防护保护（`isProcessing` 处于 true 时抛出 Error 阻断），并转发至单例。
- [x] 1.4 重构 [HumanApprovalPlugin.ts](file:///d:/projects/MyAgent/src/core/usecases/HumanApprovalPlugin.ts)，改用上下文写入白名单。
- [x] 1.5 重构 [OpenAiLlmAdapter.ts](file:///d:/projects/MyAgent/src/adapters/llm/OpenAiLlmAdapter.ts) 的 `generateSummaryAsync` 方法，改用 `AbortSignal.timeout(summaryTimeoutMs)` 进行超时控制，移除冗余局部变量。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 核心主循环与工具注册表修复

- [x] 2.1 修改 [MemoryService.ts](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts) 的 `getTool` 返回值，更正为 `'write'`。
- [x] 2.2 修改 [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)：
  - **任务 2.2-A (L-4 击穿诊断)**：在 `complete` 结算处消费 `checkCacheAndCalibrate` 生成器事件，取代原有 `updateLastApiUsage` 调用（生成器体内最末行已包含上下文用量物理更新，无需且严禁在外部重复调用）；
  - **任务 2.2-B (L-1 端口解耦)**：移除 `runPostRunCheck` 私有实现，改用 `qualityCheckPort.runPostRunCheck()`，构造接收并由 [SessionManager.ts](file:///d:/projects/MyAgent/src/core/usecases/SessionManager.ts) 透传，在 `finally` 块中加入 `this.context.clearTemporaryWhitelists()` 销毁临时授权。
- [x] 2.3 修改 [index.ts](file:///d:/projects/MyAgent/src/index.ts)，实例化 `ShellQualityCheckAdapter` 并透传注入给 `SessionManager`。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 自动化测试对齐与质量检验

- [x] 3.1 修改并适配 `test/brain/SecurityService.test.ts` 中有关临时白名单的测试断言，补齐测试中缺失的前置会话 ID 参数。

<!-- checkpoint: npm test -->
