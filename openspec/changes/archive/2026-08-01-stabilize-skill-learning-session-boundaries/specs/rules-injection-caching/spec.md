## MODIFIED Requirements

### Requirement: 技能自动重载必须以内容差异为准

项目技能 watcher MUST 监听当前项目 `<workspace>/.myagent/skills/`，并把文件系统事件视为候选信号。系统 MUST 过滤有效 `SKILL.md`、比较稳定内容摘要，只有新增、删除或内容实际变化时才刷新 SkillLibrary 的实时发现状态。每个活跃会话 MUST 在创建 `RuleManager` 时冻结用于系统提示词的 Skill 元数据快照；后续自动重载 MUST NOT 替换该快照、更新该会话系统提示词或改写历史中的首条系统消息。变更后的 Skill 元数据 MUST 从随后创建的新会话开始出现在系统提示词中。

#### Scenario: 无内容变化的文件事件

- **WHEN** watcher 收到项目 `.myagent/skills/` 下的文件事件，但有效技能主体摘要与缓存一致
- **THEN** 系统不得刷新 SkillLibrary 实时缓存、不得更新任何会话系统提示词，也不得输出误导性的 INFO 变更日志

#### Scenario: SKILL.md 内容真实变化

- **WHEN** 某个有效 `SKILL.md` 新增、删除或内容摘要变化
- **THEN** 系统必须在防抖后刷新 SkillLibrary 实时发现状态，并记录具体变更类型的结构化事件
- **THEN** 已存在会话的 Skill 元数据快照、系统提示词内容和系统提示词哈希保持不变

#### Scenario: 新会话读取已变化的 Skill

- **GIVEN** SkillLibrary 已经确认某个 Skill 新增、删除或内容发生变化
- **WHEN** 系统随后创建一个新会话及其 RuleManager
- **THEN** 新会话使用变更后的 Skill 元数据构建系统提示词
- **THEN** 更早创建的会话仍保留各自原有快照

#### Scenario: 活跃会话按名称读取已有 Skill

- **GIVEN** 活跃会话的系统提示词仍列出某个已有 Skill
- **WHEN** 该 Skill 正文在磁盘上更新后，模型通过 `load_skill` 按名称读取
- **THEN** `load_skill` 从实时 SkillLibrary 返回最新正文
- **THEN** 该读取不得替换活跃会话的 Skill 元数据快照或系统提示词

#### Scenario: 无关派生文件变化

- **WHEN** 项目技能目录中的缓存、临时文件或非技能主体文件产生事件
- **THEN** 系统必须忽略该事件，不得触发完整技能重载

#### Scenario: watcher 返回相对技能路径

- **WHEN** watcher 对项目 skills 根下的 `example/SKILL.md` 返回相对文件名
- **THEN** 系统必须把该文件识别为候选技能主体，不得要求回调文件名包含 `.myagent/skills/` 前缀

#### Scenario: watcher 未提供文件名

- **WHEN** 底层平台发出技能目录变更事件但没有提供文件名
- **THEN** 系统必须在当前防抖窗口安排一次项目 skills 全量摘要重扫
- **THEN** 只有内容实际变化时才刷新 SkillLibrary 实时状态，且不得改写已有会话的系统提示词
