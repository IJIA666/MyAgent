# 探索主题: SessionContext 拆分

## 1. 问题定义
当前 `SessionContext` 已经不再是单纯的“会话上下文”，而是同时承担消息历史、交互阻塞、审批等待、插件补丁记录、调用能力管理、临时白名单桥接等多类职责。它既是状态容器，又是运行时协调入口，导致内聚度偏低，插件与主执行链都对其形成强依赖。B 问题的核心不是“类太大”这么简单，而是会话态、授权态、交互态被揉进了同一个可变对象。

## 2. 关键发现与调研结果
- **代码库现状**：
  - `src/core/domain/context.ts` 中 `SessionContext` 直接持有 `approvalService`、`pendingNotifications`、`pendingInteraction`、`pluginPatches`、`callCapabilities`、`isProcessing`，并通过 `hasTemporaryReadWhitelist()` 等方法直接桥接 `SecurityService`。
  - `flushPendingNotifications()`、`setPendingInteraction()`、`registerCallCapability()`、`getAndClearPluginPatches()` 这些能力并不属于同一类聚合根，却都暴露在 `SessionContext` 上。
  - `src/core/usecases/plugins/plugin-runner.ts` 中，插件沙箱只对历史相关方法做代理，其他能力仍然透传真实 `SessionContext`。这说明插件系统实际上把 `SessionContext` 当成杂项运行时总线使用，而不是把它当成单一语义的会话状态对象。
  - `isProcessing` 被广泛当作修改保护锁使用，说明当前很多状态的写入规则只靠一个总开关约束，而不是靠更细的边界控制。
- **核实与洞察**：
  - OpenAI 的 conversation state 文档把“对话状态持久化/串联”定义为独立概念，重点在消息、上下文与会话标识，不把工具执行控制混入其中。这支持把会话状态与工具/授权运行时分离。[OpenAI Conversation State 指南](https://developers.openai.com/api/docs/guides/conversation-state)
  - `opencode` 的 `packages/opencode/src/acp/session.ts` 只保存 ACP 会话最小状态，例如 `id`、`cwd`、`mcpServers`、`model`、`knownParts`，没有把审批、工具策略、插件补丁全部塞进同一个对象。
  - `openclaw` 的 `src/acp/control-plane/manager.core.ts` 也把会话管理限定在元数据、runtime handle、队列与 turn 协调，没有让单个会话对象承载全部执行细节。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：保留单一 SessionContext，仅继续整理方法 | 方案 B：拆成多个会话子状态对象，由 SessionContext 退化为 façade | 结论 |
| :--- | :--- | :--- | :--- |
| 改造成本 | 低 | 中 | A 更低 |
| 内聚提升 | 弱 | 强 | B 明显更优 |
| 插件隔离 | 弱，插件仍可见大量杂项能力 | 强，可按状态面暴露更窄接口 | B 更优 |
| 时序控制 | 仍依赖 `isProcessing` 兜底 | 可按状态类别定义写入规则 | B 更优 |
| 后续扩展 | 容易继续膨胀 | 更容易稳定演进 | B 更优 |

**推荐路径**：选择方案 B，把 `SessionContext` 收缩为会话运行时外观，内部按职责拆分。

建议的拆分方向：

1. `ConversationState`
   - 负责消息历史、system prompt、usage 缓存。

2. `InteractionState`
   - 负责 `pendingNotifications`、`pendingInteraction`、`isProcessing` 这一类 turn 内交互状态。

3. `AuthorizationState`
   - 负责审批等待、调用能力、已认领资源等授权相关状态。

4. `PluginMutationLog`
   - 负责插件补丁记录与提取，不再与会话主状态混放。

5. 会话级白名单访问接口
   - `SessionContext` 不再直接桥接 `SecurityService` 单例，而是通过独立授权接口访问临时白名单。

## 4. 约束、风险与未知项
- `plugin-runner`、`agent-loop`、`ToolDispatcher` 当前都默认拿到的是一个“大而全”的可变对象；拆分后需要明确最小暴露面，否则 façade 只是换皮。
- `isProcessing` 现在承担了过多一致性保护职责；拆分后必须决定哪些状态仍需要 turn 级锁，哪些可以独立管理。
- `ApprovalService` 现在挂在 `SessionContext` 上，若迁移不当，容易让审批等待与工具执行边界再次耦合。
- 如果只拆字段、不拆调用关系，最终仍会退化成“多个小对象 + 一个大协调器”的伪解耦。

## 5. 否决方案
- **只给 `SessionContext` 补注释和分区注释**：不会改变职责混杂事实。
- **只抽类型别名，不迁移真实状态归属**：属于表面重构，不能改善边界。
- **继续让 `SessionContext` 直接桥接 `SecurityService`、审批、插件补丁**：这会让后续所有运行时能力继续往这里聚集。
