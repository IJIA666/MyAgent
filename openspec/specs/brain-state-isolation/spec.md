## 新增需求

### 需求: 内存状态容器与持久化物理隔离
会话上下文（`SessionContext`）必须（MUST）作为纯粹的内存状态数据容器存在，禁止（MUST NOT）在类内部导入或调用任何文件系统读写相关的物理 IO API（如 `fs` 或 `path` 模块的读写操作）。会话状态的物理落盘与加载职责，应当（SHALL）交由专门的仓储服务（`ContextRepository`）独立承载。

#### 场景: 保存与恢复会话内存状态
- **WHEN** 触发会话状态的保存或加载操作时
- **THEN** 系统由 `ContextRepository` 执行对会话消息历史的物理 JSON 序列化读写，而 `SessionContext` 的内存状态不受 IO 副作用的影响，仅进行纯内存级的数据变更与重置

### 需求: 安全命令白名单服务化剥离
全局命令安全白名单（`allowed_commands.json`）的管理，必须（MUST）完全从 `SessionContext` 的职责中剥离，交由专门的 `SecurityService` 承载，该服务 must 负责管理白名单的磁盘 IO、内存缓存与状态校验。

#### 场景: 安全白名单校验与读写
- **WHEN** 智能体运行命令需要校验安全白名单，或管理层更新白名单时
- **THEN** 调用 `SecurityService` 从磁盘热重载或写入白名单文件，而 `SessionContext` 不感知任何白名单文件细节
