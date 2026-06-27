# context-adapter

## Purpose
提供多态化的大模型上下文注入、缓存组装与管理能力，将上下文拼接逻辑与 Session 主控制流解耦。

## Requirements

### Requirement: 上下文安全剥离与组装
系统必须提供标准的机制，将底层的大模型提示词缓存策略、拼装策略与 `SessionManager` 的主控制流彻底分离。必须能够接受一个基线历史数组和可选的临时上下文指令，并返回一个组装后的全新提示词消息序列供模型驱动层（LlmDriver）调用。

#### Scenario: 挂载临时技能上下文
- **WHEN** 调度器发起会话流，并且传入了当前生效的临时技能指令（`transientSkillContent`）时
- **THEN** 系统必须将该技能指令包裹在 `<transient_skill>` XML 标签内，并内嵌拼接在最后一条 `user` 消息的 `content` 尾部
- **THEN** 系统必须将拼接后的内容写入持久化会话历史中，并在终端 TUI 展现端将该 XML 消息块转换为可折叠展现的微件组件，不得破坏前缀缓存哈希单元的稳定性

#### Scenario: 常规上下文流转（无临时注入）
- **WHEN** 调度器发起会话流，且没有传入任何临时技能注入需求时
- **THEN** 系统必须原样返回当前基线上下文的安全浅/深拷贝，确保不对原始会话内容进行任何多余的修改与截断

#### Scenario: 挂载临时技能上下文（消减协议交错限制）
- **WHEN** 调度器发起多轮 ReAct 工具调用且传入了临时技能指令时
- **THEN** 由于临时技能直接内嵌在 user 消息内部，系统在组装时天然保障了 `assistant` (包含 `tool_calls`) 消息与对应的 `tool` 结果消息直接相邻，从而完全避免了协议交错的冲突

#### Scenario: 挂载临时技能上下文（无 User 消息兜底）
- **WHEN** 调度器发起组装请求，且传入了临时技能指令，但传入的基线会话历史（`baseHistory`）中不包含任何 `user` 角色的消息时
- **THEN** 系统必须自动构建一条包含临时技能 XML 标签的 user 消息追加至消息历史列表的末尾并持久化，且不得抛出异常

#### Scenario: 组装文件清单记忆（解决 Windows 绝对路径 Bug）
- **WHEN** 调度器发起组装上下文请求， 且传入了被剔除历史中大模型读写过的核心操作文件及操作状态列表时
- **THEN** 系统必须执行跨平台路径规范化， 将文件绝对路径解析转换为相对于工作区根目录的相对路径， 规避在 Windows 平台下强行拼接 `process.cwd()` 与绝对路径导致的路径非法 Bug
- **THEN** 系统必须将这些相对路径按读/写状态序列化为 `<recent_files_inventory>` 清单文本， 区分 `[READ]` 与 `[EDITED]`， 绝对不允许读取并注入文件的物理原文

#### Scenario: recentFiles 存在时的请求装配
- **WHEN** 上下文装配器 `DefaultContextAdapter` 检测到 `recentFiles` 集合存在并需要注入历史。
- **THEN** 系统在装配发送给大模型的历史消息时，必须确保 `system`/`developer` 消息仅位于序列第一位。当 `summary` 存在时，系统必须将最近文件索引数据物理追加合并到第一条 `user` 角色消息（Checkpoint 消息）的 `content` 末尾；当 `summary` 不存在时，系统必须通过生成一个独立的 `user` 角色消息专门包装 recentFiles 数据并推入历史，保持规范交替的消息序列。
