## MODIFIED Requirements

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
