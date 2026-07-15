## ADDED Requirements

### Requirement: 历史中段摘要协议

系统 MUST 将待压缩中段视为早于保留尾部的历史源材料，并生成只用于理解后续原文的结构化历史摘要。摘要 MUST NOT 定义当前任务、待办或下一步，MUST NOT 回答历史中的问题，且后续保留原文与摘要冲突时 MUST 以后续原文为准。

#### Scenario: 生成历史型中段摘要

- **WHEN** 系统将可压缩中段发送给摘要模型
- **THEN** system 指令必须说明摘要之后仍保留时间上更新的原文，摘要只具有历史参考语义
- **THEN** 摘要必须按语义覆盖历史目标与背景、历史约束与偏好、已完成事项与结果、关键决定与依据、片段结束状态、问题/错误与有效结论、相关资源与关键事实
- **THEN** 摘要不得生成“当前任务”“待处理事项”或“下一步”章节

#### Scenario: 摘要输入保留必要工具事实

- **WHEN** 中段包含带 `tool_calls` 的 assistant 消息及对应 tool result
- **THEN** 摘要输入必须包含 assistant 可见文本、每个工具调用的名称与原始 arguments、tool result 的 `tool_call_id` 与内容
- **THEN** 摘要输入不得包含 system prompt、内部 `reasoning_content` 或运行时私有元数据

#### Scenario: 语言、标识符与敏感信息处理

- **WHEN** 摘要模型处理任意语言的历史中段
- **THEN** 摘要正文必须沿用该历史的主要语言
- **THEN** 继续理解所需的路径、命令、错误、URL 和标识符必须保持精确，不得翻译或重写
- **THEN** API Key、Token、密码、凭据和连接字符串不得保留原值，必须替换为 `[REDACTED]`

### Requirement: 中段压缩失败原子性

系统 MUST 先完成安全边界计算与摘要生成，再一次性替换会话历史。任何失败都不得用缺少真实中段事实的静态文本强行截断历史。

#### Scenario: 摘要调用失败或返回空文本

- **WHEN** 摘要模型抛出异常、超时或返回空白结果
- **THEN** `compact()` 必须返回失败
- **THEN** 内存消息历史和已持久化消息历史必须保持压缩前状态

#### Scenario: 不存在安全可压缩中段

- **WHEN** 头部保护区与尾部保护区重叠，或消息无法在不切断完整轮次的情况下形成中段
- **THEN** `compact()` 必须返回失败且不得修改历史

## MODIFIED Requirements

### Requirement: 对抗 Lost-in-the-Middle 的首尾双保中段压缩 (Head & Tail Preserved Compaction)

当历史会话 Token 数量超限触发 Compaction 时，系统 MUST 保护消息历史开头连续的 system prompt 前缀，并仅对该前缀和近期尾部之间的对话历史进行 LLM 语义总结。工具列表 MUST 继续作为独立请求字段保留，不参与消息历史压缩。近期尾部 MUST 由完整 user 轮次组成，同时受最大轮数与 token 预算约束；系统 MUST 至少保护最新一个完整 user 轮次，并用一条 user 角色的 Summary Notice 在原位置替换中段。

#### Scenario: Token 超额时触发中段有损压缩

- **WHEN** 当前会话 Token 水位超过模型的 Compaction 阈值，且头部与尾部之间存在可压缩中段
- **THEN** 系统必须只保护消息历史开头连续的 system prompt 前缀，首个 user 轮次及其 assistant/tool 结算消息应与其他较早历史一起进入中段
- **THEN** 独立的模型工具列表必须保持不变
- **THEN** 系统必须只把中段交给摘要模型，并将有效摘要以 Summary Notice 原位插入
- **THEN** 受保护尾部必须按原顺序完整拼接在摘要之后

#### Scenario: 按轮数和 token 预算选择近期尾部

- **WHEN** 系统从最后一个 user 轮次向前选择受保护尾部
- **THEN** 尾部最多保留 `compactionRetainCount` 个完整 user 轮次，默认最多 4 轮
- **THEN** 在加入更早轮次会超过 `compactionRetainTokens` 时，系统必须停止扩展尾部，默认预算为 8000 tokens
- **THEN** 最新一个完整 user 轮次即使自身超过预算也必须保留

