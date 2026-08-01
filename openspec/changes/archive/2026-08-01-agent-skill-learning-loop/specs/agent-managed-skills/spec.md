## ADDED Requirements

### Requirement: 统一的用户与项目 Skill 解析

系统 MUST 通过同一 Skill 库视图发现、列举和读取用户级与项目级 Skill；同名时项目 Skill MUST 覆盖用户 Skill。新创建的 Skill MUST 写入用户 Skill 根，已有 Skill 的前台修改 MUST 作用于当前合并视图实际解析到的物理 Skill。

#### Scenario: 项目 Skill 覆盖同名用户 Skill

- **WHEN** 用户根与当前项目根都存在名称相同的合法 Skill
- **THEN** Skill 列表和读取结果只暴露项目版本
- **THEN** 前台 `skill_manage` 更新该名称时修改项目版本，不得暗中修改被遮蔽的用户版本

#### Scenario: 创建新的 Skill

- **WHEN** `skill_manage(create)` 收到一个尚不存在的合法名称和完整 `SKILL.md`
- **THEN** 系统在当前用户 Skill 根创建该 Skill
- **THEN** 创建成功后当前会话的 Skill 索引能够加载该 Skill

### Requirement: Skill Manage 领域动作

系统 MUST 提供 `skill_manage` 原生工具，并支持 `create`、`patch`、`edit`、`delete`、`write_file` 和 `remove_file` 六种动作。每次工具调用 MUST 独立完成并返回该动作的成功、失败或暂存状态，系统 MUST NOT 声称多次调用属于同一事务。

#### Scenario: 定点修补 Skill

- **WHEN** `patch` 的 `oldString` 在目标文件中唯一匹配
- **THEN** 系统只替换匹配文本、重新校验目标内容并返回修改摘要

#### Scenario: 修补文本存在多个匹配

- **WHEN** `patch` 找到多个匹配且 `replaceAll` 不是 true
- **THEN** 系统拒绝该动作并报告匹配不唯一
- **THEN** 目标文件保持不变

#### Scenario: 多步维护中后续动作失败

- **WHEN** 模型先成功 patch umbrella，随后 write_file 失败
- **THEN** 系统保留已经成功的 patch 并明确报告 write_file 失败
- **THEN** 系统不得宣称两个动作被整体回滚

### Requirement: Skill 包结构与输入校验

系统 MUST 校验 Skill 名称、YAML frontmatter、内容大小和支持文件相对路径。支持文件 MUST 只允许位于 `references/`、`templates/`、`scripts/` 或 `assets/`，且不得通过绝对路径、`..`、符号链接或目录重定向逃离目标 Skill 根。`skill_manage` MUST 只把输入写为 UTF-8 文本，`SKILL.md` MUST 不超过 100,000 个字符，单个支持文件按 UTF-8 编码后 MUST 不超过 1 MiB；工具 MUST NOT 提供二进制或 base64 解码写入路径，也 MUST NOT 根据扩展名拒绝其他合法文本模板或脚本。

#### Scenario: 创建内容缺少合法 frontmatter

- **WHEN** create 或 edit 内容缺少匹配的 `name`、非空 `description` 或合法 YAML 边界
- **THEN** 系统拒绝写入并返回结构错误

#### Scenario: 支持文件尝试路径穿越

- **WHEN** `write_file` 或 `remove_file` 的 filePath 包含 `..`、绝对路径或解析后位于 Skill 根外
- **THEN** 系统拒绝动作
- **THEN** Skill 根外不得产生、修改或删除文件

#### Scenario: 支持文件超过大小上限

- **WHEN** `write_file` 的 fileContent 按 UTF-8 编码后超过 1 MiB
- **THEN** 系统拒绝动作并返回明确的大小限制错误
- **THEN** 目标支持文件保持原状或不存在

#### Scenario: 模型请求写入二进制资产

- **WHEN** 模型请求 `write_file` 解码 base64 或其他二进制 payload 后写入支持文件
- **THEN** 系统拒绝二进制解码写入语义并说明第一版只支持 UTF-8 文本

### Requirement: 单次文件替换与修改后校验

系统 MUST 使用同目录临时文件和替换操作提交单个 `SKILL.md` 或支持文件。edit、patch 和 write_file 在替换后校验失败时 MUST 恢复该动作开始前的单文件内容；该保证 MUST NOT 扩展为多个 `skill_manage` 调用的事务。

#### Scenario: patch 破坏 Skill frontmatter

- **WHEN** patch 结果会使 `SKILL.md` frontmatter 无效
- **THEN** 系统拒绝该 patch
- **THEN** 原始 `SKILL.md` 内容保持可读取

#### Scenario: 进程在文件替换前中断

- **WHEN** 临时文件已写入但正式替换尚未发生时进程中断
- **THEN** 正式目标文件不得只包含部分新内容

### Requirement: 后台所有权与 pinned 边界

后台 Review 与 Curator MUST 只修改用户 Skill 根内显式标记为 agent-created 或已 adopt 的 Skill。项目 Skill、手写用户 Skill、未 adopt Skill和 pinned Skill MUST 对后台维护只读；前台用户指令仍可按正常权限修改未被后台管理的 Skill。

#### Scenario: 后台尝试修补手写 Skill

