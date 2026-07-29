## Purpose

定义 SessionContext 的纯内存职责以及会话状态与持久仓储之间的物理隔离。该规范防止领域状态直接执行文件 IO，并确保权限更新按 session 与持久 settings 的真实作用域提交。

## Requirements

### Requirement: 内存状态容器与持久化物理隔离
会话上下文（`SessionContext`）必须（MUST）作为纯粹的内存状态数据容器存在，禁止（MUST NOT）在类内部导入或调用任何文件系统读写相关的物理 IO API（如 `fs` 或 `path` 模块的读写操作）。会话状态的物理落盘与加载职责，应当（SHALL）交由专门的仓储服务（`ContextRepository`）独立承载。

#### Scenario: 保存与恢复会话内存状态
- **WHEN** 触发会话状态的保存或加载操作时
- **THEN** 系统由 `ContextRepository` 执行对会话消息历史的物理 JSON 序列化读写，而 `SessionContext` 的内存状态不受 IO 副作用的影响，仅进行纯内存级的数据变更与重置

### Requirement: 会话权限状态与持久设置物理隔离
当前会话的 `PermissionSessionState` 必须（MUST）只维护内存中的 mode、rules、additional directories 和 stateVersion。需要持久化的 user、project 或 projectLocal 更新必须由 `PermissionSettingsStore` 与 settings repository 通过原子 CAS 写入，`SessionContext` 不得直接执行配置文件 IO。

#### Scenario: 会话规则更新与持久设置写入
- **WHEN** 用户选择只对当前 session 生效的 ApprovalAction
- **THEN** 系统只更新当前 `PermissionSessionState`，不得写入用户或项目 settings
- **WHEN** 用户通过受约束管理入口显式修改未来默认或持久规则
- **THEN** `PermissionSettingsStore` 必须先完成磁盘原子提交，再更新当前会话快照
