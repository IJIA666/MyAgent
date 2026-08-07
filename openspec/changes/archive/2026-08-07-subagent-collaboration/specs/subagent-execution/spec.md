## MODIFIED Requirements

### Requirement: 主 Agent 可同步或后台调用已注册子代理

系统 SHALL 提供模型可调用的 `Agent` 工具，支持内置 `general-purpose`、`Explore`、`Plan` 与自定义注册类型。工具 MUST 接受必填 `description`（3-5 词任务摘要）、必填非空 `prompt`、可选 `subagent_type`、可选 `run_in_background` 和可选 `model`；省略类型且 fork 开关关闭时 MUST 使用 `general-purpose`，省略后台开关时 MUST 保持同步前台执行。Agent 工具结果（接受态与前台终态）MUST 携带该子代理 transcript 路径的 `outputFile` 与父工具面是否含 Read 类工具的 `canReadOutputFile`。

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
- **AND** 接受态结果携带 `outputFile`（该子代理 transcript 路径，提交点已初始化、排队期即可读）与 `canReadOutputFile`（父工具面是否含 Read 类工具）
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

### Requirement: 子代理 transcript 与主会话隔离

系统 SHALL 在 `state/subagents` 下为每次通用子代理执行保存独立、版本化的原始 transcript，并 MUST NOT 将子代理内部消息写入主 `ContextRepository` snapshot。子代理运行中 MUST 每轮模型请求完成后原子更新 transcript 的 `running` 快照（含截至该轮的全部原始消息），使输出文件在运行中可读；终态快照 MUST 仍为最终权威记录。

#### Scenario: 原子保存完整终态

- **WHEN** 子代理进入 `running` 或任一终态
- **THEN** 系统通过同目录临时文件与 rename 原子更新 `transcript.json`
- **AND** 文件包含安全派生的父 session 路径、`agentId`、类型、上下文策略、时间、冻结模型标识、状态和原始消息

#### Scenario: 运行中快照可读

- **WHEN** 子代理处于运行中且已完成至少一轮模型请求
- **THEN** transcript 记录状态为 `running` 且消息包含截至最近一轮的完整历史
- **AND** 读取该 transcript 路径可观察到运行进展，终态后由权威终态记录覆盖

#### Scenario: 主会话操作不混入子代理记录

- **WHEN** 用户列出、恢复、压缩或回滚主会话
- **THEN** 主会话仓储不扫描或嵌入 `state/subagents` 记录
- **AND** 对主会话 snapshot 的操作不修改子代理 transcript

#### Scenario: 失败也留下可诊断终态

- **WHEN** 子代理创建 transcript 后发生模型错误、工具错误或取消
- **THEN** 系统在释放资源前尽力写入对应终态与错误摘要
- **AND** 不把凭据或完整敏感异常对象写入 transcript
