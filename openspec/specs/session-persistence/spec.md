# Session Persistence

## Purpose
提供底层会话数据的 JSON 静默持久化落盘，并提供 history 和 resume 等相关显式管理能力，以便跨重启恢复记忆上下文。

## Requirements

### Requirement: 会话上下文静默落盘
系统 MUST 在每轮交互完成或发生截断回滚后，将会话最新状态序列化并原子写入当前 workspace 对应的项目应用数据 `state/sessions/`。系统不得根据进程 cwd 选择会话目录，也不得在 workspace `.myagent` 下创建会话文件。

#### Scenario: 对话回合正常结束触发落盘

- **WHEN** 大模型流式内容输出完成且 Agent 即将重新显示输入提示符
- **THEN** 系统更新当前项目 `state/sessions/` 中对应 `sessionId` 的 JSON 快照为完整 `messageHistory`

#### Scenario: 用户执行回滚操作触发落盘

- **WHEN** 用户触发回滚并丢弃最近的对话轮次
- **THEN** 系统同步截断内存历史并原子覆盖当前项目中对应的会话 JSON 快照

### Requirement: 历史会话查看能力
系统 MUST 提供 `/history` 查看当前 workspace 已保存会话的能力。历史列表 MUST 使用当前 workspace 的统一项目数据路径，不得随 CLI 启动 cwd 改变。

#### Scenario: 唤出历史列表

- **WHEN** 用户在输入提示符下键入 `/history`
- **THEN** 系统列出当前项目应用数据 `state/sessions/` 下的会话文件，并展示 ID 与最后修改时间

#### Scenario: 其他项目存在会话

- **WHEN** 用户在项目 A 执行 `/history`，且项目 B 的数据目录中存在会话
- **THEN** 列表只显示项目 A 的会话，不得枚举或混入项目 B 的记录

### Requirement: 显式恢复历史会话
系统 MUST 提供 `resume` 能力以加载指定的持久化历史。

#### Scenario: 成功恢复会话
- **WHEN** 用户键入 `/resume <sessionId>`
- **THEN** 系统反序列化对应文件，覆盖当前内存上下文，并重绘终端展示已恢复的历史流

#### Scenario: 启动时保持幂等
- **WHEN** 用户冷启动 `myagent` 进程
- **THEN** 系统默认生成全新的 `sessionId` 与空上下文，不自动加载任何文件

### Requirement: 系统通知同步合并落盘
在会话执行过程中产生的系统通知消息，在 Hooks 执行期必须（MUST）先在暂存队列中积压。在当前交互 Loop 结束的确定同步上下文中，系统必须同步且强制地将它们刷入历史栈中并执行持久化保存，绝对不允许（SHALL NOT）在异步微任务或 `process.nextTick` 回调中执行可能被 Immer 脏写覆盖的操作。

#### Scenario: 多 Hook 连续执行期间收到后台系统通知
- **WHEN** 在 `BeforeToolSelection` 钩子处理结束且进入下一个 Hook `BeforeModel` 之间，有外部异步模块发出并追加了新的系统通知。
- **THEN** 该通知会被安全暂存至 `pendingNotifications` 队列中；在整个 `AgentLoop` 结束或 `SessionEnd` 后，系统同步且强制执行 `flushPendingNotifications`，将队列中的所有通知一次性同步追加至历史中并执行 `saveState()`，确保通知 100% 递达且绝不发生消息覆盖。
