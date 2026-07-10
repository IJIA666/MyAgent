## 背景

当前诊断数据由三个相互独立的写盘边界组成：`run.log` 通过统一 logger 写入滚动 JSONL，`AgentTracer` 将 trace 和插件 audit 分别写入会话级 JSONL，`TracerLogPlugin` 在生命周期 Hook 中提供审计事件和上下文补丁。trace 的格式为了回放保存完整 system prompt、上下文、reasoning、工具参数和结果；audit 也会保存工具调用和 Immer patches 的原始值。

会话 snapshot 由 `ContextRepository` 负责恢复语义，保存完整消息历史、checkpoint summary、recent files 和 pending interaction。它虽然敏感，但不是诊断输出，不能在本 change 中用诊断策略替换其恢复数据，否则会直接破坏 resume。

## 目标与非目标

**目标:**

- 建立 `operational`、`audit`、`replay` 三档诊断数据策略，并给出明确的默认采集行为。
- 在 `run.log`、trace、audit 首次序列化前执行同一套递归、字段感知的脱敏和长度/换行清洗。
- 默认保留稳定事件名、关联标识、状态、耗时、计数、摘要和不可逆指纹，避免把 prompt、reasoning、工具载荷和补丁值写入默认诊断文件。
- 通过显式 replay 配置保留短期完整回放能力，并让读取器区分可回放记录和 metadata-only 记录。
- 为 trace/audit 提供独立的按天数和会话数清理，限制默认和配置后的数据规模。
- 保持历史完整 trace 的读取能力以及 session snapshot 的现有保存、加载和恢复语义。

**非目标:**

- 不改变模型请求、工具执行、插件控制流、审批决策或上下文恢复行为。
- 不把 session snapshot 改造成 metadata-only 文件，也不在本 change 中治理其敏感内容。
- 不重写同步 `appendFileSync` 为异步日志管道，不引入数据库、集中式遥测后端或新的生命周期框架。
- 不依赖 `.gitignore` 或后处理脚本解决敏感数据问题。
- 不保证正则规则能够识别所有未知秘密；字段规则和模式规则共同构成防护，但不能替代文件访问控制。

## 架构决策

### 1. 以制品类型而不是 logger level 选择采集策略

使用独立的诊断策略配置，将 `run.log` 映射到 `operational`，audit 映射到 `audit`，trace 根据是否显式开启 replay 选择 `operational` 或 `replay`。默认开启 operational 和 audit，默认关闭 replay。`LOG_LEVEL` 只控制控制台/普通日志等级，不得关闭安全字段脱敏或审计必要事件。

选择按制品分级而不是继续扩展 DEBUG/INFO 的原因是日志等级表达输出噪声，不表达内容敏感度；同一个 INFO 事件可能同时包含安全摘要和完整工具结果。按制品分级也能保留 audit 的授权价值，而不把它误当作完整回放。

### 2. 在最终序列化边界复用统一 sanitizer

新增纯数据治理模块，接收 JSON 可序列化值和当前制品策略，返回不修改原始输入的安全副本。处理顺序为：

1. 递归遍历对象、数组和嵌套字符串，识别 `secret`、`token`、`authorization`、`password`、`env`、`headers`、`content`、`arguments`、`result` 等敏感字段及其大小写/分隔符变体。
2. 对命中字段执行掩码、摘要或结构化摘要；对普通文本执行内置 token/连接串/凭据模式和用户自定义模式替换。
3. 限制超长字符串和数组摘要，清洗 CR/LF 与 JSONL 分隔符，避免数据泄露和日志注入。
4. 在 `operational` 和 `audit` 下只保留允许的字段；在 `replay` 下保留回放字段，但仍执行基础秘密字段和用户模式脱敏。

sanitizer 必须在 logger、tracer 和 audit plugin 各自交给文件 sink/`appendFileSync` 之前调用，而不是只在展示端调用。这样可以覆盖绕过统一 logger 的 trace/audit 写入，也能保证原始值从未进入目标文件。安全字段的基础脱敏不能被普通日志开关或 replay 开关关闭。

### 3. 默认 trace 使用可识别的 metadata-only 格式

默认 trace 保留 session/iteration/prompt hash、模型标识、事件类型、工具名、调用关联 ID、状态、耗时、token usage、内容长度和不可逆摘要；不保存 prompt 定义正文、普通消息正文、reasoning、工具 arguments/result。记录中带有 capture mode/version，使读取器能明确报告“可读取但不可完整回放”，而不是把空内容误认为完整上下文。

