# background-skill-learning-reliability Specification

## Purpose
TBD - created by archiving change harden-background-skill-learning-reliability. Update Purpose after archive.
## Requirements
### Requirement: 后台修改必须先读取准确 Skill 目标

系统 MUST 为每次隔离后台 Skill 任务维护独立读取账本。后台模型只有在本次任务中通过 `load_skill` 成功读取动作所需的准确目标后，才能修改或删除已有内容；读取凭证 MUST 绑定宿主验证的后台 caller，MUST NOT 接受模型参数声明的读取状态或绕过标记。

#### Scenario: 未读取 SKILL.md 直接编辑

- **WHEN** 后台模型对已有 Skill 调用 `skill_manage(edit)`，但本次任务没有成功执行 `load_skill(name)`
- **THEN** 系统在产生文件或 pending 副作用前返回 `read_before_write_required`
- **THEN** Skill 正文、usage 和 pending 仓储保持不变

#### Scenario: 读取主文件后修改支持文件

- **WHEN** 后台模型只读取了 `load_skill(name)`，随后尝试覆盖一个已经存在的支持文件
- **THEN** 系统拒绝写入并要求通过 `load_skill(name, file_path)` 读取该准确支持文件
- **THEN** 读取同一 Skill 的主文件不得替代支持文件读取凭证

#### Scenario: 创建新的 Skill

- **WHEN** 后台模型调用 `skill_manage(create)` 且目标名称当前不存在
- **THEN** 系统不要求对不存在的目标执行预读
- **THEN** 目标在实际提交时已经存在则按冲突拒绝创建

#### Scenario: 创建新的支持文件

- **WHEN** 后台模型已读取所属 Skill 的 `SKILL.md`，并调用 `write_file` 创建当前不存在的合法支持文件
- **THEN** 系统允许进入写入前置条件校验
- **THEN** 支持文件在提交前已经出现时拒绝覆盖并要求读取该文件后重试

#### Scenario: 后台合并归档 Skill

- **WHEN** 后台模型通过 `delete(absorbedInto=...)` 归档一个已吸收的 Skill
- **THEN** 本次任务必须已经读取来源 Skill 和吸收目标 Skill 的 `SKILL.md`
- **THEN** 任一读取凭证缺失时不得归档来源 Skill

#### Scenario: 前台用户修改 Skill

- **WHEN** 宿主验证的前台 caller 调用 `skill_manage`
- **THEN** 后台读取账本要求不适用
- **THEN** 前台调用继续遵循统一权限、写入批准和现有 stale 校验

### Requirement: 后台写入必须校验读取版本

系统 MUST 以规范化 Skill 名作为协作写锁域，并在完整锁域内重新解析目标，把当前内容摘要与本次读取账本中的摘要比较。主文件和支持文件 MUST 使用所属 Skill 的同一锁域；`delete(absorbedInto=...)` MUST 对来源与吸收目标的规范化名称去重并按字典序获取锁。已有目标摘要不一致、新建目标不再缺失或吸收目标发生变化时，系统 MUST 拒绝该动作且不得产生部分副作用。模型重新读取后 MAY 使用新凭证重试。

#### Scenario: 读取后正文被另一会话更新

- **GIVEN** 后台任务已经读取一个 Skill 的 `SKILL.md`
- **WHEN** 另一条经 SkillLibrary 的写入在本次 edit 前更新了该文件
- **THEN** 本次 edit 返回 `stale_skill_read`
- **THEN** 较新的文件内容和 usage 记录不得被本次动作覆盖

#### Scenario: 重新读取后重试

- **GIVEN** 前一次写入因 `stale_skill_read` 被拒绝
- **WHEN** 后台模型重新调用 `load_skill` 获得最新内容，并基于该内容提交合法修改
- **THEN** 系统使用新摘要校验并允许该修改

#### Scenario: 同名 Skill 写入竞争

- **WHEN** 两个会话同时尝试通过 SkillLibrary 修改同名 Skill
- **THEN** 系统按每 Skill 写入临界区串行处理
- **THEN** 后进入者必须基于进入临界区时仍有效的读取摘要，否则被拒绝

#### Scenario: 支持文件与主文件竞争

- **WHEN** 两个调用分别修改同一 Skill 的 `SKILL.md` 和支持文件
- **THEN** 两个调用使用该 Skill 规范化名称对应的同一锁域串行执行
- **THEN** 支持文件路径不得形成独立锁域而绕过 Skill 级互斥

#### Scenario: 合并归档的双目标锁顺序

- **WHEN** 两个并发归档操作以不同参数顺序请求相互重叠的来源和吸收目标
- **THEN** 系统对规范化名称去重后按字典序获取全部锁，并按相反顺序释放
- **THEN** 两个操作不得因锁顺序相反而死锁，也不得观察到部分归档状态

#### Scenario: 写入批准开启

- **WHEN** 后台修改启用了写入批准
- **THEN** 系统在创建 pending 前先验证本次读取凭证
- **THEN** 后续批准重放继续校验 pending 自身保存的 base fingerprint

### Requirement: 后台复盘必须单执行者串行调度

