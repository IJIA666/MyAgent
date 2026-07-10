# 探索主题: 诊断数据治理与可回放边界

## 1. 问题定义

项目已经具备结构化 `run.log`、按会话 trace、插件 audit 和可恢复 session snapshot，近期变更也修复了命名、关联 ID 和 trace 回放结构。剩余问题不是“再加更多日志”，而是这些诊断制品缺少统一的数据分级、脱敏、采集开关和保留策略。当前默认 trace 会持久化完整 system prompt、上下文、reasoning、工具参数和结果，audit 会记录完整 tool call 与上下文补丁；Agent 可以读取密钥、配置、邮件或用户文档，因此本地日志目录会成为第二份高敏感数据仓库。需要在可观测性、黑盒回放和最小化敏感数据之间建立明确边界。

## 2. 关键发现与调研结果

- **三类数据语义已经不同**：`run.log` 是运维诊断流且已有 10MB × 5 文件轮转；trace 是按会话回放记录；audit 是插件生命周期与状态变更；session JSON 是最新可恢复快照。它们不应共享“什么都记”的默认策略，也不应被强行统一为一种格式。
- **trace 默认记录完整内容**：`agent-loop.ts` 写入完整 canonical system messages、每轮上下文、reasoning、assistant content、工具 arguments/result 和 token usage。即使 system prompt 通过 hash 去重，首次定义仍是明文完整内容。
- **audit 默认记录完整载荷**：`TracerLogPlugin` 在 BeforeTool/AfterTool 写入 `context.toolCall`，并将 `getAndClearPluginPatches()` 返回的补丁直接写盘。补丁可能包含消息、规则、记忆或配置内容；这里没有使用 `compressPatch()`，更没有字段级脱敏。
- **统一 logger 只做类型适配，不做数据治理**：`callRawLogger()` 会把任意对象直接交给 LogTape JSONL formatter；没有敏感字段白名单、token/authorization 模式脱敏、长度上限或换行清洗。当前 logger 测试验证幂等初始化和 patch 长度压缩，没有验证秘密不会落盘。
- **trace/audit 缺少保留上限**：`AgentTracer` 使用同步 `appendFileSync` 按 session 创建文件，未设置总量、天数或会话数上限。已有探索曾基于当时体量否决复杂清理框架，这个判断仍合理；但数据敏感性与默认采集范围使“简单、明确的保留策略”成为独立问题，不需要等磁盘变大才处理。
- **同步写入风险**：每个 trace/audit 事件都在 Agent 主执行链上同步追加。当前规模下未必构成性能瓶颈，因此不应单独立项重写异步管道；但任何后续批处理都必须保持崩溃尾行容错和关键审计事件顺序。
- **OWASP 核实**：OWASP 建议访问令牌、密码、密钥、连接串、敏感个人数据等不应直接写日志，并要求对日志的保留、访问、销毁和注入清洗有明确控制。[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- **OpenTelemetry 核实**：GenAI 语义约定明确标记 tool call arguments/result 可能包含敏感信息；完整 prompt、completion、工具参数和结果应属于 opt-in 内容，而不是默认遥测。[OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)、[GenAI 可观测性说明](https://opentelemetry.io/blog/2026/genai-observability/)
- **OpenCode 对照**：OpenCode 的通用 `Tool.execute` span 默认记录 `tool.name`、`session.id`、`message.id`、`tool.call_id` 等低基数关联属性，不默认把完整参数与结果挂到 span。参考文件：`D:\projects\Agents\opencode\packages\opencode\src\tool\tool.ts`。
- **OpenClaw 对照**：OpenClaw 提供集中式 `logging/redact.ts`，在工具详情、错误、WebSocket 日志、持久化 transcript 等多个出口复用；并有专门测试证明即使一般日志脱敏被关闭，安全边界日志仍不会泄露秘密。参考文件：`D:\projects\Agents\openclaw\src\logging\redact.ts`、`src\agents\agent-tool-definition-adapter.logging.test.ts`、`src\agents\transcript-redact.test.ts`。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：只做正则替换 | 方案 B：默认停止所有内容 trace | 方案 C：分级制品 + 字段脱敏 + 回放显式启用 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| 秘密防护 | 可兜底，但会漏掉未知格式 | 最强 | 字段规则为主、模式规则兜底 | C 可持续 |
| 黑盒回放 | 基本保留 | 丢失 | 默认 metadata，可显式开启短期 replay | C 平衡最好 |
| 运维检索 | 原始文本噪声仍大 | 只有少量事件 | 稳定事件名与关联字段，内容独立控制 | C 最清晰 |
| 实现复杂度 | 低 | 低 | 中，但可先覆盖三个写盘边界 | C 可控 |
| 合规与保留 | 未解决 | 仍需策略 | 每类制品独立保留与访问规则 | C 完整 |

**推荐路径**：定义三档诊断数据级别。`operational` 默认开启，只记录稳定事件名、component、session/call correlation、耗时、状态、错误类别和计数；`audit` 默认开启但只记录策略结果、资源摘要、批准选择、调用摘要哈希和变更类别，不记录原始 prompt、工具载荷或补丁值；`replay` 默认关闭，用户显式开启时才记录完整会话内容，并显示敏感数据提示和短期保留期限。所有制品在各自序列化边界调用同一套字段感知 sanitizer：先按字段名和数据类型处理 secret、token、authorization、env、headers、content、arguments、result，再用可配置模式做兜底。trace/audit 采用简单的会话数或天数上限，不为此扩展 `LifecycleManager`；session snapshot 保持现有恢复语义。

## 4. 约束、风险与未知项

- trace 的价值之一是完整回放，不能在没有替代方案时直接永久删除内容字段；应通过显式 replay 模式保留该能力。
- 脱敏必须发生在写盘前，不能依赖后处理脚本；后处理无法消除首次落盘和备份泄露。
- 字段名规则无法识别所有秘密，正则规则也会误报。需要组合策略，并为用户提供组织特定 patterns，但安全边界的基础脱敏不能被普通日志级别开关完全关闭。
- audit 的资源路径可能本身敏感。推荐默认保存规范化资源类别、工作区相对路径或不可逆摘要；只有本地显式诊断模式保存绝对路径。
- reasoning 内容可能包含用户秘密、系统策略和模型内部分析，不应因为“调试方便”默认持久化。
- retention 的具体天数或会话数需要结合本项目本地单用户定位确定；推荐先提供保守默认与配置上限，不引入数据库或集中式遥测后端。
- 当前 `appendFileSync` 是否需要异步化应以实际延迟测量决定，不与数据治理强行捆绑。

## 5. 否决方案

- **只依赖 `.gitignore` 保护 `.myagent`**：否决。未提交不等于未泄露，本机恶意软件、备份、诊断打包和共享仍可读取。
- **所有诊断制品默认记录完整内容**：否决。与 Agent 可访问的数据范围不匹配，形成高价值二次数据仓库。
- **彻底删除 trace/audit**：否决。会损失回放、事故分析和授权审计能力。
- **仅在展示日志时脱敏**：否决。磁盘原文仍然存在，无法满足最小化原则。
- **为保留策略引入新的生命周期清理框架**：否决。现阶段简单的启动前或写入前清理函数足够，不应扩大架构。
- **顺带重写异步日志管道**：否决。当前没有性能数据证明这是主要问题，应先完成数据边界治理。
