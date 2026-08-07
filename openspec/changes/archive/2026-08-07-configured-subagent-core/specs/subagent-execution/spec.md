# subagent-execution Specification（增量）

## Purpose

本文件是 `openspec/specs/subagent-execution` 主干规范的增量补丁：阶段 2a 将 `Agent` 工具从"仅支持 general-purpose"扩展为"支持已注册子代理类型"，schema 增加 `model` 参数，并新增 maxTurns 执行语义。其余主干需求（独立冻结模型客户端、工具作用域默认拒绝、权限派生、终态与取消、transcript 隔离、输出扫描、资源所有权、exact-fork、嵌套深度）保持不变。

## MODIFIED Requirements

### Requirement: 主 Agent 可同步或后台调用已注册子代理

系统 SHALL 提供模型可调用的 `Agent` 工具，支持内置 `general-purpose`、`Explore`、`Plan` 与自定义注册类型。工具 MUST 接受必填 `description`（3-5 词任务摘要）、必填非空 `prompt`、可选 `subagent_type`、可选 `run_in_background` 和可选 `model`；省略类型且 fork 开关关闭时 MUST 使用 `general-purpose`，省略后台开关时 MUST 保持同步前台执行。

#### Scenario: 默认调用通用子代理

- **WHEN** 主 Agent 以非空 `prompt` 与 `description` 调用 `Agent` 且未指定 `subagent_type` 或 `run_in_background`
- **THEN** 系统启动一个前台 `general-purpose` 子代理并同步等待其结束
- **AND** 成功结果包含 `completed` 状态、系统生成的 `agentId` 和最终输出

#### Scenario: 缺少 description 时拒绝

- **WHEN** 主 Agent 调用 `Agent` 但未提供 `description`
- **THEN** 系统返回可诊断的参数校验错误
- **AND** 不创建任务、transcript 或子代理循环

#### Scenario: 拒绝未知子代理类型

- **WHEN** 主 Agent 指定未注册的 `subagent_type`
- **THEN** 系统返回包含可诊断错误码和可用类型列表的 `error` 结果
- **AND** 系统不创建任务索引、transcript 或子代理循环

#### Scenario: 后台调用立即返回任务标识

- **WHEN** 主 Agent 使用 `run_in_background: true` 调用 `Agent`
- **THEN** 系统提交一个 `fresh` 后台子代理并立即返回 `async_launched` 状态、`agentId` 与 `description`
- **AND** 主 Agent 无需等待该子代理进入终态即可继续当前循环

#### Scenario: Agent schema 只暴露阶段内字段

- **WHEN** 模型读取 `Agent` 工具 schema（fork 开关关闭）
- **THEN** schema 只声明 `description`、`prompt`、`subagent_type`、`run_in_background` 与 `model`
- **AND** 不声明权限提升、隔离模式、任务查询或批量任务参数
- **AND** fork 开关关闭时不提示省略类型即 fork 的语义

#### Scenario: fork 开关开启时强制后台并隐藏后台与模型参数

- **WHEN** fork 配置开关开启且模型读取 `Agent` 工具 schema
- **THEN** schema 不包含 `run_in_background` 字段与 `model` 字段
- **AND** 模型任何 `Agent` 调用都作为后台任务提交并返回 `async_launched`

## 新增需求

### Requirement: 子代理定义可声明最大回合数

系统 MUST 使子代理定义 frontmatter 的 `maxTurns`（正整数）生效：子代理循环达到该回合数时 MUST 按既有循环上限语义收敛（不伪装成功，返回稳定错误码的 `error` 结果），且回合上限 MUST 在调用时冻结，父会话后续配置修改不影响在途子代理。未声明 `maxTurns` 时 MUST 使用既有 `runtimeLimits.maxIterations`。

#### Scenario: maxTurns 生效并冻结

- **WHEN** 定义 frontmatter 声明 `maxTurns: 8` 且子代理执行中父会话修改运行配置
- **THEN** 子代理在 8 个回合后按循环上限收敛
- **AND** 父会话配置修改不改变该在途上限

#### Scenario: 未声明时回退默认上限

- **WHEN** 定义未声明 `maxTurns`
- **THEN** 子代理使用既有 `runtimeLimits.maxIterations` 作为循环上限

#### Scenario: 非法 maxTurns 被拒绝

- **WHEN** 定义 frontmatter 声明非正整数的 `maxTurns`
- **THEN** 该定义被拒绝注册并记录可诊断日志
