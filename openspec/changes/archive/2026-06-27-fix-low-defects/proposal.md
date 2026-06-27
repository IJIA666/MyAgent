# Change Proposal: fix-low-defects

## 1. 变革背景 (Background)
本子变更旨在清理项目中遗留的 5 处低危技术债务（L-1 至 L-5），以提高系统架构的高内聚低耦合性（解耦 exec 物理依赖）、提升数据隔离安全性（多并发会话白名单物理隔离）、复活诊断死代码并剔除冗余占位。

---

## 2. 改造方案概要 (Proposed Remediation)

### 2.1 L-1：QualityCheckPort 解耦
- 新增 `QualityCheckPort` 端口，并将原本在 `AgentLoop` 中直接 exec 的 `runPostRunCheck()` 下沉为 `ShellQualityCheckAdapter`，实现领域层与 Shell 运行副作用完全解耦。

### 2.2 L-2：MemoryRefinementToolRegistry 读写标记修正
- 将 `writeMemoryFile` 工具的安全标记改回正确的 `'write'`，消除欺骗注释，还原其在会话并发下的写锁语义。

### 2.3 L-3：SecurityService 临时白名单 Map 化
- 将单例中的 Set 成员更改为 `Map<string, Set<string>>` 并引入 `sessionId` 做多会话强隔离；
- 在 `SessionContext` (`context.ts`) 中暴露写方法，对写操作施加 `isProcessing` 状态 busy 锁防护；在 `agent-loop.ts` 的 `finally` 块中加入周期性白名单销毁回收；`HumanApprovalPlugin` 通过上下文写入。

### 2.4 L-4：缓存自诊断死代码复活
- 在 `agent-loop.ts` 大模型 `complete` 结算处消费 `checkCacheAndCalibrate` 生成器，流式跑出诊断事件。

### 2.5 L-5：localAbortController 无效占位清除
- 在 `OpenAiLlmAdapter.ts` 中改用 `AbortSignal.timeout(summaryTimeoutMs)` 原生实现绑定。

---

## 3. 影响面评估 (Impact Assessment)
- 接口与调用关系：主要变动在白名单隔离上，会话生命周期的 finally 中会销毁当次临时权限。
- 单元测试：需适配 `test/brain/SecurityService.test.ts` 中关于临时白名单的操作契约。
