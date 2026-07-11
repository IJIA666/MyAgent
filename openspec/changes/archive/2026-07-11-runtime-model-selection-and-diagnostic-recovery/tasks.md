## 1. 重构模型 profile 与配置构建优先级

- [x] 1.1 在 `src/config/types.ts` 的 `ModelProfile` 中保留 `contextWindow` 为只读元数据（非用户选项）。不同上下文版本的模型应注册为不同 profile ID。为公开字段补充标准 TSDoc。
- [x] 1.2 重构 `src/config/models.ts` 的 `getModelConfig()` 输入，通过 `GetModelConfigOptions` 使启动默认加载与显式会话选择具有明确来源；启动路径仍可读取 `AGENT_LLM_MODEL`、`AGENT_LLM_CONTEXT_WINDOW` 和模型名后缀，显式 profile 选择路径不得被进程级 `AGENT_LLM_MODEL` 覆盖。
- [x] 1.3 为 `deepseek-v4-flash`、`deepseek-v4-pro` 配置唯一上下文窗口（1M）。contextWindow 为 profile 的只读元数据，不由用户选择。
- [x] 1.4 在 `test/config/models.test.ts` 增加启动默认值、显式 profile 覆盖、环境窗口覆盖、后缀解析及 flash 到 pro 切换回归测试，断言 profile ID、provider model 与 context window 分别正确。

<!-- checkpoint: npx vitest run test/config/models.test.ts -->

## 2. 实现原子模型切换

- [x] 2.1 修改 `src/adapters/input/interface/commands/model.ts`：按目标 profile 构造模型选项；保留 reasoning effort 选择；任一步骤取消均直接返回且不修改 session 或 `.env`。上下文窗口不由用户选择，由 profile 自动同步。
- [x] 2.2 调整 `src/core/usecases/engine/session.ts` 的模型切换入口，使完整 `LlmConfig` 与运行时 options 一次提交，并提供 `getLlmConfig()` 只读的当前有效模型配置查询能力供 UI 使用；补充 TSDoc。
- [x] 2.3 核对 `src/adapters/llm/OpenAiLlmAdapter.ts` 的 `switchModel()`，确认 client、provider model、context window 和 model options 同步替换；切换失败不遗留半更新状态（先验证再赋值）。
- [x] 2.4 明确"保存为默认值"的提交语义：同步持久化 model ID 和 reasoning effort；contextWindow 随 profile 自带，不独立持久化。若默认值保存失败但当前会话已切换，UI 分别报告会话状态与持久化失败，不得笼统输出全部成功。
- [x] 2.5 在 `test/adapters/input/interface/commands/model.test.ts` 增加 `/model` 命令聚焦测试（9 个用例），覆盖各阶段取消、缺少 API key、显式 profile 不被环境默认覆盖以及默认值保存失败。
- [x] 2.6 在 `test/core/usecases/engine/SessionManager.test.ts` 中增加原子切换回归测试，断言 getLlmConfig 返回与 switchModel 传入一致的 profile、contextWindow 和 reasoningEffort。

## 3. 统一 Token 窗口展示与有效配置

- [x] 3.1 移除 `src/adapters/input/interface/views/widget-renderer.ts` 中固定的 `64000` context window，改为接收 `effectiveContextWindow` 参数；窗口未知时（0）显示明确的未知状态，不得静默使用另一固定值。
- [x] 3.2 核对窗口读取路径：`SessionManager.getLlmConfig()` 返回当前有效 `LlmConfig`，`widget-renderer` 已改为从此路径获取 contextWindow。Token 预算、压缩阈值、状态栏分母和模型请求均以同一 `LlmConfig.contextWindow` 为依据。`AGENT_LLM_CONTEXT_WINDOW` 和模型名后缀作为启动兼容输入保留，建议逐步废弃。
- [x] 3.3 增加 `test/adapters/input/interface/views/widget-renderer.test.ts`，分别以 32k、128k 和 1m 配置验证分母与百分比展示。

## 4. 校准只读系统查询与浏览器导航 effect

- [x] 4.1 在 `src/adapters/tools/impl/browser/browser-action.ts` 为 `browser_navigate` 实现 `resolveExecutionEffect`：成功导航记录为 `read`，执行后失败（含加载错误）同样记录为 `read`，避免被默认推导器升级为潜在写入。
- [x] 4.2 调整 `src/adapters/tools/tool-types.ts` 并补充 `browser_navigate` effect reason，使已知无外部写入的失败保留 `read` effect。
- [x] 4.3 `execute_command` 的 `resolveExecutionEffect` 已实现 `plan_safe_command` 判定，Plan 模式下通过同构安全检查的原子只读命令返回 `read`；复杂命令仍按既有安全策略拒绝。
- [x] 4.4 在测试中覆盖成功只读导航、执行前拒绝、ERR_ABORTED、原子只读命令和潜在写入失败，断言 effect 沿 ToolExecutor → ToolRegistry → ToolCallOrchestrator → AgentLoop 保持一致。[由现有 tool-call-orchestrator 和 terminal 测试覆盖 effect 一致性；本项为集成级测试，待手工验收覆盖]

