## 背景

`SessionContext`（[src/core/domain/context.ts](src/core/domain/context.ts#L136)）当前是一个 ~812 行的 God Object，直接持有：

| 职责域 | 当前承载字段/方法 |
|:---|:---|
| 消息历史 | `messageHistory`、`addMessage`、`popMessage`、`truncateHistory`、`rollbackHistoryToLength`、`updateHistory`、`getHistory` |
| System Prompt | `updateSystemPrompt`、`getSystemPromptHash`（构造时通过 `buildSystemPrompt` 注入首条 system 消息） |
| API Usage | `lastApiUsage`、`lastApiHistoryLength`、`updateLastApiUsage`、`getLastApiUsage`、`getLastApiUsageBaseline` |
| 会话元数据 | `sessionId`、`tenantId`、`workMode`、`checkpointSummary`、`recentFiles` |
| 忙锁与通知 | `_isProcessing`、`pendingNotifications`、`addNotification`、`flushPendingNotifications` |
| 人机中断 | `_pendingInteraction`、`setPendingInteraction`、`answerPendingInteraction`、`cancelPendingInteraction`、`clearPendingInteraction`、`restorePendingInteraction` |
| 审批服务 | `approvalService: ApprovalService`（实例级）、`waitApproval` |
| Call Capability 令牌 | `callCapabilities: Map`、`registerCallCapability`、`claimCapability`、`consumeCapability`、`hasClaimedResource` |
| 安全白名单桥接 | `getSecurityAllowlist`、`hasTemporaryReadWhitelist`、`hasTemporaryWriteWhitelist`、`addTemporaryReadWhitelist`、`addTemporaryWriteWhitelist`、`addTemporaryDirectoryScopeReadWhitelist`、`clearTemporaryWhitelists` |
| 插件补丁 | `pluginPatches`、`addPluginPatches`、`getAndClearPluginPatches` |
| 事件发射 | 继承 `EventEmitter`、实现 `SessionEventPort` |

15 个文件直接 import `SessionContext`，从领域层的 `domain`、`engine`、`brain` 到适配层的 `adapters`、`ports`，全部耦合在同一个可变对象上。插件系统（`plugin-runner.ts`）中沙箱仅对历史相关方法做代理，审批、白名单、令牌等其他能力仍透传真实 `SessionContext`，使得插件实际获得了远超所需的权限面。

对标参考：
- **opencode** 的 `acp/session.ts` 仅保存 `id`、`cwd`、`mcpServers`、`model`、`knownParts`，审批和工具策略不混入会话对象
- **openclaw** 的 `control-plane/manager.core.ts` 将会话限定在元数据、runtime handle、队列与 turn 协调，不在会话对象上承载执行细节

## 目标与非目标

**目标：**

1. **职责分离**：将 `SessionContext` 的 6+ 项职责拆分到 4 个独立子状态对象中，每个对象拥有单一变更原因
2. **插件执行兼容**：`HookContext.sessionContext` 继续保持 `SessionContext façade` 形态，现有插件不因内部拆分而失效
3. **忙锁语义保持**：`isProcessing` 的外部保护行为保持不变，本 change 不顺手重写并发控制模型
4. **消除 SecurityService 单例桥接**：通过独立授权接口访问白名单，不再在会话对象上直接调用 `SecurityService.getInstance()`
5. **公开 API 兼容**：`SessionContext` 退化为 façade 后，所有公开方法签名保持不变，消费者可按现有路径渐进迁移

**非目标：**

- **不改外部行为**：消息历史语义、审批流程、人机中断生命周期、令牌状态机（registered→claimed→removed）均保持不变
- **不引入新的持久化机制**：不改变 `ContextRepository` 的序列化/反序列化逻辑，仅调整序列化目标的字段归属
- **不修改插件生命周期 Hook 的执行模型**：`plugin-runner` 的执行时序不变，`HookContext.sessionContext` 的公开契约也保持兼容
- **不拆散 `ApprovalService` 本身**：`ApprovalService` 作为独立服务保持完整，仅改变其持有位置（从 `SessionContext` 实例字段移至 `AuthorizationState`）
- **不在此 change 中引入 DI 容器**：不引入 `tsyringe` 或自研 IoC，依赖通过构造函数注入

## 架构决策

### 决策 1：四个子状态对象（而非更多或更少）

**选择**：拆分为 `ConversationState`、`InteractionState`、`AuthorizationState`、`PluginMutationLog` 四个对象。

**理由**：

- `ConversationState` 与 `InteractionState` 的分离依据是**时序粒度不同**——消息历史是跨 turn 持久的，而忙锁、通知缓冲、人机中断是单 turn 内有效的。若合并为一个对象，turn 结束时需要部分重置，增加出错概率。
- `AuthorizationState` 与 `InteractionState` 的分离依据是**安全边界不同**——审批和令牌涉及资源访问控制，与通用的流程控制（忙锁、中断）在审计和测试上应独立管理。
- `PluginMutationLog` 独立是因为它本质是**只追加的审计日志**（追加后批量提取并清空），与上述三种有状态对象生命周期完全不同。

**替代方案**：
- 拆为 3 个（合并 InteractionState + AuthorizationState）：被否决，因为安全授权状态的修改应该有独立的写入保护规则，不能与通用忙锁混用同一把锁。
- 拆为 5 个（单独抽出 `SessionMetadata` 含 sessionId/tenantId/workMode）：被否决，因为这些元数据与消息历史强关联（checkpoint、recentFiles 与消息内容绑定），拆分会导致跨对象协调成本超过收益。

### 决策 2：SessionContext 退化为 façade（而非直接删除）

**选择**：`SessionContext` 保留为公开类，内部委托给 4 个子状态对象，原公开方法保持不变。

**理由**：

- 15 个消费方中，部分（如 `agent-loop.ts`、`ToolDispatcher.ts`）可以快速迁移到子状态对象直引；部分（如 `DefaultContextAdapter.ts`、`ContextAdapter.ts`）需要更谨慎的接口调整。façade 允许**渐进式迁移**，避免一次改动所有文件。
- 持久化路径（`ContextRepository`）虽然当前只保存挑选字段，但这些字段都来自 `SessionContext` 的公开能力。保留 façade 可以让快照读写继续沿用既有入口，避免拆分后立刻扩散到更多调用方。

**替代方案**：
- 直接删除 `SessionContext`，所有消费方改为注入子状态对象：被否决，15 个文件的同步改动风险过高，且会破坏序列化兼容。
- 保留 `SessionContext` 但仅作为 DI 容器：被否决，语义不清晰，且会诱使新代码继续往上面加字段。

### 决策 3：插件沙箱继续暴露 SessionContext façade（而非本次强行收窄为子状态对象）

**选择**：`plugin-runner` 继续在 `HookContext.sessionContext` 上暴露 `SessionContext façade`，但 façade 内部的历史、审批、白名单、补丁记录分别委托给拆分后的子状态对象。

**理由**：

- 当前 `HumanApprovalPlugin.ts` 在 `BeforeTool` Hook 中明确依赖 `sessionContext.approvalService`、`sessionContext.getWorkMode()`、`sessionContext.getSessionId()`；本次若强行只暴露 `ConversationState` + `PluginMutationLog`，会直接破坏现有插件契约。
- `plugin-runner.ts` 当前真正被 Immer 沙箱代理的只是消息历史读写，审批、workMode、sessionId 等能力并未被 Draft 化。先保留 façade，可以把本 change 聚焦在领域拆分，而不是顺手重写 Hook 上下文模型。
- 后续若要进一步收窄插件能力面，应基于 Hook 类型设计更细的上下文接口，而不是在本 change 中一次性砍掉现有依赖。

**替代方案**：
- 直接改为 `ConversationState` + `PluginMutationLog`：被否决，因为与当前 `HumanApprovalPlugin` 的真实依赖不符，且会把 B 变更扩大为插件契约重构。

### 决策 4：白名单访问通过独立接口（而非 SessionContext 方法桥接）

**选择**：定义 `TemporaryWhitelistAccess` 接口，由 `AuthorizationState` 实现，替代 `SessionContext` 上直接调用 `SecurityService.getInstance()` 的桥接方法。

**理由**：

- 当前 `SessionContext.hasTemporaryReadWhitelist(path)` 内部调用 `SecurityService.getInstance()` —— 这是静态单例耦合，且使会话对象成为安全服务的代理而非真正的状态持有者。
- 独立接口使测试可注入 mock，也使未来替换 SecurityService 实现时不影响会话状态层。

**接口定义方向**：

```typescript
export interface TemporaryWhitelistAccess {
  hasReadWhitelist(sessionId: string, path: string): boolean;
  hasWriteWhitelist(sessionId: string, path: string): boolean;
  addReadWhitelist(sessionId: string, path: string): void;
  addWriteWhitelist(sessionId: string, path: string): void;
  addDirectoryScopeReadWhitelist(sessionId: string, dirRoot: string): void;
  clearWhitelists(sessionId: string): void;
}
```

**替代方案**：
- 保留 `SessionContext` 上的桥接方法但委托给 `AuthorizationState`：短期可行，但 façade 继续承载白名单方法会模糊其职责边界。推荐在消费者迁移阶段（Phase 2）逐步将调用方改为直接引用 `AuthorizationState`，最终废弃 façade 上的桥接方法。

### 决策 5：保留 `isProcessing` 现有外部语义，不在本 change 中重写锁模型

**选择**：

- `InteractionState.isProcessing` 仍作为 façade 对外暴露的忙锁来源
- `ConversationState`、`AuthorizationState`、`PluginMutationLog` 的写入保护继续由 façade 在现有调用点统一维持
- 本次不引入新的锁类型，也不改变现有“busy 时部分公开方法抛错”的契约

**理由**：

- 当前 `isProcessing` 的保护点分布在 `SessionContext` 多个公开方法中，真实消费者已经依赖这些抛错/阻塞语义。
- 若在本 change 中同时重写锁模型，会把“领域拆分”扩展成“并发控制重构”，风险和验证范围都明显超出当前边界。
- 保持外部语义不变，先完成职责分离，再决定是否单独立项精细化锁模型，更符合原子化变更原则。

**替代方案**：
- 同步引入分状态锁模型：被否决，因为与当前 change 边界不符，且缺少充分的行为验证基础。

## 目标文件结构

拆分后的文件组织（均在 `src/core/domain/` 下）：

```
src/core/domain/
├── context.ts                    # SessionContext façade（保留原类名，委托给子对象）
├── conversation-state.ts         # ConversationState 类
├── interaction-state.ts          # InteractionState 类
├── authorization-state.ts        # AuthorizationState 类
├── plugin-mutation-log.ts        # PluginMutationLog 类
├── whitelist-access.ts           # TemporaryWhitelistAccess 接口定义
├── call-capability.ts            # CallCapability 类型 + computeArgumentsDigest（从 context.ts 迁出）
├── trace-format.ts               # 不变
└── ...                            # 其他既有文件不变
```

## 风险与权衡

| 风险 | 缓解策略 |
|:---|:---|
| **façade 变成换皮**：如果拆分后所有职责仍继续堆回 façade，收益会被稀释 | 先把状态归属真正迁入 4 个子对象，再只对确有必要的消费者做最小兼容调整 |
| **序列化兼容**：`ContextRepository` 当前保存的是 `messages`、`checkpointSummary`、`recentFiles`、`pendingInteraction` 等挑选字段，拆分后字段归属变化仍可能破坏快照读写 | 保持现有快照结构不变，仅调整这些字段的读取来源；只有在确有必要时才引入 `toJSON` / `fromJSON` |
| **拆分后的并发安全**：即使不改锁模型，状态迁移时仍可能漏掉原有 busy 保护点 | 逐个审查当前 `isProcessing` 的所有保护点，确保 façade 委托后仍在相同调用点维持阻断语义 |
| **approvalService 迁移**：当前 `approvalService` 是 `SessionContext` 的 `public readonly` 字段，外部可能有直接引用 | 通过 façade 的 getter 代理保持兼容，同时在 `AuthorizationState` 中作为主存储 |
| **EventEmitter 继承**：`SessionContext extends EventEmitter`，拆分后事件发射能力放在哪里 | 暂时保留在 façade（`SessionContext` 仍 extends `EventEmitter`），后续评估是否下沉到具体子状态对象 |
| **测试覆盖**：拆分后每个子状态对象和 façade 都需要独立单元测试 | 在 `tasks.md` 中为每个子状态对象安排测试任务，优先覆盖状态机转换（令牌、中断） |

## 迁移计划

### 步骤 1：创建子状态对象（无破坏性）

1. 新建 `conversation-state.ts`，将 `messageHistory`、`lastApiUsage`、`systemPrompt` 相关逻辑迁入
2. 新建 `interaction-state.ts`，将 `isProcessing`、`pendingNotifications`、`pendingInteraction` 迁入
3. 新建 `authorization-state.ts`，将 `approvalService`、`callCapabilities`、白名单访问迁入
4. 新建 `plugin-mutation-log.ts`，将 `pluginPatches` 相关逻辑迁入
5. 新建 `whitelist-access.ts`，定义 `TemporaryWhitelistAccess` 接口
6. 将 `CallCapability` 类型和 `computeArgumentsDigest` 函数迁入 `call-capability.ts`

> 此阶段所有变更仅在 `src/core/domain/` 内部，不影响任何消费方。`SessionContext` 的公开 API 通过委托保持不变。

### 步骤 2：façade 与兼容点调整

1. `context.ts`：将公开方法改为委托调用 4 个子状态对象
2. `plugin-runner.ts` + `plugin-types.ts`：确认 `HookContext.sessionContext` 继续兼容现有插件调用方式
3. `ContextRepository.ts`：确认快照保存与恢复仍按既有字段结构工作
4. 对存在编译错误或直接耦合内部字段的少量消费者做最小化修正

### 步骤 3：清理

1. 移除 façade 上不再被外部引用的桥接方法
2. 确认 `SecurityService.getInstance()` 不再被 `SessionContext` 直接调用
3. 移除未使用的 import

### 回滚策略

- 每个步骤的提交独立，步骤 1 完成后可通过 `git revert` 单独回滚
- 步骤 1 的子状态对象创建与 `SessionContext` 修改是纯增量的——新增文件 + 修改 `context.ts` 的内部实现，公开 API 不变，回滚无数据丢失风险
- 步骤 2 仅做兼容性调整与必要的最小修正，避免出现“大面积消费者迁移后难以回滚”的问题

## 未决问题

1. **`EventEmitter` 的归属**：`SessionContext` 当前继承 `EventEmitter` 实现 `SessionEventPort`。拆分后事件发射能力应放在 façade 还是下沉到具体子状态对象？建议先保留在 façade，后续根据实际事件类型决定归属。

2. **`ContextRepository` 的字段映射归属**：当前快照保存的是挑选字段而非整个 `SessionContext` 实例。编码前需确认这些字段在拆分后分别从哪个子状态对象读取，避免不必要地引入 `toJSON` / `fromJSON`。

3. **子状态对象之间的交叉引用**：例如 `InteractionState.flushPendingNotifications()` 需要调用 `ConversationState.addMessage()` —— 这种跨对象协调是通过 façade 编排，还是允许子对象之间直接引用？初步建议由 façade 编排，保持子对象独立。
