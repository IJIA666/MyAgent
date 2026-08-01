## MODIFIED Requirements

### Requirement: 会话上下文静默落盘

系统 MUST 在每轮交互完成或发生截断回滚后，将会话最新状态序列化并原子写入当前 workspace 对应的项目应用数据 `state/sessions/`。正式快照 MUST 包含完整消息历史，以及当前存在的挂起交互、Skill 学习延续状态和版本化 Skill 学习累计状态。系统不得根据进程 cwd 选择会话目录，也不得在 workspace `.myagent` 下创建会话文件。学习累计字段缺失或非法时 MUST fail-closed 按零累计恢复，且不得阻止其他合法会话状态加载。

#### Scenario: 对话回合正常结束触发落盘

- **WHEN** 大模型流式内容输出完成且 Agent 即将重新显示输入提示符
- **THEN** 系统更新当前项目 `state/sessions/` 中对应 `sessionId` 的 JSON 快照
- **THEN** 快照包含完整 `messageHistory` 和当前合法的 Skill 学习累计状态

#### Scenario: 用户执行回滚操作触发落盘

- **WHEN** 用户触发回滚并丢弃最近的对话轮次
- **THEN** 系统同步截断内存历史并原子覆盖当前项目中对应的会话 JSON 快照
- **THEN** 系统同时保存回滚结算后的 Skill 学习累计状态

#### Scenario: 恢复未达到阈值的学习累计

- **GIVEN** 会话快照包含合法、尚未达到阈值的 Skill 学习累计状态
- **WHEN** 用户显式恢复该会话
- **THEN** 系统恢复该累计值并供后续成功逻辑任务继续使用
- **THEN** 恢复过程不得把累计值误当作已经排队的后台任务

#### Scenario: 学习累计字段损坏

- **GIVEN** 会话快照的 Skill 学习累计字段版本未知、类型错误或包含负数
- **WHEN** 系统恢复该会话
- **THEN** 系统丢弃该字段、把学习累计恢复为零并记录去敏诊断
- **THEN** 合法的消息历史、挂起交互和其他会话字段继续恢复

#### Scenario: 旧快照没有学习累计字段

- **WHEN** 系统加载一个不包含 Skill 学习累计字段的旧快照
- **THEN** 会话按零累计正常恢复
- **THEN** 系统不得伪造历史计数或拒绝整个快照
