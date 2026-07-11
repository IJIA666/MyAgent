## 1. 建立实际 effect 领域契约与统一传递链

- [x] 1.1 在 `src/adapters/tools/tool-types.ts` 中新增并导出 `ToolExecutionEffectKind`、`ToolExecutionEffect` 与 `ToolExecutionOutcome<T>`，字段至少覆盖 `kind`、`executionStarted`、`completed`、`resources`、`reason`、成功值和错误；为所有公开类型补齐标准 TSDoc，明确 `securityCategory` 是潜在风险、effect 是单次调用事实。
- [x] 1.2 为 effect 的 `reason` 定义稳定枚举或字符串联合，至少覆盖 `pre_execution_abort`、`declared_read_tool`、`declared_write_tool`、`plan_safe_command`、`execution_failed_after_start`、`legacy_fallback`，禁止在日志和测试中依赖自由文本。
- [x] 1.3 在 `NativeTool` 契约中增加可选的实际 effect 解析入口，使工具能根据参数、执行上下文、成功结果或执行错误精化 effect；未实现该入口的工具必须走统一默认推导器，不得在调用方按工具名称分支。
- [x] 1.4 在 `src/adapters/tools/ToolExecutor.ts` 中实现 effect 默认推导器：未开始执行返回 `none`；静态 read 工具成功或失败返回 `read`；静态 write 工具成功返回 `write`；静态 write 工具进入执行后失败返回 `unknown`。
- [x] 1.5 调整 `ToolExecutor.execute` 的内部结果，使成功与失败都能携带 `ToolExecutionOutcome`；保留原始 Error 作为 cause，禁止为了返回 effect 吞掉错误堆栈或把异常伪装成成功文本。
- [x] 1.6 调整 `src/adapters/tools/toolRegistry.ts` 与对应 port，使 `callTool` 沿统一运行时返回 outcome；同步更新内建工具与外部 MCP 两条分支，外部 MCP 未提供精确 effect 时使用访问元数据和执行阶段安全降级。
- [x] 1.7 调整 `src/core/usecases/engine/tool-call-orchestrator.ts` 的 `ToolExecutionResult`，移除或弃用 `hasWrite: boolean`，改为返回完整 effect；参数解析失败、BeforeTool abort、审批拒绝必须显式产生 `none`，不得落入 write fallback。
- [x] 1.8 在 Orchestrator 调用 ToolRegistry 前后标记 executionStarted，确保”执行前失败”和”执行后异常”可以可靠区分；AfterTool abort 不得抹去已经发生的 write/unknown effect。
- [x] 1.9 调整 `src/core/usecases/engine/agent-loop.ts` 的工具结果消费逻辑，先只累积 effect 而暂不切换质量检查触发；去重资源并保留 correlationId，为下一阶段迁移提供兼容数据。
- [x] 1.10 更新 `test/adapters/tools/tool-runtime` 相关类型夹具及 mock registry，使测试双提供 outcome；禁止使用 `as unknown as` 绕过新增契约。
- [x] 1.11 在 `test/contract/tool-runtime.test.ts` 增加 effect 契约测试，覆盖 read 成功、write 成功、执行前 abort、写工具执行后异常和旧工具 fallback。
- [x] 1.12 在 `test/core/usecases/engine/tool-call-orchestrator.test.ts` 增加完整传递测试，断言 ToolExecutor、ToolRegistry、Orchestrator 收到的 kind、resources、executionStarted、completed、reason 一致。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/contract/tool-runtime.test.ts test/core/usecases/engine/tool-call-orchestrator.test.ts -->

## 2. 精化命令工具 effect 并切换质量门禁触发源

