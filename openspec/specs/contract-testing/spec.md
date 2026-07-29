## Purpose

定义跨模块生产组合边界的合约测试范围和替身原则。该规范要求授权、会话仓储与日志链路保留真实装配，只替换不可控外部依赖，避免 mock 自己证明自己。

## Requirements

### Requirement: 关键组合边界的合约测试

系统必须（MUST）对以下真实生产边界提供自动化合约测试：

1. `ToolCatalog`、`ToolAuthorizationAdapter`、`ToolCallGateway`、`ToolPermissionService`、ask-only 审批交互与 `ToolCallOrchestrator` 的统一授权执行链路；
2. `ContextRepository.saveState()` 与 `loadState()` 的会话快照读写链路；
3. `src/utils/logger.ts` 与 LogTape sink 的结构化日志输出链路。

#### Scenario: 工具注册与统一权限网关的真实装配

- **WHEN** 使用真实 `ToolRegistry`、ToolCatalog 中注册的正式适配器和 ToolCallGateway，并通过 `ToolCallOrchestrator` 提交需要审批的工具调用
- **THEN** 测试必须（MUST）覆盖最终 allow、ask、deny、可信 ApprovalAction 提交和 execution grant 消费，并将执行前拒绝正确传递回编排层；测试不得直接调用 ToolExecutor、伪造授权上下文或重新引入第二套安全接口。

#### Scenario: 会话快照保存与恢复

- **WHEN** 构造 `SessionContext` 并通过 `ContextRepository.saveState()` 写入 JSON 快照，再由新的上下文调用 `loadState()`
- **THEN** 反序列化后的上下文必须（MUST）恢复已持久化的 `messages`、`checkpointSummary`、`recentFiles` 和合法的 `pendingInteraction`；测试不得声称快照包含当前实现没有保存的审批历史记录。

#### Scenario: 结构化日志管道连通

- **WHEN** 通过 `src/utils/logger.ts` 在隔离临时工作目录初始化实际文件 sink，写入带结构化属性的 DEBUG/INFO/WARN/ERROR 日志
- **THEN** 临时目录中的 JSONL 文件必须（MUST）接收到符合配置级别过滤的结构化日志条目，且测试在 teardown 中释放 LogTape 资源；测试不得引入不存在的 `LoggerPort` 接口。

### Requirement: 确定性外部依赖替身

合约测试必须（MUST）使用受控的 Fake 替代真实 LLM、网络、向量服务和外部交互依赖；真实的工具注册、权限适配器、权限网关、审批交互边界、会话仓储和日志适配器应保持真实装配。

#### Scenario: Fake 实现的使用

- **WHEN** 合约测试需要 `LlmPort` 或其他外部驱动端口
- **THEN** 测试必须（MUST）使用 `test/contract/fakes/` 下完整实现对应接口的 Fake，返回确定性输出，且不得发起网络请求或不可控外部服务调用。

### Requirement: 合约测试的独立执行脚本

合约测试必须（MUST）可通过专用 npm script 独立执行，不应包含在 `npm test` 的默认运行集合中。

#### Scenario: 合约测试脚本

- **WHEN** 执行 `npm run test:contract`
- **THEN** 系统必须（MUST）运行 `test/contract/` 目录下的所有测试文件，并在失败时以非零退出码终止。
