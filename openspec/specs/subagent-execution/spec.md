# subagent-execution Specification

## Purpose

定义主 Agent 通过 `Agent` 工具同步调用隔离 `general-purpose` 子代理的执行契约：独立上下文、冻结模型客户端、显式默认拒绝的工具作用域、不超过父会话的权限派生、确定终态与取消传播、与主会话隔离的 transcript、确定性输出扫描、资源所有权边界，以及 Skill Review/Curator 复用公共内核时保持的既有契约。后台执行、exact-fork、自定义 Markdown Agent 与任务管理命令由后续 change 扩展。

## Requirements

### Requirement: 主 Agent 可同步调用通用子代理

系统 SHALL 提供模型可调用的 `Agent` 工具，并在本阶段仅支持 `general-purpose` 子代理。工具 MUST 接受非空 `prompt` 和可选 `subagent_type`，省略类型时 MUST 使用 `general-purpose`。

#### Scenario: 默认调用通用子代理

- **WHEN** 主 Agent 以非空 `prompt` 调用 `Agent` 且未指定 `subagent_type`
- **THEN** 系统启动一个 `general-purpose` 子代理并同步等待其结束
- **AND** 成功结果包含 `completed` 状态、系统生成的 `agentId` 和最终输出

#### Scenario: 拒绝未知子代理类型

- **WHEN** 主 Agent 指定未注册的 `subagent_type`
- **THEN** 系统返回包含可诊断错误码的 `error` 结果
- **AND** 系统不创建 LLM 客户端、transcript 或子代理循环

#### Scenario: 第一阶段不接受后台与 fork 参数

- **WHEN** 模型读取 `Agent` 工具 schema
- **THEN** schema 仅声明 `prompt` 与 `subagent_type`
- **AND** 不声明后台运行、模型覆盖、上下文复制、隔离模式或批量任务参数

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

每个可注册工具 SHALL 具有不进入模型 schema 的 `SubagentToolPolicy`，包含 `freshForeground`、`freshBackground` 和 `fork` 三个字段。缺失策略 MUST 按全部拒绝处理。本阶段运行器 MUST 只消费 `freshForeground`，其余两项 MUST 保持 fail-closed。

#### Scenario: 允许工具保持原 schema

- **WHEN** 某工具的 `freshForeground` 为 `true`
- **THEN** `ScopedToolRegistry` 向子代理暴露与父注册表字节等价的工具定义
- **AND** 实际调用仍经过统一工具网关、caller 注入和权限检查

#### Scenario: 禁止嵌套与直接用户交互

- **WHEN** `general-purpose` 子代理枚举可用工具
- **THEN** `Agent`、`ask_user_question`、`human_interruption`、会话生命周期控制及后台事件专用工具不可见
- **AND** 即使以工具名直接请求执行，作用域注册表也拒绝调用

#### Scenario: 未分类工具不会意外开放

- **WHEN** 原生或 MCP 工具进入父注册表但没有子代理策略
- **THEN** 该工具不出现在前台子代理定义中
- **AND** 契约测试报告该工具尚未完成策略审计

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
- **AND** transcript 记录 `cancelled` 终态
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
