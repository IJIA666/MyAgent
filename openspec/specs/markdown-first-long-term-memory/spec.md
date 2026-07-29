# Markdown-first Long-term Memory

## Purpose

定义项目级 Markdown 长期记忆的存储、写入、召回、诊断和遗忘契约，确保模型能够使用标准文件工具维护透明、可治理且跨会话可复用的记忆。
## Requirements
### Requirement: 项目长期记忆必须采用机器本地的 Markdown 目录

系统必须（MUST）通过 `ApplicationPaths.memoryDir` 将当前项目的长期记忆定位到 `<projectDataDir>/memory/`，其中 `<projectDataDir>` 为 `~/.myagent/projects/<workspace-key>/`。该目录必须（MUST）使用 `MEMORY.md` 作为有界索引，并允许（MAY）使用 `topics/*.md` 保存主题正文。系统不得（MUST NOT）为长期记忆引入数据库、向量库、Embedding、文本分块或派生检索索引。

#### Scenario: 首次进入没有记忆的项目

- **WHEN** 当前项目的 `memoryDir` 或 `MEMORY.md` 不存在
- **THEN** 系统将长期记忆视为空
- **AND** 系统不因读取记忆而创建目录或文件

#### Scenario: 两个工作区具有不同的 workspace-key

- **WHEN** 两个工作区分别解析其 `ApplicationPaths.memoryDir`
- **THEN** 两者位于各自的 `<projectDataDir>/memory/`
- **AND** 任一工作区的记忆不会写入工作区内的 `.myagent/` 配置目录

### Requirement: 主题文件必须遵循固定类型与确定性命名

每个主题文件必须（MUST）位于 `topics/` 的单层目录中，并使用匹配 `[a-z0-9]+(?:-[a-z0-9]+)*\.md` 的 ASCII kebab-case 文件名。主题 frontmatter 必须（MUST）包含 `name`、`description` 和 `type`，其中 `type` 只能（MUST）为 `user`、`feedback`、`project` 或 `reference`。稳定的记忆机制提示词必须（MUST）向模型提供包含这三个字段的完整 frontmatter 模板和 `MEMORY.md` 单行索引示例。创建新主题前，模型必须（MUST）先检查并复用语义相同的现有主题；确需创建时，必须（MUST）先写入主题文件，重新读取并核对格式及事实忠实性，再更新 `MEMORY.md` 索引。模型不得（MUST NOT）向记忆正文补充用户未确认的原因、工具、数字、技术栈或项目细节。

#### Scenario: 保存新的项目约定

- **WHEN** 模型确认一项稳定的项目约定尚无对应主题
- **THEN** 模型创建符合 kebab-case 规则的 `topics/<slug>.md`
- **AND** frontmatter 的 `type` 为 `project`
- **AND** 主题文件写入成功后才更新 `MEMORY.md`

#### Scenario: 候选主题与现有主题同义

- **WHEN** 模型发现候选记忆与已有主题语义相同
- **THEN** 模型更新或复用已有主题
- **AND** 不创建仅名称不同的重复主题

### Requirement: 记忆机制规则与记忆内容必须分层注入

系统必须（MUST）将稳定的记忆读写规则放入 system prompt，并将当前会话冻结的 `MEMORY.md` 快照作为独立、非持久化的 `role: user` 请求投影注入模型请求。该投影必须（MUST）位于连续 system 消息之后、持久化会话消息之前，始终包含当前项目实际的绝对 `memoryDir`，并转义来自索引的边界字符；不得（MUST NOT）拼接到真实用户消息或 system prompt 中，也不得（MUST NOT）写入 `SessionContext` 历史。最终上下文预算必须（MUST）计入该投影。

#### Scenario: 会话存在有效记忆索引

- **WHEN** 模型请求组装当前会话上下文
- **THEN** system prompt 包含稳定的记忆机制规则
- **AND** 冻结的索引快照以独立 `role: user` 消息进入本次请求
- **AND** 该消息不进入持久化历史

#### Scenario: 当前项目没有记忆

- **WHEN** 会话快照为空
- **THEN** 系统注入包含实际绝对 `memoryDir` 和空索引说明的最小记忆投影
- **AND** 模型能够据此使用标准文件工具创建第一份记忆

### Requirement: 忘记操作必须先修改事实源再修复索引

当用户明确要求忘记某项内容时，模型必须（MUST）先从主题事实源中删除对应内容，再更新 `MEMORY.md`。若主题仍包含其他有效记忆，则必须（MUST）保留主题文件并更新其摘要；若主题已无有效内容，则必须（MUST）删除主题文件及其索引项。模型必须（MUST）从当前回合起停止依赖已被要求忘记的内容，但不得（MUST NOT）声称能够从既有会话历史中物理擦除已出现的文本。

#### Scenario: 忘记主题中的单项内容

- **WHEN** 用户要求忘记的内容只占主题的一部分
- **THEN** 模型先编辑主题文件删除该内容
- **AND** 保留主题文件并按需更新索引摘要

#### Scenario: 忘记整个主题

- **WHEN** 用户要求忘记主题的全部内容
- **THEN** 模型先删除主题文件
- **AND** 再删除 `MEMORY.md` 中对应的索引项

### Requirement: 会话内记忆快照必须具有明确刷新边界

系统必须（MUST）在会话启动时创建一次不可变记忆快照。普通记忆文件写入不得（MUST NOT）隐式刷新当前快照；只有成功完成上下文压缩后才允许（MAY）从磁盘重新加载快照。模型必须（MUST）把标准文件工具的即时读取结果与会话启动快照区分开。

