## ADDED Requirements

### Requirement: 基于工具迭代的后台复盘触发

系统 MUST 累计主 Agent 正常完成的逻辑学习单元中的工具调用迭代，并在累计值达到 `skills.creationNudgeInterval` 时安排一次 Skill Review；默认阈值 MUST 为 10。错误、中断和没有最终回复的任务 MUST NOT 触发复盘。挂起人机交互的物理 run MUST NOT 立即触发复盘，但系统 MUST 保存其学习证据，并在同一任务恢复后正常完成时合并累计。

#### Scenario: 复杂任务正常完成

- **WHEN** 若干正常运行累计达到配置的工具迭代阈值，且最后一次运行产生最终回复
- **THEN** 系统把累计值归零并安排一次后台 Skill Review

#### Scenario: 简单任务未达到阈值

- **WHEN** 本轮正常结束但累计工具迭代仍低于阈值
- **THEN** 系统保留累计值供后续运行使用
- **THEN** 本轮不得启动 Skill Review

#### Scenario: 多个简单任务累计达到阈值

- **WHEN** 多个正常 run 各自只产生少量工具迭代，但累计值达到 creationNudgeInterval
- **THEN** 最后一个正常完成且有最终回复的 run 安排 Skill Review

#### Scenario: 运行因错误或用户中断结束

- **WHEN** Agent 运行以 error 或 abort 结束
- **THEN** 系统不得把该运行作为成功学习触发器

#### Scenario: 人机中断暂不触发 Review

- **WHEN** 主 Agent 因交互工具暂停，尚未提交最终回复
- **THEN** 本轮不得启动 Skill Review 或修改任何 Skill
- **THEN** 系统把当前轨迹、工具证据和迭代计数保存为会话级学习延续状态

#### Scenario: 人机中断恢复后正常完成

- **GIVEN** 一个物理 run 因等待用户交互保存了学习延续状态
- **WHEN** 用户回答后恢复运行，并提交不含工具调用的最终回复
- **THEN** Review 阈值使用等待前后工具迭代数之和
- **THEN** Review 输入同时包含等待前轨迹、交互工具回答和恢复后轨迹
- **THEN** 学习延续状态在完成结算后被清除

#### Scenario: 人机中断恢复后失败

- **GIVEN** 一个物理 run 因等待用户交互保存了学习延续状态
- **WHEN** 恢复后的运行发生错误、中断、拒绝或达到最大迭代数
- **THEN** 系统丢弃该学习延续状态
- **THEN** 等待前工具迭代不得污染后续无关任务的 Review 阈值

#### Scenario: 重启进程后恢复人机中断

- **GIVEN** 等待前学习延续状态已经写入正式会话快照
- **WHEN** 新进程加载该会话并恢复挂起交互
- **THEN** 系统恢复等待前轨迹、已加载 Skill、工具证据和迭代计数
- **THEN** 后续正常完成时仍按同一个逻辑学习单元复盘

### Requirement: 无歧义的 RunEnd 学习摘要

系统 MUST 只在 RunEnd 提供可选只读 `AgentRunSummary`。`toolIterationCount` MUST 表示本 run 中包含非空 `tool_calls` 的模型响应数量，`requestedToolCallCount` MUST 表示这些响应请求的工具调用总数，`hasFinalResponse` MUST 只在系统成功处理 `complete` 模型事件并提交最终 assistant message 时为 true。带 content 的 `tool_calls` 响应 MUST NOT 被当作最终回复。

#### Scenario: 一个响应并行请求多个工具

- **WHEN** 一个模型响应同时携带 content 和三个 tool_calls
- **THEN** toolIterationCount 增加 1 且 requestedToolCallCount 增加 3
- **THEN** 该响应本身不得把 hasFinalResponse 设为 true

#### Scenario: 工具迭代后产生最终回复

- **WHEN** 本 run 先处理一个 tool_calls 响应，随后成功处理不含工具调用的 complete 响应
- **THEN** RunEnd summary 同时包含大于零的 toolIterationCount 和 `hasFinalResponse=true`

#### Scenario: 非 RunEnd Hook 执行

- **WHEN** 插件收到 RunStart、AfterModel、AfterTool 或其他非 RunEnd 事件
- **THEN** HookContext 不提供 runSummary

### Requirement: 主回复后的非阻塞执行

Skill Review MUST 在主 Agent 回复正文已交付后异步执行，并且不得延迟、改写或撤销前台回复和 complete 生命周期。复盘失败 MUST 只产生诊断或非阻塞通知。

#### Scenario: 后台复盘耗时较长

- **WHEN** 主 Agent 已完成回复且后台 Review 仍在调用模型
- **THEN** 用户可以看到完整前台回复并继续使用会话
- **THEN** 后台任务不得占用主会话的 isGenerating 锁

#### Scenario: 后台模型调用失败

- **WHEN** Review Agent 因网络、限流或模型错误终止
- **THEN** 前台运行仍保持成功
- **THEN** 系统记录去敏失败诊断且不得生成半真半假的成功通知

### Requirement: 后台 Agent 上下文与持久化隔离

系统 MUST 为 Skill Review 创建独立临时 SessionContext、background caller、权限状态快照和不落盘 ContextRepository。Review prompt、模型回复和工具消息 MUST NOT 写入主会话历史、主会话 snapshot 或后续用户请求上下文。

#### Scenario: Review Agent 完成复盘

- **WHEN** 后台 Review 产生内部 user/assistant/tool 消息
- **THEN** 主 SessionContext 历史与启动复盘前保持一致
- **THEN** sessionsDir 中不得创建 Review Agent 会话快照

