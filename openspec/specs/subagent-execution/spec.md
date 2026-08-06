# subagent-execution Specification

## Purpose

定义主 Agent 通过 `Agent` 工具调用隔离子代理的执行契约：同步与后台提交、description 必填摘要、独立上下文与冻结模型客户端、显式默认拒绝的工具作用域、exact-fork 双入口（模型开关与 `/subtask`）与占位闭合、不超过父会话的权限派生、确定终态与取消传播、与主会话隔离的 transcript、确定性输出扫描、资源所有权边界，以及 Skill Review/Curator 复用公共内核时保持的既有契约。自定义 Markdown Agent 与嵌套多层由后续 change 扩展。

## Requirements

### Requirement: 主 Agent 可同步或后台调用通用子代理

系统 SHALL 提供模型可调用的 `Agent` 工具，并仅支持 `general-purpose` 子代理。工具 MUST 接受必填 `description`（3-5 词任务摘要）、必填非空 `prompt`、可选 `subagent_type` 和可选 `run_in_background`；省略类型且 fork 开关关闭时 MUST 使用 `general-purpose`，省略后台开关时 MUST 保持同步前台执行。

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

- **WHEN** 模型读取 `Agent` 工具 schema
- **THEN** schema 只声明 `description`、`prompt`、`subagent_type` 与 `run_in_background`
- **AND** 不声明模型覆盖、权限提升、隔离模式、任务查询或批量任务参数
- **AND** fork 开关关闭时不提示省略类型即 fork 的语义

#### Scenario: fork 开关开启时强制后台并隐藏后台参数

- **WHEN** fork 配置开关开启且模型读取 `Agent` 工具 schema
- **THEN** schema 不包含 `run_in_background` 字段
- **AND** 模型任何 `Agent` 调用都作为后台任务提交并返回 `async_launched`

### Requirement: 通用子代理使用独立的新上下文

`general-purpose` 子代理 SHALL 使用 `fresh` 上下文。系统 MUST 为其构造独立 system 与任务消息，并 MUST NOT 复制父会话 system 或消息历史。

#### Scenario: 新上下文加载项目规则

- **WHEN** 系统创建 `general-purpose` 子代理
- **THEN** 子代理按当前项目重新加载适用的全局/项目规则与 Skill 元数据
- **AND** 用户任务是该子代理的首条 user 消息

#### Scenario: 父历史不进入通用子代理

- **WHEN** 父会话在调用 `Agent` 前已有 user、assistant 或 tool 消息
- **THEN** 这些父消息不出现在子代理请求或原始 transcript 中
- **AND** 父主历史只接收本次 `Agent` 工具调用及其最终工具结果，不接收子代理内部消息

### Requirement: 子代理拥有独立且冻结的模型客户端

系统 SHALL 从调用时的父 `LlmConfig` 生成冻结快照，并通过 `LlmClientFactoryPort` 为每个子代理创建独立 `LlmPort`。父子运行 MUST NOT 共享可变驱动实例。

#### Scenario: 父会话切换模型不影响在途子代理

- **WHEN** 子代理已经从父配置创建独立客户端
- **AND** 父会话随后切换模型或改变驱动状态
- **THEN** 在途子代理继续使用启动时冻结的 provider/model 配置

#### Scenario: 子代理关闭不影响父驱动

- **WHEN** 子代理成功、失败或取消并释放自身客户端
- **THEN** 父会话的 LLM 客户端保持可用且配置不变

### Requirement: 子代理工具范围显式且默认拒绝

每个可注册工具 SHALL 具有不进入模型 schema 的 `SubagentToolPolicy`，包含 `freshForeground`、`freshBackground` 和 `fork` 三个字段。缺失策略 MUST 按全部拒绝处理。`fresh` 子代理 MUST 根据前后台只消费对应策略字段；fork 子代理 MUST 透传父精确工具池并按 caller 深度拒绝禁用调用。

#### Scenario: 允许工具保持原 schema

- **WHEN** 某工具在当前 `fresh` 策略键下为 `true`
- **THEN** `ScopedToolRegistry` 向子代理暴露与父注册表字节等价的工具定义
- **AND** 实际调用仍经过统一工具网关、caller 注入和权限检查

#### Scenario: 前台与后台名单互不替代

- **WHEN** 工具只设置 `freshForeground: true` 而 `freshBackground/fork` 为 `false`
- **THEN** 同步 fresh 子代理可以看到该工具
- **AND** 后台 fresh 子代理不可见该工具

#### Scenario: 后台工具白名单排除浏览器

- **WHEN** 后台 fresh 子代理枚举可用工具
- **THEN** 可用集合只包含审计通过的非交互工具，浏览器导航、交互和登录类工具不可见
- **AND** 缺失策略的工具默认拒绝并出现在契约测试审计报告中

