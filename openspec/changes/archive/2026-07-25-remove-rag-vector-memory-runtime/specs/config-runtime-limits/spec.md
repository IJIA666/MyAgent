## MODIFIED Requirements

### Requirement: 核心模块控制参数的可配置性扩展

系统在初始化加载环境配置时，必须（MUST）支持对中段上下文压缩和死循环熔断模块的有效运行参数进行环境变量抽提。系统不得（MUST NOT）继续解析或暴露已退役的长期记忆 RAG 参数、记忆子智能体总超时参数和异步完整 Checkpoint 参数。

#### Scenario: 死循环防护与中段压缩参数加载

- **WHEN** 应用程序加载 runtime limits，或 Token 水位触发中段压缩
- **THEN** 系统必须加载 `AGENT_LOOP_PREVENTION_LIMIT`，默认值为 3
- **THEN** 系统必须加载 `AGENT_COMPACTION_RETAIN_COUNT` 作为尾部最多保留的完整 user 轮数，默认值为 4
- **THEN** 系统必须加载 `AGENT_COMPACTION_RETAIN_TOKENS` 作为受保护尾部 token 预算，默认值为 8000
- **THEN** 系统必须加载 `AGENT_COMPACTION_SUMMARY_MAX_TOKENS` 作为摘要模型输出上限，默认值为 4096

#### Scenario: 非法压缩预算回退默认值

- **WHEN** 任一压缩轮数或 token 预算环境变量不是正整数
- **THEN** 配置加载器必须拒绝将非法值传入压缩服务，并使用该配置项的默认正整数值

#### Scenario: 已删除的完整 Checkpoint 与记忆 RAG 配置退出

- **WHEN** 应用程序加载环境配置
- **THEN** `AGENT_COMPACTION_TRIGGER_DELTA`、`AGENT_COMPACTION_FAILURE_LIMIT`、`AGENT_COMPACTION_RECENT_FILES_LIMIT` 不得出现在 `RuntimeLimitsConfig` 或压缩服务中
- **THEN** `AGENT_RAG_ENABLED`、`AGENT_RAG_SCORE_THRESHOLD`、`AGENT_RAG_RECALL_LIMIT`、`AGENT_RAG_REFINEMENT_THRESHOLD` 和 `AGENT_SUB_AGENT_TIMEOUT_MS` 不得出现在 `RuntimeLimitsConfig` 中
- **THEN** 即使部署环境仍提供这些旧变量，也不得触发异步完整摘要、静态兜底、recent-files 收集、记忆提炼或向量数据库初始化
