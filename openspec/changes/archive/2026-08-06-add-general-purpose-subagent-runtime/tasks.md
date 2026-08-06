## 1. 固化端口、定义与路径契约

- [x] 1.1 在 `src/ports/driving/SubagentExecutionPort.ts` 定义同步子代理请求、`completed/cancelled/error` 结果、运行上下文（父 session、交互端口、取消信号）与稳定错误码；第一期请求只含 `prompt`、`subagentType`，不得提前加入后台、fork 或模型覆盖字段。
- [x] 1.2 在 `src/ports/driven/llm/LlmClientFactoryPort.ts` 定义按冻结 `LlmConfig` 创建独立 `LlmPort` 的工厂端口；在 `src/core/usecases/subagent/llm-config-snapshot.ts` 以显式字段复制实现快照，保留 `ModelProfile.buildExtraPayload` 等函数引用并冻结可变对象。
- [x] 1.3 在 `src/ports/driven/tools/ToolRegistryPort.ts` 与 `src/adapters/tools/tool-types.ts` 定义 `SubagentToolPolicy { freshForeground, freshBackground, fork }` 及 `standard/parent-signal` 执行超时策略；将其作为不进入模型 schema 的内部元数据，缺失子代理策略时按全部拒绝、缺失超时策略时按 `standard` 处理；为受信 `securityContext` 增加与执行 session 分离的可选父 `ApprovalPort`。
- [x] 1.4 更新 `src/adapters/tools/ToolCatalog.ts`、`src/adapters/tools/toolRegistry.ts` 和对应端口映射，保证调用方可以按工具名读取规范化后的子代理策略与超时策略，且 `getTools()` 返回的函数定义不携带这些内部字段。
- [x] 1.5 在 `src/config/application-paths.ts` 增加 `<projectDataDir>/state/subagents` 的 `subagentsDir`，同步更新配置路径测试，断言它独立于 `sessionsDir` 且继续随 workspace key 隔离。
- [x] 1.6 新增 `src/core/usecases/subagent/SubagentDefinitionRegistry.ts`，只注册内置 `general-purpose`，并在 `test/core/usecases/subagent/subagent-definition-registry.test.ts` 覆盖默认解析、未知类型拒绝、重复注册拒绝及未扫描 Markdown 文件。

<!-- checkpoint: npm run test:typecheck -->

## 2. 实现 transcript 与确定性输出扫描

- [x] 2.1 新增 `src/core/usecases/subagent/SubagentOutputScanner.ts`，用版本化规则对行首 `System/Assistant/Human/User/Tool` 角色伪装、保留系统标签伪装和权限绕过措辞进行确定性转义/标记；不调用 LLM、不删除原文，安全文本保持不变。
- [x] 2.2 新增 `test/core/usecases/subagent/subagent-output-scanner.test.ts`，以表驱动用例覆盖大小写、前导空白、多行、多个命中、保留标签、权限绕过标记、安全文本字节一致和重复扫描稳定性。
- [x] 2.3 新增 `src/core/usecases/subagent/SubagentTranscriptStore.ts`，实现版本化 record、状态转换、原始 `ChatMessage` 深复制、扫描版本/规则记录，以及 `<subagentsDir>/<安全父会话键>/<agentId>/transcript.json` 的同目录临时文件 + rename 原子写入；路径段不得直接信任用户输入。
- [x] 2.4 transcript 错误摘要复用现有敏感信息脱敏能力或等价安全边界，只保存可诊断摘要，不序列化凭据、完整异常对象或循环引用；明确原始 assistant 文本先落 transcript，扫描只产生交付副本。
- [x] 2.5 新增 `test/core/usecases/subagent/subagent-transcript-store.test.ts`，覆盖 `running -> completed/failed/cancelled`、原子替换、并发写串行化、安全路径、原始文本不被扫描改写、主 `sessionsDir` 无新增文件及写入失败不留下半文件。

<!-- checkpoint: npx vitest run test/core/usecases/subagent/subagent-output-scanner.test.ts test/core/usecases/subagent/subagent-transcript-store.test.ts -->

## 3. 建立独立模型、权限与工具作用域