- [x] 2.1 在 `src/adapters/tools/impl/system/terminal.ts` 中复用现有 Plan 同构安全判定结果实现命令 effect 解析；已通过 Plan 安全判定的原子只读命令必须返回 read，禁止复制一套不同正则造成审批判定与 effect 判定漂移。
- [x] 2.2 保持 `ExecuteCommandTool.securityCategory='write'`、命令审批、默认拒绝和保守资源锁语义不变；新增注释解释静态潜在风险与动态实际 effect 的职责边界。
- [x] 2.3 对非 Plan 或不能静态证明只读但获准执行的命令返回 unknown；仅当已有可靠命令 effect 分类结果时才返回 write，禁止根据命令名称片段草率推断无副作用。
- [x] 2.4 在 `test/adapters/tools/terminal.test.ts` 增加原子只读命令 effect 用例，至少覆盖 `wmic logicaldisk`、`Get-PSDrive C` 与 `dir`；断言审批仍按潜在写风险执行，但 outcome 为 read。
- [x] 2.5 在 terminal 测试中覆盖带管道、重定向、连接符、环境变量展开的命令仍被 Plan 阻断，且执行前 outcome 为 none，不得因本 change 放宽安全边界。
- [x] 2.6 在 terminal 测试中覆盖获准执行但无法证明只读的命令产生 unknown，并携带 command-prefix 资源摘要而非完整敏感命令。
- [x] 2.7 在 `src/core/usecases/engine/agent-loop.ts` 中将本轮变更状态改为 effect/resource 累积器，删除以静态类别驱动的 `hasWriteOperation` 赋值路径。
- [x] 2.8 实现质量门禁触发谓词：read/none 永不触发；write 仅在资源属于代码范围时触发；unknown 在资源为空或与工作区代码相交时保守触发；将谓词提取为可单测纯函数并附职责注释。
- [x] 2.9 明确定义代码相关资源过滤规则，至少排除纯日志、trace、会话快照和已知非代码缓存；无法分类的工作区写入按可能代码写入处理，避免漏检。
- [x] 2.10 在 `test/core/usecases/engine/agent-loop.test.ts` 增加“只执行 Plan 原子只读命令不调用 QualityCheckPort”测试，使用本次 C 盘日志的调用序列作为回归夹具。
- [x] 2.11 在 agent-loop 测试中增加真实文件写入触发、执行前被拒绝不触发、unknown 工作区命令触发、纯 `.myagent` 运行日志写入不触发四类场景。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/adapters/tools/terminal.test.ts test/core/usecases/engine/agent-loop.test.ts -->

## 3. 重构质量门禁执行、反馈上限与 AgentEvent 呈现

- [x] 3.1 扩展 `src/ports/driven/security/QualityCheckPort.ts` 输入契约，传入 sessionId、触发 effects、去重变更资源与 AbortSignal；输出改为包含总体状态、步骤列表、durationMs 和脱敏摘要的结构化结果。
- [x] 3.2 在 `src/adapters/tools/ShellQualityCheckAdapter.ts` 中把 ESLint 与 TypeScript 拆成两个可计时步骤，分别记录 exitCode、durationMs、success/cancelled 与受限摘要；公共类和方法使用标准 TSDoc。
- [x] 3.3 让 ShellQualityCheckAdapter 的子进程执行响应 AbortSignal；取消后不得继续启动下一步骤，并确保已启动子进程按现有终端生命周期机制终止，不遗留后台进程。
- [x] 3.4 为质量检查输出建立长度限制与秘密脱敏，模型修复上下文只能接收受限错误摘要；完整 stdout/stderr 不得默认进入 UI、metadata-only trace 或会话历史。
- [x] 3.5 在 AgentLoop 中增加 `qualityRepairAttempts` 与“自上次检查后新增变更 effect”状态；首次失败最多允许一次自动修复，修复轮无新增 write/unknown 时直接终止重跑。
- [x] 3.6 修复成功后清空已消费的变更 effect；修复后第二次仍失败时停止自动注入系统修复消息，保留失败摘要并正常进入 complete。
- [x] 3.7 在 AgentEvent 类型定义中新增 `quality_check_status`，字段至少包含 phase、summary、durationMs、detailRef；phase 限定为 started、passed、failed、cancelled。
- [x] 3.8 用 `quality_check_status` 替换 AgentLoop 中三条包含 `[PostRunHook]` 的 thinking 文本；代码注释、用户文案和日志不得继续暴露 PostRunHook 实现名称。
- [x] 3.9 在 `src/adapters/input/interface/facade.ts` 与 `views/widget-renderer.ts` 中处理质量状态事件，渲染稳定的“正在验证修改/验证通过/验证失败/验证已取消”状态，详细错误使用现有折叠或详情能力。
- [x] 3.10 确保 `quality_check_status` 不修改 InputListener 所有权和渲染终结状态；只有随后唯一的 complete 可以恢复输入。
- [x] 3.11 在 `test/core/usecases/engine/agent-loop.test.ts` 覆盖质量检查通过、首次失败后一次修复、修复无写入不重跑、第二次失败停止和 abort 取消。
- [x] 3.12 在 `test/adapters/input/interface/CliFacade.test.ts` 覆盖 started/passed/failed/cancelled 均不恢复输入且 complete 只恢复一次。
- [x] 3.13 为 `ShellQualityCheckAdapter` 新增聚焦测试，使用可控子进程执行依赖或注入式执行器，禁止单测真正运行全仓 ESLint/tsc；覆盖步骤耗时、第一步失败不启动第二步、取消和输出截断。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/core/usecases/engine/agent-loop.test.ts test/adapters/input/interface/CliFacade.test.ts -->

