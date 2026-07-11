## 背景

本次 change 来源于同一个真实会话中的连续运行时问题。Plan 模式先允许原子只读 `wmic logicaldisk`，随后阻断五条复合命令；模型没有成功切换到内建文件工具，却继续输出高置信度清理估算。与此同时，`ExecuteCommandTool` 的静态安全类别固定为 `write`，`ToolCallOrchestrator` 因此把已通过 Plan 判定的只读命令记为写操作，`AgentLoop` 在模型完成后运行 `npm run lint` 与 `npx tsc --noEmit`。该过程延长前台等待约 46 秒，并与 `RuleManager` 的无差异 watcher 日志交叠。

当前实现存在三类语义混用：静态安全风险与本次实际副作用混用；目录局部或截断测量与回合整体证据等级混用；内部运行日志与用户界面状态混用。它们共同导致安全策略虽然保守，但运行行为、诊断结论与用户体验不准确。

本 change 保持一个统一交付边界，但内部按一条数据链设计：工具调用先得到实际 effect，真实变更再触发质量门禁；内建测量产生对象级证据，证据完整性决定结论强度；所有阶段通过结构化日志和 trace 关联，UI 只消费稳定的产品事件。

## 目标与非目标

**目标:**

- 保留现有静态 `securityCategory` 的默认拒绝与审批安全价值，同时新增本次调用的实际 effect 事实。
- 只让真实代码写入或无法排除写入的执行结果触发质量门禁，彻底消除已确认只读命令误触发。
- 将质量检查从内部 `thinking` 文本提升为稳定的领域事件，保证发生在 `complete` 之前并可被 CLI/TUI 一致渲染。
- 让一次受限目录测量可以比较目标目录的直接子目录，并在权限错误、链接、截断或取消时返回可解释的部分结果。
- 用对象级证据记录约束诊断结论，使“测到了一个对象”不能提升整个任务的证据强度。
- 让技能 watcher 仅在技能主体内容真实变化时更新缓存，并在主会话与子智能体结束时释放。
- 为实际 effect、质量门禁、目录测量和热重载建立可关联、可计时、符合 capture mode 的结构化观测。

**非目标:**

- 不放宽 Plan 模式对复合命令、管道、重定向、变量展开和写倾向命令的限制。
- 不把 `execute_command` 静态改成只读工具，也不削弱未知命令的审批、锁和默认拒绝策略。
- 不新增磁盘清理、删除缓存或自动执行清理的业务能力。
- 不承诺对整个系统盘进行无限深度、无预算的精确扫描。
- 不让文件系统 watcher 直接承担跨进程可靠事件总线职责。
- 不改变默认 trace 的 metadata-only 隐私边界，不在日志中写入完整命令、文件正文或未脱敏绝对路径。

## 架构决策

### 决策 1：静态安全风险与实际执行 effect 使用两个独立契约

保留 `NativeTool.securityCategory` 作为潜在风险元数据，继续服务 `HumanApprovalPlugin`、默认拒绝、保守锁和未知工具降级。新增 `ToolExecutionEffect` 作为单次调用事实，至少包含：

- `kind`: `none | read | write | unknown`
- `executionStarted`: 是否进入工具执行
- `completed`: 是否正常完成
- `resources`: 本次实际或可能受影响的结构化资源
- `reason`: effect 判定来源的稳定枚举值

`ToolExecutionResult` 携带该 effect。插件在执行前 abort、参数解析失败或审批拒绝时返回 `none`；只读工具成功执行返回 `read`；写工具成功执行返回 `write`；写工具进入执行后异常且无法证明没有改变资源时返回 `unknown`。`unknown` 按写入风险触发质量门禁，但日志中必须说明不确定来源。

`execute_command` 的 effect 复用执行前已经通过的同构安全判定：Plan 安全原子查询成功或失败均为 `read`；未被证明只读但获准执行的命令为 `unknown`，除非命令适配器能够返回更精确的写入 effect。安全审批仍按静态 `write` 处理，因此不会因 effect 精化产生授权绕过。

选择该方案而不是动态修改 `securityCategory`，因为静态类别描述的是工具能力上界，而 actual effect 描述的是一次调用事实；二者生命周期和消费者不同。

### 决策 2：质量门禁消费实际 effect 与变更资源，不消费工具名称

`AgentLoop` 不再维护基于 `taskRes.hasWrite` 的布尔值，而是累积本轮 `write/unknown` effect 及其资源。只有至少一个 effect 指向代码相关资源，或 unknown effect 无法排除工作区代码写入时，才调用 `QualityCheckPort`。

