# Config Runtime Limits

## Purpose
支持对中段上下文压缩和死循环熔断等核心模块控制参数进行运行期环境变量抽提与可配置性扩展，取代原有系统硬编码限制，提高部署时的动态调节能力。系统不得继续解析或暴露已退役的长期记忆 RAG 参数、记忆子智能体总超时参数和异步完整 Checkpoint 参数。

## Requirements

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

### Requirement: 后台子代理容量限制由统一配置装配

系统 MUST 由 `loadConfig()` 装配后台子代理最大并发数、最大在途任务数和前台自动后台化时长，并通过 `RuntimeLimitsConfig` 注入任务管理器。消费方不得定义不同的本地回落值。

#### Scenario: 使用默认后台容量

- **WHEN** `AGENT_SUBAGENT_MAX_CONCURRENT` 与 `AGENT_SUBAGENT_MAX_IN_FLIGHT` 均未配置
- **THEN** `subagentMaxConcurrent` 默认为 4
- **AND** `subagentMaxInFlight` 默认为 16

#### Scenario: 使用自定义后台容量

- **WHEN** 两个环境变量分别为有效正整数 2 和 8
- **THEN** `RuntimeLimitsConfig` 原样包含 `subagentMaxConcurrent: 2` 和 `subagentMaxInFlight: 8`
- **AND** 任务管理器使用这两个值进行排队和拒绝

#### Scenario: 单项配置非法

- **WHEN** 任一后台容量变量为空、不可解析、不是正整数或超出安全整数范围
- **THEN** 配置加载器不得把非法值传给任务管理器
- **AND** 该项回退到对应默认值

#### Scenario: 在途上限小于并发上限

- **WHEN** 解析后的 `subagentMaxInFlight` 小于 `subagentMaxConcurrent`
- **THEN** 两项配置整组回退为默认值 4 和 16
- **AND** 系统记录不包含环境变量原始值的诊断告警

#### Scenario: 配置自动后台化时长

- **WHEN** `AGENT_SUBAGENT_AUTO_BACKGROUND_MS` 配置为有效正整数
- **THEN** `subagentAutoBackgroundMs` 采用该值，前台任务超过该时长后自动转为后台
- **WHEN** 该变量未配置或为 0
- **THEN** 自动后台化关闭，前台任务保持阻塞直至完成或手动后台化

#### Scenario: 配置 fork 开关

- **WHEN** `AGENT_SUBAGENT_FORK_ENABLED` 为 `1`/`true`
- **THEN** `subagentForkEnabled` 为 true，`Agent` 工具省略 `subagent_type` 时创建隐式 fork 且强制全部调用后台运行
- **WHEN** 该变量未配置或为 `0`/`false`
- **THEN** `subagentForkEnabled` 为 false，省略类型保持 `general-purpose`，`run_in_background` 字段保留

#### Scenario: 嵌套深度不作为可配置入口

- **WHEN** 应用加载后台子代理配置
- **THEN** `RuntimeLimitsConfig` 不新增可提升嵌套层数的字段
- **AND** 本期深度限制固定为 1
