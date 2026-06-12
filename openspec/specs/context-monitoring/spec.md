## 新增需求

### Requirement: 本地 Token 预算前置估算
系统必须（MUST）引入纯 JavaScript 的分词组件 `js-tiktoken`，在向大模型发起 API 请求之前，对即将发送的所有消息块（包括基础人设、挂载的全局规则、可用技能索引、动态注入的项目规则、临时技能规范以及历史消息链）分别计算估算的 Token 长度。

#### Scenario: 会话发送前触发分块 Token 计算
- **WHEN** 触发单次 ReAct 会话交互（`SessionManager.chat()`）且大模型网络请求尚未发送时
- **THEN** 系统应分别计算出 System Prompt（人设 + 全局规则 + 技能大纲）、Project Rules、Transient Skill 以及历史消息各部分的 Token 估算长度，并汇总当前总请求 Token。

### Requirement: 提示词前缀缓存哈希一致性监测
系统必须（MUST）缓存并检测静态 System Prompt 部分的哈希一致性。如果在同一会话的连续交互中发生非预期的哈希变更，系统应当（SHALL）在终端控制台向用户和开发人员抛出缓存抖动与 Caching 失效的风险预警。

#### Scenario: 动态规则热重载引起哈希前缀抖动
- **WHEN** 在会话中，全局规则文件被重载或可用技能目录发生变化，导致重新组装得到的静态 System Prompt 物理字符与前一次的哈希基准不一致时
- **THEN** 系统应在下一次向大模型发起请求前，抛出包含缓存前缀抖动风险提示的警告信息，并在日志中记录此次抖动的变更细节。

### Requirement: 大模型 API 真实 Usage 提取与校准
系统必须（MUST）在模型接口流式调用返回后，无损解析 API 响应体中的 `usage` 字段（包括输入 Token 数、输出 Token 数以及具体的 `cached_tokens` 等缓存特征），用真实结算数据校准前置的 Token 预测数据库，并落盘存储。

#### Scenario: 接口请求完成后校准 Token 计数并记录黑匣子
- **WHEN** 底层 `LlmDriver` 完成了流式会话解析，并正常触发了大模型完成事件（`complete` 或 `tool_calls`）时
- **THEN** 系统应提取返回的真实 `usage` 参数，修正本轮的前置估算值，并将包含真实 Token 水位、缓存命中率的 `InteractionRecord` 数据沉淀到 `AgentTracer` 交互日志文件中。

### Requirement: 终端 REPL 界面监控回显
系统必须（MUST）在 REPL 命令行控制台界面，以直观的可视化文本、百分比或色阶柱状图，实时向用户展示当前会话消耗 of Token 数量、占比以及哈希缓存的健康状态。

#### Scenario: 每一轮 ReAct 结束时在命令行展示 Token 监控指标
- **WHEN** 一轮用户指令及大模型（含多轮工具调用）在 REPL 终端交互闭环，大模型输出最终回复且准备接受用户下一次输入时
- **THEN** 系统应计算出当前总上下文占用大模型窗口的百分比，在终端控制台打印出格式化的监控面板（显示静态前缀 Token 数、动态消息 Token 数、累计花费、以及本次缓存命中率）。
