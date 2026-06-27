# 探索主题: 项目根基缺陷排查

## 1. 问题定义

在进入新功能开发前，对当前项目的核心链路进行全面的代码审读与缺陷评估。
重点关注架构一致性、安全性边界、异步边界的健壮性和技术债务。

## 2. 关键发现与调研结果

- **代码库现状**：项目整体架构采用六边形架构（Ports & Adapters），核心链路为 `SessionManager → AgentLoop → Plugin Pipeline → ToolDispatcher`，架构设计层次清晰。
- **核实与洞察**：经过两轮审查修正。初版存在三处误判（H-2/H-3 高估，M-4 低估）；二版经用户技术反馈后，发现 H-1 的影响范围比预期更复杂，H-2 的修复方案存在技术漏洞，M-1 的修复方向需调整。

---

## 3. 缺陷清单（终版）

### 🔴 高危缺陷

#### H-1：规则/技能加载存在双轨制职责割裂，技能系统路径仍硬编码

- **位置**：`src/core/usecases/contextLoader.ts` L12-14、`src/core/usecases/RuleManager.ts` L46-72
- **现状澄清**：`RuleManager` 完全**没有**调用 `contextLoader.ts` 的任何函数，而是自己独立实现了规则加载逻辑（基于 `process.cwd()`），因此**系统提示词中注入的全局规则（`.agent/global_rules.md`）和局部规则（`.myagent.md`）是健康的，不受硬编码影响**。
- **真实影响范围**：硬编码路径（`DEV_SKILLS_DIR` 等）仅影响**技能系统**（`SKILL.md` 的发现与加载）。换机器后，技能列表为空，Agent 无法使用任何通过 `skill` 工具调用的扩展能力，但规则注入不受影响。
- **深层架构问题**：两套规则加载逻辑并行存在且互不知晓——`RuleManager` 自行推导路径，`contextLoader` 硬编码路径——且两者对规则文件的路径约定也不一致（`.agent/global_rules.md` vs 硬编码绝对路径），是典型的职责边界割裂。
- **修复方向**：`contextLoader.ts` 中的所有加载函数（`loadGlobalRules`、`loadLocalRules`、`refreshSkillsCache` 等）应彻底无状态化，改为接受显式的 `workspacePath` 参数；调用方（`RuleManager` 或 `ToolRegistry`）在获取到合法的 `workspace` 路径后显式传入，消除全局副作用与路径硬编码。

#### H-2：`flushPendingNotifications` 的 `nextTick` 导致通知消息被永久覆盖

- **位置**：`src/core/domain/context.ts` L93-101，`src/core/usecases/plugin-runner.ts` L163-170
- **触发序列**：
  1. `BeforeToolSelection` 结束 → `isProcessing = false` → `nextTick` 调度 flush
  2. `BeforeModel` **同步**紧接着开始（同一 `async` 函数内无 `await` 间隙）→ `isProcessing = true` → `createDraft(baseState)` 捕获此刻的 `messageHistory`（通知尚未在其中）
  3. `nextTick` 触发 → `messageHistory.push(通知)` — **写入真实 `messageHistory`，不在 Draft 内**
  4. `BeforeModel` 结束 → `finishDraft` → `updateHistory(finalState.history)` — **Draft 版本整体覆盖 `messageHistory`，通知消息被彻底抹除**
- **影响**：异步系统通知（如定时任务完成反馈）在特定时序下**永久丢失**，该时序在相邻两个 Hook 管道之间有通知到达时必然触发。
- **修复方向（已修正，排除错误方案）**：
  - ❌ **不能**在 `nextTick` 回调中直接 `if (isProcessing) return`——若此时仍有 Hook 管道在执行，`pendingNotifications` 将永远无人消费，通知同样丢失。
  - ✅ **正确方案**：不清空、不丢弃，在 `AgentLoop` 每一轮交互最后（`SessionEnd` Hook 结束后、save state 前）强制执行一次终态 flush，确保所有通知最终都落入历史栈。

#### H-3：`DefaultContextAdapter` 将 `recentFiles` 注入为 mid-sequence `system` 消息

- **位置**：`src/adapters/context/DefaultContextAdapter.ts` L58-62、L64-70
- **问题**：当 `recentFiles` 存在时，注入的消息为 `role: 'system'`，并被 `splice` 插入到历史第 2 位。此时序列变为 `[system, user(checkpoint), system(recentFiles), ...]`，即 `system` 消息出现在 `user` 消息之后。
- **影响**：OpenAI spec 要求 `system` 消息只能位于序列最开头。`o` 系列模型、DashScope（阿里云）、GLM 等主流第三方兼容 API 均可能以 HTTP 400 拒绝此类请求，导致 Agent 推理完全中断。当前在 DeepSeek 上可能静默工作，但存在随接入模型切换而随时爆发的风险。
- **修复方向**：将 `recentFiles` 改为 `role: 'user'` 消息，或直接将 `<recent_files_inventory>` XML 片段追加合并到 `conversation-checkpoint` 消息的 `content` 末尾，100% 规避 Spec 兼容性风险。

---

### 🟠 中危缺陷

#### M-1：`CompactionService.compact()` 截断时存在"信息真空"窗口期

