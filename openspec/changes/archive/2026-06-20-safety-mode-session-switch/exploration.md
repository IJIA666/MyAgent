# 探索主题: 安全模式（WorkMode）会话切换机制与安全隐患分析

## 1. 问题定义
在当前 Agent 项目中，工作安全模式（`WorkMode`，即 `Safe`、`Auto`、`YOLO`）负责限制或放行高危操作（如执行终端命令、修改文件系统、应用补丁等）。
本主题旨在深入探讨：如果在一个交互会话（Session）中动态切换安全工作模式，系统的内部状态会发生何种变化？这一切换流程在现有的设计与实现下是否存在潜在的安全隐患、数据不一致或越权漏洞？

## 2. 关键发现与调研结果
- **代码库现状**：
  - **静态全局变量管理**：在 [terminal-config.ts](file:///d:/Projects/MyAgent/src/action/tools/system/terminal-config.ts) 中，`workMode` 被声明在模块顶层的静态全局变量 `globalState.workMode` 里。它是一个进程级的全局单例，而非会话级别的局部变量。
  - **磁盘依赖与重载覆盖**：[ExecuteCommandTool.ts](file:///d:/Projects/MyAgent/src/action/tools/system/terminal.ts) 及其它文件系统写入工具（如 `WriteFileTool`, `EditFileTool`）在执行 `checkSafety` 的生命周期时，第一步均会强制调用 `loadWorkMode()` 从物理磁盘配置文件 `.agent/config.json` 中重载模式。
  - **冻结的全局配置 (数据割裂)**：[loader.ts](file:///d:/Projects/MyAgent/src/config/loader.ts) 的 `loadConfig()` 会在启动阶段一次性完成全局配置的引导，并使用 `Object.freeze` 深度冻结全局 `AppConfig`（其中包含了 `workMode`）。若在运行期间通过 `saveWorkMode` 修改了磁盘和内存，已被冻结的全局 `config.workMode` 依然保持旧值，从而与 `globalState.workMode` 分裂。
  - **缺乏会话级别沙箱隔离**：[HumanApprovalPlugin.ts](file:///d:/Projects/MyAgent/src/brain/plugins/HumanApprovalPlugin.ts) 包含 `sessionContext` 以支持多会话管理，但安全模式并没有作为 `SessionContext` 的上下文变量进行隔离。
- **Claude Code 竞品深度分析**：
  在深入分析 `d:\Projects\Agents\claude-code` 项目后，发现其在处理安全模式切换和会话防护上，有以下非常成熟的机制可供借鉴：
  - **无状态上下文鉴权（`ToolPermissionContext`）**：Claude Code 在 [permissions.ts](file:///d:/Projects/Agents/claude-code/src/types/permissions.ts) 中设计了无状态的、由上下文承载的权限状态。工具执行的鉴权完全依赖当前会话的 `ToolPermissionContext` 副本，彻底杜绝了进程级全局静态变量的跨会话污染。
  - **即时安全的模式转换（`transitionPermissionMode`）**：在 [permissionSetup.ts](file:///d:/Projects/Agents/claude-code/src/utils/permissions/permissionSetup.ts#L597-L646) 中，当会话切换安全模式时（例如 Plan、Auto、Default 模式之间的循环切换），并不回写磁盘，而是通过状态机计算出新模式对应的 `ToolPermissionContext` 副本，以保证在单个会话的生命周期中即时生效且与其它会话绝对隔离。
  - **高危规则动态剥离与还原（Strip & Restore）**：Claude Code 在切换至 `auto` 模式时，会调用 `stripDangerousPermissionsForAutoMode` 自动剥离可能会绕过 Classifier 审查的高危规则（如 `Bash(*)` 通配符放行），并暂存在 `context.strippedDangerousRules` 中。在退出 `auto` 模式时，再调用 `restoreDangerousPermissions` 将其还原。这有效避免了在模式切换中由于历史遗留通配规则造成的安全屏障被穿透。
  - **更新目标的分级隔离（`PermissionUpdateDestination`）**：Claude Code 对所有权限更改 `PermissionUpdate` 都强制显式指定 `destination`。日常的会话切换只作用于内存级 `session` 目的地，只有当用户明确指示要持久化到全局配置或项目配置时，才会写入 `userSettings` 或 `projectSettings` 等磁盘文件。
- **OpenCode 竞品深度分析**：
  在分析 `d:\Projects\Agents\opencode` 的权限服务 [permission.ts](file:///d:/Projects/Agents/opencode/packages/core/src/permission.ts) 后，发现其基于 Effect TS 架构提供了优秀的会话安全隔离设计：
  - **基于 `sessionID` 绑定的挂起队列**：OpenCode 的权限申请 `AssertInput` 强制包含 `sessionID`。在内存中，所有的挂起请求维护在一个 `pending: Map<ID, Pending>` 中。不同会话的异步等待（由 `Deferred` 实现）在同一个 Map 里通过 `sessionID` 实现了逻辑上的天然隔离。
  - **熔断式级联拒绝机制（Cascade Reject）**：在 `reply` 处理函数中，一旦某一会话的权限请求被用户拒绝（`reply === "reject"`），系统不仅会拒绝当前请求，还会**遍历 pending 队列，将同一 `sessionID` 下的所有其他挂起请求一并置为 reject 予以熔断驳回**。然而，这一熔断动作完全不会波及其他 `sessionID` 的会话，确保了多会话隔离下的最大化防御。
  - **静态覆盖优先与动态即时放行（Override & Eventual Consistency）**：在判定权限时，OpenCode 首先评估内置的 `configured` 策略，如果被内置规则显式 `deny`，则直接拦截，绕过任何持久化的 savedRules 放行规则，保证了策略覆盖的安全下限。此外，当某一请求被授权为永久放行（`always`）后，系统会**实时重新评估**同一会话队列中剩下的所有挂起项，若通过则自动唤醒并放行，实现了授权的动态即时生效。
- **Hermes 竞品深度分析**：
  在剖析 `d:\Projects\Agents\hermes-agent` 的安全模块 [approval.py](file:///d:/Projects/Agents/hermes-agent/tools/approval.py) 后，发现其在 YOLO 模式的生命周期与环境防护上具有极高的安全指导意义：
  - **导入期环境变量冻结（_YOLO_MODE_FROZEN）**：为了防止在会话运行期间智能体被 Prompt 注入攻击或通过恶意脚本动态修改进程的环境变量（例如调用 `os.environ["HERMES_YOLO_MODE"] = "1"`）进行提权绕过，Hermes 强制在**模块导入（Import）阶段一次性冻结** YOLO 模式变量。之后的所有校验仅比对模块内冻结的布尔常量，彻底斩断了运行时动态篡改环境变量的越权提权路径。
  - **底线级别的硬核黑名单（Hardline Floor）**：在 YOLO 模式判断之下，Hermes 设有一条绝对不可逾越的底层黑名单过滤 `HARDLINE_PATTERNS`（如毁灭性递归删除 `rm -rf /`、格式化硬盘 `mkfs`、向原始块设备覆写等）。哪怕会话处于 YOLO 模式（或者配置为完全不审批），一旦触发黑名单规则，也会被**无条件强制拦截**。
  - **ContextVars 实现的多线程上下文隔离**：面向 Gateway 等并发多线程/多协程运行场景，Hermes 舍弃了共享的全局变量或文件读写，使用 `contextvars.ContextVar` 来独立维护每个线程/任务内部专属的 `session_key`、`turn_id`。这在不依赖进程全局标志的同时，做到了彻底的线程级安全隔离。
- **OpenClaw 竞品深度分析**：
  在剖析 `d:\Projects\Agents\openclaw` 项目在多端/移动端架构下的会话控制服务 [session.ts](file:///d:/Projects/Agents/openclaw/packages/acp-core/src/session.ts) 后，发现其在会话边界的生命周期与主动熔断保护上具有独特的防范逻辑：
  - **基于活跃心跳的会话超时回收（Reap Idle Sessions）**：OpenClaw 内置了 `AcpSessionStore` 会话库，会通过 `touchSession` 实时跟踪每次交互的时间戳。在内存限制（`maxSessions`）或空闲超时（`idleTtlMs`）达到阈值时，自动对其进行内存驱逐与安全销毁。
  - **会话销毁联动任务主动中止（Abort Active Run）**：在会话被销毁（`removeSession`）或主动取消（`cancelActiveRun`）时，系统绝不遗留任何悬挂运行的后台子进程，而是会**立即对该会话当前执行的 `activeRunId` 派发 `abortController.abort()` 中止信号**进行强制熔断退出。这在防范高危的后台命令失控、断联后无限循环执行等问题上形成了稳固的安全网。
  - **会话类型与特权隔离**：OpenClaw 区分了会话模式的用户面对交互级（`interactive`）与父级代理委派级（`parent-owned-background`），对于后者，安全机制只允许其与父级代理之间通过内部信道流转状态，而不向外暴露或直接交互，实现了极佳的权限分级隔离。
- **gemini-cli 竞品深度分析**：
  在剖析 `d:\Projects\Agents\gemini-cli` 的沙箱管理服务 [sandboxManager.ts](file:///d:/Projects/Agents/gemini-cli/packages/core/src/services/sandboxManager.ts) 后，发现其在沙箱路径层面的黑白名单防范设计极具参考价值：
  - **仓库治理与宪法文件写保护（GOVERNANCE_FILES）**：针对 `.git`、`.gitignore`、`.geminiignore` 等用于仓库规则控制和忽略映射的文件，沙箱中强行设置为只读保护，防止大模型通过强行覆盖规则来逃逸限制。
  - **敏感秘密文件彻底隐藏（SECRET_FILES）**：针对 `.env` 和 `.env.*` 等包含关键凭据和 Key 的机密文件，沙箱执行时会**剥离全部读写权限**（完全隐去/隐藏），即便命令正在以 YOLO 模式执行，也无法读取机密文件以防凭据被窃取。
- **codex 竞品深度分析**：
  在剖析 `d:\Projects\Agents\codex` 的 Rust 核心执行器 [lib.rs](file:///d:/Projects/Agents/codex/codex-rs/exec/src/lib.rs) 后，发现其对 YOLO 模式有独特的硬限降级管理：
  - **硬约束降级机制（Requirements-Constrained Demote）**：在校验逻辑中，即使大模型或用户传参了 `--yolo` 标志，一旦任务命中特定的系统预设限制或特许只读约束，系统会**强制要求跳过 YOLO 模式并降级为需要沙箱批准的受限状态**。这保证了无论外界如何配置，底层硬底座策略永远享有最高决定权。
- **tinypace-ai-desktop 竞品深度分析**：
  在剖析 `d:\Projects\Agents\tinypace-ai-desktop` 的主进程服务 [main.ts](file:///d:/Projects/Agents/tinypace-ai-desktop/electron/main.ts) 与 [AIChatService.ts](file:///d:/Projects/Agents/tinypace-ai-desktop/electron/services/AIChatService.ts) 后，发现其在桌面客户端架构中具有极佳的防御深度：
  - **基于 Host 主进程强制访问控制的 IPC 卡关**：所有的权限核查与确认回复（`TOOL_PERMISSION_REPLY`）完全发生在绝对可信的 Electron 主进程中。处于沙箱和 Web 环境中的 Renderer 前端界面仅用于渲染展示，无法干涉底层决策。这杜绝了模型在渲染端利用溢出或 JS 欺骗手段来伪造确认回复的风险。
  - **最小系统权限白名单（Least Privilege）**：在主窗口创建时，通过 `setPermissionRequestHandler` 对渲染窗口的设备权限进行了最严密的管控，除了白名单允许 of 音视频，一律拒绝其他任何设备级原生访问权限。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (现状：全局磁盘/内存共享) | 方案 B (推荐：会话级安全上下文隔离) | 选型分析 |
| :--- | :--- | :--- | :--- |
| **多会话隔离性** | 弱 ✗ (全局污染，一个会话切换 YOLO 会导致所有并发会话全部降级为 YOLO) | 强 ✓ (不同会话独立持有 `workMode` 状态，互不干扰) | B 方案隔离性极高 |
| **配置数据一致性** | 差 ✗ (修改 `globalState.workMode` 会导致已冻结的 `AppConfig.workMode` 产生不一致) | 好 ✓ (配置只作为默认缺省，实际模式从 Session 动态取得，无数据割裂) | B 方案一致性更优 |
| **会话切换内存持久性**| 差 ✗ (如果仅修改内存 `globalState`，下次工具调用 `loadWorkMode` 会被磁盘重载覆盖而丢失) | 好 ✓ (Session 生命周期内状态保持稳定) | B 方案逻辑稳定 |
| **防 Prompt 注入能力**| 弱 ✗ (模型被注入后若成功调用修改，危害直接扩散至全局系统) | 强 ✓ (即使单个会话被劫持，也仅局限于当前会话) | B 方案防线更安全 |

**推荐路径**：
应当将工作安全模式（`workMode`）从全局单例重构为**会话级（Session-scoped）**属性：
1. **解耦全局重载**：在 `SessionContext` 中维护 `workMode` 状态，作为该会话私有的安全控制变量，初始值从全局配置中拷贝。
2. **重构卡关判定**：在工具的 `checkSafety` 中，安全核查必须通过 `sessionContext.workMode` 来获取安全级别，而不是调用 `loadWorkMode()` 直接刷新静态全局变量。
3. **配置文件只读化**：全局配置文件 `.agent/config.json` 仅作为系统初始启动的默认安全级别参考，禁止在运行期通过会话内工具对其直接修改。
4. **级联安全熔断**：借鉴 OpenCode 机制，引入会话级排队申请的熔断拒绝（Cascade Reject）。一旦某个会话被用户驳回了高危命令或文件写入，立即自动拒绝该会话下等待的其他全部高危权限申请，防止在多会话并发下漏洞扩散。
5. **敏感环境变量静态冻结**：借鉴 Hermes 经验，在安全模式 `workMode` 模块加载时，应对全局初始环境变量进行静态冻结，防止运行期模型通过注入改写环境变量并越权提权。
6. **底线黑名单硬拦截（Hardline Floor）**：设立一套独立于 `workMode` 的底线黑名单拦截逻辑，即使在 YOLO 模式下，针对格式化、系统破坏或关机等极其危险的操作也一律强制拦截，作为绝对的安全地基。
7. **会话生命周期超时联动中止**：借鉴 OpenClaw 机制，为 Session 引入空闲 TTL 超时及清除策略。一旦会话因为超时卸载或被强制垃圾回收，必须**联动调用 `abortController` 主动中止当前会话正在运行的所有活跃后台进程**，避免后台高危操作失控。
8. **硬约束降级防御（Requirements-Constrained Demote）**：借鉴 Codex 实践，对于特定的硬约束（例如只读代码分支、机密变量），即使处于 YOLO 模式也必须降级为需要沙箱批准的安全模式，杜绝人为或模型疏忽造成的安全防护穿透。
9. **进程级强制访问控制与前端隔离**：借鉴 Tinypace 实践，对于客户端/IDE 交互，将敏感鉴权决策与回复控制完全保留在绝对可信的 Main (Host) 主进程中，渲染页面端（UI 交互侧）只做受限的数据呈现和单向信道输入，从架构上封杀模型利用渲染漏洞篡改或伪造特权回复的威胁。

## 4. 约束、风险与未知项
- **外部并发修改响应**：如果外部宿主在运行时强行更改了 `.agent/config.json`（例如用户在 IDE 插件配置界面修改），当前由于工具每次都调用 `loadWorkMode()` 重载，能做到实时响应。如果重构成 Session 级别，需要提供一个事件总线，在磁盘修改后通知并同步更新所有活跃的 Session 模式。
- **与测试环境的兼容性**：自动化测试工具可能会在子进程中频繁重定向 `AUTHORIZED_WORKSPACE_DIR` 并设置临时的 YOLO 状态，需确保重构不破坏测试框架的临时 YOLO 放行逻辑。

## 5. 否决方案
- **否决方案：基于内存 `globalState` 不落盘临时切换**。
  - **舍弃原因**：若仅在内存中改变 `globalState.workMode`，由于当前各个工具在 `checkSafety` 阶段频繁调用 `loadWorkMode()` 从磁盘重载，这种临时切换会被瞬间擦除失效，导致行为难以预测。

## 6. 最终设计重构方案
结合以上竞品分析与当前项目的安全隐患，以及经过深入辩论达成的安全与体验平衡，本项目的最终安全模式重构方案落地为以下 6 个核心控制维度：
- **会话级安全上下文解耦（Session-Scoped Mode）**：
  - **重构路径**：彻底废除 [terminal-config.ts](file:///d:/Projects/MyAgent/src/action/tools/system/terminal-config.ts) 中顶层共享的静态全局变量 `globalState.workMode`，不再让工具在执行 `checkSafety` 时频繁调用 `loadWorkMode` 从磁盘进行强行重载覆盖。
  - **实现**：将 `workMode`（Safe、Auto、YOLO、Plan）转移至 `SessionContext` 中独立管理。每个会话在初始化时，从全局 `AppConfig.workMode` 中拷贝默认安全级作为副本。工具鉴权仅比对 `sessionContext.workMode`，实现多会话物理级隔离，互不污染。
- **配置单向单次加载（One-way Configuration Injection）**：
  - **重构路径**：放弃在模块头部硬性全局冻结环境变量的方案（避免阻碍宿主进行合法的配置热重载）。
  - **实现**：全局配置加载器提供只读的 `defaultWorkMode` 属性。当且仅当 Session 初始化时，将该默认值单向拷贝至会话上下文中。后续会话的安全判定完全依赖已生成的上下文副本，即使全局环境变量或磁盘配置在运行期被篡改，已运行 the 会话也无法感知，天然切断越权提权路径，同时兼顾热重载特性。
- **底线级别的硬核黑名单拦截（Hardline Floor）**：
  - **重构路径**：在 `terminal-guard.ts` 中定义绝对硬拦截正则集 `HARDLINE_PATTERNS`（覆盖 `rm -rf /`，`rm -rf ~`，磁盘格式化 `mkfs`，向原始磁盘覆写 `dd`，以及 Fork 炸弹等）。
  - **实现**：重构 `ExecuteCommandTool.checkSafety`：在判断任何 `workMode` 之前，必须首先对命令行进行底线拦截检查。一旦命中底线规则，直接返回 `{ status: 'deny', message: 'BLOCKED (Hardline Blocklist)' }` 并强制拦截。YOLO 模式在此拦截线之下，无权豁免。
- **带“中断重塑”的级联安全熔断（Halted Cascade Reject）**：
  - **重构路径**：在 [HumanApprovalPlugin.ts](file:///d:/Projects/MyAgent/src/brain/plugins/HumanApprovalPlugin.ts) 的挂起等待列表（`pendingRequests`）中，强绑定会话 ID `sessionID`。
  - **实现**：当用户拒绝某一步骤时，系统清空并安全中止该会话下其余处于 `pending` 的所有挂起任务（避免残留挂起导致状态污染），但向大模型返回结构化的 `HaltedByReject` 上下文（“操作 X 被拒绝，后续步骤已被熔断安全中止”）。大模型捕获此信息后进入中断重塑（Halt & Re-plan）流程，根据拒绝理由修正该步骤参数并重新提交，保障开发体验与系统一致性。
- **会话超时与后台任务主动中止联动（Lifecycle Abort）**：
  - **重构路径**：在终端引擎 `terminal-engine.ts` 中，使用 Map 结构追踪活跃的进程句柄 `activeProcesses: Map<string, ChildProcess>`。
  - **实现**：为 Session 引入空闲心跳和超时回收机制。会话超时销毁或被强制关闭时，联动调用 `abortController.abort()` 强行杀死该会话对应在 `activeProcesses` 中的所有活跃子进程与终端后台任务。
- **机密资产的分级写保护与读审计（Secrets Partition & Audit）**：
  - **重构路径**：在 `ReadFileTool`、`WriteFileTool` 和 `EditFileTool` 的 `checkSafety` 中重构敏感资产路径过滤。
  - **实现**：允许 `.env.example` 自由读写以支持脚手架搭建。对真实包含凭据的敏感文件（如 `.env`、`.env.*` 等），取消一刀切彻底隐藏。但在 YOLO 模式下，**读取与写入这些文件也绝不静默放行**，必须强制降级为 `Safe` 模式（人工审批并向用户展示明文内容与 Diff），防止注入静默偷 Key，兼顾 AI 协助配置的实用性与信息安全性。

---

### 🌐 附录：业界主流安全模式及横向对比
在业界的 AI Agent 安全架构设计中，除了 `Safe` (安全每次确认)、`Auto` (智能分类器过滤)、`YOLO` (全自动免密) 这三种执行态模式外，主流项目还普遍引入了第四种模式——**`Plan` (只读计划模式)**：
- **Plan 只读模式**：智能体被限制在“只读与模拟”状态。在此模式下，任何写入操作在 `checkSafety` 拦截阶段都会被无条件拒绝。这使得人类用户能安全地评估方案，确认无误切换出 Plan 模式后方可执行。

#### 7 大主流 Agent 框架安全权限管理横向对比：
| 评估维度 | Claude Code | OpenHands (原 OpenDevin) | Hermes-Agent | OpenCode | OpenClaw | 本项目重构方案 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **基础模式覆盖** | Default, Auto, Plan, Bypass | Full-Auto (YOLO), Interactive | Safe, Auto, YOLO | Allow, Ask, Deny 规则策略 | Interactive, Parent-Owned-Background | Safe, Auto, YOLO, Plan |
| **沙箱隔离级** | 本地路径过滤 (软限制) | **Docker 物理隔离 (硬限制) ✓** | 本地路径过滤 (软限制) | 本地路径过滤 (软限制) | 本地路径过滤 (软限制) | 本地路径过滤 (软限制) |
| **自动放行判定** | 依赖 Classifier 模块二次校验 | 依赖 Risk Analyzer 评估器分析 | 依赖辅助 LLM 判定低风险操作 | 基于内置配置与 Saved 规则合并判定 | 不支持自动判定 (依靠前端交互) | 协同审批插件 & 白名单规则匹配 |
| **底线拦截机制** | 敏感系统路径/配置防改写 | 容器隔离阻断，无全局破坏 | **底线黑名单拦截 (YOLO 下也强制卡关) ✓** | Built-in 静态配置绝对优先拦截 | 会话超时/注销联动任务主动中止 | **底线黑名单拦截 (YOLO 下也强制卡关) ✓** |
| **并发安全防范** | 基于 `session` 的权限上下文剥离 | 事件流追溯 (Event Stream) | **ContextVars 线程级局部上下文隔离 ✓** | **`sessionID` 队列隔离 & 级联熔断 (Cascade Reject) ✓** | **TTL 超时回收 & 强杀活动进程 (Active Run Abort) ✓** | **会话级隔离 & 级联熔断 & 超时中止联动 ✓** |

**安全加固推荐路径**：
鉴于本项目主要在本地（如 Windows 物理机环境）运行，不具备 Docker 容器等物理沙箱隔离的硬条件。因此我们必须优先把**“配置单向单次加载（维度 2）”**与**“硬底盘黑名单拦截（维度 3）”**这两项安全地基确立为最核心的本地防御壁垒。
