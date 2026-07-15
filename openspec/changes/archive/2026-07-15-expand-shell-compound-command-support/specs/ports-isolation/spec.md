## MODIFIED Requirements

### Requirement: Dependency Inversion for Adapters

核心逻辑层（`SessionManager` 与 `AgentLoop`）绝对不允许（MUST NOT）对外围的具体适配器产生物理 import 引用与手动 new 实例化操作；外部依赖必须（MUST）定义为 Ports 契约，并通过构造注入由外层装配注入。

#### Scenario: Instantiate Session In Entrypoint

- **WHEN** 客户端 Facade 入口启动并初始化会话时
- **THEN** 必须（MUST）由 Facade 统一实例化具体适配器 ToolRegistry，并作为 ToolRegistryPort 注入构造函数，保证核心对工具具体实现的零物理耦合。

