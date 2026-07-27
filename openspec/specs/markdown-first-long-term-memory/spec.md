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

### Requirement: 记忆索引加载必须有界且可诊断

系统必须（MUST）在会话快照中最多读取 `MEMORY.md` 的前 200 行或前 20KB，以先达到的限制为准。发生截断时，系统必须（MUST）在投影给模型的内容中明确标记索引已截断，并且不得（MUST NOT）修改磁盘文件。加载器必须（MUST）诊断重复索引、断链主题、非法主题文件名、未知记忆类型和无效 frontmatter，但单个异常不得（MUST NOT）导致会话启动失败。对于文件存在且名称合法、但 frontmatter 缺失或类型未知的索引主题，加载器必须（MUST）保留索引标题和摘要以支持降级召回，同时不得（MUST NOT）把未知类型推断为四种合法类型之一。

#### Scenario: MEMORY.md 超出容量上限

- **WHEN** `MEMORY.md` 超过 200 行或 20KB
- **THEN** 加载器在先达到的边界停止读取
- **AND** 投影内容包含截断标记
- **AND** 磁盘上的 `MEMORY.md` 保持不变

#### Scenario: 索引包含无效条目

- **WHEN** `MEMORY.md` 同时包含有效条目、重复条目和不存在的主题引用
- **THEN** 有效条目仍可进入会话快照
- **AND** 加载器报告重复与断链诊断
- **AND** 会话启动继续进行

#### Scenario: 主题 frontmatter 缺失或类型未知

- **WHEN** 索引引用的主题文件存在且文件名合法，但 frontmatter 缺失或 `type` 未知
- **THEN** 加载器报告对应诊断
- **AND** 快照保留该索引条目的标题与摘要以支持降级召回
- **AND** 快照不为该条目推断合法记忆类型

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

### Requirement: 记忆维护必须复用标准文件工具

模型必须（MUST）使用现有目录列举、文件读取、文件写入和文件编辑工具维护 `memoryDir`，并继续受工具 effect、`PermissionMode`、路径授权和审计机制约束。系统不得（MUST NOT）增加专用 memory 工具或专用记忆模型。模型只应（SHOULD）保存跨会话仍有价值、可复用且相对稳定的信息；不得（MUST NOT）保存秘密、临时任务状态、可从权威文件直接获得的重复内容或未经核实的推测。

#### Scenario: 用户明确要求记住稳定偏好

- **WHEN** 用户明确要求记住一项不含敏感信息的稳定偏好
- **THEN** 模型使用标准文件工具更新对应主题和索引
- **AND** 每次工具调用仍经过正常权限判断与审计

#### Scenario: 内容不适合长期保存

- **WHEN** 候选内容是秘密、短期进度或未经核实的推测
- **THEN** 模型不将其写入长期记忆

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

### Requirement: 第一版不得执行自动抽取或语义检索

系统不得（MUST NOT）在对话外调用额外模型抽取记忆，也不得（MUST NOT）建立向量、关键词或分块检索流水线。记忆选择、更新与遗忘由主模型依据 system prompt 规则和标准文件工具完成。

#### Scenario: 普通会话结束

- **WHEN** 一次会话结束且用户没有触发任何标准文件工具写入
- **THEN** 系统不启动记忆抽取模型
- **AND** 系统不生成数据库记录、Embedding 或检索分块
