## 改造原因

当前运行时暴露出两类会直接误导用户和 Agent 的契约缺口。其一，`/model` 虽然允许选择目标模型，但目标 profile 仍可能被进程环境中的 `AGENT_LLM_MODEL` 反向覆盖，界面提示”已生效”却未必代表实际请求模型已经切换；同时，Token 面板使用与会话配置不一致的固定值，用户无法确认实际生效的上下文窗口。其二，系统级只读诊断在工作模式或 effect 判定阶段被拒绝后，现有提醒虽然要求收敛，运行时仍可能允许模型改用不具备测量语义的浏览器文件导航反复枚举目标，把失败或枚举结果错误推断成容量证据。

这些问题已经在真实磁盘诊断会话中造成模型选择不可验证、上下文配置不可控以及连续低价值工具调用。现在需要把”实际生效的模型配置”和”诊断失败后的可执行恢复路径”提升为可验证的运行时契约，而不是继续依赖模型自行理解提示词。

核心认识：上下文窗口是模型 profile 的内建元数据，不同上下文版本应注册为不同 profile ID，而非对同一 profile 覆盖窗口。因此 `/model` 不需要展示窗口选择步骤——用户只选模型，contextWindow 由 profile 自动同步。

## 变更内容

- 修正运行时模型选择的配置优先级：显式选择的目标 profile 必须决定本次会话实际使用的模型，持久化的默认环境配置不得反向覆盖当前选择。
- 明确上下文窗口由模型 profile 唯一决定，不对 `/model` 添加窗口选择步骤。用户只选模型，contextWindow 随 profile 自动同步。不同上下文版本的模型应注册为不同 profile ID。
- 统一模型切换后的用户反馈、会话状态、Token 窗口展示和后续 API 请求所使用的有效配置；切换结果必须展示实际 provider model 与 context window（后者为观测字段，非用户选项）。
- 为进程启动和运行时模型切换补充不包含密钥的结构化配置日志，使尚未产生聊天内容的进程也能确认加载了哪个模型、上下文窗口和 profile。
- 收紧系统诊断失败后的工具恢复路径：不具备目标指标测量语义的浏览器文件导航不得作为目录容量查询的降级替代，失败或 `ERR_ABORTED` 不得被升级为“目录过大”等测量结论。
- 将诊断调用的停机条件落到运行时控制：连续调用未提升证据等级、重复失败或仅扩展枚举范围时，必须阻止继续横向扩散，并要求基于现有证据总结、声明未知项或请求用户缩小范围。
- 校准只读系统查询与浏览器导航的实际 effect，确保 Plan 模式、安全策略、审计和诊断恢复逻辑使用一致的事实分类。

## 业务能力

### 新增业务能力

无。

### 修改业务能力

- `dynamic-model-selection`: 明确显式模型选择的契约：用户只选模型，上下文窗口由 profile 唯一决定且自动同步；原子切换和实际生效配置反馈。
- `diagnostic-planning-guardrails`: 明确系统诊断失败后允许的替代能力、禁止浏览器文件导航伪装成测量工具，并将低证据增益停机条件落实到运行时。
- `diagnostic-evidence-quality`: 明确导航失败、目录枚举和浏览器错误不得形成容量测量或目录大小结论。
- `runtime-effect-accounting`: 校准原子只读系统查询与浏览器导航的实际 effect 和失败状态，避免策略层依据错误分类做出拒绝或放行。
- `logging-observability-and-naming`: 增加启动及模型切换时的有效模型配置日志，使空会话场景仍可诊断配置加载结果。

## 影响范围

- 配置与模型 profile：`src/config/models.ts`、`src/config/types.ts`、`src/config/loader.ts`。
- CLI 模型向导与状态展示：`src/adapters/input/interface/commands/model.ts`、`src/adapters/input/interface/views/widget-renderer.ts` 及相关交互适配层。
- 会话与 LLM 适配：`src/core/usecases/engine/session.ts`、`src/adapters/llm/OpenAiLlmAdapter.ts`、Token 估算与上下文监控调用链。
- 诊断约束与工具运行时：动态 system reminder、诊断证据账本、`ToolExecutor -> ToolRegistry -> ToolCallOrchestrator -> AgentLoop` effect 传递路径，以及浏览器和终端工具的 effect 解析。
- 可观测性：启动配置日志、模型切换日志、trace meta 中的有效模型信息。
- 测试：模型配置优先级、交互选择与取消、会话热切换、Token 窗口准确展示、Plan 只读查询、浏览器导航 effect、诊断低增益停机和启动日志测试。
