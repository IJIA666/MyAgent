## 背景

当前模型配置同时承担“启动默认值”和“会话显式选择值”两种语义。`getModelConfig(id)` 已接收目标 profile ID，但内部仍优先使用全局 `AGENT_LLM_MODEL` 作为实际 provider model，导致显式热切换可能被启动默认值覆盖。`SessionManager.switchModel()` 与 `OpenAiLlmAdapter.switchModel()` 能够替换运行时配置，但 CLI 向导只传入模型和 reasoning effort，未把上下文窗口作为同一次切换的一部分；Token 展示又存在固定窗口值，形成配置、请求和界面三套事实来源。

诊断侧已经存在 `DiagnosticTurnState`、对象级证据账本、`computeEvidenceGain()`、调用预算和动态 reminder，但运行时约束主要围绕 `listFiles` 与 `execute_command`。浏览器导航没有容量测量能力，却可以在系统查询失败后继续访问 `file://` 目录；其结果既未被明确排除在容量证据之外，也未进入统一的低增益停机判断。与此同时，实际 effect 的保守回退会把部分成功导航标为 `write`，把执行后失败标为 `unknown`，导致 Plan 策略、审计与诊断恢复使用不一致的分类。

空会话不需要生成可恢复快照，但进程启动后应留下有效配置日志，否则用户无法判断重启后到底加载了哪个模型和窗口。

## 目标与非目标

**目标:**

- 建立启动默认配置与会话显式覆盖之间单向、可预测的优先级。
- 将 provider model、profile、context window 和 reasoning effort 作为一个不可分割的有效会话配置切换。
- 让 `/model` 只展示目标模型真实支持的上下文窗口，并让 UI、Token 估算和 API 请求读取同一配置。
- 让启动和模型切换在无聊天内容时也具备可诊断的结构化日志。
- 将浏览器导航从磁盘容量测量降级路径中排除，并让所有诊断工具进入统一的证据增益与停机控制。
- 校准工具实际 effect，使安全决策和审计基于执行事实而不是工具名称猜测。

**非目标:**

- 不修复或重构中文编码；本 change 不把读取端显示异常视为产品缺陷。
- 不新增通用模型市场、远程模型发现或任意 provider 配置编辑器。
- 不允许用户为任意模型输入未经 profile 声明的任意 context window。
- 不把浏览器改造成文件管理器或目录统计器。
- 不因空会话而创建 session 快照、trace iteration 或伪造聊天记录。
- 不重新设计整个 Plan/Build 模式、审批策略或终端安全模型。

## 架构决策

### 1. 分离启动默认值与显式会话选择

`getModelConfig()` 应明确区分两种入口：启动加载可以读取 `AGENT_LLM_MODEL` 默认值；通过 `/model` 传入 target profile 时，实际 provider model 必须来自该 profile 或显式的会话选择参数，不能再次被全局默认值覆盖。推荐通过具名构建选项表达来源，而不是在 CLI 临时删除或修改进程环境变量。

选择该方案是因为环境变量是进程级默认配置，不应承担会话内可变状态。备选方案是在切换前写入 `.env` 再重新加载配置，但这会把一次临时选择变成全局副作用，且无法可靠支持取消和多会话。

### 2. 上下文窗口由模型 profile 唯一决定

上下文窗口（contextWindow）是模型 profile 的只读元数据，不再作为独立配置项由用户选择。其理由如下：

- 系统内部仍然需要 contextWindow（Token 使用率展示、压缩阈值、请求预算、模型间切换后容量计算），但它不应成为交互选项。
- 不同上下文版本的模型（如 32k 与 1M）本质上是不同的模型/部署，应注册为不同 profile ID，而不是对同一个 profile 覆盖窗口。
- 允许用户选择与模型技术规格不一致的窗口（例如对只支持 1M 的模型选择 128k）会导致 UI 展示与实际 API 能力脱节。

`ModelProfile.contextWindow` 保留为可选的只读元数据字段。切换成功反馈和结构化日志从切换后的 `LlmConfig.contextWindow` 读取，`widget-renderer.ts` 不再维护固定 `64000`，从 `SessionManager.getLlmConfig().contextWindow` 获取使用率分母。

`AGENT_LLM_CONTEXT_WINDOW` 环境变量和模型名 `[1m]`/`[128k]` 后缀作为启动兼容输入保留（向后兼容），但从产品语义上建议逐步废弃：供应商的不同上下文版本应注册为不同 profile。

### 3. 模型切换采用先验证后提交

CLI 在修改会话前完成 profile API key 校验和 reasoning effort 选择。任何选择取消或校验失败都不得部分更新 session、adapter 或 `.env`。只有完整配置构建成功后才执行一次 `switchModel()`；用户选择保存默认值时，再将同一有效配置持久化到对应环境项。

由于 contextWindow 不再由用户选择，验证范围缩小为模型和 reasoning effort，避免了”模型已切换但窗口未切换”的情景。持久化失败时应明确报告”当前会话已生效、默认值保存失败”或采用先持久化临时文件再提交的原子更新策略，具体按现有 `updateEnvVariable` 能力选择并由测试锁定语义。

