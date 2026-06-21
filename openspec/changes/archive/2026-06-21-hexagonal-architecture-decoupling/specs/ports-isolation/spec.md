# 规格契约：外部工具隔离与依赖反转规范

## 新增需求

### Requirement: Tool Access Port Isolation
外部具体工具适配器（如 `terminal.ts` 或 `file-system.ts`）在运行时绝不允许直接访问或操作核心的 `SessionContext` 实体；工具对核心的交互应当（SHALL）被严格隔离在超薄的、职责单一的 driven ports 中，以防范敏感状态泄露。

#### Scenario: Write Command Request Approval
- **WHEN** 终端工具 ExecuteCommandTool 在 YOLO 模式之外执行具有写倾向的危险命令时
- **THEN** 工具必须（MUST）调用专门的 ApprovalPort 的 waitApproval 接口挂起并申请确权，不得绕过端口直接修改 Session 状态。

#### Scenario: Async System Notification Dispatch
- **WHEN** 外部工具的异步后台进程产生退出或特征行匹配通知时
- **THEN** 工具应当（SHALL）仅通过 EventNotificationPort 接口向会话推送 notification，由核心执行自唤醒，保持依赖清洁。

### Requirement: Dependency Inversion for Adapters
核心逻辑层（`SessionManager` 与 `AgentLoop`）绝对不允许（MUST NOT）对外围的具体适配器产生物理 import 引用与手动 new 实例化操作；外部依赖必须（MUST）定义为 Ports 契约，并通过构造注入由外层装配注入。

#### Scenario: Instantiate Session In Entrypoint
- **WHEN** 客户端 Facade 入口启动并初始化会话时
- **THEN** 必须（MUST）由 Facade 统一实例化具体适配器 ToolRegistry，并作为 ToolRegistryPort 注入构造函数，保证核心对工具具体实现的零物理耦合。