## 4. 实现公平、受限、可取消的目录比较测量

- [x] 4.1 在 `src/adapters/tools/impl/filesystem/file-system.ts` 中定义目录测量请求、对象 accumulator、完整性、截断原因和最终 payload 类型；公开结果字段补齐 TSDoc，私有辅助结构使用轻量职责注释。
- [x] 4.2 保留 `listFiles` 默认名称列表和现有 includeMetadata 行为，新增显式直接子目录比较入口；未提供测量开关时不得调用递归扫描辅助函数。
- [x] 4.3 校验测量请求必须同时提供非负/正数语义正确的 maxDepth、maxEntries、maxBytes、maxDurationMs；为 0 的合法/非法含义分别写测试，错误信息必须指出具体字段。
- [x] 4.4 将 ListFilesTool 测量路径改为异步并接收 ToolExecutionContext 中的 AbortSignal；默认轻量路径不得因异步改造改变返回 JSON 结构。
- [x] 4.5 使用共享队列为每个直接子目录建立扫描任务，按轮转方式推进，确保目录枚举顺序不会让第一个目录独占全部预算。
- [x] 4.6 为目标整体统计与直接子目录比较复用同一扫描内核，但分别生成 targetMeasurement 和 entries[].measurement，禁止把目标整体总量错误复制给每个子目录。
- [x] 4.7 使用 `lstat`/平台可用属性识别符号链接、junction 和 reparse point；默认跳过递归并累计 skippedLinks，禁止用 `stat` 跟随后再判断。
- [x] 4.8 记录根目标的设备/卷标识，默认跳过跨设备或跨卷目录并累计 skippedMounts；无法可靠判定时按不跟随处理并记录 unknown-boundary。
- [x] 4.9 将后代目录的 EACCES/EPERM/ENOENT 等错误转为对象级 skippedEntries/errorCount，继续扫描其他对象；根目标本身不可读时才抛出调用级错误。
- [x] 4.10 实现 maxEntries、maxBytes、maxDepth、maxDurationMs 和 AbortSignal 的统一停机检查；每次异步目录读取之间检查取消，避免超时后继续长时间遍历。
- [x] 4.11 仅当对象完整覆盖且无跳过时返回 totalSizeBytes；任何截断、跳过、链接边界或取消必须返回 observedSizeBytes，并设置 completeness=partial/lower-bound 与稳定 reason。
- [x] 4.12 对结果中的 skipped path 进行数量限制和相对路径/摘要处理，避免系统盘扫描把大量绝对敏感路径写入上下文。
- [x] 4.13 在 `test/adapters/tools/tools.test.ts` 覆盖默认不递归、目标整体完整统计、多个直接子目录公平比较和目录项 measurement 结构。
- [x] 4.14 增加权限拒绝继续扫描、链接不跟随、maxEntries、maxBytes、maxDurationMs、AbortSignal、根目录不可读、部分结果字段语义测试；Windows junction 测试无法稳定创建时必须以平台条件测试并保留 lstat 单元夹具。
- [x] 4.15 更新 `test/adapters/tools/tool-definition-description.test.ts`，断言工具描述明确默认不递归、显式预算、部分结果和实际参数名，避免模型继续猜测不存在的用法。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/adapters/tools/tools.test.ts test/adapters/tools/tool-definition-description.test.ts -->