- [x] 3.1 新增 `src/adapters/llm/OpenAiLlmClientFactory.ts` 实现 `LlmClientFactoryPort`，每次创建新的 `OpenAiLlmAdapter`；补 `test/adapters/llm/OpenAiLlmClientFactory.test.ts`，断言父 `switchModel()`、父/子 `abort()` 和活动请求状态互不影响。
- [x] 3.2 新增 `src/core/usecases/subagent/ChildPermissionResolver.ts`，从父 `PermissionSessionSnapshot` 派生独立 `PermissionSessionState`：保留 `plan/dontAsk` 约束，仅继承父已持有的 `acceptEdits/bypassPermissions`，复制适用规则但不共享可变 rule store，拒绝来自模型参数的模式提升。
- [x] 3.3 在 `test/core/usecases/subagent/child-permission-resolver.test.ts` 覆盖五种现有 PermissionMode、父状态后续变更不回写子状态、子审批更新不回写父状态，以及 `dontAsk` 无交互、`plan` 无写入的候选决策。
- [x] 3.4 新增 `src/core/usecases/subagent/ScopedToolRegistry.ts`：按 `freshForeground` 过滤定义，保留允许工具原 schema，委托父注册表执行时注入独立 caller/权限/审批标志；执行参数使用子 `SessionContext`，批准展示单独使用调用时捕获的父 `ApprovalPort`；实现候选分析和元数据透传，但 `close()` 不得调用父 `close()` 或关闭 MCP。
- [x] 3.5 在 `src/adapters/tools/tool-factory.ts`、各原生工具聚合入口及 MCP descriptor 规范化路径完成策略审计：普通文件/终端/Git/浏览器/Skill/MCP 工具按前台权限链开放；Agent、交互、会话控制和后台事件工具关闭；所有 `freshBackground/fork` 先为 `false`，不得留隐式默认开放项。
- [x] 3.6 修改 `src/core/usecases/engine/tool-call-orchestrator.ts`，仅当工具超时策略为 `parent-signal` 时不传普通 `toolTimeoutMs`，其他工具保持原逻辑；不得移除上游 `AbortSignal`，也不得改变子循环中模型和工具各自的既有超时。
- [x] 3.7 新增 `test/core/usecases/subagent/scoped-tool-registry.test.ts` 与补充 `test/core/usecases/engine/tool-call-orchestrator.test.ts`，覆盖 schema 等价、未知/禁止工具拒绝、子 caller、子执行 context + 父批准端口分离、缺少批准端口 fail-closed、父子权限隔离、MCP 策略、父 registry 存活，以及只有显式 `parent-signal` 工具绕过总工具超时。

<!-- checkpoint: npm run build -->

<!-- checkpoint: npx vitest run test/adapters/llm/OpenAiLlmClientFactory.test.ts test/core/usecases/subagent/child-permission-resolver.test.ts test/core/usecases/subagent/scoped-tool-registry.test.ts test/core/usecases/engine/tool-call-orchestrator.test.ts -->

## 4. 实现通用同步子代理运行器

