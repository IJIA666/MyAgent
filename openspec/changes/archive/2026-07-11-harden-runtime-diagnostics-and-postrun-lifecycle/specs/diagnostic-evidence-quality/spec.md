## MODIFIED Requirements

### Requirement: 诊断证据分级

系统必须（MUST）以对象级证据记录区分至少 `presence`、`enumeration`、`measured` 与 `error` 四种证据类型。每条记录必须绑定目标对象、指标、来源、调用关联、覆盖范围和完整性；回答中的结论强度必须由相关记录派生，不得使用回合级单一枚举值为未覆盖对象背书。

#### Scenario: 目录枚举结果只能标记为候选

- **WHEN** 模型仅通过 `listFiles` 或类似只读工具拿到一组目录候选
- **THEN** 系统只能为这些对象记录 enumeration，并将其表述为候选或疑似占用来源，不得描述成已经测量确认的大头

#### Scenario: 完整结构化测量形成对象级 measured

- **WHEN** 结构化只读工具返回某个明确对象的完整 size、lineCount、容量或目录统计
- **THEN** 系统必须为该对象和指标记录 complete measured，并保留来源工具与调用关联

#### Scenario: 截断测量只能形成下界证据

- **WHEN** 目录测量因预算、权限、链接边界或取消而未完整覆盖目标
- **THEN** 系统只能为对应目标记录 partial 或 lower-bound measured，不得提升未扫描对象或整个任务的完整测量状态

#### Scenario: 测量失败不得删除既有有效证据

- **WHEN** 某个目标的新测量失败、被拦截或未返回有效数值
- **THEN** 系统必须追加与该目标绑定的 error 记录，同时保留此前其他目标的有效证据，不得把全局状态简单覆盖为 error 或 measured

### Requirement: 结论声明与不确定性约束

系统必须（MUST）约束诊断结论中的对象、指标与覆盖范围。没有相关 complete measured 记录时，不得宣称“深度扫描完成”“已确认主要占用项”或给出覆盖未测量对象的高置信度释放空间估算。

#### Scenario: 无真实测量时禁止宣称深度扫描完成

- **WHEN** 当前相关证据仅覆盖存在性或目录枚举
- **THEN** 系统不得使用“基于实际深度扫描结果”或“主要占用项已确认”等超出证据等级的表述

#### Scenario: 完整测量允许受限量化结论

- **WHEN** 模型拥有某些对象的 complete measured 记录并能指出对应来源
- **THEN** 系统可以只针对这些对象给出量化判断或处理优先级，不得外推到未测量范围

#### Scenario: 下界测量必须声明剩余不确定性

- **WHEN** 模型只有 partial 或 lower-bound measured 记录
- **THEN** 回答必须使用“至少”“已观察到”或等价下界语义，并说明截断、跳过或未覆盖范围