#### Scenario: 保持工具调用协议完整

- **WHEN** 某个受保护轮次包含 assistant `tool_calls` 与后续 tool result
- **THEN** 系统不得把截断边界放在该工具调用与结果之间
- **THEN** 压缩层不得再次截断或改写近期 tool result，超大工具输出继续由既有 tool-output-offloading 能力处理

#### Scenario: 手动压缩复用同一中段策略

- **WHEN** 用户执行 `/compact`
- **THEN** 系统必须使用与自动 Token 水位触发相同的头部、尾部、token 预算、摘要协议和原子失败规则
- **THEN** 系统不得切换为完整历史压缩或单侧部分压缩

#### Scenario: 自动压缩通过 Hook 沙箱原子提交

- **WHEN** Token 水位插件在 Hook 管线 busy 锁期间触发中段压缩
- **THEN** 历史整体替换必须写入 Hook draft，不得绕过沙箱直接改写宿主会话
- **THEN** 插件运行器必须在释放 busy 锁后统一提交有效历史，并把压缩成功产生的 `restart` 控制信号同步回调用方
- **THEN** 摘要失败时不得提交 draft 历史或返回成功重启

## REMOVED Requirements

### Requirement: 异步定期提炼策略 (Asynchronous Compaction)

**Reason:** 回合后完整历史 Checkpoint 与中段 Summary Notice 形成两套互相冲突的历史来源，并产生重复模型调用和旧任务重新激活风险。

**Migration:** 删除 after-turn 异步摘要入口及其状态；会话恢复只依赖持久化 `messageHistory` 中的原始消息和中段 Summary Notice。

#### Scenario: 回合结束不再生成完整 Checkpoint

- **WHEN** 用户交互回合结束
- **THEN** 系统不得基于 Token 增量启动完整历史摘要，也不得写入独立 Checkpoint 状态

### Requirement: 标识符防篡改护栏 (Strict Identifier Preservation)

**Reason:** 无条件绝对保留所有不透明字符串会放大摘要体积并保留无关或敏感内容，且旧提示词措辞不构成可验证契约。

**Migration:** 在“历史中段摘要协议”中仅精确保留继续理解所需的标识符，并对凭据执行 `[REDACTED]`。

#### Scenario: 不再注入独立绝对禁令

- **WHEN** 系统构建中段摘要请求
- **THEN** 系统不得追加独立 `IDENTIFIER_PRESERVATION_INSTRUCTION` 常量

### Requirement: 交接班角色防偏离 (Handoff Instructions)

**Reason:** “LEADER / SUBORDINATE”角色晋升会改变正常 Agent 身份，并可能阻止模型继续执行用户要求。

**Migration:** 中段摘要只声明历史参考语义；后续保留原文自然决定当前工作，不再注入角色 handoff。

#### Scenario: 不再注入角色晋升

- **WHEN** 模型请求包含压缩后的 Summary Notice
- **THEN** 系统不得追加 `HANDOFF_INSTRUCTION` 或任何等价的领导者、子单元和只做战略指挥声明

### Requirement: 本地确定性静态兜底 (Deterministic Fallback)

**Reason:** 只包含最后工具名或最后用户请求的静态文本不能代表被删除中段，强行替换会造成不可逆信息丢失。

**Migration:** 摘要失败时遵循“中段压缩失败原子性”，返回失败并保留完整原历史。

#### Scenario: 摘要失败不再强行截断

- **WHEN** 摘要模型不可用或返回无效结果
- **THEN** 系统不得调用 `buildStaticFallbackSummary()` 替换中段

### Requirement: 文件清单与增量变更挂载 (File Operations Tracking & Diff Mount)

**Reason:** recent-files 清单只服务已删除的完整 Checkpoint 注入，且文件事实已经存在于原始 tool call/result 和 tool-output-offloading 引用中。

**Migration:** 删除压缩阶段的 recent-files 收集与 `<recent_files_inventory>` 注入；工具编辑 Diff 和大输出文件引用继续由各自工具结果契约提供。

#### Scenario: 压缩后不再生成文件清单附件

- **WHEN** 中段压缩成功或模型请求组装
- **THEN** 压缩服务和上下文适配器不得扫描历史并生成独立 recent-files inventory