- **位置**：`src/core/usecases/CompactionService.ts` L55-74
- **问题**：`compact()` 同步硬截断（pointer-based），而 AI 摘要由 `triggerAsyncCompactionIfNeeded` 异步生成。两者之间存在窗口期——截断已发生，但 AI 摘要尚未写入时，模型下一轮收到的是静态兜底文本（或空摘要），历史连贯性严重断裂。
- **影响**：在 Token 高压触发截断时，若异步摘要还未生成，模型将在"信息真空"状态下继续执行，可能产生错误的续写行为。
- **修复方向（已修正）**：
  - ❌ **不建议**在 `compact()` 中 `await` AI 摘要——这会将异步提升改造为同步阻塞，将单次交互延迟拉升为多次 LLM 调用的时间之和，代价不可接受。
  - ✅ **推荐"滚动窗口"方案**：截断时物理保留最近 3.5 轮完整对话（而非当前的固定 8 条消息），使模型自身有足够的上下文短程记忆来弥合信息断层。这样，即便摘要尚未生成，模型也能基于保留的最近对话自洽，避免真空状态，同时规避同步阻塞。

#### M-2：`ContextRepository.saveState()` 吞掉所有 I/O 异常

- **位置**：`src/core/usecases/ContextRepository.ts` L44-46
- **问题**：`catch` 块完全静默，没有任何日志输出。
- **影响**：磁盘满、权限不足、路径不可写等情况下，会话状态悄无声息地丢失，用户和开发者均无感知。与 `CompactionService` 中有 `logger.warn` 的做法不统一。
- **修复方向**：补充 `logger.warn` 输出异常信息，保持可观测性。

---

### 🟡 低危缺陷（技术债务）

#### L-1：`AgentLoop.runPostRunCheck()` 领域层直接 exec Shell 命令

- **位置**：`src/core/usecases/agent-loop.ts` L814-838
- **问题**：领域层核心类 `AgentLoop` 直接依赖 `child_process` 并执行 shell 命令，违反六边形架构——领域层不应持有 I/O 副作用。`process.cwd()` 与 `appConfig.workspace` 在正常使用下等价，运行时路径不会出错。
- **影响**：无法在单元测试中 mock 替换；若未来出现 `workspace ≠ cwd` 的场景，会跑错目录。当前生产环境无影响。
- **修复方向**：下沉为独立插件通过 `PostRunHook` 钩子注入，或抽象为 `CodeCheckPort` 端口移入 `adapters` 层。

#### L-2：`MemoryRefinementToolRegistry.getTool()` 将写工具标记为 `'read'`

- **位置**：`src/core/usecases/MemoryService.ts` L382-389
- **实际影响**：子 Agent 使用 `emptyPluginRegistry`，`HumanApprovalPlugin` 根本未注册，`securityCategory` 对安全审查链路无任何影响。`FileLockManager` 按读锁获取——因子 Agent 单线程执行无并发竞争，实际无害。
- **问题所在**：代码具有强烈的欺骗性，注释明写"避开 Lint 编译检查"，是主动规避代码审查的不良实践。
- **修复方向**：正确标记为 `'write'`，并通过在受限注册表中重写安全判断逻辑来显式豁免。

#### L-3：`SecurityService` 全局单例的临时白名单跨会话污染隐患

- **位置**：`src/core/usecases/SecurityService.ts`
- **问题**：`temporaryReadWhitelist` 和 `temporaryWriteWhitelist` 是单例级别的 `Set`，多会话并发时会跨会话共享权限。
- **修复方向**：将临时白名单改为 `Map<sessionId, Set<string>>` 结构，或移入 `SessionContext` 管理范围。

#### L-4：`checkCacheAndCalibrate` 是死代码（功能完全失效）

- **位置**：`src/core/usecases/agent-loop.ts` L846-885
- **问题**：该方法定义完整（115 行），但经 grep 确认在整个代码库中无任何调用点。缓存击穿诊断功能完全失效。
- **修复方向**：在 `chat()` 获取到 `event.usage` 后（`AfterModel` 阶段）实际调用此方法，或在确认无用后删除。

#### L-5：`generateSummaryAsync` 中 `localAbortController` 无效占位

- **位置**：`src/adapters/llm/OpenAiLlmAdapter.ts` L310-321
- **问题**：创建了 `localAbortController` 但其 `signal` 永远不会触发，summary 生成理论上可无限挂起（由子 Agent 外层 `subAgentTimeoutMs` 兜底）。
- **修复方向**：改用 `AbortSignal.timeout(summaryTimeoutMs)` 直接传入，语义更清晰。

---

## 4. 约束与风险

- **H-1** 的实际问题不在系统提示词（已由 `RuleManager` 独立实现），而在技能系统（`contextLoader.ts` 仍有硬编码）与双轨架构本身。修复时需统一两套加载逻辑的路径约定。
- **H-2** 的正确修复需要在 `AgentLoop` 的 turn-end 阶段增加终态 flush 逻辑，需协调 `agent-loop.ts` 和 `context.ts` 两个文件。
- **H-3** 改动影响面小，修复成本最低，优先级应在 H-1 之前处理。

## 5. 否决方案

- **H-2 修复：在 `nextTick` 中加 `isProcessing` 守卫后直接 return**：若此时仍有 Hook 管道在执行，`pendingNotifications` 将永远无人消费，通知同样丢失，等价于另一种丢失路径，不可采用。
- **M-1 修复：在 `compact()` 中 `await` AI 摘要同步生成**：将异步提升改造为同步阻塞，代价不可接受，每次压缩都会额外增加一次完整 LLM 调用时延。
- **H-2 原分析（初版）：升级为高危的判断正确，但修复方向存在漏洞，已在本版修正**。
- **H-3 原分析（初版 H-3）：writeMemoryFile 安全欺骗高危判断错误**，子 Agent 用空插件注册表，安全插件不参与，已降级为 L-2。
