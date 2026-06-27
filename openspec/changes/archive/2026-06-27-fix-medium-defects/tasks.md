# Implementation Tasks: fix-medium-defects

本清单用于跟踪本变更落地开发过程中的任务节点。

## 1. M-1 与 M-2 核心缺陷修复

- [x] 1.1 修改 [context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts)，为 `SessionContext` 类新增公有方法 `truncateHistoryFromIndex(startIndex: number): void`，并添加对应的 busy 锁断言保护。
- [x] 1.2 重构 [CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts) 的 `compact()` 方法。将 `compactionRetainCount` 配置的物理语义从“保留的消息条数”升级映射为“保留的 User 消息轮数”（类内字面量 8 仅作为最底层无配置兜底降级，无需做物理更改）；前置守卫重构为统计 index 1 之后的 `user` 角色消息总数；实现反向扫描寻找倒数第 `compactionRetainCount` 个 `user` 消息的索引作为 `cutoffIndex` 起点，并调用新 API 执行物理截断。
- [x] 1.3 重构 [ContextRepository.ts](file:///d:/projects/MyAgent/src/core/usecases/ContextRepository.ts)，头部引入统一日志组件 `logger`，并在 `saveState()` 的 `catch` 块中补齐 `logger.warn` 打印警告，但不抛出异常以维持非阻断性。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 自动化测试对齐与质量检验

- [x] 2.1 重构并适配 `test/brain/CompactionService.test.ts` 中的单元测试断言，使其能够使用符合新滚动窗口规范 of User 对话历史流触发硬截断，保障测试契约对齐。

<!-- checkpoint: npm test -->
