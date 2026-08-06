## 背景

MyAgent 已在 `background-skill-review.ts` 中具备一条可工作的隔离 Agent 链路：创建独立 `SessionContext`、装载历史、派生受限工具和权限、建立预算协调器并运行独立 `AgentLoop`。但这条链路属于 Skill Review/Curator 专用实现，仍直接复用父会话的有状态 LLM 驱动，也没有可复用的子代理定义、工具作用域、transcript 和结果交付边界。

本 change 只建立“同步执行”的第一阶段闭环：主 Agent 通过 `Agent` 工具调用一个前台 `general-purpose` 子代理，并等待其完成。后台任务、exact-fork、命令入口和审批回传属于第二阶段，因为它们共同依赖任务队列、通知、状态、取消和跨循环审批路由，不应混入本次内核迁移。

## 目标与非目标

### 目标

- 提供可被普通子代理和现有 Skill 后台任务共同复用的隔离执行内核。
- 提供同步 `Agent` 工具和唯一内置类型 `general-purpose`。
- 保证父子 Agent 的 LLM 实例、上下文、权限状态、插件和 transcript 相互隔离。
- 在不改变工具 schema 的前提下，为子代理建立显式、默认拒绝的工具可见性策略。
- 在子代理结果进入父 Agent 前执行确定性输出扫描，并保留未修改的原始 transcript。
- 迁移 Skill Review/Curator 的隔离执行骨架，同时保持其现有触发与安全契约。

### 非目标

- 不支持后台 `Agent` 调用、`queued`/`running` 任务管理、`/subtask`、`/tasks` 或完成通知。
- 不支持 exact-fork、父会话历史复制、自定义 Agent Markdown、Explore/Plan 类型或模型覆盖。
- 不支持子代理嵌套、恢复、worktree 隔离、Agent Team 或后台审批回传。
- 不改变主会话 snapshot 格式、Skill 工具协议、PermissionMode 枚举或现有审批协议。

## 架构决策

### 1. 以定义注册表稳定 Agent 工具协议

新增 `SubagentDefinitionRegistry`。第一期只注册内置 `general-purpose`，定义至少包含类型名、描述、上下文策略、系统提示词构造器和工具策略键。注册表不扫描 Markdown 文件，避免提前承诺第三阶段的配置格式。

`Agent` 工具第一期只接受：

- `prompt: string`：非空任务描述。
- `subagent_type?: string`：省略时为 `general-purpose`；未知值返回可诊断错误。

工具同步返回 JSON 结果：成功为 `completed + agentId + output`，取消为 `cancelled + agentId`，执行失败为 `error + agentId + code + message`。本次不接受 `run_in_background`、`model`、`isolation`、`context` 或批量 `tasks` 参数。保留字符串类型而非 schema 枚举，使后续注册新类型时无需改变工具参数结构。

`Agent` 是编排入口，不是对子代理未来全部副作用的一次性授权。它自身按无业务资源副作用的协调调用进入统一网关；子代理内部每个文件、Shell、浏览器或 MCP 调用必须分别授权并留下自己的 effect/audit，父层对 `Agent` 的放行不得转化为子调用的通配授权。

### 2. 用会话绑定端口解决工具装配循环

`Agent` 工具依赖 `SubagentExecutionPort`，不直接构造运行器。组合根先创建一个稳定的会话绑定控制器并注入 `BuildNativeToolsOptions`；`SessionManager` 完成当前会话、父工具注册表和 LLM 配置装配后，再绑定具体执行器。控制器在未绑定、重复绑定到其他会话或会话关闭后必须 fail-closed，并在关闭时解除绑定。

这样可以避免 `AgentTool -> SubagentRuntime -> parent ToolRegistry -> AgentTool` 的构造环，也不需要全局单例。单元测试可直接注入假的 `SubagentExecutionPort`。

### 3. 通用运行器与上下文装载策略分离

新增 `SubagentRuntime`，统一负责 ID、取消、独立依赖创建、`AgentLoop` 运行、终态记录、输出扫描和资源释放；上下文差异由装载策略承担。

本次实现两种策略：

- `fresh`：用于 `general-purpose`。新建子代理 system，按当前项目重新加载全局/项目规则和 Skill 元数据，以用户任务作为首条 user 消息；不复制父 system、父历史或父运行时追加消息。
- `history-replay`：用于 Skill Review/Curator。保留隔离上下文自己的 system，剥离父 system 后回放冻结的 user/assistant/tool 消息，保持现有复盘语义。

exact-fork 不在本次伪实现为特殊分支；第二阶段通过新增装载策略接入同一运行器。

### 4. 子代理必须拥有独立 LLM 客户端

