## Purpose

维护项目级局部规则与技能的系统提示词注入契约：规定规则文件的探测、上下文前置注入、手动热重载、多会话工作区物理隔离，以及技能自动重载的内容差异判断与会话快照冻结语义。
## Requirements
### Requirement: 局部规则文件的探测与自动加载
系统 SHALL 在会话启动时探测当前项目 `<workspace>/.myagent/rules/` 下的有效规则文件。文件存在时 MUST 按稳定顺序加载并缓存；目录不存在或没有有效文件时 SHALL 静默视为空项目规则集。系统不得读取旧 `.agent` 规则路径。

#### Scenario: 项目中存在合法的局部规则文件

- **WHEN** 会话启动且项目 `.myagent/rules/` 下存在一个或多个有效规则文件
- **THEN** 系统按稳定顺序读取内容并存入该会话的规则缓存，在缓存有效期内不重复读取相同内容

#### Scenario: 局部规则目录不存在

- **WHEN** 会话启动但项目 `.myagent/rules/` 不存在或为空
- **THEN** 系统正常完成初始化，项目规则上下文为空，且不得为了运行数据创建该目录

### Requirement: 规则在上下文历史中的前置动态注入
系统 SHALL 在每次与大模型交互时将局部规则动态注入至消息历史中。注入局部规则时，系统 MUST 将规则内容包裹在 `<project_rules>` XML 标签内，并直接内嵌拼接在最新一条 `user` 角色消息的 `content` 尾部。一旦拼装并发送，该注入后的内容 MUST 永久保留在该条历史消息中，不得在后续轮次中将其抹除或还原，以保护前缀缓存哈希一致性。在终端 TUI 呈现和日志记录等视觉展现层，系统 MUST 将该 XML 标签及其包裹的数据解析转换为支持可折叠展开的精美卡片微件（Widget），折叠隐藏冗长规则以维持界面整洁，点击可展开。

#### Scenario: 向含有用户消息的历史记录中注入局部规则
- **WHEN** LLM 交互发生，且当前消息历史中包含至少一条 `user` 消息，且局部规则内容非空
- **THEN** 局部规则内容被包裹在 `<project_rules>` 标签中，内嵌拼接在最后一条 `user` 消息的 `content` 尾部，其余历史消息顺序与内容保持不变，并永久保留在该历史节点中

#### Scenario: 无用户消息时的边界注入
- **WHEN** LLM 交互发生，但消息历史中不包含任何 `user` 消息（如会话刚刚启动），且局部规则内容非空
- **THEN** 系统必须自动构建一条包含局部规则 XML 标签的 `user` 消息，追加到消息历史列表的末尾并持久化，且不得抛出异常

### Requirement: 规则的手动热重载与缓存清除
系统 SHALL 对外暴露规则重载方法。当外部调用该方法时，系统 MUST 立即清空内存中锁定的规则缓存（包括全局规则与局部规则），并在下一次与大模型交互前重新读取磁盘文件，以将最新的规则内容注入后续交互。

#### Scenario: 执行手动重载指令
- **WHEN** 规则重载方法被调用，且磁盘上的规则文件已更新
- **THEN** 内存中的规则文件缓存被立即清空，在随后的 LLM 交互时重新触发磁盘读取，将更新后的规则内容注入上下文

### Requirement: 规则与技能加载的多会话工作区物理隔离
系统在运行时针对不同 `SessionContext` 的规则与技能扫描、解析路径和缓存 MUST 保持实例级隔离。每个实例 MUST 使用自身规范化 workspace 对应的项目配置路径，且不得共享可变的全局规则或技能缓存。

#### Scenario: 并发加载不同工作区技能

- **WHEN** Session A 与 Session B 分别拥有不同规范化 workspace，并同时初始化规则与技能
- **THEN** A 只能加载 A 的 `.myagent/rules` 与 `.myagent/skills`，B 只能加载 B 的对应目录，两个项目缓存互不污染

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

### Requirement: RuleManager watcher 必须与拥有者生命周期一致

`RuleManager` 必须（MUST）保存 watcher 句柄并提供幂等关闭方法；主会话结束时必须释放 timer、watcher 与候选事件状态。

#### Scenario: 主会话关闭
- **WHEN** `SessionManager.close()` 执行
- **THEN** 当前 RuleManager 必须关闭 watcher、清理 debounce timer，且关闭后不得再更新该会话的系统提示词

#### Scenario: 重复关闭
- **WHEN** 同一 RuleManager 被多次调用 close
- **THEN** 关闭必须幂等，不得抛错或重复操作已释放句柄

