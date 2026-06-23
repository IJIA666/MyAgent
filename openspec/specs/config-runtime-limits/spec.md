# Config Runtime Limits

## Purpose
支持对长期记忆 RAG、上下文压缩（Compaction）和死循环熔断（Loop Prevention）等核心模块控制参数进行运行期环境变量抽提与可配置性扩展，取代原有系统硬编码限制，提高部署时的动态调节能力。

## Requirements

### Requirement: 核心模块控制参数的可配置性扩展
系统在初始化加载环境配置时，必须 (MUST) 支持对长期记忆 RAG 启闭开关、向量检索相似度过滤阈值、召回数量上限、自省最小轮数进行环境变量级配置。同时，系统必须 (MUST) 支持对上下文压缩（Compaction）和死循环熔断（Loop Prevention）模块中的所有原硬编码参数进行环境变量抽提，允许外部调用与部署时动态干预。

#### Scenario: RAG 功能模块运行期动态控制与阈值配置
- **WHEN** 应用程序在启动阶段解析环境变量，加载并冻结系统全局配置时
- **THEN** 系统必须加载 `AGENT_RAG_ENABLED`（启闭 RAG）、`AGENT_RAG_SCORE_THRESHOLD`（向量分数阈值）、`AGENT_RAG_RECALL_LIMIT`（召回条数限制）和 `AGENT_RAG_REFINEMENT_THRESHOLD`（自省轮数限制）等四个 RAG 环境变量，若未配置，则降级使用对应的系统安全默认值。

#### Scenario: 死循环防护与上下文压缩服务硬编码参数抽提
- **WHEN** 触发死循环熔断插件（BeforeTool 阶段）或上下文提炼压缩服务运行（afterTurn 阶段）时
- **THEN** 对应服务必须加载并遵循环境变量中配置的 `AGENT_LOOP_PREVENTION_LIMIT`（同一工具相同参数熔断限额）、`AGENT_COMPACTION_RETAIN_COUNT`（硬截断保留最新消息轮数）、`AGENT_COMPACTION_TRIGGER_DELTA`（触发异步摘要的 Token 额度）、`AGENT_COMPACTION_FAILURE_LIMIT`（允许连续压缩失败的次数上限）及 `AGENT_COMPACTION_RECENT_FILES_LIMIT`（收集并记忆的最新的读写文件路径数），若未配置则退化到原有的 3 次熔断、4 轮保留、5000 Token 差额、3 次失败降级和 5 个文件跟踪 of 硬编码逻辑。

#### Scenario: RAG 功能停用时的向量数据库零初始化开销
- **WHEN** 应用程序在启动阶段解析环境变量，确认加载的 `AGENT_RAG_ENABLED` 值为 `false` 时
- **THEN** 整个系统初始化流程及后续会话管理均不得与底层向量数据库适配器（`VectorDbPort`）发生 any 物理交互（例如调用 `count` 查询或数据重建等），确保不加载和连接 LanceDB，实现零数据库开销。