#### Scenario: fork 子代理使用父精确工具池

- **WHEN** exact-fork 子代理启动
- **THEN** 其工具定义与父注册表字节等价（含 `Agent` 本身）
- **AND** 调用 `Agent` 时按 caller 深度返回嵌套拒绝，不产生新的子代理

#### Scenario: 禁止直接用户交互与会话控制

- **WHEN** `fresh` 子代理枚举可用工具
- **THEN** `ask_user_question`、`human_interruption`、会话生命周期控制及后台事件专用工具不可见
- **AND** 即使以工具名直接请求执行，作用域注册表也拒绝调用

#### Scenario: 未分类工具不会意外开放

- **WHEN** 原生或 MCP 工具进入父注册表但没有子代理策略
- **THEN** 该工具不出现在任何子代理定义中
- **AND** 契约测试报告该工具尚未完成策略审计

#### Scenario: 三种策略互不替代

- **WHEN** 工具只设置 `freshForeground: true` 而 `freshBackground/fork` 为 `false`
- **THEN** 同步 fresh 子代理可以看到该工具
- **AND** 后台 fresh 与 exact-fork 子代理均不可见该工具

### Requirement: 子代理权限不得超过父会话

系统 SHALL 从调用瞬间冻结的父权限状态派生独立子权限状态。子代理定义、prompt 或工具参数 MUST NOT 提升父会话权限。

#### Scenario: plan 与 dontAsk 保持约束

- **WHEN** 父会话权限模式为 `plan`
- **THEN** 子代理保持只读并拒绝写操作
- **WHEN** 父会话权限模式为 `dontAsk`
- **THEN** 子代理对需要询问的操作直接拒绝且不打开交互

#### Scenario: 前台批准只修改子状态

- **WHEN** 父会话允许交互且子代理工具调用需要人工批准
- **THEN** 系统以子 `SessionContext` 执行工具，并通过调用时捕获的父 `ApprovalPort` 同步展示批准请求
- **AND** 批准结果及会话态授权只写入子权限状态
- **AND** 父权限状态不被子代理修改

#### Scenario: 缺少父批准端口时安全拒绝

- **WHEN** 子代理工具决策为 `ask` 但调用上下文没有可用的父 `ApprovalPort`
- **THEN** 系统拒绝该子工具调用
- **AND** 不把缺少交互界面解释为批准

#### Scenario: Agent 放行不是子工具通配授权

- **WHEN** 父循环已获准执行 `Agent` 工具
- **AND** 子代理随后请求文件、Shell、浏览器或 MCP 副作用
- **THEN** 每个子工具调用仍使用子权限状态独立完成授权和审计
- **AND** 外层 `Agent` 调用的放行不自动批准任何子工具

#### Scenario: 特权模式不能由子代理自选

- **WHEN** 父状态不是 `acceptEdits` 或 `bypassPermissions`
- **THEN** 子代理无法通过类型、prompt 或调用参数进入对应模式

### Requirement: 同步执行具有确定终态与取消传播

`Agent` 工具 SHALL 阻塞到子代理产生最终 assistant 输出、失败或取消。父调用的取消信号 MUST 传播到子代理模型请求和工具执行。

#### Scenario: 子代理正常完成

- **WHEN** 子代理循环产生非空最终 assistant 文本
- **THEN** 运行器记录 `completed` 终态并将扫描后的文本作为工具结果交付

#### Scenario: 通用子代理使用冻结的循环上限

- **WHEN** 系统启动 `general-purpose` 子代理
- **THEN** 子循环使用调用时冻结的 `runtimeLimits.maxIterations`
- **AND** 父会话随后修改运行配置不会改变该在途上限

#### Scenario: 无最终文本不得伪装成功

- **WHEN** 子代理达到循环上限、抛出异常或未产生非空最终 assistant 文本
- **THEN** `Agent` 工具返回带稳定错误码和 `agentId` 的 `error` 结果
- **AND** 不返回空的 `completed` 结果

#### Scenario: 父调用被取消

- **WHEN** 父 `AbortSignal` 在子代理运行期间触发
- **THEN** 系统取消在途模型与工具工作
- **AND** transcript 记录 `killed` 终态
- **AND** `Agent` 工具返回 `cancelled` 结果

#### Scenario: 长时编排不受普通工具总超时误杀

- **WHEN** `Agent` 工具运行时间超过普通 `toolTimeoutMs` 但父调用未取消
- **THEN** 外层工具执行器不因普通工具总超时终止子循环
- **AND** 子代理的单次模型请求、内部工具调用和模型循环数仍分别受既有上限约束

#### Scenario: 其他工具继续使用标准超时

