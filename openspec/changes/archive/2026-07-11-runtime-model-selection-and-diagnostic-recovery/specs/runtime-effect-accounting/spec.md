## ADDED Requirements

### Requirement: 只读导航和系统查询必须报告与执行事实一致的 effect

系统必须（MUST）依据工具是否进入执行、是否完成以及是否改变外部资源记录实际 effect。成功的只读浏览器导航和通过安全判定的原子只读系统查询必须记录为 `read`，不得因工具静态类别或通用回退而记录为 `write`。

#### Scenario: 浏览器成功导航到只读资源

- **WHEN** `browser_navigate` 成功加载网页或本地只读资源，且没有修改外部资源
- **THEN** 实际 effect 必须为 `read`，并记录完成状态和目标资源

#### Scenario: 导航执行前被策略拒绝

- **WHEN** 浏览器导航在进入物理执行前被诊断 capability 或安全策略拒绝
- **THEN** 实际 effect 必须为 `none`，并记录拒绝原因

#### Scenario: 只读导航执行后失败

- **WHEN** 浏览器导航已经开始但以加载错误结束，且工具能够证明没有修改外部资源
- **THEN** 实际 effect 必须保持为失败的 `read` 尝试，不得自动升级为潜在写入

#### Scenario: Plan 模式执行原子系统查询

- **WHEN** `execute_command` 的单一原子命令被安全判定为只读系统查询
- **THEN** Plan 模式必须允许执行，并沿统一运行链返回 `read` effect
