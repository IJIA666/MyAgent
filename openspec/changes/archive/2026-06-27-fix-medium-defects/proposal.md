# Change Proposal: fix-medium-defects

## 1. 变革背景 (Background)
本子变更旨在修复项目在会话上下文提炼（Compaction）与状态落盘（saveState）中的两处中危设计缺陷：
- **M-1：`CompactionService.compact()` 截断时存在"信息真空"窗口期**
  在 Token 爆仓触发硬截断后，由于异步摘要还未生成，模型会收到静态兜底文，失去历史连贯性；且原本基于固定 RetainCount 的截断可能导致截断点落在 Tool/Assistant 消息中间，带来 API 400 崩溃的风险。
- **M-2：`ContextRepository.saveState()` 吞掉所有 I/O 异常**
  在写入本地持久化状态时捕获异常被静默吞掉，导致磁盘空间满或权限受限时会话丢失而开发者完全无感知。

---

## 2. 改造方案概要 (Proposed Remediation)

### 2.1 M-1：滚动窗口轮数硬截断
- **策略**：将 `compactionRetainCount` 配置由“消息条数”升级为“保留的 User 消息轮数”。
- **前置守卫**：若历史中包含的 `user` 角色消息总数 `<= compactionRetainCount`，则不予截断。
- **定位切片点**：反向扫描（仅限于 index 1 及之后的范围，绝对不能触碰 index 0 的 system 消息）找到倒数第 `compactionRetainCount`（默认 4，即最近 3.5 轮交互）个 `user` 角色消息的索引作为 `cutoffIndex` 起点。
- **API 补全**：在 `SessionContext` 中提供 `truncateHistoryFromIndex(startIndex)` 物理执行截断，首条保留 system，中间跳过，后面保留，天然保障契约 Spec 合规。

### 2.2 M-2：saveState 异常记录
- 在 `ContextRepository` 的 `saveState()` 中添加 `catch (e)` 日志记录，通过 `logger.warn` 打印警告但不抛出，保持核心交互流程不受写盘错误阻断。

---

## 3. 影响面评估 (Impact Assessment)
- **Compaction 逻辑**：硬截断行为由基于配置条数改变为基于 User 消息轮次，截断时保留更多更完整的上下文。
- **集成测试与单元测试**：
  - `test/brain/CompactionService.test.ts` 需要同步重构，校准测试中模拟的硬截断行为及断言。
