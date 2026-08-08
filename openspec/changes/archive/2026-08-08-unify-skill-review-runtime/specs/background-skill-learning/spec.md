## ADDED Requirements

### Requirement: 后台 Skill Agent 统一经公共子代理运行器执行

系统 MUST 通过公共子代理运行器（`SubagentRuntime.runTask`）执行全部隔离 Skill Agent 任务（Review 与 Curator），不得（MUST NOT）保留第二套独立装配路径（手工 SessionContext/RuleManager/ContextRepository/AgentLoop 装配）。`subagentRuntime` 必须（MUST）为服务构造必填依赖，按装配点分两级保证：直接构造服务处由类型系统在编译期拒绝缺参；`SessionManager` 自动装配处（`subagentRuntime` 字段本身可选）在需要创建 Review 服务而运行器缺失时 MUST 抛出明确装配错误，不得（MUST NOT）静默禁用、不得（MUST NOT）使用非空断言掩盖。执行结果 MUST 保持既有隔离契约：独立权限快照、受信 background caller、固定三工具面（`skills_list`/`load_skill`/`skill_manage`）、不落盘上下文与取消传播语义不变。

#### Scenario: 复盘任务经公共运行器执行

- **WHEN** 后台 Skill Review 任务启动
- **THEN** 该任务经公共子代理运行器 `SubagentRuntime.runTask` 执行
- **AND** 工具面固定收窄为 `skills_list`/`load_skill`/`skill_manage` 三工具

#### Scenario: Curator 任务经同一运行器执行

- **WHEN** 后台 Skill Curator 任务启动
- **THEN** 该任务与 Review 共用同一公共子代理运行器执行
- **AND** Curator 候选范围与读取凭证约束保持有效

#### Scenario: 直接构造点缺少运行器

- **WHEN** 直接构造隔离 Skill 任务服务而未提供 `subagentRuntime`
- **THEN** 该装配在编译期失败（必填依赖）
- **AND** 不存在运行时静默回退到第二套装配的路径

#### Scenario: SessionManager 自动装配缺少运行器

- **WHEN** `SessionManager` 需要创建 Review 服务（未注入外部 scheduler 且提供 skillLibrary）而子代理运行器缺失
- **THEN** `SessionManager` 抛出明确装配错误
- **AND** 抛错必须发生在 `RuleManager` 向 `SkillLibrary` 注册监听之前（不遗留订阅引用）
- **AND** 不得静默禁用 Review 服务，不得以非空断言掩盖缺失
