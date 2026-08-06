# 子代理体系演进路线图（对齐 Claude Code 源码机制）

> 状态: active
> 创建: 2026-08-06
> 依据: 对照 `D:\projects\Agents\claude-code-analysis` 源码逐条核对的机制映射（AgentTool.tsx / runAgent.ts / forkSubagent.ts / LocalAgentTask.tsx / Task.ts / constants/tools.ts / messageQueueManager.ts）
> 原则: 机制同构、命名照搬、安全只严不松；产品面（UI/团队/实验体系）按 MyAgent 形态适配，不做字节级复刻

---

## 1. 目标与边界

### 目标

单代理层（子代理、fork、后台、任务管理）最终达到与 Claude Code **行为等价**：模型侧能力、用户侧命令、任务生命周期与官方一致，命名直接对照官方源码，用户可用 Claude Code 的知识直接操作 MyAgent。

### 明确不做（不追的差距）

- **缓存字节级对齐**：fork 前缀与父字节一致由子代理保证（`renderedSystemPrompt` 透传本来就是 `buildExactFork` 的要求）；缓存命中是上下文管理模块与 provider 缓存规则的职责，不在本路线图承诺范围。官方"占位闭合让所有 fork 共享缓存段"的缓存经济性优化不做。
- **Agent Team / swarm**：mailbox、task list、权限桥、tmux 后端是独立系统，**明确不在计划内**（用户确认）。
- **coordinator 模式**：主线程改写为 orchestrator 的运行时模式，非目标。
- **GrowthBook 实验平台**：官方用功能开关平台做灰度（fork 本身是实验功能）；MyAgent 用本地配置开关等价替代（forkEnabled、subagentAutoBackgroundMs），不建灰度平台。
- **UI 面板**（/tasks 面板、fork 面板、颜色、进度视图）：暂不考虑，CLI 以文本状态行呈现。

---

## 2. 命名基线（已锁定，后续 change 全部沿用）

| 域 | 已对齐命名 | 官方依据 |
|---|---|---|
| 工具 | `Agent`（description 必填 / prompt / subagent_type / run_in_background） | AgentTool.tsx:82-88 |
| 命令 | `/subtask`、`/tasks`、`/tasks show`、`/tasks stop` | commands.ts |
| 任务 | `TaskManager`、`TaskStateStore`、`taskId === agentId`、状态 `pending/running/waiting_approval/completed/failed/killed/interrupted`、`notified` | Task.ts、LocalAgentTask.tsx |
| 协议 | `async_launched`、`task-notification`、`buildForkedMessages`、`filterIncompleteToolCalls`、`renderedSystemPrompt`、`task_update`、usage(totalTokens/toolUses/durationMs) | AgentTool.tsx、forkSubagent.ts、constants/xml.ts |
| 常量 | `ASYNC_AGENT_ALLOWED_TOOLS`、`ALL_AGENT_DISALLOWED_TOOLS` | constants/tools.ts |
| ID | `agentId` 格式 `a<16位hex>` | utils/uuid.ts |
| 保留 MyAgent 特有 | `SubagentRuntime`、`ScopedToolRegistry`、`ChildPermissionResolver`、`SubagentExecutionController`、`SubagentOutputScanner`、`interrupted` | — |

---

## 3. 演进阶段

### 阶段 0：同步内核（change 1，已归档 ✅）

独立上下文、独立 LLM 客户端、工具作用域（freshForeground）、权限派生、确定性输出扫描、独立 transcript、Skill 迁移。

### 阶段 1：统一任务系统 + fork + 后台（change 2，修正完成，待 apply）

- 统一任务系统：前台也注册任务（taskId === agentId）、`subagentAutoBackgroundMs` 超时自动后台化（手动快捷键 Ctrl+B 列阶段 3）
- 模型 fork 入口（`subagentForkEnabled` 开关默认关）：开关开启时省略 subagent_type 即隐式 fork、强制全部调用后台并隐藏 run_in_background；占位 `tool` 消息闭合（MyAgent 协议）；fork 枚举字节一致 + 调用阶段拒绝
- exact-fork 冻结**最终请求快照**（含记忆投影与插件改写，非仅历史）
- description 必填、usage 报告、后台白名单收窄（去浏览器）
- 审批路由、task-notification 通知、`/subtask`、`/tasks`