## 5. 将诊断状态迁移为对象级证据并按成本治理扫描

- [x] 5.1 在 `src/core/domain/diagnostic-guardrails.ts` 中新增 `DiagnosticEvidenceRecord`、metric、unit、completeness、source 与 coverage 类型；把 evidenceRecords 设为有界集合，并为公开类型和函数补齐 TSDoc。
- [x] 5.2 保留兼容的回合摘要字段时，必须改为由 evidenceRecords 纯函数派生；禁止任何调用方直接把整个回合赋值为 measured 或 error。
- [x] 5.3 实现 readFile 结构化结果解析：sizeBytes 与 lineCount 分别产生绑定文件路径的 measured 记录，mtimeMs、kind 和存在性只能产生辅助/presence 信息。
- [x] 5.4 实现 listFiles 结果解析：普通名称列表产生 enumeration；直接文件 size 绑定具体文件；目录完整总量产生 complete；observedSizeBytes 或截断结果产生 lower-bound/partial。
- [x] 5.5 为 execute_command 的数量型结果保留原子系统查询证据，但绑定命令资源、指标与调用关联；不得仅凭任意大数字正则把整个任务升级为 measured。
- [x] 5.6 修改失败处理：查询失败追加目标级 error 记录，保留其他对象的有效 measured；同一目标的新完整证据可以替换旧 partial，但必须保留来源可追溯性。
- [x] 5.7 实现证据集合上限和淘汰策略，优先保留 complete measured、最新错误、高风险目标与当前焦点；提示词只注入压缩摘要，不注入完整扫描 payload。
- [x] 5.8 将 listFiles 调用次数预算升级为扫描成本预算，调用前按请求 maxEntries/maxDurationMs 预留，调用后按实际 scannedEntries、durationMs 和结果大小结算。
- [x] 5.9 修改截断后规则：禁止扩大原目标或预算；只有目标属于上一范围后代、仍有剩余成本、且各项上限不增加时允许更窄扫描。
- [x] 5.10 删除 `lastDirectoryStatsTruncated` 导致后续所有 listFiles 一律阻断的粗粒度逻辑，替换为目标范围和预算感知判定。
- [x] 5.11 在 `src/core/usecases/brain/prompts.ts` 或实际 reminder 组装边界中移除硬编码 `list_dir/read_file/grep_search`；从 ToolRegistry/ToolCatalog 提供的实际工具名或能力映射生成降级提示。
- [x] 5.12 更新模型提醒，逐条输出目标、指标、完整性和覆盖摘要；明确 complete、partial、lower-bound 的允许措辞，禁止使用单一 `DiagnosticEvidenceLevel: measured` 作为泛化授权。
- [x] 5.13 扩展 `test/core/domain/diagnostic-guardrails.test.ts`，覆盖文件行数、文件大小、目录完整测量、目录下界、辅助 mtime 不升级、失败不抹除其他证据和同目标证据替换。
- [x] 5.14 在 guardrail 测试中覆盖截断后更窄目标允许、提高预算阻断、无关目标阻断、成本耗尽阻断和普通枚举停机。
- [x] 5.15 扩展 `test/core/usecases/engine/model-request-assembler.test.ts`，断言提醒使用实际工具名称、对象级证据摘要和不确定性，并且不存在旧别名。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/core/domain/diagnostic-guardrails.test.ts test/core/usecases/engine/model-request-assembler.test.ts -->

