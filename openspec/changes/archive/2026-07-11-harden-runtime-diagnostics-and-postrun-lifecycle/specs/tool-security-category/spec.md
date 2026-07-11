## ADDED Requirements

### Requirement: 静态安全类别不得等同于实际副作用

工具静态 `securityCategory` 必须（MUST）继续表示工具能力的潜在风险上界，用于审批、默认拒绝和保守资源控制；系统不得把该字段直接当作本次调用已经发生写入的事实。

#### Scenario: 静态写类别的只读调用

- **WHEN** 一个静态类别为 write 的多态工具在本次参数下被安全策略证明为只读并执行
- **THEN** 审批前置策略仍可按静态风险处理，但运行后行为必须消费实际 read effect

#### Scenario: 缺少实际 effect 的潜在写工具

- **WHEN** 潜在写工具已经执行但没有提供实际 effect
- **THEN** 系统必须降级为 unknown 而不是擅自判定为 read

