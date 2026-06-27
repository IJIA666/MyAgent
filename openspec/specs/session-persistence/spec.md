# Session Persistence

## Purpose
提供底层会话数据的 JSON 静默持久化落盘，并提供 history 和 resume 等相关显式管理能力，以便跨重启恢复记忆上下文。

## Requirements

### Requirement: 会话上下文静默落盘
系统 MUST 在每轮交互完成或发生截断回滚后，自动将会话的最新状态序列化并写入本地持久化目录。

#### Scenario: 对话回合正常结束触发落盘
- **WHEN** 大模型的流式内容输出并打印完毕，Agent 再次显示用户输入提示符前
- **THEN** 系统更新对应 `sessionId` 的 `.json` 文件内容为完整的 `messageHistory` 数组

#### Scenario: 用户执行回滚操作触发落盘
- **WHEN** 用户触发双击 ESC 回滚操作，丢弃了最近的对话轮次
- **THEN** 系统不仅内存截断，并且应同步覆盖磁盘中的 `.json` 会话文件

### Requirement: 历史会话查看能力
系统 MUST 提供供用户查看已保存的会话记录列表的指令 `/history`。

#### Scenario: 唤出历史列表
- **WHEN** 用户在输入提示符下键入 `/history`
- **THEN** 系统列出 `.myagent/sessions` 下的会话文件，展示其 ID 与最后修改时间

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
