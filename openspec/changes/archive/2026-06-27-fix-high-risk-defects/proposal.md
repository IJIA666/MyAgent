## 改造原因

在对项目进行底座审计时，确认了 3 个高危安全与执行缺陷：
1. **H-1**：技能加载系统硬编码了特定的物理绝对路径，且与 `RuleManager` 加载机制割裂，导致在非本地开发机上技能系统静默失效，且无法天然隔离并发多会话的工作区。
2. **H-2**：系统通知的刷入机制采用隐式的 `process.nextTick` 异步调度，在多 Hooks 连续同 Tick 执行时会与 Immer 的不可变覆写逻辑发生竞态冲突，导致通知消息被彻底抹除。
3. **H-3**：上下文适配器在拼接 `recentFiles` 时将其包装为 `system` 角色强行 splice 插入消息历史流中部，形成了不符合大模型 API Spec 规范的非法交错消息序列，引发部分严格合规端点的 HTTP 400 崩溃。

为了保障智能助手底座的安全隔离性、通知落盘确定性以及大模型请求的多平台兼容性，必须对这三个高危缺陷进行彻底的重构纠偏。

## 变更内容

1. **规则与技能加载重构 (H-1)**：
   - 彻底将 `contextLoader.ts` 改造为无状态纯工具类，移除其中硬编码的物理路径，所有读取函数均改为接收显式的工作区路径参数。
   - 重新理顺职责，将技能的发现、缓存与索引生命周期收归到实例化的 `RuleManager` 类中统一管理，确保随着 `Session` 实例的隔离而天然隔离，消除并发工作区的技能交叉污染风险。
2. **通知消息同步合并重构 (H-2)**：
   - 废除 `SessionContext` 中通过 `process.nextTick` 隐式异步刷入通知的机制。
   - 在 `SessionContext` 内部将 Hook 执行期产生的通知安全地追加并存放在 `pendingNotifications` 队列中。
   - 在 `AgentLoop` 主执行周期每轮迭代完成时，通过确定的同步流在状态保存前安全地执行一次终态 flush，合并入历史栈，确保所有通知消息 100% 安全落盘且绝无覆盖风险。
3. **适配器消息序列规整重构 (H-3)**：
   - 调整 `DefaultContextAdapter` 中 `recentFiles` 的注入行为。
   - 不再创建多余的 `system` 消息节点去破坏历史，而是将其内容拼装成 `<recent_files_inventory>` 格式的 XML 文本片段，直接物理追加在第一条 `user` 角色消息（即会话 Checkpoint 消息）的 content 尾部，从而形成标准干净的 `[system, user, assistant]` 交替消息序列。

## 业务能力

### 新增业务能力
- `technical-contracts`: 底层非功能性契约与系统健壮性规范。

### 修改业务能力
*本次改造为纯底层技术性重构，不涉及对既有面向用户需求规格的业务能力修改。*

## 影响范围

1. **状态模型与执行器**：
   - [context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts)：修改 `isProcessing` 状态锁及通知暂存/刷入行为，剔除异步隐式副作用。
   - [plugin-runner.ts](file:///d:/projects/MyAgent/src/core/usecases/plugin-runner.ts)：去除多余的同步覆写前对 notification 的间接干扰。
   - [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)：在每轮 Loop 迭代收尾及保存状态前增加同步 flush 终态入口。
2. **规则与技能加载层**：
   - [contextLoader.ts](file:///d:/projects/MyAgent/src/core/usecases/contextLoader.ts)：纯无状态化，移除物理硬编码，新增路径传参。
   - [RuleManager.ts](file:///d:/projects/MyAgent/src/core/usecases/RuleManager.ts)：承接技能缓存发现与管理职责。
3. **外部适配器**：
   - [DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts)：修改 recentFiles 拼装与注入逻辑，合并至 checkpoint。
4. **集成测试**：
   - 可能会影响部分校验系统 system prompt 结构以及模拟规则加载逻辑的单元/集成测试用例，重构时需一并校准。