`QualityCheckPort` 输入增加结构化上下文：session、触发 effect、去重后的变更资源和 AbortSignal。第一阶段继续复用现有 ESLint 与 TypeScript 检查，避免本 change 同时引入新的增量编译器；但适配器必须记录每个检查步骤的耗时与结果，并响应取消。

失败反馈最多自动修复一次。若修复轮没有产生新的代码写入，不得重跑；若第二次仍失败，系统返回失败状态和摘要，不再无限注入伪用户消息。检查成功后清空本轮变更累积，避免后续无变更 iteration 重复触发。

替代方案“所有 `execute_command` 都跳过质量检查”被否决，因为获准执行的构建脚本或任意 shell 仍可能修改代码。替代方案“继续使用 securityCategory，但给几个命令加例外”被否决，因为会形成名称和字符串分支，无法覆盖未来工具。

### 决策 3：质量门禁使用专用 AgentEvent，不再伪装成 thinking 文本

新增 `quality_check_status` 事件，字段包含 `phase: started | passed | failed | cancelled`、稳定摘要、耗时和可选 `detailRef`。CLI/TUI 只渲染“正在验证修改”“验证通过”“验证失败”等产品文案；不得显示 `PostRunHook`、适配器类名或原始命令。

事件在 `complete` 之前产生，`complete` 继续是唯一终结点。内部日志不直接承担 UI 通知职责，logger sink 与 renderer 之间不建立隐式耦合。失败详情通过折叠区域、trace 引用或后续模型修复上下文提供。

### 决策 4：目录比较测量采用共享预算下的分组轮转扫描

在 `listFiles` 的显式测量模式中支持两种目标：当前目标整体统计，以及直接子目录比较统计。比较模式为每个直接子目录维护独立 accumulator，使用共享队列轮转推进，避免深度优先扫描让目录排序靠前的对象耗尽全部预算。

测量请求必须显式提供 `maxDepth`、`maxEntries`、`maxBytes` 和 `maxDurationMs`，并接收 AbortSignal。默认不跟随符号链接、junction 或 reparse point；默认不跨文件系统/卷边界。不可访问子项被记录为跳过错误，不中断其他子目录；只有目标根目录自身不可读时才使整个调用失败。

每个测量对象返回：`observedSizeBytes`、文件/目录计数、扫描条目数、错误计数、跳过计数、`completeness`、截断原因和耗时。只有完整扫描可以使用 `totalSizeBytes` 语义；部分结果明确表示下界，不得伪装成总量。

选择分组轮转而不是逐目录串行扫描，是为了在有限预算内获得可比较的覆盖。选择显式模式而不是默认递归，是为了保持普通目录浏览的低成本与低噪声。

### 决策 5：诊断证据改为有界的对象级记录集合

`DiagnosticTurnState` 使用有界 `evidenceRecords` 保存证据记录。每条记录至少包含：目标、指标、数值、单位、来源工具与调用关联、`complete | partial | lower-bound` 完整性、覆盖描述和错误摘要。回合级摘要只能由这些记录派生，不能单独成为结论授权开关。

一次失败不会删除此前有效证据，而是追加错误记录并标记本次目标失败。`readFile.lineCount`、文件 size 和目录统计都可产生记录，但只能支持对应文件、目录或扫描范围。截断目录的 `observedSizeBytes` 只能产生 `lower-bound`。模型提醒中输出压缩后的对象级证据摘要，并明确禁止向未覆盖范围外推。

为控制上下文，记录数量设固定上限，优先保留完整测量、最新错误和高风险目标；详细记录留在运行时状态与 trace，提示词只注入摘要。

### 决策 6：诊断预算按成本与范围收敛，不再“一次截断后封死全部读取”

护栏在调用前根据请求上限预留扫描成本，在调用后使用实际 `scannedEntries`、耗时和返回大小结算。截断后禁止自动扩大深度、条目、字节或时间上限，但允许在剩余预算内对已发现的明确子目标执行更窄扫描；目标必须是先前范围的后代，且请求上限不得大于上一轮。

工具失败后的提示必须使用 ToolRegistry 中实际注册的名称或从注册表生成能力描述，移除 `list_dir/read_file/grep_search` 等与当前工具名不一致的硬编码示例。文件树元数据优先使用 `listFiles/readFile`；卷容量等系统信息允许单一原子命令补位；第二次失败后必须总结未知项。

### 决策 7：技能 watcher 使用候选事件、内容快照和显式释放

`RuleManager` 保存 `FSWatcher` 句柄、待处理候选路径集合和技能主体摘要快照。watcher 只把 `.agent/skills/**/SKILL.md` 的事件加入候选集；防抖到期后重新扫描元数据并比较稳定内容摘要。仅当新增、删除或内容摘要变化时才替换缓存并更新 system prompt。