- **WHEN** 后台 Review 调用 `skill_manage(patch)`，但目标没有 curator-managed 所有权标记
- **THEN** 系统拒绝修改并说明需要显式 adopt

#### Scenario: 前台修改手写 Skill

- **WHEN** 用户明确要求前台 Agent 修改一个未 adopt 的合法 Skill
- **THEN** 系统按普通工具权限处理该请求
- **THEN** 后台所有权限制不得把该前台请求误判为自动维护

#### Scenario: 后台尝试修改 pinned Skill

- **WHEN** 后台 Review 或 Curator 对 pinned Skill 发起 patch、edit、delete、write_file 或 remove_file
- **THEN** 系统拒绝动作并保持 Skill 不变

### Requirement: 可选的 Skill 写入暂存批准

系统 MUST 支持 `skills.writeApproval` 开关，默认值 MUST 为 false。开关为 true 时，每个有副作用的 `skill_manage` 调用 MUST 保存为独立 pending 记录而不修改目标 Skill，并支持列举、查看差异、批准和拒绝。

#### Scenario: 写入批准关闭

- **WHEN** writeApproval 为 false 且 `skill_manage` 通过权限与输入检查
- **THEN** 系统直接执行该次动作并返回最终结果

#### Scenario: 写入批准开启

- **WHEN** writeApproval 为 true 且模型调用 `skill_manage(patch)`
- **THEN** 系统持久化该次调用的 action、目标、来源、摘要、时间和完整重放参数
- **THEN** 工具返回 staged 状态和 pending id，目标 Skill 保持不变

#### Scenario: 用户批准一条 pending

- **WHEN** 用户执行 `/skill approve <id>`
- **THEN** 系统重放该条独立动作并返回真实执行结果
- **THEN** 其他 pending 不得被隐式批准

#### Scenario: 用户拒绝一条 pending

- **WHEN** 用户执行 `/skill reject <id>`
- **THEN** 系统删除该 pending 记录且不修改目标 Skill

### Requirement: Skill 变更后的索引刷新

成功的 Skill 创建、修改、归档、恢复或删除 MUST 触发当前会话重新扫描 Skill 元数据；无实际目标变化的失败或 pending 动作 MUST NOT 宣称 Skill 已刷新。

#### Scenario: 用户 Skill 创建成功

- **WHEN** `skill_manage(create)` 已真实写入新的用户 Skill
- **THEN** 当前会话的 available skills 和 `load_skill` 能够看到新 Skill

#### Scenario: 动作只被暂存

- **WHEN** `skill_manage` 返回 staged 而尚未批准
- **THEN** 当前 Skill 索引保持原状态
- **THEN** 系统不得把 pending 内容注入主 Agent

### Requirement: Skill 工具权限与副作用证据

`skill_manage` MUST 作为有副作用原生工具注册类型化权限适配器，提供 `SkillManage` 权限身份和实际目标资源证据。调用来源 MUST 由宿主验证的 caller 或授权分析派生，MUST NOT 作为模型可提交的 Function Calling 参数。Plan、显式 deny、host cap 和 background caller 限制 MUST 在执行前生效；缺少适配器时系统 MUST fail closed。合法非 delete 动作可以提供内建 allow 候选，delete MUST 作为 destructive action 提供内建 ask 候选且 MUST NOT 被归类为普通 edit。

#### Scenario: 模型伪造后台来源

- **WHEN** 模型在 skill_manage 参数中提交 origin 或等价调用来源字段
- **THEN** 工具 schema 拒绝该额外属性
- **THEN** 系统不得把前台调用提升为 background review 或 curator origin

#### Scenario: 前台删除 Skill

- **WHEN** writeApproval 为 false 且前台 Agent 调用 `skill_manage(delete)`
- **THEN** ToolGateway 在删除前返回 destructive ask 决策
- **THEN** 用户批准后系统硬删除当前解析目标，未批准时目标保持不变

#### Scenario: 后台删除 Skill

- **WHEN** 宿主验证的 Curator origin 调用 `skill_manage(delete)` 并提供有效 absorbedInto
- **THEN** 系统把源 Skill 移入可恢复 archive 而不是永久删除

#### Scenario: Plan 模式调用 skill_manage

- **WHEN** 当前 PermissionMode 为 plan 且模型调用任一有副作用的 skill_manage action
- **THEN** ToolGateway 在执行前拒绝该动作

#### Scenario: 工具缺少权限适配器

- **WHEN** `skill_manage` 被注册为 write 工具但没有正式 authorization adapter
- **THEN** ToolGateway 拒绝执行
- **THEN** Skill 和 pending 根均不得改变

### Requirement: Skill CLI 管理入口

现有 `/skill <name> <task>` 临时加载行为 MUST 保持可用，并新增 pending、diff、approve、reject 和 approval 管理子命令。CLI MUST 通过 driving port 调用用例，不得直接编辑 Skill 或 pending 文件。

#### Scenario: 继续临时调用 Skill

- **WHEN** 用户执行 `/skill <name> <task>`
- **THEN** 系统按既有语义只为该请求注入指定 Skill 正文并执行 task

#### Scenario: 查看 pending 差异

- **WHEN** 用户执行 `/skill diff <id>` 且 pending 存在
- **THEN** 系统显示该单次动作会造成的目标差异或创建/删除摘要
- **THEN** 查看行为不得应用该动作