### 4. 诊断恢复依据 capability 与证据语义，而非工具名称猜测

在诊断域为工具结果保留明确的证据解释能力。`browser_navigate` 对网页访问可以产生导航状态，但对本地目录容量任务不得产生 `measured`，`ERR_ABORTED` 只能形成目标级 `error`。当系统查询失败时，下一步候选工具必须同时满足：当前模式允许、具备目标指标解释器、预计不会扩大未经筛选的目标范围。浏览器文件导航不满足磁盘大小指标解释器，因此在该上下文应被运行时拒绝，而不仅是由 prompt 劝阻。

备选方案是完全禁止 `file://`。这会影响合法的本地 HTML 检查，范围过宽，因此只在诊断目标和所需指标不匹配时阻断。

### 5. 将低增益停机条件统一接入工具预留与结算

复用 `DiagnosticTurnState`、`computeEvidenceGain()` 及现有 reserve/finalize 生命周期，增加连续低增益、重复目标失败和横向枚举扩散状态。每次诊断工具结算后更新状态；下一次调用预留前统一判断：若没有新增指标、完整性提升或由现有证据支持的更窄目标，则拒绝继续同类扩散，并注入明确的总结/澄清要求。

固定次数预算继续作为硬上限，但证据增益是主要判断。一次有价值的窄化测量不应因之前的枚举次数被机械拒绝；连续失败或只增加候选目录则应在达到大上限前提前停止。

### 6. effect 由工具执行结果沿统一链路产生

浏览器导航成功且只改变浏览器会话读取位置时，其实际 effect 应按工具契约记录为 `read`；执行前拒绝为 `none`；执行后失败但未改变外部资源时仍记录失败的读取尝试，而不是自动提升为潜在写入。原子只读系统查询通过安全判定并执行时同样为 `read`。effect 继续沿 `ToolExecutor -> ToolRegistry -> ToolCallOrchestrator -> AgentLoop` 传递，诊断层不按工具名称重新猜测。

### 7. 启动日志记录有效配置，不创建空会话制品

配置加载并完成 adapter/session 初始化后写入结构化 `runtime_config_loaded` 事件，包含 profile ID、实际 provider model、context window、reasoning effort 和 base URL 主机信息，不记录 API key、完整 headers 或敏感查询参数。模型切换成功或失败分别记录相关事件。空进程因此可由 `run.log` 验证配置，但 session snapshot 和 trace 仍只在真实会话内容产生后创建。

## 风险与权衡

- [切换时同时更新会话和 `.env` 可能出现部分成功] -> 明确当前会话切换与默认持久化的提交顺序和错误反馈，不输出笼统的”全部成功”。
- [诊断 capability 判断过严可能阻断合法探索] -> 只禁止与当前指标不匹配的替代工具；保留用户缩小范围、显式授权新目标和更窄测量路径。
- [低增益算法误判] -> 以新增指标、完整性提升和目标窄化三类正向信号判定，并保留固定预算作为兜底而非唯一规则。
- [effect 分类变化影响现有 Plan 策略测试] -> 按执行前、执行后成功、执行后失败分别增加契约测试，避免用静态 `securityCategory` 替代实际 effect。
- [启动日志增加配置暴露面] -> 采用字段白名单并对 URL 仅保留非敏感定位信息，禁止记录凭证和 headers。
- [模型名后缀与独立 profile 的边界模糊] -> 不同上下文版本的模型应注册为不同 profile ID；profile 作为唯一事实来源，`AGENT_LLM_CONTEXT_WINDOW` 和后缀解析视为兼容输入，建议逐步废弃。

## 迁移计划

1. 扩展模型 profile 与配置构建入口，同时保留现有启动环境变量和模型名窗口后缀解析。
2. 调整 `/model` 向导和 session 切换契约，不再将 context window 作为独立配置项，移除窗口展示中的固定值。
3. 增加启动/切换结构化日志，验证无聊天启动场景。
4. 扩展诊断状态和工具 capability/effect 解释，先以测试锁定现有合法只读路径，再启用低增益阻断。
5. 运行 TypeScript 编译、模型切换/CLI/诊断/effect 聚焦测试，并用一次无聊天启动和一次磁盘诊断回放验证行为。

回滚时可独立撤销诊断阻断逻辑并保留日志与模型配置修复；模型 profile 原有 `contextWindow` 字段不变，仅不再作为用户交互选项。

## 开放问题

- 不同供应商的多个上下文版本模型应如何注册 profile？当前建议：每个 profile 一个版本，profile ID 体现版本差异（如 `deepseek-v4-flash-32k`、`deepseek-v4-flash-1m`）。
- `.env` 默认持久化失败时，产品语义应采用”会话继续生效但提示保存失败”，还是回滚当前会话切换；推荐前者，因为临时会话切换本身不应依赖磁盘写入成功。