新增 `LlmClientFactoryPort` 及 OpenAI 兼容实现。启动子代理时从父会话读取一次当前 `LlmConfig`，生成不可变快照，再由工厂创建独立 `LlmPort`。快照采用显式字段复制，保留 `ModelProfile.buildExtraPayload` 等函数引用，不使用会丢失函数的 `structuredClone`。

子代理运行期间父会话的 `switchModel()`、取消控制器或其他可变驱动状态不得影响子代理；子代理关闭也不得关闭或切换父驱动。本次不允许模型自行选择 provider/model。

### 5. 工具策略与作用域注册表

在工具内部元数据中定义固定形状的 `SubagentToolPolicy`：

```ts
interface SubagentToolPolicy {
  freshForeground: boolean;
  freshBackground: boolean;
  fork: boolean;
}
```

该元数据不进入发送给模型的函数 schema。缺失策略一律视为三项 `false`。本次完成所有原生工具和 MCP 工具装配路径的策略审计：

- `freshForeground` 可开放普通文件、终端、Git、浏览器、Skill 和 MCP 能力；每次调用仍经过现有 `ToolCallGateway` 与权限检查。
- `Agent`、`ask_user_question`、`human_interruption`、会话生命周期控制及只适用于后台事件的工具必须关闭，保证深度为 1 且子代理不直接接管父会话交互。
- `freshBackground` 与 `fork` 字段在本次定义并保持 fail-closed；第二阶段只填充其语义，不再修改接口形状。

`ScopedToolRegistry` 只暴露所选策略允许的定义，且直接保留允许工具原有 schema，避免包装导致定义漂移。执行仍委托父注册表，但注入子代理 caller、权限上下文和深度。其 `close()` 只释放子代理自己的钩子/登记，严禁调用父 `ToolRegistry.close()` 或关闭共享 MCP 物理连接。

`Agent` 还是一个长时编排工具，不能沿用普通工具统一的 `toolTimeoutMs` 包住整个子循环。工具内部元数据新增默认值为 `standard` 的执行超时策略；只有 `Agent` 标记为 `parent-signal`，使外层执行器只组合父取消信号。子代理内部的每次模型请求仍受 `modelTimeoutMs` 约束，每个子工具仍受 `toolTimeoutMs` 约束，整个循环仍受 `maxIterations` 约束，因此不形成无限执行逃逸口。

### 6. 权限只可继承或收窄

新增 `ChildPermissionResolver`，从调用瞬间冻结的父 `PermissionSessionState` 派生独立子状态。模型参数和 Agent 定义均不能提升权限：

- 父 `plan` 保持只读。
- 父 `dontAsk` 对需要询问的操作继续拒绝，不得借用父交互界面绕过。
- 父 `default` 可通过现有前台交互端口同步请求批准，但批准及会话态变更只写入子状态。
- `acceptEdits` 和 `bypassPermissions` 只有在可信父状态已经处于对应模式时才能继承，子代理不能自行设置。

前台批准需要把“执行上下文”和“批准展示端口”分开：`ScopedToolRegistry` 向父注册表传递子 `SessionContext` 供工具执行，同时在受信 `securityContext` 中传递调用时捕获的父 `ApprovalPort`。`ToolRegistry` 只用该父端口展示批准请求，所有 `PermissionUpdate` 仍应用到子权限状态；用户明确选择的持久规则继续经过现有 `PermissionSettingsStore`，但父会话内存状态不得被改写。未提供批准端口时，`ask` 必须 fail-closed。

所有实际工具调用继续走统一授权链。现有 Skill Review/Curator 仍使用后台 caller、收窄的三工具注册表和 `approvalAllowed: false`，不因公共内核迁移获得前台审批能力。这里的同步批准路由不等于第二阶段的后台审批回传：主循环此时正阻塞等待子代理，可以直接复用当前会话的批准界面，不需要任务通知或跨循环恢复。

### 7. 子代理插件与预算隔离

每次执行创建独立 `SessionContext`、预算协调器、`AgentLoop`、取消控制器和插件注册表。通用子代理只装配维持正常循环安全所必需、且不会产生跨会话副作用的插件；不得装配 `SkillLearningPlugin`、自动记忆提取或其他会递归创建整理任务的插件。

`general-purpose` 使用调用时冻结的 `runtimeLimits.maxIterations`；父 `AbortSignal` 必须向下传播，取消正在进行的模型和工具调用。达到循环上限、无最终 assistant 文本、工具异常或取消时，不得伪装成空的成功结果。

### 8. transcript 独立于主会话存储

在 `ApplicationPaths` 增加 `subagentsDir = <projectDataDir>/state/subagents`。同步通用子代理的记录路径为：

`<subagentsDir>/<编码后的父 sessionId>/<agentId>/transcript.json`

