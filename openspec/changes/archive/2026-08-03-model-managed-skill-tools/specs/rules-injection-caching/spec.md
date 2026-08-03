## ADDED Requirements

### Requirement: 冻结提示词与实时 Skill 目录必须并存

系统 MUST 保留活跃会话创建时冻结的 `<available_skills>` 元数据快照，并同时允许 `skills_list` 从该会话的实时 `SkillLibrary` 查询当前目录。调用 `skills_list` MUST NOT 重建系统提示词、改写历史消息或改变既有提示词哈希；实时目录与启动快照不同时，系统 MUST 把前者作为主动查询的当前事实，把后者继续作为本会话的稳定提示词前缀。

#### Scenario: 活跃会话中新增 Skill

- **GIVEN** 一个活跃会话已经冻结了启动时的 Skill 提示词快照
- **WHEN** `SkillLibrary` 确认一个 Skill 新增且模型随后调用 `skills_list`
- **THEN** 目录结果包含该新 Skill
- **THEN** 活跃会话原有系统提示词内容与哈希保持不变

#### Scenario: 活跃会话中删除或覆盖 Skill

- **GIVEN** 活跃会话的 `<available_skills>` 仍保留启动时条目
- **WHEN** 实时合并视图删除该条目或由项目 Skill 覆盖同名用户 Skill
- **THEN** `skills_list` 返回当前删除或覆盖后的目录事实
- **THEN** 系统不得为同步目录而修改已经发送的提示词或历史

#### Scenario: 目录查询后读取新 Skill

- **WHEN** 模型通过 `skills_list` 发现启动快照中不存在的新 Skill，并随后调用 `load_skill`
- **THEN** `load_skill` 从同一实时 `SkillLibrary` 返回该 Skill 的当前完整内容
- **THEN** 两次工具调用均不得触发系统提示词重建