## 6. 修正 RuleManager 差异重载与 watcher 生命周期

- [x] 6.1 在 `src/core/usecases/brain/RuleManager.ts` 中保存 `FSWatcher` 句柄、debounce timer、候选技能主体路径集合和当前技能内容摘要映射；导入具体 Node 类型，避免在正文中重复全限定名。
- [x] 6.2 增加 `RuleManagerOptions`，允许主会话启用 watcher、短生命周期实例禁用 watcher；构造函数与公开方法补齐标准 TSDoc。
- [x] 6.3 将 watcher 回调改为接收 eventType 与 filename，仅接受 `.agent/skills/**/SKILL.md` 候选；filename 缺失时允许一次受限全量摘要校验，但不得直接宣称内容变化。
- [x] 6.4 防抖到期后统一扫描一次技能元数据和主体摘要，比较新增、删除、修改集合；无差异时只清空候选状态，不调用 updateSystemPrompt。
- [x] 6.5 将 `refreshSkillsCache` 改为先构建新 Map、完成差异比较后原子替换，避免刷新过程中清空旧缓存导致并发读取看到空列表。
- [x] 6.6 拆分手动 `reloadRules()` 与 watcher 增量刷新；手动重载读取规则和技能各一次，watcher 只刷新技能，删除当前一次事件调用两次 refreshSkillsCache 的路径。
- [x] 6.7 新增幂等 `RuleManager.close()`，依次清理 timer、关闭 watcher、清空候选集合并阻止关闭后回调更新上下文；关闭异常只能记录诊断，不得阻塞会话关闭。
- [x] 6.8 在 `src/core/usecases/engine/session.ts` 的 close 生命周期中调用 `ruleManager.close()`，明确放在终结状态设置前，并补充重复 close 不重复释放测试。
- [x] 6.9 在 `src/core/usecases/brain/MemoryService.ts` 创建子 RuleManager 时显式禁用 watcher，并在子 Agent for-await 的 finally 中调用 close，覆盖成功、异常、abort 和超时。
- [x] 6.10 在 `test/core/usecases/brain/RuleManager.test.ts` 使用可注入 watcher/摘要依赖或临时目录测试：无内容事件不刷新、SKILL.md 修改刷新一次、无关文件忽略、删除技能更新、连续事件防抖合并。
- [x] 6.11 在 RuleManager 测试中覆盖 close 清 timer/句柄、关闭后事件无效、重复 close 幂等和两个工作区实例互不污染。
- [x] 6.12 在 `test/core/usecases/brain/MemoryService.test.ts` 覆盖子 RuleManager watcher 禁用与 finally 释放；在 `test/core/usecases/engine/SessionManager.test.ts` 覆盖主会话关闭调用 RuleManager.close。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/core/usecases/brain/RuleManager.test.ts test/core/usecases/brain/MemoryService.test.ts test/core/usecases/engine/SessionManager.test.ts -->

## 7. 补齐结构化日志与 trace 阶段关联

