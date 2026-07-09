## 1. 子状态对象与类型提取

- [x] 1.1 将 `CallCapability` 类型、`CallCapabilityState`、`computeArgumentsDigest` 从 `context.ts` 提取到新建的 [call-capability.ts](src/core/domain/call-capability.ts)，`context.ts` 改为从此文件 re-export
- [x] 1.2 新建 [whitelist-access.ts](src/core/domain/whitelist-access.ts)，定义 `TemporaryWhitelistAccess` 接口
- [x] 1.3 新建 [conversation-state.ts](src/core/domain/conversation-state.ts)，迁移消息历史、system prompt、API usage 相关字段与方法，含单元测试
- [x] 1.4 新建 [interaction-state.ts](src/core/domain/interaction-state.ts)，迁移忙锁、通知缓冲、人机中断相关字段与方法，含单元测试
- [x] 1.5 新建 [authorization-state.ts](src/core/domain/authorization-state.ts)，迁移审批服务、CallCapability 令牌、白名单访问相关字段与方法，含单元测试
- [x] 1.6 新建 [plugin-mutation-log.ts](src/core/domain/plugin-mutation-log.ts)，迁移插件补丁记录逻辑，含单元测试

<!-- checkpoint: npm run build -->

## 2. SessionContext façade 改造

- [x] 2.1 重构 `SessionContext` 构造函数：实例化 4 个子状态对象，`approvalService` 改为通过 `AuthorizationState` 访问
- [x] 2.2 将现有公开方法改为委托调用（`addMessage` → `conversationState.addMessage`，`setPendingInteraction` → `interactionState.setPendingInteraction`，等），保持方法签名不变
- [x] 2.3 `SessionContext` 上 `SecurityService.getInstance()` 的直接调用全部改为通过 `AuthorizationState` 的 `TemporaryWhitelistAccess` 接口
- [x] 2.4 更新 `context.ts` 的 import，移除对 `ApprovalService`、`SecurityService` 的直接依赖（改为由 `AuthorizationState` 内部持有）
- [x] 2.5 保持 `SessionContext extends EventEmitter` 不变，事件发射能力暂留 façade
- [x] 2.6 验证所有既有的 `SessionContext` 公开方法行为与拆分前一致

<!-- checkpoint: npm test -->

## 3. 插件执行兼容性校验

- [x] 3.1 检查 [plugin-types.ts](src/core/usecases/plugins/plugin-types.ts)：保持 `HookContext.sessionContext` 为 `SessionContext façade`，不在本 change 中改动 Hook 公开契约
- [x] 3.2 检查 [plugin-runner.ts](src/core/usecases/plugins/plugin-runner.ts)：确认消息历史 Draft 代理在 façade 拆分后仍正确工作
- [x] 3.3 检查 [HumanApprovalPlugin.ts](src/core/usecases/plugins/HumanApprovalPlugin.ts)：确认 `approvalService`、`getWorkMode()`、`getSessionId()` 兼容不变

<!-- checkpoint: npm run build -->

## 4. 持久化与最小兼容调整

- [x] 4.1 更新 [ContextRepository.ts](src/core/usecases/brain/ContextRepository.ts)：保持 `messages`、`checkpointSummary`、`recentFiles`、`pendingInteraction` 的快照结构与恢复语义不变
- [x] 4.2 检查 [SessionEventPort.ts](src/ports/driven/session/SessionEventPort.ts) 及相关调用方：确认对外端口签名无需因本 change 改动
- [x] 4.3 仅在编译或行为兼容需要时，修正少量直接耦合 `SessionContext` 内部字段的消费者；禁止扩大为全仓库迁移

<!-- checkpoint: npm run build -->

## 5. 清理与收尾

- [x] 5.1 检查 `SessionContext` façade 上是否仍有仅被自身内部使用、不再对外暴露的方法，移除冗余桥接方法
- [x] 5.2 确认 `SessionContext` 不再直接 import `SecurityService`，所有白名单操作均通过 `AuthorizationState` 的 `TemporaryWhitelistAccess` 接口
- [x] 5.3 移除 `context.ts` 中不再需要的 import 语句（`ApprovalService`、`SecurityService` 等）
- [x] 5.4 分别执行编译与测试回归，确认无破坏

<!-- checkpoint: npm run build -->
<!-- checkpoint: npm test -->
