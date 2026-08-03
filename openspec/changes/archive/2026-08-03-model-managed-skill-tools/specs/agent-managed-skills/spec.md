## ADDED Requirements

### Requirement: Skill 工具必须按目录读取写入分离职责

系统 MUST 提供 `skills_list`、`load_skill` 和 `skill_manage` 三个原生 Skill 工具。`skills_list` MUST 只浏览 Skill 元数据，`load_skill` MUST 读取一个 Skill 文件的完整内容，`skill_manage` MUST 继续承担全部六种受控写入动作。系统 MUST NOT 同时注册与 `load_skill` 职责重复的 `skill_view`。

#### Scenario: 模型先发现再读取 Skill

- **WHEN** 模型尚不知道准确 Skill 名称并调用 `skills_list`
- **THEN** 系统只返回可用于选择候选的目录元数据
- **THEN** 模型可以随后通过 `load_skill` 读取所选 Skill 的完整内容

#### Scenario: Skill 工具统一装配

- **WHEN** 系统使用当前 `SkillLibrary` 构建原生工具目录
- **THEN** Skill 工具按 `skills_list`、`load_skill`、`skill_manage` 的稳定顺序注册
- **THEN** 外部 MCP 工具不得以任一同名工具覆盖这些原生职责

### Requirement: skills_list 必须提供实时且可判定完整性的目录

`skills_list` MUST 从当前 `SkillLibrary` 的用户与项目合并活动视图返回实时目录，同名时只暴露项目版本。每个条目 MUST 包含 `name`、`description` 和 `source`，存在分类时 MUST 包含 `category`；描述超过 1024 个字符时 MUST 返回有界摘要并设置 `descriptionTruncated: true`。结果 MUST 按名称稳定排序，并提供筛选前的 `totalCount`、筛选后的 `matchedCount`、实际返回的 `returnedCount` 和布尔值 `complete`。

工具 MAY 接受去除首尾空白后的可选 `category` 精确筛选和大小写不敏感的 `query` 子串筛选，`query` MUST 同时检索名称、描述和分类。显式空筛选值、超过 256 个字符的筛选值和未知参数 MUST 被拒绝。工具 MUST NOT 提供 cursor、offset、limit、正文、磁盘绝对路径、usage 或所有权内部字段。

工具 MUST 声明独立于统一默认值的输出配额，并 MUST 按最终模型可见 `CallToolResult` 的外层序列化与内层文本转义后大小，在低于该配额的 UTF-8 字节预算内构造始终可解析的 JSON。当所有匹配项均已返回时 `complete` MUST 为 `true`；不能全部返回时 `complete` MUST 为 `false` 并返回 `refineHint`，不得让统一输出层把正常目录结果折叠成不可恢复的 head/tail 文本。合法空结果 MUST 返回空列表、正确计数和 `complete: true`，而不是错误。

#### Scenario: 列举合并后的实时 Skill

- **WHEN** 用户 Skill 与项目 Skill 中存在同名条目，且项目 Skill 还包含一个会话启动后新建的条目
- **THEN** `skills_list` 只返回同名项目版本并包含新建条目
- **THEN** 所有返回条目按名称稳定排序
- **THEN** `totalCount`、`matchedCount` 与 `returnedCount` 反映该完整结果且 `complete` 为 true

#### Scenario: 按分类与关键词筛选 Skill

- **WHEN** 模型使用合法的 `category` 和 `query` 调用 `skills_list`
- **THEN** 结果只包含分类精确匹配且名称、描述或分类包含关键词的条目
- **THEN** 没有匹配项时返回 `skills: []`、`matchedCount: 0`、`returnedCount: 0` 和 `complete: true`

#### Scenario: 目录超过单次输出预算

- **GIVEN** 当前筛选匹配的 Skill 元数据序列化后超过工具内部字节预算
- **WHEN** 模型调用 `skills_list`
- **THEN** 工具返回仍可解析且小于声明配额的 JSON，并使 `returnedCount` 小于 `matchedCount`
- **THEN** 结果设置 `complete: false` 和 `refineHint`，提示模型通过更具体的分类或关键词重新查询
- **THEN** 结果不得被替换为需要普通文件工具恢复的折叠输出

#### Scenario: 长描述使用有标记摘要

- **WHEN** 某个 Skill 的描述超过目录条目的摘要上限
- **THEN** `skills_list` 返回不超过 1024 个字符的描述摘要和 `descriptionTruncated: true`
- **THEN** 分类和关键词匹配仍基于原始元数据，而不是截断后的展示文本

#### Scenario: 列举目录不产生查看遥测

- **WHEN** `skills_list` 成功返回一个或多个 Skill 元数据
- **THEN** 任一 Skill 的 viewCount 和 lastViewedAt 均保持不变

#### Scenario: SkillLibrary 未装配

- **WHEN** Skill 工具执行时没有可用的 `SkillLibrary`
- **THEN** 工具明确失败且不得返回伪造或不完整的目录与读取结果

### Requirement: load_skill 必须返回完整结构化读取结果

`load_skill` MUST 保持 `name` 与可选 `file_path` 参数，并以结构化 JSON 返回 `name`、`description`、`source`、实际读取的相对 `file`、完整 `content` 和稳定排序的 `supportFiles`；存在分类时 MUST 返回 `category`。主文件的 `file` MUST 为 `SKILL.md`，支持文件 MUST 使用通过现有路径安全校验的 Skill 内相对路径。工具 MUST NOT 提供 offset、limit 或其他部分读取语义。

#### Scenario: 读取 Skill 主文件

- **WHEN** 模型调用 `load_skill` 并只提供合法 Skill 名称
- **THEN** 系统返回 `file: "SKILL.md"`、完整正文和该 Skill 的全部合法支持文件相对路径
- **THEN** 成功读取按既有遥测契约增加一次查看次数

#### Scenario: 读取 Skill 支持文件

- **WHEN** 模型以合法 `file_path` 调用 `load_skill`
- **THEN** 系统返回该支持文件的完整内容、规范化相对路径和同一 Skill 的支持文件列表
- **THEN** 绝对路径、路径穿越、符号链接或不存在的文件继续被拒绝

#### Scenario: 后台只列目录后尝试修改

- **WHEN** 后台模型调用 `skills_list` 后直接修改一个已有 Skill，但没有通过 `load_skill` 读取准确目标
- **THEN** `skills_list` 不产生任何读取凭证
- **THEN** 现有先读后写边界以 `read_before_write_required` 拒绝该修改
