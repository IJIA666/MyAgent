## ADDED Requirements

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