- [x] 7.1 为 effect、质量门禁、目录测量和技能重载定义统一 component/event 常量或轻量事件构造器，避免各模块自由拼接名称；字段至少统一 sessionId、correlationId、status、durationMs。
- [x] 7.2 在 ToolCallOrchestrator effect 最终确定后记录 `tool_effect_resolved` DEBUG 事件，只记录 kind、reason、资源数量和摘要，不记录完整参数或命令。
- [x] 7.3 在 AgentLoop/质量适配器记录 `quality_check_started`、每个 `quality_check_step_finished` 和 `quality_check_finished`，包含触发 effect 数、变更资源数、步骤耗时和最终状态。
- [x] 7.4 在 ListFilesTool 测量路径记录 `directory_measurement_started/finished`，包含预算、实际扫描条目、耗时、完整性、错误与跳过计数；默认普通列目录不得产生重型测量日志。
- [x] 7.5 将 RuleManager 原”检测到技能文件变动”和”正在重载”自然语言 INFO 替换为结构化事件：候选事件无差异为 DEBUG，真实缓存变化为 INFO，关闭为 DEBUG。
- [x] 7.6 检查 `src/utils/logger.ts` 的 console/file sink 路由，确保内部结构化 INFO/DEBUG 不在 Agent 正在渲染时直接写入用户主交互区；不得通过全局禁用日志掩盖问题。
- [x] 7.7 扩展 `AgentTracer` 或相邻 trace 写入边界，为 effect、质量门禁、目录测量和技能刷新追加 metadata span；使用与 run.log 相同 correlationId 关联工具调用或会话阶段。
- [x] 7.8 在 metadata-only 模式只写阶段、状态、耗时、计数和不可逆摘要；在 replay 模式复用既有脱敏器，禁止另建绕过数据治理的原始输出字段。
- [x] 7.9 在 `test/contract/log-pipeline.test.ts` 覆盖四类事件字段、级别、无内容变化不产 INFO、内部名称不进入前台 console sink。
- [x] 7.10 扩展 trace 相关测试，断言 metadata-only 不含命令输出/文件正文/绝对敏感路径，replay 仍执行脱敏，且 span correlationId 可与 audit/tool call 对齐。
- [x] 7.11 增加质量检查取消和 watcher close 的日志测试，确认 cancelled/closed 有终态事件，不产生只有 started 没有 finished 的悬空阶段。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/contract/log-pipeline.test.ts test/contract/diagnostic-data-governance.test.ts -->

## 8. 端到端回归、制品一致性与收尾

- [x] 8.1 构造与 `.myagent` 会话等价的集成夹具：Plan 模式执行一个安全原子卷查询、阻断复合 shell、再结束回答；断言没有 write/unknown effect、没有质量门禁事件、没有 ESLint/tsc 调用。
- [x] 8.2 在同一集成边界增加真实代码写入场景，断言 write effect、变更资源、quality_check_status、结构化日志、trace span 与唯一 complete 的顺序一致。
- [x] 8.3 增加“目录比较部分成功”集成场景：多个子目录中一个无权限或链接被跳过，其他目录仍返回 lower-bound/complete 记录；模型提醒不得声称整个根目录已完整测量。
- [x] 8.4 增加“watcher 噪声”集成场景：触发无内容文件事件并运行质量门禁，断言技能缓存不刷新、system prompt hash 不变化、前台不出现 RuleManager 文案。
- [x] 8.5 审核 `proposal.md`、`design.md`、全部 `specs/*/spec.md` 与实现，逐项确认 actual effect、质量重试上限、扫描完整性、证据作用域、watcher close、日志/trace 字段均有代码和测试落点。
- [x] 8.6 审核所有新增或修改的公开 Class、Interface、Function、Method 注释符合标准 TSDoc；纯函数文件顶部保留文件级 JSDoc，含 Class 文件的 import 前不写文件级注释。
- [x] 8.7 运行 TypeScript 编译与本 change 全部聚焦测试，修复失败时只修改当前 change 涉及的边界，不顺手清理无关历史代码。
- [x] 8.8 运行 OpenSpec strict 校验和 change status，确认所有任务状态、增量 spec 与主规范名称一致；实现验收完成前不得提前 archive。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/adapters/tools/terminal.test.ts test/adapters/tools/tools.test.ts test/core/domain/diagnostic-guardrails.test.ts test/core/usecases/engine/tool-call-orchestrator.test.ts test/core/usecases/engine/agent-loop.test.ts test/core/usecases/brain/RuleManager.test.ts test/core/usecases/brain/MemoryService.test.ts test/core/usecases/engine/SessionManager.test.ts test/adapters/input/interface/CliFacade.test.ts test/contract/log-pipeline.test.ts test/contract/diagnostic-data-governance.test.ts -->
<!-- checkpoint: openspec validate harden-runtime-diagnostics-and-postrun-lifecycle --strict -->