**验收**：模型可开前台/后台/fork 三种子代理；你可用 `/subtask`、`/tasks stop` 管理；行为与官方对应能力等价。

### 阶段 2：配置型子代理（对齐 loadAgentsDir.ts / builtInAgents.ts）

| 能力 | 官方机制参考 | 关键点 |
|---|---|---|
| `.myagent/agents/*.md` 定义 | loadAgentsDir.ts:296-393（分层加载、优先级 built-in > plugin > user > project > flag > managed） | frontmatter 字段：tools/disallowedTools/model/permissionMode/maxTurns/background/skills/mcpServers/hooks/color/effort/memory/omitClaudeMd/initialPrompt |
| 内置 Explore / Plan | exploreAgent.ts、planAgent.ts | 只读 + `omitClaudeMd: true`（不加载 CLAUDE.md）、跳过 git status |
| general-purpose 完善 | generalPurposeAgent.ts | `['*']` 工具池 |
| @-mention 用户引导 | utils/messages.ts（提醒转换） | 不绕过 Agent 工具，转成高优先级提醒 |
| `--agent` 会话模式 | AgentTool 之外的主会话入口 | 子代理定义成为主会话 |
| model 解析完整化 | utils/model/agent.ts:37-95 | env > per-invocation > frontmatter > inherit；同 tier 防降级 |
| hooks 映射 | runAgent.ts:531-575（SubagentStart/Stop） | 映射到现有 PluginRegistry 事件体系 |
| 子代理专属 MCP | runAgent.ts:648-656（内联定义新建、字符串引用共享） | MyAgent McpManager 已有基础 |
| 子代理记忆 | loadAgentsDir.ts memory 字段 | user/project/local 三域（与 MyAgent 长期记忆体系融合评估） |

**验收**：写一个 `.md` 文件就能获得一个新子代理类型；Explore/Plan 行为对齐（只读、不加载规则）。

### 阶段 3：隔离与协作增强

| 能力 | 官方机制参考 | 关键点 |
|---|---|---|
| worktree 隔离 | AgentTool.tsx:590-593、utils/worktree.ts | 无变更自动清理、有变更保留并回报 |
| 嵌套多层 | 深度限制扣留 Agent 工具（fork 保留但报错） | 官方默认 3 层可配置 |
| SendMessage 恢复 | SendMessageTool.ts（agentId/name 寻址、队列或 resume） | 已完成子代理可继续对话 |
| TaskStop 模型工具 | TaskStopTool.ts | 模型可停任务（当前只有用户 /tasks stop） |
| outputFile 机制 | getTaskOutputPath / evictTaskOutput | 任务可读输出文件 + `canReadOutputFile` |
| Ctrl+B 后台化 | AgentTool.tsx:886-1053 | 依赖 CLI 输入监听能力评估 |
| verification 类强制后台 agent | verificationAgent.ts（background: true） | 定义级 background 字段 |
| 清理语义对齐 | runAgent.ts:816-859 | killShellTasksForAgent、只关新建 MCP、清缓存 |

**验收**：fork 在 worktree 里跑、模型能自己停任务、子代理结果可恢复继续。

### 阶段 4：不在计划内

Agent Team / swarm（mailbox、task list、权限桥、in-process runner）与 coordinator 模式**明确不纳入本路线图**（用户确认）。如未来需要团队协作，单独立项评估，不并入子代理演进。

---

## 4. 全程贯穿的机制基线（每个 change 必须保持）