#### Scenario: 会话中写入新的记忆

- **WHEN** 模型在普通回合中成功更新记忆文件
- **THEN** 当前会话的自动记忆投影保持原快照
- **AND** 后续请求不因累计写入次数自动刷新

#### Scenario: 模型需要核对刚写入的内容

- **WHEN** 模型需要在刷新边界前核对磁盘上的最新记忆
- **THEN** 模型可以使用标准读取工具查看文件
- **AND** 该即时读取不替换会话快照

### Requirement: Auto Memory Index Is Loaded Automatically and Bounded

`autoMemoryEnabled` MUST 默认开启。会话启动时，记忆子系统 MUST 由宿主直接读取 `MEMORY.md` 前 200 行或前 25KB（先到者为准），并作为低权限 context 自动注入；该宿主读取 MUST NOT 进入工具审批。

#### Scenario: A session starts with an index

- **WHEN** 当前项目启用 Auto Memory 且 `MEMORY.md` 存在
- **THEN** 会话 MUST 自动注入有界索引
- **THEN** 用户 MUST NOT 收到 Read 工具审批

#### Scenario: An index exceeds a limit

- **WHEN** `MEMORY.md` 超过 200 行或 25KB
- **THEN** 启动投影 MUST 只包含限制内的完整内容
- **THEN** 诊断 MUST 说明截断原因和限制

#### Scenario: Topic files exist

- **WHEN** `MEMORY.md` 引用 topic 文件
- **THEN** 会话启动 MUST NOT 打开或注入 topic 内容
- **THEN** Agent MUST 按需通过标准文件工具读取

### Requirement: Default Memory Root Has Claude-Style File Permission

文件权限层 MUST 明确识别当前项目默认 Auto Memory 根和 Agent memory 根。显式 deny/hard cap MUST 先评估；随后默认根内的 Read/Edit/Write 以及映射为 Write 的 `createDirectory` MUST 在危险目录检查和普通 ask 之前 allow。

#### Scenario: Manual writes a topic in the default root

- **WHEN** 当前模式为 Manual，Agent 在默认 memory 根内创建 `topics/`、写 topic 或更新 `MEMORY.md`
- **THEN** 系统 MUST 直接允许
- **THEN** 系统 MUST NOT 弹审批或切换到 Accept edits on

#### Scenario: A memory write targets a sibling directory

- **WHEN** 目标位于 projectDataDir 中但不在精确 memory 根内
- **THEN** memory allow MUST NOT 生效

#### Scenario: A destructive memory operation is requested

- **WHEN** Agent 请求删除、移动、执行 memory 文件或修改 settings/instructions
- **THEN** 系统 MUST 按相应高风险或 protected 策略评估
- **THEN** Read/Edit/Write 特例 MUST NOT 泛化到该操作

### Requirement: Custom Auto Memory Directory Follows Claude Boundaries

`autoMemoryDirectory` MUST 只接受规范化绝对路径或 home-relative 路径。项目/local 来源 MUST 在工作区获得信任后生效。自定义根内读取 MUST 允许；写入 MUST 进入普通权限流程，除非存在显式 allow rule。

#### Scenario: A custom root is read

- **WHEN** 可信配置选择自定义 memory 根，Agent 按需读取其中 topic
- **THEN** 文件权限层 MUST 允许读取

#### Scenario: A custom root is written without a rule

- **WHEN** Manual 模式下 Agent 写入自定义 memory 根且没有显式 allow rule
- **THEN** 系统 MUST 返回 `ask`

#### Scenario: An untrusted project config selects a custom root

- **WHEN** 未建立工作区信任的项目/local 配置指定工作区外 memory 根
- **THEN** 系统 MUST 忽略该覆盖并记录去敏告警

### Requirement: Background Memory Agent Uses a Restricted Tool Policy

后台记忆整理 Agent MUST 使用独立 caller 和与 Claude `createAutoMemCanUseTool()` 等价的工具策略：允许 Read/Grep/Glob、只读 Bash，以及仅限 memory 根的 Edit/Write；其他工具 MUST 拒绝。

#### Scenario: The background agent writes memory

- **WHEN** 后台记忆 Agent 编辑精确 memory 根内文件
- **THEN** 操作 MUST 允许并记录 `extract_memories` 等独立审计来源

#### Scenario: The background agent writes outside memory

- **WHEN** 后台记忆 Agent 尝试在 memory 根外 Edit/Write、执行有副作用 Shell、调用 MCP 或发送外部消息
- **THEN** 受限工具策略 MUST 拒绝

### Requirement: Memory Operation Trust and Content Trust Are Separate

默认 memory 根的文件操作 allow MUST NOT 提升 memory 内容的指令权重。memory MUST 保持 provenance、可审计、可撤销，并与 instructions、权限设置、caller identity 和系统策略隔离。

#### Scenario: Memory contains a permission instruction

- **WHEN** `MEMORY.md` 声称应启用 bypass、扩大目录或忽略 host policy
- **THEN** 权限系统 MUST 忽略该内容作为授权来源

#### Scenario: An untrusted channel produces a candidate memory

- **WHEN** 网页、邮件、共享聊天或未知 MCP 内容触发记忆候选
- **THEN** 候选 MUST 进入带 provenance 的暂存状态
- **THEN** 未通过记忆策略前 MUST NOT 作为激活的稳定事实注入
