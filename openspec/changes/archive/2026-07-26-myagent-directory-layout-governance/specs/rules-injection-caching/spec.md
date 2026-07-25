## MODIFIED Requirements

### Requirement: 局部规则文件的探测与自动加载

系统必须在会话启动时探测当前项目 `<workspace>/.myagent/rules/` 下的有效规则文件。文件存在时 MUST 按稳定顺序加载并缓存；目录不存在或没有有效文件时 SHALL 静默视为空项目规则集。系统不得读取旧 `.agent` 规则路径。

#### Scenario: 项目中存在合法的局部规则文件

- **WHEN** 会话启动且项目 `.myagent/rules/` 下存在一个或多个有效规则文件
- **THEN** 系统按稳定顺序读取内容并存入该会话的规则缓存，在缓存有效期内不重复读取相同内容

#### Scenario: 局部规则目录不存在

- **WHEN** 会话启动但项目 `.myagent/rules/` 不存在或为空
- **THEN** 系统正常完成初始化，项目规则上下文为空，且不得为了运行数据创建该目录

### Requirement: 规则与技能加载的多会话工作区物理隔离

系统在运行时针对不同 `SessionContext` 的规则与技能扫描、解析路径和缓存 MUST 保持实例级隔离。每个实例 MUST 使用自身规范化 workspace 对应的项目配置路径，且不得共享可变的全局规则或技能缓存。

#### Scenario: 并发加载不同工作区技能

- **WHEN** Session A 与 Session B 分别拥有不同规范化 workspace，并同时初始化规则与技能
- **THEN** A 只能加载 A 的 `.myagent/rules` 与 `.myagent/skills`，B 只能加载 B 的对应目录，两个项目缓存互不污染

### Requirement: 技能自动重载必须以内容差异为准

项目技能 watcher MUST 监听当前项目 `<workspace>/.myagent/skills/`，并把文件系统事件视为候选信号。系统 MUST 过滤有效 `SKILL.md`、比较稳定内容摘要，只有新增、删除或内容实际变化时才替换缓存和更新系统提示词。

#### Scenario: 无内容变化的文件事件

- **WHEN** watcher 收到项目 `.myagent/skills/` 下的文件事件，但有效技能主体摘要与缓存一致
- **THEN** 系统不得刷新技能缓存、不得更新系统提示词，也不得输出误导性的 INFO 变更日志

#### Scenario: SKILL.md 内容真实变化

- **WHEN** 某个有效 `SKILL.md` 新增、删除或内容摘要变化
- **THEN** 系统必须在防抖后执行一次缓存替换，更新系统提示词，并记录具体变更类型的结构化事件

#### Scenario: 无关派生文件变化

- **WHEN** 项目技能目录中的缓存、临时文件或非技能主体文件产生事件
- **THEN** 系统必须忽略该事件，不得触发完整技能重载

#### Scenario: watcher 返回相对技能路径

- **WHEN** watcher 对项目 skills 根下的 `example/SKILL.md` 返回相对文件名
- **THEN** 系统必须把该文件识别为候选技能主体，不得要求回调文件名包含 `.myagent/skills/` 前缀

#### Scenario: watcher 未提供文件名

- **WHEN** 底层平台发出技能目录变更事件但没有提供文件名
- **THEN** 系统必须在当前防抖窗口安排一次项目 skills 全量摘要重扫，并仅在内容实际变化时刷新缓存