- **WHEN** 非 `Agent` 工具通过主循环执行
- **THEN** 该工具继续使用既有 `toolTimeoutMs` 行为

### Requirement: 子代理 transcript 与主会话隔离

系统 SHALL 在 `state/subagents` 下为每次通用子代理执行保存独立、版本化的原始 transcript，并 MUST NOT 将子代理内部消息写入主 `ContextRepository` snapshot。

#### Scenario: 原子保存完整终态

- **WHEN** 子代理进入 `running` 或任一终态
- **THEN** 系统通过同目录临时文件与 rename 原子更新 `transcript.json`
- **AND** 文件包含安全派生的父 session 路径、`agentId`、类型、上下文策略、时间、冻结模型标识、状态和原始消息

#### Scenario: 主会话操作不混入子代理记录

- **WHEN** 用户列出、恢复、压缩或回滚主会话
- **THEN** 主会话仓储不扫描或嵌入 `state/subagents` 记录
- **AND** 对主会话 snapshot 的操作不修改子代理 transcript

#### Scenario: 失败也留下可诊断终态

- **WHEN** 子代理创建 transcript 后发生模型错误、工具错误或取消
- **THEN** 系统在释放资源前尽力写入对应终态与错误摘要
- **AND** 不把凭据或完整敏感异常对象写入 transcript

### Requirement: 子代理输出经过确定性安全扫描

系统 SHALL 在最终文本进入父 Agent 前使用版本化的 `SubagentOutputScanner`。扫描 MUST 是确定性的，MUST NOT 调用 LLM，且 MUST 保持 transcript 中的原始输出不变。

#### Scenario: 安全文本保持不变

- **WHEN** 最终文本未命中任何角色、保留标签或权限绕过规则
- **THEN** 交付给父 Agent 的文本与原始文本一致
- **AND** transcript 记录扫描版本和空命中集合

#### Scenario: 角色或保留标签伪装被转义

- **WHEN** 最终文本包含行首角色伪装或保留系统标签伪装
- **THEN** 交付副本对命中形态插入确定性转义并附带固定安全标记
- **AND** transcript 保留未转义原文并记录命中规则 ID

#### Scenario: 扫描不冒充通用提示注入检测

- **WHEN** 文本只包含未命中确定规则的普通语义内容
- **THEN** 扫描器不删除、概括或重写该内容

### Requirement: 子代理资源不得关闭父会话资源

系统 SHALL 明确区分子代理拥有的资源与借用的父资源。子代理结束时 MUST 关闭自身上下文、LLM 客户端、插件和登记，但 MUST NOT 关闭父工具注册表、父 LLM 客户端或共享 MCP 连接。

#### Scenario: 子代理结束后父工具仍可用

- **WHEN** `ScopedToolRegistry.close()` 或子代理清理流程执行
- **THEN** 父 `ToolRegistry` 保持打开
- **AND** 父会话随后仍可调用原生工具和已有 MCP 工具

### Requirement: 子代理不触发递归学习任务

通用子代理的插件集合 MUST 排除自动 Skill 学习、自动记忆提取及其他会创建新整理任务的插件。

#### Scenario: 子代理完成不会增加学习计数

- **WHEN** `general-purpose` 子代理产生多个模型循环并结束
- **THEN** 这些循环不增加父会话的 Skill 学习或记忆提取计数
- **AND** 不再创建新的 Skill Review/Curator 子任务

### Requirement: Skill 隔离任务复用内核但保持既有契约

Skill Review 与 Skill Curator SHALL 通过通用运行器的专用配置执行，但公共内核迁移 MUST NOT 扩大其工具、权限、持久化或消息交付行为。

#### Scenario: Skill Review 保持受限历史回放

- **WHEN** Skill Review 对冻结的主会话快照运行
- **THEN** 它使用隔离 system 并只回放剥离父 system 后的 user、assistant 和 tool 消息
- **AND** 仅可见 `skills_list`、`load_skill`、`skill_manage`
- **AND** 保持 16 个模型循环上限和禁止人工审批

#### Scenario: Skill Curator 保持现有触发与不落盘行为

- **WHEN** Skill Curator 通过迁移后的公共运行器执行
- **THEN** 其现有计数、排队、caller、通知和关闭等待语义保持不变
- **AND** 不在通用子代理 transcript 目录持久化内部消息

### Requirement: 模型与用户都可创建 exact-fork

系统 SHALL 提供两种 exact-fork 创建入口：模型在 fork 开关开启时省略 `subagent_type` 即隐式 fork（强制后台运行）；用户通过 `/subtask <prompt>` 创建后台 fork。fork MUST 在提交时冻结父会话最近一次模型请求的最终组装快照（消息含记忆投影与插件改写、过滤后工具集合、冻结模型配置），但 MUST NOT 共享父会话的可变上下文、权限状态或 LLM 客户端。

