## MODIFIED Requirements

### Requirement: 项目长期记忆必须采用机器本地的 Markdown 目录

系统必须（MUST）通过 `ApplicationPaths.memoryDir` 将当前项目的长期记忆定位到 `<projectDataDir>/memory/`，其中 `<projectDataDir>` 为 `~/.myagent/projects/<workspace-key>/`。该目录必须（MUST）使用 `MEMORY.md` 作为有界索引，主题正文以 `<slug>.md` 平铺保存于该目录根下（与 `MEMORY.md` 同层，不再使用 `topics/` 子目录）。系统不得（MUST NOT）为长期记忆引入数据库、向量库、Embedding、文本分块或派生检索索引。

#### Scenario: 首次进入没有记忆的项目

- **WHEN** 当前项目的 `memoryDir` 或 `MEMORY.md` 不存在
- **THEN** 系统将长期记忆视为空
- **AND** 系统不因读取记忆而创建目录或文件

#### Scenario: 两个工作区具有不同的 workspace-key

- **WHEN** 两个工作区分别解析其 `ApplicationPaths.memoryDir`
- **THEN** 两者位于各自的 `<projectDataDir>/memory/`
- **AND** 任一工作区的记忆不会写入工作区内的 `.myagent/` 配置目录

### Requirement: 主题文件必须遵循固定类型与确定性命名

每个主题文件必须（MUST）位于 `memoryDir` 根的单层目录中（与 `MEMORY.md` 同层平铺），并使用匹配 `[a-z0-9]+(?:-[a-z0-9]+)*\.md` 的 ASCII kebab-case 文件名。主题文件名不得（MUST NOT）为 `memory.md`（大小写不敏感比较；该名与索引 `MEMORY.md` 在大小写不敏感文件系统上指向同一文件，属于保留名）。主题 frontmatter 必须（MUST）包含 `name`、`description` 和 `type`，其中 `type` 只能（MUST）为 `user`、`feedback`、`project` 或 `reference`。稳定的记忆机制提示词必须（MUST）向模型提供包含这三个字段的完整 frontmatter 模板、`MEMORY.md` 单行索引示例以及保留名禁令。创建新主题前，模型必须（MUST）先检查并复用语义相同的现有主题；确需创建时，必须（MUST）先写入主题文件，重新读取并核对格式及事实忠实性，再更新 `MEMORY.md` 索引。模型不得（MUST NOT）向记忆正文补充用户未确认的原因、工具、数字、技术栈或项目细节。

#### Scenario: 保存新的项目约定

- **WHEN** 模型确认一项稳定的项目约定尚无对应主题
- **THEN** 模型创建符合 kebab-case 规则的 `<slug>.md`（位于 `memoryDir` 根下）
- **AND** frontmatter 的 `type` 为 `project`
- **AND** 主题文件写入成功后才更新 `MEMORY.md`

#### Scenario: 候选主题与现有主题同义

- **WHEN** 模型发现候选记忆与已有主题语义相同
- **THEN** 模型更新或复用已有主题
- **AND** 不创建仅名称不同的重复主题

#### Scenario: 保留名 memory.md 不可作为主题名

- **WHEN** 索引引用 `memory.md`（任意大小写变体），或模型试图以该名创建主题
- **THEN** 加载器将 `memory.md` 记为无效文件名，不进入主题列表
- **AND** 权限层对大小写折叠等于 `memory.md` 且原形字符串不等于 `MEMORY.md` 的写/建目标返回 `deny`
- **AND** 对原形 `MEMORY.md` 的索引更新写入仍正常放行

### Requirement: Default Memory Root Has Claude-Style File Permission

文件权限层 MUST 明确识别当前项目默认 Auto Memory 根和 Agent memory 根。显式 deny/hard cap MUST 先评估；随后默认根内的 Read/Edit/Write 以及映射为 Write 的 `createDirectory` MUST 在危险目录检查和普通 ask 之前 allow。

#### Scenario: Manual writes a topic in the default root

- **WHEN** 当前模式为 Manual，Agent 在默认 memory 根内写主题文件或更新 `MEMORY.md`
- **THEN** 系统 MUST 直接允许
- **THEN** 系统 MUST NOT 弹审批或切换到 Accept edits on

#### Scenario: A memory write targets a sibling directory

- **WHEN** 目标位于 projectDataDir 中但不在精确 memory 根内
- **THEN** memory allow MUST NOT 生效

#### Scenario: A destructive memory operation is requested

- **WHEN** Agent 请求删除、移动、执行 memory 文件或修改 settings/instructions
- **THEN** 系统 MUST 按相应高风险或 protected 策略评估
- **THEN** Read/Edit/Write 特例 MUST NOT 泛化到该操作
