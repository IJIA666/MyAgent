# 探索主题: AskUserQuestion 交互契约与提问模型

## 1. 问题定义
当前 `ask_user_question` 的问题不在单一 UI 细节，而在于交互契约前后不一致。工具层已经暴露了 `multiSelect`，但 CLI 交互层仍按单选处理；问题选项模型只有平铺的 `string[]`，导致状态、意图、环境事实等不同语义被混在一个问题里；同时，CLI 侧对同一个挂起提问缺少去重与串行保护，存在重复拉起提问界面的风险。这些问题叠加后，会直接损伤可用性、可测性和后续扩展能力。

## 2. 关键发现与调研结果
- **代码库现状**：`AskUserQuestionTool`、`InteractionPort.AskUserPayload`、`QuestionPayload` 与快照恢复链路都保留了 `multiSelect` 和 `allowFreeInput`，但 `InteractionHandler` 没有消费 `multiSelect`，仍然固定走“打印编号 + 输入单个序号 + 返回单个字符串”的流程。与此同时，`InteractionPort.askUser()`、`PendingInteraction.answer`、`resumePendingInteraction()` 的答案契约也仍然是单个 `string`，这说明多选不是只缺一个 CLI 输入解析，而是整条挂起/恢复链路都还是单值模型。
- **代码库现状**：`CliFacade` 会在收到 `interaction_request` 时直接调用 `handlePendingInteraction()`，也允许用户在存在挂起提问时通过 `/resume` 再次调用同一方法；但 `handlePendingInteraction()` 本身没有“当前是否已有提问 UI 活跃”或“同一 interactionId 是否已在处理”的防重保护。领域层虽然禁止并发创建两个不同的 `PendingInteraction`，但没有阻止同一个挂起提问被 CLI 重复渲染。
- **代码库现状**：当前选项模型只有 `options?: string[]`，没有选项类型、分组、互斥关系或展示标签等结构化元数据。因此模型很容易把“当前症状”“用户目标”“设备事实”放进同一个问题里，形成语义混杂的平面列表。
- **代码库现状**：现有测试只验证了工具层是否保留 `multiSelect` 语义，以及 CLI 收到 `interaction_request` 后能完成一次基本恢复；没有覆盖多选输入语法、重复提问保护、同一挂起提问二次拉起、混合选项建模约束等关键场景。现有手动测试文档也只覆盖了二选一和自由输入，没有覆盖多选与重复提问。
- **核实与洞察**：主流设计系统对单选/多选的边界非常一致。GOV.UK 明确要求“只能选一个用 radios，需要选多个用 checkboxes”；Fluent 的 Radio group 也明确只适用于单选，若需多选应使用 checkbox group；Atlassian 对 radio 与 checkbox 的定义同样一致。这说明当前“工具声明支持多选，但 UI 仍按单选提问”的状态不符合主流交互范式。参考：[GOV.UK Radios](https://design-system.service.gov.uk/components/radios/)、[GOV.UK Checkboxes](https://design-system.service.gov.uk/components/checkboxes/)、[Fluent Radio group](https://fluent2.microsoft.design/components/web/react/core/radiogroup/usage)、[Fluent Checkbox](https://fluent2.microsoft.design/components/web/react/core/checkbox/usage)、[Atlassian Radio](https://atlassian.design/components/radio/)、[Atlassian Checkbox](https://atlassian.design/components/checkbox/)
- **核实与洞察**：Fluent 明确建议同一组选项应保持一致的结构，例如都用名词或都用动词，混搭会降低扫读性；GOV.UK 也建议复杂或多部分问题应拆分，而不是塞进一个问题。这直接支持“不要在一个 `ask_user_question` 里同时询问状态、意图和设备事实”的判断。参考：[Fluent Checkbox](https://fluent2.microsoft.design/components/web/react/core/checkbox/usage)、[GOV.UK Checkboxes](https://design-system.service.gov.uk/components/checkboxes/)

## 3. 竞品源码调研分析

基于 D:\projects\Agents 目录下 5 个竞品项目（OpenCode、Codex、Hermes Agent、OpenClaw、Claude Code）的源码深度分析，以下是跨项目对比的关键发现。

### 3.1 提问数据模型对比

| 维度 | 当前 (MyAgent) | OpenCode | Codex | Hermes Agent | OpenClaw | **Claude Code** |
|------|---------|----------|-------|-------------|----------|----------------|
| 选项结构 | `string[]` 纯字符串 | `{label, description}` 结构化 | `{label, description}` 结构化 | `string[]` + 自动追加"Other" | `{label, description?}` 结构化 | **`{label, description, preview?}` 最丰富，支持预览** |
| 多选 | 声明但未实现 | `multiple: boolean` | ❌ 每问题独立单选（支持一次提多个问题） | ❌ 仅单选 | ❌ 仅单选 | **✅ `multiSelect: boolean` 完整实现** |
| 自由输入 | `allowFreeInput` | `custom: boolean` | `is_other`（自动 true） | 通过"Other"隐式支持 | `isOther?` | **✅ 系统自动追加"Other"，模型不需要指定** |
| 密码掩码 | ❌ | ❌ | ✅ `is_secret` | ❌ | ✅ `isSecret?` | ❌ |
| 批量提问 | ❌（单次一个） | ❌ | ✅ `questions: Vec` | ❌ | ✅ 多问题映射 | **✅ `questions: Vec` (1-4个/次)，带分页导航** |
| 答案模型 | `string`（单值） | `string[]`（多值） | `HashMap<id, Vec<string>>` | `string`（JSON） | `Record<id, string[]>` | **`Record<questionText, string>` + annotations 元信息** |
| 答案审核 | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ SubmitQuestionsView 提交前回顾** |

> OpenCode 文件：`packages/schema/src/question.ts` | Codex 文件：`codex-rs/protocol/src/request_user_input.rs` | Claude Code 文件：`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`

### 3.2 暂停/恢复机制对比

| 维度 | 当前 (MyAgent) | OpenCode | Codex | Hermes Agent | OpenClaw | **Claude Code** |
|------|---------|----------|-------|-------------|----------|----------------|
| **暂停原语** | `InteractionRequestError` 异常抛出 | `Deferred` (Effect-TS) | `oneshot::channel` (tokio) | `threading.Event` | Task Flow `setFlowWaiting` | **Promise + React 渲染 + `toolUseConfirmQueue`** |
| **挂起存储** | PendingInteraction（内存+快照） | `Map<ID, Pending>`（纯内存） | `TurnState` HashMap（纯内存） | 模块级 dict（纯内存） | SQLite `flow_runs` 表 | **React `useState` queue + `PermissionContext`** |
| **跨重启持久化** | ✅（快照含 PendingInteraction） | ❌（进程关闭时 fail 所有 pending） | ❌（turn 结束清理） | ❌ | ✅（SQLite） | ❌ 纯内存 |
| **防重放/竞速保护** | ❌ restore 直接覆写 | ✅ 终端 Finalizer 清理 | ✅ `PendingInteractiveReplayState` | ❌（纯内存无需恢复） | ✅ SQLite OCC + 状态校验 | **✅ `createResolveOnce` + `claim()` 原子竞速守卫** |
| **自动超时** | ❌（仅支持 AbortSignal） | ❌ | ✅ `auto_resolution_ms` + 倒计时 | ✅ 可配置超时 | ❌ | ❌ |
| **多路径并行审批** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ 5 路竞速：本地UI + 远程Bridge + 频道 + Hook + 分类器** |

> OpenCode 核心：`packages/core/src/question.ts` | Codex 核心：`codex-rs/core/src/session/mod.rs`（第 2445-2508 行） | Codex 防重放：`codex-rs/tui/src/app/pending_interactive_replay.rs` | Claude Code：`src/hooks/toolPermission/handlers/interactiveHandler.ts`

### 3.3 防重/串行保护对比

| 维度 | 当前 (MyAgent) | OpenCode | Codex | Hermes Agent | OpenClaw | **Claude Code** |
|------|---------|----------|-------|-------------|----------|----------------|
| **领域层禁止并发创建不同 Pending** | ✅ `setPendingInteraction()` 检测 | ✅ `pending.has(id)` → die | ✅ 覆盖时 warn | ✅ `_NEVER_PARALLEL_TOOLS` frozenset | ✅ OCC `expectedRevision` | **✅ `toolUseConfirmQueue` 队列串行处理** |
| **同一 interaction 重复 UI** | ❌ 无保护 | ❌ 但 Event Bus 不会重复推 | ✅ PendingInteractiveReplayState | ❌ 但线程模型天然串行 | ❌ 依赖状态机 | **✅ `createResolveOnce` + `claim()` 原子守卫，多路竞速下唯一胜出** |
| **快照恢复防重放** | ❌ 直接覆写 | ✅ 进程关闭 fail 所有 pending | ✅ `should_replay_snapshot_request()` | ❌ 纯内存无恢复 | ✅ SQLite OCC | ❌ 纯内存无恢复 |

### 3.4 交互接口解耦对比

| 维度 | 当前 (MyAgent) | OpenCode | Codex | Hermes Agent | OpenClaw | **Claude Code** |
|------|---------|----------|-------|-------------|----------|----------------|
| **端口抽象** | ✅ `InteractionPort` | ✅ `Service.Interface` | ❌ 事件驱动无独立 trait | ❌ 回调注入 | ✅ `onBlockReply/onApprovalEvent` | **✅ `ToolUseContext.requestPrompt` + `PermissionContext` + `checkPermissions()`** |
| **UI 状态管理** | 内嵌在 InteractionHandler | ✅ 纯状态机与渲染分离 | ✅ 状态机 overlay | prompt_toolkit 渲染 | Task Flow | **✅ useReducer 状态机 + React/Ink 渲染分离，最完善** |
| **多通道支持** | ❌ 仅有 CLI | ✅ CLI/TUI + HTTP API + Web App | ✅ CLI/TUI + WebSocket | ✅ CLI + Telegram + Discord + Slack | ✅ Slack + TG + Discord + Matrix + CLI | **✅ REPL + StructuredIO + Bridge(claude.ai) + Channels(TG/Discord)** |

### 3.5 关键可借鉴设计

1. **Claude Code 的 `createResolveOnce` + `claim()` 原子竞速守卫**：在多路并行审批路径（本地UI + 远程Bridge + 频道 + Hook + 分类器）中，只有第一个胜出者的结果被采纳。这是在复杂多通道场景下防止重复响应的最佳实践。文件：`src/hooks/toolPermission/PermissionContext.ts`
2. **Claude Code 的多问题分页 UI（`use-multiple-choice-state.ts`）**：支持 1-4 个问题/次，带分页导航和提交前回顾（SubmitQuestionsView），用户体验最佳。文件：`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` + `src/components/permissions/AskUserQuestionPermissionRequest/`
3. **Claude Code 的选项 `preview` 字段**：选项可附带 HTML/Markdown 预览内容，用于对比展示不同方案的效果。这是 OpenCode/Codex 都不具备的高阶特性。
4. **Claude Code 的权限审批竞速架构（`interactiveHandler.ts`）**：5 路并行审批路径 + `createResolveOnce` 守卫，兼顾本地快速响应和远程便捷审批。文件：`src/hooks/toolPermission/handlers/interactiveHandler.ts`
5. **Claude Code 的 `checkPermissions()` 权限级联**：settings.json → 运行模式 → 工具级别 → 特定规则，层层递进的权限决策模型。文件：`src/hooks/useCanUseTool.tsx` + `src/utils/permissions/permissions.ts`
6. **OpenCode 的结构化选项模型（`label + description`）**：取代当前平铺的 `string[]`，可读性和可用性更强。文件：`packages/schema/src/question.ts`
7. **OpenCode 的纯状态机与渲染分离（`question.shared.ts`）**：UI 逻辑可独立测试、可跨平台复用。文件：`packages/opencode/src/cli/cmd/run/question.shared.ts`
8. **Codex 的 `PendingInteractiveReplayState`**：切换线程/Agent 重放快照时，仅当请求仍 pending 才重放 UI，防止重复拉起。文件：`codex-rs/tui/src/app/pending_interactive_replay.rs`
9. **Codex 的 `auto_resolution_ms`**：用户不回答也不阻塞的超时兜底机制，配置范围 60s-240s。文件：`codex-rs/protocol/src/request_user_input.rs`
10. **Codex 的多问题批量提交（`questions: Vec`）**：支持一次向用户提出多个独立问题，减少模型调用次数。同上。
11. **Hermes Agent 的 `_NEVER_PARALLEL_TOOLS` frozenset**：虽过于脆弱不宜直接引用，但"禁止并行执行 clarify"的思路与 MyAgent 的 `human_interruption` 执行模型一致，后者是更优雅的等价方案。文件：`agent/tool_dispatch_helpers.py`
12. **OpenClaw 的 `MessagePresentation` 可移植 UI 模型**：为未来的多通道（Web UI、Telegram、VS Code Webview）预留跨平台 UI 抽象。文件：`src/interactive/payload.ts`

### 3.6 竞品结论校正

- **OpenCode 不应被低估为“单题模型”**：源码已确认 `Question.Request.questions` 是数组，`Question.Reply.answers` 是二维数组，且 `question.shared.ts` 明确区分了单题立即提交与多题确认提交两条路径。因此，OpenCode 对 MyAgent 的有效参考不只是“结构化选项”，还包括“批量问题 + 多值答案 + 纯状态机渲染分离”。
- **Codex 的强项应界定为“批量问题、结构化回答、防重放与自动兜底”**：`request_user_input.rs` 确认了 `questions: Vec<_>`、按问题 id 组织的 `HashMap<String, RequestUserInputAnswer>`、以及 `auto_resolution_ms`。但就本次核对的协议文件而言，未看到像 `multiSelect: boolean` 这样的显式字段，因此不应把 Codex 作为“显式多选 UI”证据，而应作为“多问题批量提交 + 结构化回答 + 快照重放治理”的证据。
- **MyAgent 当前已有可复用的 Clack 交互栈**：仓库内已经在 `/model`、`/workmode`、交互菜单等路径使用 `@clack/prompts` 与自定义 `selectWithCleanCancel` 适配层。因此 ask 方案不应继续围绕手写 `readline` 多选扩展，而应优先复用现有的 Clack 栈，并沿用 `InputListener` 的 stdin 独占约束。

### 3.7 竞品对照否决的方案

- **Hermes Agent 的纯回调注入（`clarify_callback`）**：虽然简洁，但缺乏类型安全和端口抽象，不适合 MyAgent 现有的端口适配器架构。
- **Codex 的纯内存 oneshot channel**：跨重启会丢失状态，不适合需要快照持久化的场景。MyAgent 现有的快照 + PendingInteraction 序列化方案更健壮。
- **OpenClaw 的 Task Flow SQLite 持久化**：对于简单的"暂停-回答-恢复"场景过于重量级，适合复杂工作流但不适合轻量交互。

## 4. 方案对比与推荐方向（竞品验证）
| 评估维度 | 方案 A：在现有模型上最小修补 | 方案 B：升级为结构化提问契约 | 结论 |
| :--- | :--- | :--- | :--- |
| 修复重复提问 | 可在 `CliFacade` / `InteractionHandler` 增加进行中标记与 interactionId 去重 | 同样可以覆盖，并能顺手把串行语义写进契约 | 两者都能做，但 B 更完整 |
| 支持多选 | 只能临时约定逗号分隔并继续返回单个字符串，语义脆弱 | 将问题模式与答案结构显式化，可稳定支持多选 | B 明显更合理 |
| 选项类型一致性 | 仍依赖模型自觉，不具备结构约束 | 可引入分组、类型或分步提问规则，约束模型输出 | B 更可控 |
| 持久化与恢复 | 表面改动小，但会把真实复杂度藏在字符串编码里 | 需要调整挂起答案模型与恢复逻辑，但语义清晰 | B 成本更高但债务更少 |
| 测试可测性 | 需要围绕字符串协议堆特判，测试脆弱 | 可以按问题模式、答案结构和去重状态分层测试 | B 更稳 |
| 后续扩展 | 继续堆 `multiSelect`、`allowFreeInput` 等布尔开关，容易失控 | 可扩展到单选、多选、自由输入、分组问题等统一范式 | B 更适合新项目 |

**推荐路径**：仍然选择方案 B，但需要从原先的“两步泛化方案”收紧为“三阶段落地”，否则容易把几个不同层级的问题揉在一起：

1. **先治理交互生命周期，不碰问题能力扩张**：先引入“同一挂起提问只允许一个活动 UI”的串行与去重保护，至少覆盖 `interaction_request`、`/resume`、快照恢复重放三条入口。这里参考的是 Codex 的 `PendingInteractiveReplayState` 与 Claude Code 的 `createResolveOnce` / `claim()`，但实现上应保持 MyAgent 当前单 CLI 通道的轻量形态。
2. **直接升级到批量问题 + 结构化回答契约，而不是只修单题多选**：既然 OpenCode、Codex、Claude Code 都证明了“一个交互里承载多个独立问题”是成熟路径，而用户当前痛点又恰恰是“不同语义维度混在一个题里”，那么 MyAgent 不应停留在“单题 + multiSelect + 逗号拼接”的过渡方案，而应直接改为 `questions[]` + 结构化 `answers`。这样才能在不增加多轮模型往返的前提下把“当前状态”“目标”“环境事实”拆开。
3. **CLI 渲染统一收敛到现有 Clack 栈**：仓库已经引入 `@clack/prompts` 并有自定义单选适配层，后续 ask 的单选、多选、Other、自定义输入应优先基于同一套交互栈扩展，而不是继续维护一套平行的手写 `readline` 逻辑。这样既能复用现有取消态/指引/footer 渲染经验，也更符合之前已验证过的 stdin 独占约束。

在这三个阶段里，**本轮不建议引入的内容**也要明确：不需要第一阶段就复制 Claude Code 的 React/Ink 渲染层，不需要第一阶段就做 OpenClaw 式 SQLite 流程持久化，也不需要第一阶段就把 `preview`、多通道审批竞速等高阶能力一并带入。

## 5. 约束、风险与未知项
- `PendingInteraction.answer`、`InteractionPort.askUser()`、`resumePendingInteraction()` 当前都是单字符串契约，若升级为结构化答案，挂起恢复链路与快照持久化都要一起调整，不能只改 CLI。
- 需要定义明确的提问模式边界，例如“单选”“多选”“纯自由输入”“单选+其他”，避免继续通过多个布尔字段组合表达。
- 需要定义多选答案的顺序、去重、空选择和自由输入混合时的规则，否则即便结构化后仍会出现歧义。
- 需要决定是支持”同题分组展示”，还是强制把多维问题拆成多个 `ask_user_question`。综合 OpenCode、Codex、Claude Code 的做法，更推荐“单次交互承载多个独立问题”的批量模式，而不是“一个题里混多个语义维度”。
- 现有测试覆盖明显不足，后续设计若不补足自动化与手动场景，很容易再次出现”工具层支持、CLI 层丢语义”的回归。OpenCode 的纯状态机与渲染分离设计值得借鉴——它让 UI 逻辑可独立于渲染层测试。
- 快照恢复防重放是一个必须在第二阶段处理的隐患。Codex 的 `PendingInteractiveReplayState` 在切换 Agent/线程时通过 `should_replay_snapshot_request()` 判断是否重放 UI，这一机制对 MyAgent 的快照恢复链路有直接参考价值。Claude Code 虽然无此机制（纯内存），但其 `createResolveOnce` + `claim()` 模式对其他场景的多路并行竞速防御有借鉴意义。
- 由于仓库当前已经依赖并使用 `@clack/prompts`，如果 ask 继续独立维护 `readline` 分支，后续会出现两套交互系统并行演化的问题：取消语义、提示 footer、键位约定、stdin 独占规则都可能再次漂移。

## 6. 否决方案
- 仅在 `InteractionHandler` 中增加逗号分隔解析：这只能让终端表面看起来支持多选，但底层仍是单字符串答案，挂起恢复、快照持久化和语义校验都会继续失真。
- 继续使用平铺 `string[]` 承载所有问题类型：这会持续诱导模型把不同语义维度混在一起，无法从结构上约束“选项必须同类”。
- 只靠提示词约束模型不要重复提问或不要混搭选项：这些问题已经落在运行时契约和数据模型上，不能只靠提示词补救。
- **Claude Code 的 Promise + React 渲染 + Queue 架构**：虽然是最完善的多通道交互模型，但其依赖 React/Ink 全功能 TUI 框架的架构太重，不适合 MyAgent 当前基于 readline 的轻量 CLI。其设计思想（队列串行、原子竞速守卫、分页导航）值得借鉴，但不应直接复制渲染层实现。