#### Scenario: 模型省略类型创建隐式 fork

- **WHEN** fork 配置开关开启且主 Agent 调用 `Agent` 时省略 `subagent_type`
- **THEN** 系统创建 exact-fork 后台子代理而非 `general-purpose`
- **AND** 子代理消息前缀来自提交时父模型请求的最终组装快照，父 system 内容保持字节一致

#### Scenario: fork 开关关闭时省略类型仍为通用子代理

- **WHEN** fork 配置开关关闭且主 Agent 省略 `subagent_type`
- **THEN** 系统创建 `general-purpose` 子代理
- **AND** `Agent` 工具 schema 保留 `run_in_background` 且不提示 fork 语义

#### Scenario: 快照包含请求期动态注入内容

- **WHEN** 父会话最近一次模型请求包含记忆投影、插件改写或请求期注入的消息
- **THEN** 这些内容出现在 fork 子代理的消息前缀中
- **AND** fork 不依赖只复制持久历史造成的遗漏

#### Scenario: 未完成工具调用被占位闭合

- **WHEN** fork 捕获的快照最后一条 assistant 消息含未闭合 `tool_calls`
- **THEN** 系统为每个未闭合 `tool_calls` 条目合成统一占位内容的 `tool` 消息（`tool_call_id` 对应）后追加任务消息
- **AND** 占位文本对所有 fork 子代理字节一致
- **AND** 执行侧对仍残留的孤立 `tool_calls` 消息按 MyAgent 消息协议做防御性剔除

#### Scenario: 空闲会话创建完整分支

- **WHEN** 主会话空闲、消息协议闭合且用户执行 `/subtask <prompt>`
- **THEN** 子代理消息前缀包含提交时父会话最近一次模型请求的最终组装快照深副本
- **AND** `<prompt>` 作为新的末尾 user 消息追加

#### Scenario: 排队期间父会话继续变化

- **WHEN** exact-fork 已提交但仍在队列中
- **AND** 父会话随后新增消息、切换模型或修改权限状态
- **THEN** 该任务继续使用提交时冻结的消息快照、过滤后工具集合、`LlmConfig`、权限快照和 `maxIterations`

#### Scenario: 协议未闭合时拒绝用户 fork

- **WHEN** 主会话正在生成、存在未解决 tool call 或处于待恢复的人机交互
- **AND** 用户请求 `/subtask`
- **THEN** 系统返回可操作的拒绝说明且不创建任务索引或 transcript

#### Scenario: fork 超过上下文预算

- **WHEN** 完整 fork 快照追加任务后超过模型请求预算
- **THEN** 系统仍 MUST 经过既有 `ContextBudgetCoordinator` 处理
- **AND** 允许对子历史执行既有压缩而不是绕过预算或提交必然超窗的请求

#### Scenario: fork 内禁止再 fork

- **WHEN** 子代理 caller 深度已处于 fork 内部且尝试调用 `Agent`
- **THEN** 系统拒绝该调用并指示子代理直接完成任务
- **AND** 不产生新的子代理

### Requirement: 后台子代理保持独立权限与模型边界

后台 fresh 与 exact-fork 子代理 SHALL 使用提交时冻结的父权限快照和模型配置派生独立运行资源。后台执行 MUST NOT 因异步生命周期获得比同步子代理更高的权限。

#### Scenario: 后台批准不修改父权限

- **WHEN** 后台子代理工具调用需要人工批准且父审批端口可用
- **THEN** 系统通过父审批界面展示请求
- **AND** 批准产生的模式或规则更新只写入该子代理权限状态
- **AND** 父权限状态保持不变

#### Scenario: 后台任务缺少审批界面

- **WHEN** 后台工具决策为 `ask` 但父审批端口不可用或会话已关闭
- **THEN** 系统 fail-closed 拒绝该工具调用
- **AND** 不把后台运行解释为自动批准

#### Scenario: 后台任务使用独立模型实例

- **WHEN** 后台任务从排队进入运行
- **THEN** 系统通过独立 LLM 工厂按提交时冻结配置创建客户端
- **AND** 父模型切换、中止或关闭单次请求不得改变该客户端配置

### Requirement: 子代理嵌套深度固定为一层

本阶段系统 MUST 只允许根主 Agent 或受信 CLI 创建子代理。子代理自身 MUST NOT 创建新的子代理，即使通过伪造参数或直接调用控制端口也必须拒绝。

#### Scenario: 子代理尝试调用 Agent

- **WHEN** caller audience 已是 `subagent`
- **THEN** `fresh` 子代理的工具列表中不含 `Agent`
- **AND** fork 子代理保留 `Agent` 定义但对控制端口的直接调用返回稳定的嵌套拒绝错误