- [x] 4.1 新增 `src/core/usecases/subagent/SubagentContextBuilder.ts`：`fresh` 为通用子代理重新构造 system、加载当前全局/项目规则与 Skill 元数据并只追加任务 user 消息；`history-replay` 保留隔离 system、过滤父 system、深复制 user/assistant/tool 快照并在末尾追加专用任务输入。
- [x] 4.2 在 `test/core/usecases/subagent/subagent-context-builder.test.ts` 覆盖父历史不进入 `fresh`、规则/Skill 元数据仍加载、回放顺序与 tool call 字段不丢失、父 system 被剥离、传入消息后续变更不污染子上下文。
- [x] 4.3 新增 `src/core/usecases/subagent/SubagentRuntime.ts`，统一创建 agentId、冻结配置、独立 LLM、`SessionContext`、`RuleManager`、预算协调器、`ToolDispatcher`、受限注册表、插件注册表和 `AgentLoop`；所有公开类型与方法按项目规范补完整 TSDoc。
- [x] 4.4 为运行器提供显式执行配置：上下文装载策略、工具作用域、caller、审批策略、迭代上限、持久/不落盘 transcript、插件集合、结果适配器和 mutation 钩子；禁止通过松散布尔值绕过权限或资源所有权边界。
- [x] 4.5 从 `AgentLoop` 事件/子历史提取非空最终 assistant 文本，按 `completed/failed/cancelled` 写终态；`general-purpose` 冻结使用调用时的 `runtimeLimits.maxIterations`，达到上限、异常或缺少最终文本时返回稳定错误，父取消信号必须物理取消子 LLM 与在途工具。
- [x] 4.6 通用 `general-purpose` 配置只装配安全循环所需插件，显式排除 `SkillLearningPlugin`、自动记忆提取及会递归启动整理任务的插件；子循环模型次数不得计入父 Skill/Memory cadence。
- [x] 4.7 在成功交付路径中先保存原始 transcript，再调用 `SubagentOutputScanner` 生成父模型可见副本；取消和失败路径也必须在 `finally` 中释放子资源，且绝不关闭借用的父 LLM、父 ToolRegistry 或 MCP 连接。
- [x] 4.8 新增 `test/core/usecases/subagent/subagent-runtime.test.ts`，以 fake LLM/工具覆盖成功、多轮工具调用、独立客户端、未知最终文本、模型失败、工具失败、取消、迭代上限、扫描顺序、终态持久化、插件排除和资源释放。

<!-- checkpoint: npx vitest run test/core/usecases/subagent/subagent-context-builder.test.ts test/core/usecases/subagent/subagent-runtime.test.ts -->

## 5. 接入 Agent 工具与真实会话装配

- [x] 5.1 新增 `src/core/usecases/subagent/SubagentExecutionController.ts`，实现稳定的会话绑定转发：未绑定、跨会话误用、重复绑定不同执行器和关闭后调用均 fail-closed；提供宿主专用 bind/unbind，但不向模型暴露绑定能力。
- [x] 5.2 新增 `src/adapters/tools/impl/agent/AgentTool.ts` 与聚合入口，schema 只含必填 `prompt` 和可选 `subagent_type`；校验空 prompt/未知类型，从外层执行上下文安全捕获父 session/`ApprovalPort`，连同 `InteractionPort`、signal 传给执行端口，并序列化 `completed/cancelled/error` 结果。
- [x] 5.3 将 `Agent` 加入 `src/adapters/tools/constants/native-tool-names.ts` 和 `src/adapters/tools/tool-factory.ts`，通过 `BuildNativeToolsOptions` 注入 `SubagentExecutionPort`；该工具不得出现在自己的 `freshForeground` 工具集，并使用 `parent-signal` 超时策略。
- [x] 5.4 修改 `src/core/usecases/engine/session.ts` 和 `src/index.ts`：组合根在 ToolRegistry 前创建同一个 `SubagentExecutionController` 与 `OpenAiLlmClientFactory`，ToolRegistry 获得执行端口，SessionManager 用当前 context/config/registry/estimator/adapter/paths 绑定具体运行器，并在会话关闭时先取消子执行再解除绑定。
- [x] 5.5 调整 `src/adapters/tools/toolRegistry.ts` 的提示适配器装配：securityContext 提供父 `ApprovalPort` 时只用它展示批准，PermissionUpdate 应用到子状态，持久更新仍走既有 settings 仓储；明确 `Agent` 外层调用不产生对子工具的通配 grant，每个子调用继续独立授权、执行和审计。
- [x] 5.6 新增 `test/adapters/tools/agent-tool.test.ts` 与控制器单测，覆盖 schema、默认类型、参数错误、未绑定、取消、结构化结果、禁止嵌套及 `parent-signal` 元数据。
- [x] 5.7 新增 `test/integration/subagent-execution.test.ts`，使用临时应用目录、真实 ToolRegistry/SessionManager/AgentLoop 装配和可编排 fake LLM，验证主模型调用 `Agent`、子模型调用一个普通工具、父历史只收到最终工具结果、transcript 独立落盘、父工具/MCP stub 仍可用。
- [x] 5.8 在同一集成测试覆盖权限链：父 `plan` 阻断子写入、父 `default` 的批准只改变子状态、外层 Agent 放行不批准子写入，以及子运行超过很小的 `toolTimeoutMs` 仍可完成但父取消立即终止。