每个 `BackgroundSkillReviewService` MUST 使用先进先出队列调度复盘，任一时刻最多运行一个隔离复盘 Agent。`schedule` MUST 同步返回请求是否已接受；被接受的请求 MUST 使用入队时复制的不可变证据。

#### Scenario: 活动复盘期间再次达到阈值

- **WHEN** 一个复盘仍在运行，主会话又提交一个新的复盘请求
- **THEN** 新请求按到达顺序进入等待队列
- **THEN** 系统不得并行启动第二个复盘 Agent

#### Scenario: 前一个复盘失败

- **WHEN** 活动复盘因模型或工具错误结束，且队列中还有请求
- **THEN** 系统记录该失败并完成资源清理
- **THEN** 随后启动队首请求，单个失败不得永久阻塞队列

#### Scenario: 服务关闭

- **WHEN** 会话关闭且复盘服务仍有一个活动任务和若干等待任务
- **THEN** 系统停止接受新请求、丢弃未启动任务并取消活动任务
- **THEN** 关闭完成后不得再启动队列中的任何复盘

#### Scenario: 关闭后请求调度

- **WHEN** 调用方在复盘服务关闭后调用 schedule
- **THEN** schedule 同步返回未接受
- **THEN** 不创建任务、控制器或队列条目

### Requirement: Skill 学习节奏必须准确持久化

Skill 学习阈值 MUST 按正常完成的用户逻辑任务中“包含非空 `tool_calls` 的模型响应数量”累计。最终纯文本响应 MUST NOT 计数，并行请求的工具数量 MUST NOT 改变单个模型响应只计一次。未达到阈值的累计值 MUST 写入会话快照并在恢复同一会话后继续使用；系统 MUST NOT 将该指标描述为模型请求总数或所有 Agent 循环数。

#### Scenario: 九次工具型响应加一次最终响应

- **WHEN** 一个成功任务包含九个带非空 tool_calls 的模型响应，随后产生一次纯文本最终响应
- **THEN** Skill 学习累计值增加 9 而不是 10

#### Scenario: 一个响应并行调用多个工具

- **WHEN** 一个模型响应并行请求五个工具
- **THEN** 学习累计值增加 1
- **THEN** 工具调用总数仍可单独记录为 5，但不得用于阈值判断

#### Scenario: 未达到阈值时恢复会话

- **GIVEN** 会话已经累计 7 次工具型响应并成功保存快照
- **WHEN** 进程重启并恢复该会话，随后成功任务产生 3 次工具型响应
- **THEN** 系统从 7 继续累计并达到默认阈值 10
- **THEN** 系统不得从零重新计数

#### Scenario: 累计值超过单个阈值

- **GIVEN** 当前累计值为 8 且阈值为 10
- **WHEN** 下一个成功任务产生 5 次工具型响应，复盘请求被调度器接受
- **THEN** 系统安排一次复盘并保留累计余数 3

#### Scenario: 调度器同步拒绝请求

- **GIVEN** 累计值已经达到阈值
- **WHEN** 调度器因关闭或同步故障未接受复盘请求
- **THEN** 系统保留完整累计值供后续成功任务重试
- **THEN** 不得先归零再记录失败

#### Scenario: 已接受的复盘异步失败

- **WHEN** 调度器已经接受请求并消费一个阈值，随后后台模型调用失败
- **THEN** 系统记录失败诊断但不自动返还已消费计数
- **THEN** 系统不得立即形成无限重试循环

### Requirement: 前台已经沉淀的任务不得重复推进后台学习

系统 MUST 根据真实前台 `skill_manage` 工具结果判断当前逻辑任务是否已经完成 Skill 沉淀。结果为 `success` 或 `staged` 时，本逻辑任务的工具型响应数量 MUST NOT 加入后台学习累计；系统 MUST 保留此前其他逻辑任务留下的累计值。失败、拒绝或模型文字声明不得触发豁免。

#### Scenario: 前台成功更新 Skill

- **GIVEN** 进入当前任务前已经累计 6 次工具型响应
- **WHEN** 当前任务成功调用前台 `skill_manage` 更新 Skill 并最终正常完成
- **THEN** 当前任务的工具型响应不加入后台累计
- **THEN** 原有累计值仍为 6

#### Scenario: 前台写入被暂存

- **WHEN** 写入批准已开启，当前任务的前台 `skill_manage` 返回 staged
- **THEN** 当前逻辑任务视为已经形成显式沉淀提案
- **THEN** 该任务不得再安排重复的后台复盘

#### Scenario: 前台写入失败

- **WHEN** 当前任务调用前台 `skill_manage` 但结果为 error 或权限拒绝
- **THEN** 当前任务仍按普通成功任务规则推进学习累计
- **THEN** 模型声称已经保存不得改变该结果

#### Scenario: 等待用户交互后完成前台写入

- **GIVEN** 一个逻辑任务跨越等待用户交互边界
- **WHEN** 等待前或恢复后有一次成功或暂存的前台 skill_manage，且任务最终完成
- **THEN** 前台沉淀标志随延续状态合并
- **THEN** 等待前后的工具型响应均不得推进该任务的后台学习累计

