## ADDED Requirements

### Requirement: 关键组合边界的合约测试

系统必须（MUST）对以下真实生产边界提供自动化合约测试：

1. `ToolRegistry`、其 `policyPort`、`HumanApprovalPlugin` 与 `ToolCallOrchestrator` 的工具审批编排链路；
2. `ContextRepository.saveState()` 与 `loadState()` 的会话快照读写链路；
3. `src/utils/logger.ts` 与 LogTape sink 的结构化日志输出链路。

#### Scenario: 工具注册与审批插件的真实装配

- **WHEN** 使用真实 `ToolRegistry` 的内建工具和 `policyPort`，注册具体的 `HumanApprovalPlugin`，并通过真实 `ToolDispatcher` 与 `ToolCallOrchestrator` 提交需要审批的工具调用
- **THEN** 审批插件必须（MUST）能够拦截该请求，使用确定性审批决策完成 pass、deny、suspend/允许路径，并将拒绝结果正确传递回编排层；测试不得依赖 `ToolRegistryPort.getTool().checkSafety()` 之类不存在的接口。

#### Scenario: 会话快照保存与恢复

- **WHEN** 构造 `SessionContext` 并通过 `ContextRepository.saveState()` 写入 JSON 快照，再由新的上下文调用 `loadState()`
- **THEN** 反序列化后的上下文必须（MUST）恢复已持久化的 `messages`、`checkpointSummary`、`recentFiles` 和合法的 `pendingInteraction`；测试不得声称快照包含当前实现没有保存的审批历史记录。

#### Scenario: 结构化日志管道连通

- **WHEN** 通过 `src/utils/logger.ts` 在隔离临时工作目录初始化实际文件 sink，写入带结构化属性的 DEBUG/INFO/WARN/ERROR 日志
- **THEN** 临时目录中的 JSONL 文件必须（MUST）接收到符合配置级别过滤的结构化日志条目，且测试在 teardown 中释放 LogTape 资源；测试不得引入不存在的 `LoggerPort` 接口。

### Requirement: 确定性外部依赖替身

合约测试必须（MUST）使用受控的 Fake 替代真实 LLM、网络、向量服务和外部交互依赖；真实的工具注册、策略适配、审批插件、会话仓储和日志适配器应保持真实装配。

#### Scenario: Fake 实现的使用

- **WHEN** 合约测试需要 `LlmPort` 或其他外部驱动端口
- **THEN** 测试必须（MUST）使用 `test/contract/fakes/` 下完整实现对应接口的 Fake，返回确定性输出，且不得发起网络请求或不可控外部服务调用。

### Requirement: 合约测试的独立执行脚本

合约测试必须（MUST）可通过专用 npm script 独立执行，不应包含在 `npm test` 的默认运行集合中。

#### Scenario: 合约测试脚本

- **WHEN** 执行 `npm run test:contract`
- **THEN** 系统必须（MUST）运行 `test/contract/` 目录下的所有测试文件，并在失败时以非零退出码终止。