<!-- checkpoint: npm run build -->

<!-- checkpoint: npx vitest run test/adapters/tools/agent-tool.test.ts test/integration/subagent-execution.test.ts -->

## 6. 迁移 Skill Review 与 Curator 到公共内核

- [x] 6.1 重构 `src/core/usecases/brain/background-skill-agent.ts`，保留三工具白名单、读取凭证、mutation 钩子、后台 caller 和 `approvalAllowed: false`，但复用公共作用域/权限基础设施；不得用通用前台策略替代 Skill 专用约束。
- [x] 6.2 重构 `src/core/usecases/brain/background-skill-review.ts` 的 `runIsolatedSkillTask()`，将上下文、预算、循环、取消和资源释放委托给 `SubagentRuntime` 的 `history-replay` 专用配置；移除直接共享父 `driver` 的路径，改由独立 LLM 工厂创建客户端。
- [x] 6.3 为 Skill 专用配置固定 1..16 迭代校验、空 Memory、无自动学习插件、剥离父 system 的完整消息回放、不落盘 transcript 和原有 mutation/result 适配；Review 的 FIFO、冻结快照、关闭等待与通知逻辑继续留在服务层。
- [x] 6.4 保持 `src/core/usecases/brain/skill-curator.ts` 通过 `IsolatedSkillTaskRunner` 调用同一专用运行配置，逐项核对 allowedExistingSkillNames、beforeSkillMutation、备份/报告和读取版本凭证没有在迁移中丢失。
- [x] 6.5 更新 `test/core/usecases/brain/background-skill-agent.test.ts`、`background-skill-review.test.ts` 和 `skill-curator.test.ts`，断言工具白名单、禁止审批、16 轮、system 剥离、模型实例隔离、不落盘、取消、mutation 与通知计数保持不变。
- [x] 6.6 更新 `test/integration/background-skill-isolation.test.ts` 与 `test/integration/skill-learning-loop.test.ts`，通过真实 SessionManager 链路确认 Review/Curator 迁移后仍按既有 cadence 排队，且子循环不反向增加学习计数或污染主历史。

<!-- checkpoint: npx vitest run test/core/usecases/brain/background-skill-agent.test.ts test/core/usecases/brain/background-skill-review.test.ts test/core/usecases/brain/skill-curator.test.ts test/integration/background-skill-isolation.test.ts test/integration/skill-learning-loop.test.ts -->

## 7. 契约收口与回归验收

- [x] 7.1 新增 `test/contract/subagent-execution.test.ts`，从生产 `buildNativeTools()` 和 MCP fixture 枚举工具，确保每个工具都有明确三元策略、缺失项 fail-closed、`Agent` 不可嵌套、允许工具 schema 不变、只有 `Agent` 使用 `parent-signal`。
- [x] 7.2 在契约测试固定第一阶段边界：Agent schema 不得出现 background/fork/model/tasks 字段，不得注册 `/subtask`、`/tasks`、自定义 Markdown Agent、Explore/Plan、恢复或 worktree 入口。
- [x] 7.3 全仓检索并清理 Skill Review 旧的重复 `SessionContext/AgentLoop` 装配和父 driver 共享路径；保留兼容所需的 `IsolatedSkillTaskRunner` 业务接口，但确保其唯一生产实现委托公共运行器。
- [x] 7.4 执行 lint、TypeScript 编译、核心/适配器测试、契约测试和两条相关集成测试；只处理本 change 引入或暴露的回归，对无关环境失败如实记录而不扩大实现范围。
- [x] 7.5 运行 `openspec validate add-general-purpose-subagent-runtime --strict`，核对 proposal、design、spec 与任务实现一致，尤其是同步边界、独立 LLM、三元工具策略、`parent-signal`、transcript 原文和 Skill 不落盘契约。

<!-- checkpoint: npm test -->

<!-- checkpoint: npm run test:contract -->

<!-- checkpoint: npx vitest run test/integration/subagent-execution.test.ts test/integration/background-skill-isolation.test.ts test/integration/skill-learning-loop.test.ts -->

<!-- checkpoint: openspec validate add-general-purpose-subagent-runtime --strict -->
