## MODIFIED Requirements

### Requirement: 核心模块控制参数的可配置性扩展

系统在初始化加载环境配置时，必须 MUST 支持对长期记忆 RAG 启闭开关、向量检索相似度过滤阈值、召回数量上限、自省最小轮数进行环境变量级配置。同时，系统 MUST 支持对中段上下文压缩和死循环熔断模块的有效运行参数进行环境变量抽提；已删除的异步完整 Checkpoint 参数不得继续进入运行时配置。

#### Scenario: RAG 功能模块运行期动态控制与阈值配置

- **WHEN** 应用程序在启动阶段解析环境变量，加载并冻结系统全局配置时
- **THEN** 系统必须加载 `AGENT_RAG_ENABLED`、`AGENT_RAG_SCORE_THRESHOLD`、`AGENT_RAG_RECALL_LIMIT` 和 `AGENT_RAG_REFINEMENT_THRESHOLD`，若未配置则使用对应默认值

#### Scenario: 死循环防护与中段压缩参数加载

- **WHEN** 应用程序加载 runtime limits，或 Token 水位触发中段压缩
- **THEN** 系统必须加载 `AGENT_LOOP_PREVENTION_LIMIT`，默认值为 3
- **THEN** 系统必须加载 `AGENT_COMPACTION_RETAIN_COUNT` 作为尾部最多保留的完整 user 轮数，默认值为 4
- **THEN** 系统必须加载 `AGENT_COMPACTION_RETAIN_TOKENS` 作为受保护尾部 token 预算，默认值为 8000
- **THEN** 系统必须加载 `AGENT_COMPACTION_SUMMARY_MAX_TOKENS` 作为摘要模型输出上限，默认值为 4096

#### Scenario: 非法压缩预算回退默认值

- **WHEN** 任一压缩轮数或 token 预算环境变量不是正整数
- **THEN** 配置加载器必须拒绝将非法值传入压缩服务，并使用该配置项的默认正整数值

#### Scenario: 已删除的完整 Checkpoint 配置退出

- **WHEN** 应用程序加载环境配置
- **THEN** `AGENT_COMPACTION_TRIGGER_DELTA`、`AGENT_COMPACTION_FAILURE_LIMIT`、`AGENT_COMPACTION_RECENT_FILES_LIMIT` 不得出现在 `RuntimeLimitsConfig` 或压缩服务中
- **THEN** 即使部署环境仍提供这些旧变量，也不得触发异步完整摘要、静态兜底或 recent-files 收集

#### Scenario: RAG 功能停用时的向量数据库零初始化开销

- **WHEN** 应用程序在启动阶段解析环境变量，确认 `AGENT_RAG_ENABLED` 为 `false`
- **THEN** 系统初始化流程及后续会话管理不得与 `VectorDbPort` 发生物理交互，确保不加载和连接 LanceDB

