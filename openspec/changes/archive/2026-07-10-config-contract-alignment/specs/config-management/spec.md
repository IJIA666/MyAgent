## 新增需求

### Requirement: 运行时超时统一装配

系统必须（MUST）由 `loadConfig()` 统一装配 AgentLoop 单次模型调用超时与后台自省子智能体总超时。两个超时字段必须存在于返回的 `runtimeLimits` 中，运行时消费方不得自行定义回落默认值。

#### Scenario: 从环境变量装配自定义超时

- **WHEN** `AGENT_MODEL_TIMEOUT_MS` 为 `45000`，且 `AGENT_SUB_AGENT_TIMEOUT_MS` 为 `90000`
- **THEN** `loadConfig()` 返回的 `runtimeLimits.modelTimeoutMs` 必须为 `45000`，`runtimeLimits.subAgentTimeoutMs` 必须为 `90000`

#### Scenario: 未提供安全有效的环境变量时使用统一默认值

- **WHEN** 两个超时环境变量缺失、为空白、无法解析为整数、不是正数或超出 Node.js 定时器安全范围
- **THEN** `loadConfig()` 返回的 `modelTimeoutMs` 与 `subAgentTimeoutMs` 必须均为 `60000`

### Requirement: 超时配置单一来源

系统必须（MUST）将 `loadConfig()` 装配后的超时值原样传递给运行时消费方。`MemoryService` 已接收 `AppConfig` 时必须直接使用其中的后台总超时；AgentLoop 到达模型调用边界时必须使用会话配置中的单次调用超时。

#### Scenario: AgentLoop 使用已装配的单次调用超时

- **WHEN** 会话配置中的 `runtimeLimits.modelTimeoutMs` 为 `45000`，且 AgentLoop 发起模型请求
- **THEN** AgentLoop 必须使用 `45000` 创建该次请求的超时信号，不得改用消费方本地默认值

#### Scenario: MemoryService 使用已装配的后台总超时

- **WHEN** 注入 MemoryService 的配置中 `runtimeLimits.subAgentTimeoutMs` 为 `90000`，且后台自省子智能体启动
- **THEN** MemoryService 必须以 `90000` 作为该后台任务的总超时，不得改用消费方本地默认值

#### Scenario: AgentLoop 执行前配置尚未注入

- **WHEN** AgentLoop 到达模型调用边界时 `SessionContext` 尚未注入 `AppConfig`
- **THEN** 系统必须抛出能够定位配置初始化问题的明确错误，不得静默回落到硬编码超时