父 sessionId 必须经过安全编码或哈希，`agentId` 由系统生成，禁止用户输入参与路径拼接。文件使用版本化结构并通过同目录临时文件 + rename 原子替换，至少记录：

- `version`、`agentId`、`parentSessionId`、`agentType`、`contextPolicy`。
- `status`（`running/completed/failed/cancelled`）、开始/结束时间。
- 冻结的 provider/model 标识。
- 未经输出扫描修改的原始 system/user/assistant/tool 消息。
- 最终交付的扫描版本和命中规则 ID。

该目录不属于 `ContextRepository.sessionsDir`，主会话历史列表、恢复、压缩和回滚均不得扫描或嵌入这些记录。此格式预留终态字段供第二阶段建立后台任务索引，但本次不提供任务列表 API。

Skill Review/Curator 继续使用不落盘的 transcript 策略，避免公共内核迁移改变其现有隔离与持久化行为。

### 9. 在唯一交付边界执行确定性输出扫描

新增 `SubagentOutputScanner`，它不是凭据脱敏器，也不复用 `diagnostic-sanitizer.ts`。扫描器只处理即将作为 `Agent` 工具结果交给父 Agent 的最终文本：

- 对行首角色伪装（例如 `System:`、`Assistant:`、`Human:`、`User:`、`Tool:`）和保留系统标签伪装插入确定性转义。
- 对命中的角色/标签规则或权限绕过措辞附加固定安全标记，并记录规则 ID 与扫描器版本。
- 不调用 LLM，不删除原文，不概括或改写语义；没有命中时输出必须与原文本一致。

原始 assistant 输出先写入 transcript，再生成交付副本。该边界降低角色伪装和指令形态混淆风险，但不宣称能够识别所有语义型提示注入。

### 10. Skill Review/Curator 只迁移执行骨架

从 `background-skill-review.ts` 抽取上下文创建、独立循环、预算、取消和资源释放能力，由 Skill Review 与 Curator 以专用配置调用 `SubagentRuntime`。迁移后必须保持：

- 原触发计数、FIFO 排队、冻结快照与关闭等待语义。
- `skills_list`、`load_skill`、`skill_manage` 三工具白名单及后台 caller。
- 剥离父 system 的历史回放、16 轮上限、禁止人工审批和不落盘隔离。
- 原有 mutation/notification、读取凭证和失败处理契约。

Skill 后台结果不作为普通 `Agent` 工具结果进入父模型，因此不强行套用通用子代理的交付 JSON；只有实际进入父 Agent 的文本才经过输出扫描器。

## 风险与权衡

- **工具策略漏标导致能力缺失**：缺失策略默认拒绝，并以全量注册表契约测试列出未分类工具；宁可显式补标，也不静默放开。
- **前台子代理可能长时间阻塞**：这是本阶段有意的同步语义；取消会向下传播。并发、排队和用户无感后台运行留到第二阶段统一解决。
- **长时工具绕过统一工具超时**：仅 `Agent` 可使用 `parent-signal` 策略，且模型请求、子工具和迭代数仍分别有界；契约测试确保其他工具继续使用标准超时。
- **transcript 增加磁盘占用**：本次先保证可诊断和未来恢复所需的独立格式，不引入自动清理策略；后续任务管理 change 再定义保留期与清理入口。
- **输出扫描可能改变示例文本展示**：只对明确的保留形态做最小转义，并保存原始 transcript；安全文本保持字节一致。
- **Skill 迁移产生回归面**：通过专用配置保留三工具、禁止审批、不落盘和历史回放契约，并用现有真实链路测试对照迁移前行为。
- **未实现 exact-fork 的缓存收益**：本次 `fresh` 不复制父 prompt 前缀，因此不承诺 exact-fork 的字节级缓存；第二阶段再为 fork 单独处理 system 与工具 schema 一致性。

## 迁移计划

1. 先增加纯端口、定义注册表、策略元数据、扫描器和 transcript 存储，不接入生产入口。
2. 实现独立 LLM 工厂、作用域工具注册表、权限派生、上下文策略和通用运行器，以测试替身验证资源所有权。
3. 注册同步 `Agent` 工具并完成组合根的会话绑定，验证真实 `ToolCallGateway -> AgentTool -> SubagentRuntime -> AgentLoop` 链路。
4. 将 Skill Review/Curator 切换到公共运行器的 `history-replay` 专用配置，删除重复骨架并跑既有回归。
5. 若迁移失败，可先撤销 Agent 工具注册与 Skill 调用点；独立 transcript 目录不会影响主会话 snapshot，可安全保留用于诊断。

## 待确认问题

无。后台任务保留策略、exact-fork system 复制、后台审批回传和 `/tasks` 交互均明确延后到后续 change 决策。