1. **权限只继承或收窄**：父 bypassPermissions/acceptEdits 优先不可覆盖；子代理无法自选特权模式。
2. **Agent 放行不等于子工具授权**：每个子工具独立授权、审计。
3. **输出扫描唯一交付边界**：transcript 存原文，父模型只见扫描副本；`task-notification` 只用 deliveredOutput。
4. **资源所有权**：子代理绝不关闭父 LLM/Registry/MCP；后台任务与父 AbortSignal 解绑，会话 close 才有权取消。
5. **通知安全点**：task-notification 永不打断生成；缓冲 + 协议闭合 + 熔断 + `notified` 原子去重。
6. **重启诚实收敛**：不恢复执行，只收敛为 `interrupted`。
7. **Skill 学习隔离**：子代理循环不计入父 Skill/Memory cadence；Skill Review/Curator 专用配置不受公共内核影响。
8. **命名对照**：新机制引入时先查官方命名表（第 2 节），有对应就照搬。

---

## 5. 差距清单（对齐/可追/不追）

| 能力 | 差距类型 | 阶段 | 说明 |
|---|---|---|---|
| Agent 工具参数 | 已对齐 | 0-1 | 缺 model 字段（MyAgent 多 provider，阶段 2 评估） |
| 统一任务系统 | 已对齐 | 1 | 多了 pending 排队与容量限制（官方本地无上限） |
| fork 双入口 | 已对齐 | 1 | 官方省略即 fork，我们同语义 + 开关 |
| 输出扫描 | **超越官方** | 0 | 官方无此机制 |
| 预设 .md 子代理 | 可追 | 2 | |
| Explore/Plan | 可追 | 2 | |
| hooks | 可追 | 2 | 映射 PluginRegistry |
| MCP 内联 | 可追 | 2 | |
| worktree | 可追 | 3 | |
| 嵌套多层 | 可追 | 3 | |
| SendMessage 恢复 | 可追 | 3 | |
| TaskStop / outputFile | 可追 | 3 | |
| Ctrl+B | 可追（待评估） | 3 | 依赖 CLI 输入能力 |
| 缓存字节级对齐 | **不追** | — | 缓存归上下文管理模块；子代理只保证 fork 前缀一致 |
| Agent Team / coordinator | **不追** | — | 明确不在计划内（用户确认） |
| GrowthBook 实验平台 | **不追** | — | 本地配置开关等价替代 |
| UI 面板 | 暂不考虑 | — | CLI 文本状态行呈现 |

---

## 6. 决策记录

| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-08-06 | 统一任务系统（前台也注册任务、可中途后台化） | registerAgentForeground / backgroundSignal（LocalAgentTask.tsx:526） |
| 2026-08-06 | 模型 fork 入口（开关默认关）而非禁止 | forkSubagent.ts 隐式 fork 语义 + 占位闭合方案 |
| 2026-08-06 | 占位闭合 + filterIncompleteToolCalls 兜底 | forkSubagent.ts:107-169 + runAgent.ts:866-904 |
| 2026-08-06 | fork 使用父精确工具池 + 调用时拒绝 Agent | useExactTools（runAgent.ts:500） |
| 2026-08-06 | 后台白名单收窄去浏览器 | ASYNC_AGENT_ALLOWED_TOOLS（constants/tools.ts:55-71） |
| 2026-08-06 | 保留并发上限与 FIFO 排队（官方本地无上限） | 本地运行防限流风暴，pending 是增强 |
| 2026-08-06 | 命名照搬官方 | 降低与 Claude Code 对照的理解成本 |
| 2026-08-06 | 输出扫描保留并强化（官方无） | 安全只严不松原则 |
| 2026-08-06 | 缓存对齐归上下文管理模块，子代理只保证 fork 前缀一致 | 各大模型均有缓存，命中由 provider 规则决定（用户确认） |
| 2026-08-06 | Agent Team / coordinator 明确不在计划内 | 用户确认 |
| 2026-08-06 | 实验体系以本地配置开关替代（不建 GrowthBook） | fork 开关与 autoBackgroundMs 已覆盖灰度需求 |
| 2026-08-06 | UI 面板暂不考虑 | 用户确认，CLI 文本状态行呈现 |
