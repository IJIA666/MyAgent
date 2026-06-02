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
