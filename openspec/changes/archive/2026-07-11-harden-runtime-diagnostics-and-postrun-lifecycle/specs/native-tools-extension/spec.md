## ADDED Requirements

### Requirement: 通用目录工具必须支持受限的直接子目录比较测量

`listFiles` 必须（MUST）在显式请求时支持对目标目录的直接子目录进行聚合占用比较；默认列目录行为必须保持非递归和低噪声。比较测量必须共享有限预算并返回每个对象独立的完整性。

#### Scenario: 默认列目录不触发聚合扫描

- **WHEN** 调用方未显式请求目录测量
- **THEN** `listFiles` 只能读取直接子项，不得递归计算任何目录聚合大小

#### Scenario: 受限比较多个直接子目录

- **WHEN** 调用方显式请求直接子目录比较并提供深度、条目、字节和时间上限
- **THEN** 工具必须在共享预算内轮转扫描各直接子目录，并分别返回 observedSizeBytes、计数、耗时、错误和完整性

#### Scenario: 单个子目录无权限

- **WHEN** 某个直接子目录或其后代因权限被拒绝而无法读取
- **THEN** 工具必须记录该对象的跳过项和部分完整性，同时继续测量其他可访问子目录；目标根目录自身不可读时才允许整个调用失败

### Requirement: 递归测量必须限制链接、卷边界与取消

目录测量必须（MUST）默认不跟随符号链接、junction 或 reparse point，不跨文件系统或卷边界，并响应 AbortSignal。

#### Scenario: 遇到目录链接

- **WHEN** 测量扫描遇到符号链接、junction 或其他可重定向目录项
- **THEN** 工具必须跳过递归并在结果中增加对应跳过计数，不得形成循环或越过授权范围

#### Scenario: 达到时间预算

- **WHEN** 扫描耗时达到 maxDurationMs 或收到 AbortSignal
- **THEN** 工具必须尽快停止，保留已经获得的对象级部分结果，并标记 time-limit 或 cancelled 完整性原因

### Requirement: 部分测量不得伪装成目录总量

工具必须（MUST）明确区分完整总量与部分观测值。只有覆盖完整时才能返回 totalSizeBytes；截断、跳过或取消时必须返回 observedSizeBytes 和 lower-bound/partial 语义。

#### Scenario: maxEntries 导致截断

- **WHEN** 扫描达到 maxEntries 但仍有未访问条目
- **THEN** 结果必须标记为非完整，给出截断原因，且不得把 observedSizeBytes 声称为完整总大小

