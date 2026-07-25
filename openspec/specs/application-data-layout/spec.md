# Application Data Layout

## Requirements

### Requirement: 项目配置与应用运行数据必须分离

系统 MUST 使用 `.myagent` 作为唯一产品目录命名空间，并将人工维护的项目配置与程序生成的运行数据置于不同物理作用域。项目 `<workspace>/.myagent/` MUST 只包含 `settings.json`、`settings.local.json`、`rules/` 和 `skills/`；项目运行数据 MUST 位于 `~/.myagent/projects/<workspace-key>/` 下，并按 `logs/`、`state/`、`artifacts/` 和 `tmp/` 分类。

#### Scenario: 正常启动项目

- **WHEN** 用户从已授权 workspace 启动 MyAgent
- **THEN** 系统从 workspace `.myagent` 读取项目配置，并将该项目产生的日志、会话、浏览器状态、工具输出、截图和备份写入对应 workspace key 的用户应用数据目录

#### Scenario: workspace 内没有项目配置

- **WHEN** workspace 中不存在 `.myagent` 或其中不存在某个可选配置文件
- **THEN** 系统使用用户配置和内建默认值继续启动，且不得为了运行数据在 workspace 中创建 `.myagent`

### Requirement: workspace 运行数据必须稳定隔离

系统 MUST 根据规范化 workspace 绝对路径生成同时包含可读 basename 与稳定摘要的 `workspace-key`。同一物理 workspace 的等价路径表示 MUST 解析为同一 key，不同物理路径的同名 workspace MUST 解析为不同 key。

#### Scenario: 同一 Windows 路径使用不同表示

- **WHEN** 同一 workspace 通过不同盘符大小写、分隔符或可规范化路径表示启动
- **THEN** 系统生成相同 workspace key 并定位到同一项目应用数据目录

#### Scenario: 两个同名项目位于不同目录

- **WHEN** 用户分别启动 basename 相同但规范化绝对路径不同的两个 workspace
- **THEN** 系统生成不同 workspace key，且两者的日志、状态和产物不得互相可见

### Requirement: settings 必须采用统一作用域与优先级

系统 MUST 使用统一 settings 契约管理 permission default mode、`allow/ask/deny` 规则和 terminal default shell family。有效值优先级 MUST 为会话或 CLI 临时值、项目 `settings.local.json`、项目 `settings.json`、用户 `~/.myagent/settings.json`、内建默认值，并按该顺序从高到低覆盖。

#### Scenario: 项目本机设置覆盖共享项目设置

- **WHEN** 项目 `settings.json` 与 `settings.local.json` 对同一标量字段提供不同有效值
- **THEN** 当前项目使用 `settings.local.json` 的值，且不修改任一源文件

#### Scenario: 更新权限规则时保留终端设置

- **WHEN** 系统向指定 settings scope 持久化新的权限规则，而同一文件还包含 terminal 配置
- **THEN** 系统原子更新权限字段并完整保留不属于本次更新的 terminal 字段

#### Scenario: 项目配置请求危险权限模式

- **WHEN** 仓库可提交的项目 `settings.json` 请求无提示启用高风险 bypass 权限
- **THEN** 系统 MUST 按现有权限安全边界拒绝静默生效或要求显式用户确认，不能因配置作用域迁移而自动放宽权限

### Requirement: 持久化路径必须由统一解析结果提供

系统 MUST 在授权 workspace 确认后一次性解析项目配置路径、用户配置路径和全部项目运行数据路径。持久化消费者 MUST 使用该解析结果，不得依据当前进程目录或自行拼装产品目录。未注入时 MUST 抛出明确的运行时错误而非静默回退。

#### Scenario: 启动目录不同于授权 workspace

- **WHEN** 进程 cwd 与最终授权 workspace 不同
- **THEN** 所有项目配置和运行数据仍归属于授权 workspace 对应的路径，不得在 cwd 下产生第二份数据

#### Scenario: 用户应用数据根不可创建

- **WHEN** 当前项目的用户应用数据根无法创建或不可写
- **THEN** 系统通过控制台报告明确错误并停止需要持久化路径的会话初始化，不得静默回退到 workspace

### Requirement: 运行数据清理必须受分类边界限制

系统 MUST 分别治理诊断日志、持久状态、会话引用产物和临时数据。任何保留或清理操作 MUST 只作用于当前项目解析出的精确分类目录，不得将一种数据的保留策略应用到另一种数据。

#### Scenario: trace 保留清理

- **WHEN** trace 文件超过配置的保留边界
- **THEN** 系统只能清理当前项目 `logs/traces` 中符合条件的非活跃 trace，不得删除 audit、session、browser state、tool output 或 backup

#### Scenario: 会话仍引用完整工具输出

- **WHEN** 某个工具输出文件仍被保留的会话消息引用
- **THEN** 系统不得把该文件作为普通缓存按启动时间直接删除

### Requirement: 测试必须隔离应用数据根

自动化测试 MUST 显式使用临时 workspace 与临时应用数据根。测试不得通过真实 `process.cwd()` 或真实用户 home 创建 MyAgent 配置、日志、状态、产物或备份。

#### Scenario: 运行路径相关测试

- **WHEN** 单元、契约或集成测试初始化 logger、tracer、session、browser、tool output 或 backup 消费者
- **THEN** 所有文件只写入该测试拥有的临时根，测试结束后真实项目和真实用户应用目录没有新增产物

### Requirement: 旧目录必须零兼容退役

生产运行时 MUST 只读取新目录契约，不得双读、双写或回退到 `.agent`、workspace 内旧运行数据目录和 `.agent/allowed_commands.json`。系统 MUST 保留用户旧文件供人工处理，不得自动删除；启动时 MUST 仅检查已知旧目录形状，并且每个进程最多输出一次迁移警告。

#### Scenario: 仅存在旧目录

- **WHEN** workspace 仅存在旧 `.agent` 配置或旧 workspace `.myagent` 运行数据
- **THEN** 系统不加载旧数据，并按新目录契约使用用户配置或内建默认值，同时不得删除旧文件；本进程首次检测到时输出被忽略类别和人工迁移文档位置

#### Scenario: 同一进程重复初始化

- **WHEN** 同一进程中的 logger、session 或工具初始化多次触发旧布局检测
- **THEN** 系统最多输出一次面向用户的迁移警告，不得因每个消费者初始化而重复刷屏

#### Scenario: 只有新项目配置目录

- **WHEN** workspace `.myagent` 只包含 `settings.json`、`settings.local.json`、`rules/` 或 `skills/`
- **THEN** 系统不得把该目录误报为旧运行数据，也不得输出旧布局迁移警告