显式 replay 开启时，trace 仍使用现有结构化记录和 prompt definition/iteration 关联方式，以保留离线回放路径；写盘前仍经过基础脱敏。历史完整 trace 不做重写，读取器继续兼容旧记录，并按记录自身的 capture mode 判断是否可以 hydration。

选择保留同一 trace 族格式而不是新建第二种文件的原因是现有 trace reader、session 绑定和问题定位工具可以复用；capture mode 明确了内容采集差异，避免文件名成为隐式安全开关。

### 4. audit 记录“发生了什么”而不是“原始值是什么”

`TracerLogPlugin` 继续记录生命周期顺序，但默认 audit 只写入事件名、工具名、调用关联 ID、资源类别/相对路径摘要、策略结果、状态、耗时、patch 操作和路径摘要、变更类别与不可逆值摘要。不得写入原始 `context.toolCall`、patch value、prompt、消息正文或工具结果。

选择摘要审计而不是彻底删除 audit 的原因是授权与事故归因仍需要知道谁在何时对何类资源执行了什么策略结果；选择不可逆摘要而不是可恢复加密载荷则避免本地日志变成另一份可解密数据仓库。

### 5. retention 采用简单、可预测的启动/写入前清理

trace 和 audit 分别维护默认 7 天、最多 20 个会话文件的保留上限；配置允许降低或提高限制，但不得超过 30 天或 100 个会话文件的安全上限。清理在创建新 tracer 或首次写入前执行，按文件的最后修改时间保留最新记录，并保护当前活跃 session 文件。`run.log` 继续使用现有 10MB × 5 文件轮转，不与 trace/audit 清理混合。

选择简单清理函数而不是扩展 `LifecycleManager`，因为当前问题是本地文件数据边界而不是生命周期编排；启动/写入前清理足以覆盖长期无人值守场景，且失败时不应阻断 Agent 主流程，只记录受治理的清理失败事件。

### 6. 通过配置迁移而不是数据迁移切换默认行为

旧配置没有 replay/retention 字段时采用安全默认值。旧 trace/audit 文件保持原样，由用户自行按新的 retention 清理；新版本不扫描并重写历史原文。开启 replay 必须在会话启动前设置，并在用户可见配置说明中标记敏感数据和短期保留风险。

## 风险与权衡

- **默认 trace 不再完整回放** -> 记录 capture mode 和内容摘要；需要完整回放时显式开启 replay，并保留旧文件读取兼容。
- **字段规则可能漏掉未知秘密** -> 组合结构化字段规则、内置模式和用户自定义模式；对 `content`、`arguments`、`result` 等高风险字段默认摘要/删除，不把正则当作唯一防线。
- **脱敏可能误伤可诊断内容** -> operational/audit 只保留稳定 metadata 和不可逆摘要；replay 仍保留非秘密正文，并通过 focused tests 覆盖嵌套对象、数组、错误和自定义 pattern。
- **清理过程中可能删除用户正在排查的文件** -> 只清理超出时间/数量上限的非活跃文件，保护当前 session，清理失败不影响主流程。
- **新增递归复制和正则替换带来开销** -> 仅在写盘边界执行，保留长度上限并避免重复序列化；当前同步写盘性能不在本 change 中重构。
- **session snapshot 仍然含敏感数据** -> 在文档和 change 边界中明确其属于恢复状态；另行评估 snapshot 脱敏，避免本 change 破坏恢复契约。

## 迁移与回滚

1. 先发布策略、sanitizer、metadata-only trace 读取和新测试，再启用默认 operational/audit 行为。
2. 配置旧版本未识别的字段时，旧版本继续使用旧行为；升级后无配置则使用安全默认值。
3. 升级不改写历史 trace/audit；读取器按旧格式继续读取，清理器只依据 retention 删除超期文件。
4. 若 replay 或脱敏规则出现兼容问题，可关闭新配置并保留历史文件；代码回滚不会要求数据格式迁移，session snapshot 不受影响。

## 开放问题

没有阻塞当前 change 的开放问题。组织特定的额外脱敏 pattern 和未来 session snapshot 治理属于配置扩展或独立 change，不改变本次三类诊断制品的边界。
