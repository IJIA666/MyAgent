## ADDED Requirements

### Requirement: 技能自动重载必须以内容差异为准

技能目录 watcher 必须（MUST）把文件系统事件视为候选信号，而不是已确认变更。系统必须过滤技能主体文件并比较稳定内容摘要，只有新增、删除或内容实际变化时才替换缓存和更新系统提示词。

#### Scenario: 无内容变化的文件事件

- **WHEN** watcher 收到 `.agent/skills` 下的文件系统事件，但技能主体摘要与缓存一致
- **THEN** 系统不得刷新技能缓存、不得更新系统提示词，也不得输出“技能文件已变动”的 INFO 结论

#### Scenario: SKILL.md 内容真实变化

- **WHEN** 某个技能的 `SKILL.md` 新增、删除或内容摘要变化
- **THEN** 系统必须在防抖后执行一次缓存替换，更新系统提示词，并记录具体变更类型的结构化事件

#### Scenario: 无关派生文件变化

- **WHEN** 技能目录中的缓存、临时文件或非技能主体文件产生事件
- **THEN** 系统必须忽略该事件，不得触发完整技能重载

### Requirement: RuleManager watcher 必须与拥有者生命周期一致

`RuleManager` 必须（MUST）保存 watcher 句柄并提供幂等关闭方法；主会话和短生命周期子智能体结束时必须释放 timer、watcher 与候选事件状态。

#### Scenario: 主会话关闭

- **WHEN** `SessionManager.close()` 执行
- **THEN** 当前 RuleManager 必须关闭 watcher、清理 debounce timer，且关闭后不得再更新该会话的系统提示词

#### Scenario: 记忆自省子智能体结束

- **WHEN** `MemoryService` 创建的短生命周期子智能体完成、失败或超时
- **THEN** 其 RuleManager 必须在 finally 中关闭；默认应允许该类短生命周期实例禁用 watcher

#### Scenario: 重复关闭

- **WHEN** 同一 RuleManager 被多次调用 close
- **THEN** 关闭必须幂等，不得抛错或重复操作已释放句柄