`reloadRules()` 的手动强制刷新与 watcher 增量刷新分开实现，避免一次事件重复扫描两次。`RuleManager.close()` 幂等地清理 debounce timer、关闭 watcher 并清空候选集。主 `SessionManager.close()` 必须调用它；`MemoryService` 创建短生命周期 `RuleManager` 时禁用 watcher，并在 finally 中关闭，形成双重生命周期保障。

选择内容摘要而不是只比较 mtime，是因为 Windows 文件事件、编辑器原子保存和临时文件可能产生无内容变化的事件。摘要只针对技能主体，不扫描技能目录内无关派生文件。

### 决策 8：日志与 trace 使用同一 correlation 字段，但承担不同职责

为以下阶段记录结构化事件：`tool_effect_resolved`、`quality_check_started/step_finished/finished`、`directory_measurement_started/finished`、`skill_watch_event`、`skill_cache_refreshed`、`skill_watcher_closed`。公共字段包含 component、event、sessionId、correlationId、durationMs、status；资源路径默认写工作区相对路径或不可逆摘要。

run.log 保存运行诊断需要的结构化字段。trace 在 metadata-only 模式只保存阶段、耗时、计数、状态和摘要；replay 模式仍需经过既有脱敏后才可保存更完整详情。UI 不直接显示 logger INFO 文本。

## 风险与权衡

- **[effect 判定错误可能漏跑质量检查]** -> 静态安全策略保持不变；执行开始后无法证明无写入的结果使用 `unknown` 并按写入触发门禁；增加只读命令、失败命令和真实写入的契约测试。
- **[目录比较扫描开销增加]** -> 默认关闭；强制四类预算、AbortSignal、不跟随链接、不跨卷、轮转公平扫描，并在 trace 中记录实际成本。
- **[部分测量让模型理解成本上升]** -> 使用稳定字段 `observedSizeBytes` 与 completeness 枚举，提示词注入简短证据摘要，不用自由文本解释协议。
- **[对象级证据增加状态复杂度]** -> 记录集合有固定上限并提供纯函数归并/派生，禁止在 AgentLoop 中散落字段更新。
- **[内容哈希增加 watcher I/O]** -> 只对 `SKILL.md` 候选和扫描结果计算摘要，防抖合并事件；无变化时不更新 Prompt。
- **[一次 change 影响多个边界，回归面较大]** -> tasks 按数据链顺序设置检查点：先契约与 effect，再质量门禁，再测量/证据，再 watcher，最后观测与端到端回归；每一阶段必须保持编译通过。
- **[新增事件影响 CLI 状态机]** -> `quality_check_status` 明确为非终结事件，复用现有 `complete` 唯一终结契约并补充输入恢复测试。

## Migration Plan

1. 先新增兼容的 effect 类型和默认推导器，让未适配工具仍能由静态类别安全降级；此时暂不切换 PostRunHook。
2. 让原生文件工具和命令工具返回实际 effect，补齐 ToolExecutor/Orchestrator 传递与契约测试。
3. 切换 AgentLoop 的质量门禁触发源并引入专用事件；确认只读命令不触发、真实写入仍触发后，移除旧 `hasWrite` 布尔链。
4. 升级目录测量结果和对象级证据状态，再切换诊断提醒与预算逻辑；保留默认 `listFiles/readFile` 简洁返回兼容路径。
5. 改造 RuleManager watcher 与关闭生命周期，最后接入结构化日志和 trace span。
6. 使用本次 `.myagent` 场景构造回归：Plan 原子只读查询、复合命令阻断、目录受限测量、无真实写入、无技能内容变化。

若新 effect 传递出现问题，可暂时回退 AgentLoop 消费逻辑到旧布尔值，但不得回退 Plan 安全策略。若目录测量出现兼容问题，可关闭显式比较模式而保留默认读取。若 watcher 摘要比较异常，可停用自动 watcher 并保留手动 reload，不允许恢复无差异 INFO 刷屏。

## Open Questions

- 首次实现的质量门禁仍执行全仓 ESLint 与 TypeScript；后续是否增加按变更资源选择 focused check，需要用真实耗时和漏检数据单独决策，本 change 不提前承诺增量编译。
- `unknown` effect 对工作区外命令是否触发项目质量检查，初始实现建议仅在资源为空或与工作区相交时触发；需要通过现有命令资源提取结果验证边界。
- Windows junction 的识别在不同 Node 版本和权限下可能不同，实现阶段必须以 `lstat`/reparse 行为测试确定，不能仅依赖 `Dirent.isSymbolicLink()`。

