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

#### Scenario: Synchronous Tool Result Does Not Dispatch Notification

- **WHEN** 外部工具以同步模式完成并已经通过当前 tool result 返回执行结果
- **THEN** 工具不得额外通过 `EventNotificationPort` 注入完成通知，以避免同一个工具调用同时产生 tool response 和异步 user notification。

### Requirement: Dependency Inversion for Adapters
核心逻辑层（`SessionManager` 与 `AgentLoop`）绝对不允许（MUST NOT）对外围的具体适配器产生物理 import 引用与手动 new 实例化操作；外部依赖必须（MUST）定义为 Ports 契约，并通过构造注入由外层装配注入。

#### Scenario: Instantiate Session In Entrypoint
- **WHEN** 客户端 Facade 入口启动并初始化会话时
- **THEN** 必须（MUST）由 Facade 统一实例化具体适配器 ToolRegistry，并作为 ToolRegistryPort 注入构造函数，保证核心对工具具体实现的零物理耦合。

#### Scenario: Code Quality Auto Check Port Inversion
- **WHEN** 智能体大脑引擎完成推理后，在 PostRunHook 检查点触发物理项目 Lint 与编译强校验时
- **THEN** 绝对不允许（MUST NOT）在领域层（`AgentLoop`）直接引入 `child_process` 或物理 Shell 命令；必须（MUST）定义 `QualityCheckPort` 作为抽象驱动端口，并在应用装配入口（`index.ts`）实例化对应的物理执行适配器并由外围注入。

### Requirement: Usecases and Ports Subdomain Cohesion
源码用例物理文件摆放和驱动接口协议定义文件，必须依据插件、控制引擎、记忆人设与安全拦截等高内聚的子域分类，隔离存放在各自独立的子文件夹中，杜绝平铺冗余，确保概念和依赖清晰。

#### Scenario: Cascade Dependencies Work in Subdomains
- **WHEN** 35 个文件被物理分批移动并在系统各处修正引入路径后，运行全量测试时
- **THEN** 级联 ESM 模块（`.js`）导入无任何找不到文件的死锁报错，且全量 205 个测试绿灯通过。