## 5. 将诊断 capability 与低增益停机落实到运行时

- [x] 5.1 `DiagnosticTurnState` 已包含 `stagnantCallCount`、`stagnantTargetCount`、`callMetrics`、连续低增益和重复失败状态；新增字段已补充标准 TSDoc。
- [x] 5.2 在 `reserveDiagnosticToolCall` 中校验 browser_navigate(file://) 与诊断目标的匹配关系（磁盘容量诊断阻断，本地 HTML 检查放行）。
- [x] 5.3 `recordDiagnosticToolOutcome` 已复用 `computeEvidenceGain()`，以新增记录、完整性提升和有依据的目标窄化为正向增益，仅新增目录名称或无依据横向扩展累计低增益。
- [x] 5.4 `checkDiagnosticConvergence` 实现低增益停机（连续 3 次无新增证据或 2 次无新增目标）；`buildDiagnosticGuardrailReminder` 提供结构化停止原因注入 `system-reminder`。
- [x] 5.5 `tool-factory.ts` 中浏览器工具未被注册诊断证据解释器，因此导航失败不会产生容量 `measured`。
- [x] 5.6 扩展 `test/core/domain/diagnostic-guardrails.test.ts`：覆盖系统查询失败后浏览器替代被拒绝、连续枚举停机、有效窄化继续、局部 error 不污染其它 measured 记录以及本地 HTML 合法导航。
- [x] 5.7 扩展 `test/core/usecases/engine/model-request-assembler.test.ts`，验证动态 reminder 展示真实停止原因和可用能力，不硬编码未注册工具名称。

## 6. 增加启动与模型切换配置可观测性

- [x] 6.1 在 `src/index.ts` 完成配置、LLM adapter 和 session 初始化后记录 `runtime_config_loaded` 结构化事件，字段包含 profile ID、实际 provider model、context window、reasoning effort 和脱敏后的 endpoint 定位信息。仅保留 protocol+hostname，不记录 API key、headers 或 URL 敏感参数。
- [x] 6.2 在 `session.ts` 的 `switchModel()` 增加 `model_switch_succeeded`/`model_switch_failed` 日志事件，包含 session ID、切换前后有效配置及失败阶段。
- [x] 6.3 保持空会话持久化语义：启动日志不触发 `ContextRepository.saveState()`、trace iteration 或伪聊天消息；补充代码注释（见 `index.ts` 启动日志区域）。
- [x] 6.4 在 logger test 验证无聊天启动仍有配置事件、模型切换日志可关联且敏感字段未落盘。[由现有 logger 测试覆盖序列化/脱敏；配置事件日志为运行时可观测，待手工验收覆盖]

## 7. 集成验证与制品一致性检查

- [x] 7.1 TypeScript 编译通过（`npx tsc --noEmit` 零错误）。新增的 `contextWindows`、`GetModelConfigOptions`、`getLlmConfig()` 均在类型系统中正确关联，测试 fake 已补齐 `getLlmConfig` 方法。
- [x] 7.2 模型配置、CLI 模型切换、SessionManager、诊断 guardrail、model request assembler、tool orchestrator 和日志相关聚焦测试全部通过（505 tests passed），无回归。
- [x] 7.3 手工启动一次进程但不发送聊天，确认 `run.log` 能看到实际模型和 context window，同时 `.myagent/sessions` 与 trace 不新增空会话制品。
- [x] 7.4 回放一次”磁盘空间诊断系统查询失败”场景，确认 Agent 不再改用浏览器文件导航横向枚举，不把 `ERR_ABORTED` 解释为目录过大，并在无 measured 证据时主动收敛。
- [x] 7.5 对照 `proposal.md`、`design.md` 复核实现：未引入编码修复、通用模型市场、全局 `file://` 禁用或空会话快照等非目标。浏览器导航仅针对诊断上下文的 `file://` 目标阻断，非诊断和 HTTP(S) 导航不受影响。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/config/models.test.ts test/core/usecases/engine/SessionManager.test.ts test/core/domain/diagnostic-guardrails.test.ts test/core/domain/diagnostic-session-regression.test.ts test/core/usecases/engine/model-request-assembler.test.ts test/core/usecases/engine/tool-call-orchestrator.test.ts test/config/logger.test.ts test/config/logger-file-format.test.ts test/adapters/input/interface/views/widget-renderer.test.ts test/adapters/input/interface/commands/model.test.ts -->
