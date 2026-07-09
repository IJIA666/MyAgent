## 改造原因

当前 `SessionContext`（[src/core/domain/context.ts](src/core/domain/context.ts#L136)）已经从"会话上下文"膨胀为 **God Object**，同时承担六项非内聚职责：

1. **消息历史管理** — system prompt、消息增删、截断/回滚、API usage 缓存
2. **交互阻塞控制** — `isProcessing` 忙锁、`pendingNotifications` 缓冲、`pendingInteraction` 人机中断
3. **审批与授权** — `ApprovalService` 实例、`CallCapability` 令牌生命周期、`SecurityService` 白名单桥接
4. **插件补丁记录** — `PluginPatchGroup` 的追加与提取
5. **会话元数据** — sessionId、tenantId、workMode、checkpoint、recentFiles
6. **事件发射** — 直接继承 `EventEmitter` 实现 `SessionEventPort`

这导致三个具体问题：
- **插件隔离薄弱**：`plugin-runner.ts` 中插件沙箱仅对历史方法做代理，其他能力（审批、白名单、令牌）仍透传真实 `SessionContext`，插件实际获得了远超所需的权限面。
- **耦合面过宽**：15 个文件直接依赖 `SessionContext`，从领域层（`domain`）到适配层（`adapters`）全部耦合在同一个可变对象上。
- **时序控制粗放**：所有状态的写入保护仅靠单一的 `isProcessing` 锁约束，无法按状态类别定义差异化写入规则。

对标 `opencode`（ACP session 只存 id/cwd/mcpServers/model/knownParts）和 `openclaw`（会话限定在元数据、runtime handle、队列协调），当前设计把运行时执行细节全部塞进了会话对象，违背了单一职责原则。

## 变更内容

- **拆分 SessionContext 为四个子状态对象**：`ConversationState`（消息历史与 usage）、`InteractionState`（忙锁、通知缓冲、人机中断）、`AuthorizationState`（审批等待、CallCapability 令牌、白名单访问）、`PluginMutationLog`（插件补丁记录）
- **SessionContext 退化为 façade**：保留公开 API 兼容，内部委托给子状态对象，不再在 `context.ts` 中直接持有 `ApprovalService` 实例和 `SecurityService` 单例桥接
- **引入授权访问接口**：替代 `SessionContext` 直接桥接 `SecurityService` 单例的现状，通过独立接口访问临时白名单
- **插件执行路径保持兼容**：`HookContext.sessionContext` 继续暴露 `SessionContext façade`，确保 `HumanApprovalPlugin` 等现有插件仍可访问 `approvalService`、`getWorkMode()`、`getSessionId()` 等必要能力
- **忙锁外部语义保持不变**：本次仅拆分内部职责，不重写 `isProcessing` 的对外保护规则

本次为纯内部架构重构，**无 BREAKING 变更**，所有公开行为保持不变。

## 业务能力

### 新增业务能力

本次为纯架构重构，不引入新的业务能力。内部域对象拆分属于实现细节，对外的会话管理、消息历史、审批流程、插件执行等契约均保持不变。

### 修改业务能力

无。本次变更不修改任何 spec 级别的业务行为，所有外部可观测行为保持一致。

## 影响范围

| 层级 | 受影响模块 | 影响性质 |
|:---|:---|:---|
| **领域层** | `src/core/domain/context.ts` | 核心重构，拆分为 façade + 4 个子状态对象 |
| **插件层** | `src/core/usecases/plugins/plugin-runner.ts`、`plugin-types.ts`、`HumanApprovalPlugin.ts` | 校验 façade 拆分后插件执行兼容性，避免错误收窄 Hook 上下文 |
| **持久化层** | `src/core/usecases/brain/ContextRepository.ts` | 适配拆分后的字段归属，保持快照读写契约不变 |
| **少量消费方** | 与 `SessionContext` 内部字段耦合的直接消费者 | 仅在编译或行为兼容需要时做最小化调整，不扩大为全仓库迁移 |