#### Scenario: 父会话权限随后变化

- **WHEN** Review 启动后父会话切换 PermissionMode 或更新规则
- **THEN** 已启动 Review 继续使用启动时继承的独立权限快照
- **THEN** Review 不得反向修改父会话权限状态

### Requirement: 后台工具面固定收窄

Review Agent 的有效工具面 MUST 是父 Agent 工具面与固定 `{load_skill, skill_manage}` 集合的交集。Memory、普通文件、Shell、Browser、MCP、交互和外部副作用工具 MUST 被拒绝，且 Review 不得请求人工批准。

#### Scenario: Review 尝试调用 Shell

- **WHEN** 后台模型请求 Bash 或 PowerShell
- **THEN** 系统在执行前拒绝调用
- **THEN** 不得因为父 Agent 拥有 Shell 而扩大后台工具面

#### Scenario: Review 尝试修改未拥有的 Skill

- **WHEN** Review 调用 skill_manage 指向未标记为 curator-managed 的 Skill
- **THEN** Skill 工具的所有权检查拒绝修改

### Requirement: 复盘优先更新已有 Skill

Review Agent MUST 按“本轮已加载 Skill、已有 class-level umbrella、已有 umbrella 支持文件、新建 class-level Skill”的顺序选择承载位置。只有前序位置均不适用时，才允许创建新 Skill。

#### Scenario: 已加载 Skill 缺少本轮发现的步骤

- **WHEN** 本轮使用了一个 agent-created Skill，成功路径暴露其缺失步骤
- **THEN** Review 优先 patch 该 Skill，而不是创建只描述本轮问题的新 Skill

#### Scenario: 没有合适的已有 Skill

- **WHEN** 本轮产生了可复用程序性知识，且现有 Skill 均不覆盖该任务类别
- **THEN** Review 可以创建带明确触发条件、步骤、陷阱和验证方法的 class-level Skill

### Requirement: 有证据的程序性学习与合法 no-op

Review MUST 只保存可复用且可验证的程序性知识，不得保存临时环境故障、已经恢复的一次性错误、当前任务叙事、未经验证的工具不可用结论或普通用户事实。知识不得固化当前会话偶然的绝对路径、时间戳、临时版本或机器状态；平台或版本确实影响流程时 MUST 写明适用前提和检测方法。保存的步骤 MUST 包含后续可执行的前置检查或结果验证。没有合格学习时 MUST 允许 `Nothing to save`，不得设置每轮最低更新数。

#### Scenario: 任务顺利但没有新方法

- **WHEN** 本轮没有用户纠正、没有新技术路径且已有 Skill 已完整覆盖
- **THEN** Review 不调用 skill_manage
- **THEN** Review 以 no-op 结束

#### Scenario: 缺少本地依赖后重试成功

- **WHEN** 本轮最初因未安装依赖失败，安装后成功
- **THEN** Review 只能在已有 setup/troubleshooting Skill 中保存可复用安装步骤
- **THEN** 保存内容包含依赖检测和安装结果验证方法
- **THEN** 不得创建“该工具不可用”的持久 Skill

#### Scenario: 多个失败尝试后找到成功路径

- **WHEN** 本轮前两个方案失败且第三个方案通过可观察结果验证成功
- **THEN** Review 优先保存第三个方案及其前置检查和结果验证
- **THEN** 前两个方案只有在失败原因已验证且能写成带适用条件的 pitfall 时才可保存

#### Scenario: 发现只适用于当前机器的路径

- **WHEN** 成功步骤依赖当前会话独有的绝对路径或临时时间戳
- **THEN** Review 将其抽象为可检测的输入或适用条件，无法抽象时不得保存

#### Scenario: 用户纠正执行顺序

- **WHEN** 用户指出原步骤顺序错误且修正后的顺序已在本轮验证
- **THEN** Review 将该顺序或陷阱写入对应任务类别的 Skill

### Requirement: 后台创建来源标记和结果通知

只有后台 Review 创建的新 Skill MUST 自动标记为 agent-created。Review 对已有 Skill 的成功修改 MUST 更新 patch telemetry；用户通知 MUST 基于真实成功工具结果生成，不得从模型自述推断已写入。

#### Scenario: 后台成功创建 Skill

- **WHEN** Review 的 skill_manage(create) 返回真实成功
- **THEN** usage sidecar 将该 Skill 标记为 agent-created
- **THEN** 系统可以发送包含 Skill 名称的非阻塞成功通知

#### Scenario: 模型声称已保存但工具失败

- **WHEN** Review 回复声称已更新 Skill，但对应 skill_manage 返回失败或未执行
- **THEN** 系统不得发送 Skill 已更新通知
- **THEN** usage sidecar 不得增加成功计数

### Requirement: 后台任务生命周期受 SessionManager 管理

SessionManager MUST 登记 Skill Review 的取消器和运行 Promise。会话关闭时 MUST 取消未完成任务并有界等待清理；后台 Review 自身 MUST 禁止再次触发 Skill Review。

#### Scenario: 会话在复盘期间关闭

- **WHEN** SessionManager.close() 执行且 Review Agent 尚未完成
- **THEN** 系统向 Review 传播取消信号并等待配置的有限收尾时间
- **THEN** 关闭完成后 Review 不得继续修改 Skill

#### Scenario: Review Agent 自己完成一个工具迭代

- **WHEN** Review 的隔离 AgentLoop 到达 RunEnd
- **THEN** 其 PluginRegistry 不包含 SkillLearningPlugin
- **THEN** 系统不得递归安排下一次 Review
