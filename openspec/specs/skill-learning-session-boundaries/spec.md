# skill-learning-session-boundaries Specification

## Purpose
TBD - created by archiving change stabilize-skill-learning-session-boundaries. Update Purpose after archive.
## Requirements
### Requirement: 逻辑学习轨迹必须包含触发任务的用户输入

系统 MUST 由用户任务入口显式确定逻辑学习轨迹起点。交给后台 Skill 复盘的轨迹 MUST 从触发当前任务的原始用户消息开始，按原顺序包含属于该任务的助手消息、工具调用和工具结果，并 MUST NOT 包含更早任务或无关后台事件。系统 MUST NOT 通过索引减一或反向搜索角色来猜测该起点。

#### Scenario: 正常用户任务完成

- **WHEN** 用户提交一条消息，主 Agent 完成若干工具调用并返回最终回复
- **THEN** 复盘轨迹的第一条消息是该用户消息
- **THEN** 该消息之后属于本任务的助手和工具消息按原顺序保留

#### Scenario: 当前任务之前已有历史

- **WHEN** 会话已有多个已完成任务，用户又提交一个达到复盘条件的新任务
- **THEN** 复盘轨迹只从新任务的用户消息开始
- **THEN** 更早任务的用户、助手和工具消息不得进入本次复盘输入

#### Scenario: 等待用户交互后恢复完成

- **GIVEN** 当前逻辑任务因交互工具暂停并保存了学习延续状态
- **WHEN** 用户回答后任务恢复并最终完成
- **THEN** 复盘轨迹包含最初用户任务、等待前消息、交互工具回答和恢复后消息
- **THEN** 各段消息按发生顺序只出现一次

#### Scenario: 内部生成没有用户任务边界

- **WHEN** 系统启动一次不属于用户任务或交互恢复的内部生成，且没有提供合法学习轨迹起点
- **THEN** 该运行不得推进 Skill 学习计数或安排后台复盘
- **THEN** 系统记录去敏的 `missing_learning_boundary` 诊断

#### Scenario: 学习轨迹索引越界

- **WHEN** RunEnd 收到的学习轨迹起点小于零、大于结束索引或超出当前历史
- **THEN** 系统 fail-closed 丢弃本次学习证据
- **THEN** 系统不得通过修正、减一或角色搜索继续复盘

### Requirement: Skill 复盘结果必须通过只展示事件交付

后台 Skill 复盘的成功或暂存结果 MUST 作为非持久化、仅面向宿主展示的结构化事件交付。该事件 MUST 基于真实成功的 `skill_manage` 结果生成，MUST NOT 作为任意角色消息写入主会话历史、会话快照或下一次模型请求。

#### Scenario: 主会话空闲时后台写入成功

- **WHEN** 后台复盘在主会话空闲时成功创建或更新一个 Skill
- **THEN** 宿主收到包含状态、动作和 Skill 名称的展示事件
- **THEN** 主会话历史长度和持久化消息内容保持不变

#### Scenario: 主会话忙碌时后台写入成功

- **WHEN** 后台复盘结果在另一轮主 Agent 推理期间抵达
- **THEN** 展示事件可以立即或由宿主缓冲渲染
- **THEN** 该结果不得进入 `pendingNotifications`，也不得在主循环结束时刷入历史

#### Scenario: 模型自述写入但工具没有成功

- **WHEN** 后台模型声称已经保存 Skill，但没有对应的成功或暂存工具结果
- **THEN** 系统不得发送成功展示事件
- **THEN** 主会话上下文保持不变

### Requirement: Skill 复盘事件不得自动唤醒主 Agent

Skill 复盘展示事件 MUST NOT 设置主会话的异步通知待处理标记，MUST NOT 增加自动唤醒计数，也 MUST NOT 启动 `runInternalGeneration()`。前台回合的 `complete` 生命周期 MUST 独立于后台复盘事件抵达时间。

#### Scenario: 复盘结果在前台回复后抵达

- **WHEN** 主 Agent 已发送最终回复和 `complete`，随后后台复盘完成
- **THEN** 系统只交付展示事件
- **THEN** 不产生新的模型请求或第二个前台推理生命周期

#### Scenario: 复盘结果在前台收尾期间抵达

- **WHEN** 后台复盘事件在主 Agent 设置最终回复之后、发出 `complete` 之前抵达
- **THEN** 当前前台回合仍正常发出且只发出一次 `complete`
- **THEN** 系统不得因 Skill 事件安排延迟自动唤醒

#### Scenario: 其他异步功能请求唤醒

- **WHEN** 非 Skill 复盘功能通过现有通用异步事件通道请求主 Agent 处理
- **THEN** 该功能继续遵循原有缓冲和自动唤醒契约
- **THEN** Skill 复盘的只展示限制不得全局禁用通用异步事件机制

