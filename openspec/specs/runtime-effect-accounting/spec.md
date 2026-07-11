# 运行时实际副作用核算

## 单次工具调用必须产出实际执行 effect

系统必须（MUST）为每次工具调用产出结构化实际 effect，至少区分 `none`、`read`、`write` 与 `unknown`，并记录是否进入执行、是否完成以及本次实际或可能影响的资源。实际 effect 必须独立于工具的静态安全类别。

### Scenario: Plan 原子只读命令成功执行

- **WHEN** `execute_command` 在 Plan 模式通过同构安全判定并成功执行原子只读系统查询
- **THEN** 本次调用的实际 effect 必须为 `read`，即使该工具静态 `securityCategory` 为 `write`

### Scenario: 工具在执行前被拦截

- **WHEN** 工具因参数解析失败、审批拒绝或 BeforeTool 策略 abort 而未进入物理执行
- **THEN** 实际 effect 必须为 `none`，且不得把潜在写入类别记成已经发生的写入

### Scenario: 写工具成功修改资源

- **WHEN** 写工具成功完成并修改一个或多个工作区资源
- **THEN** 实际 effect 必须为 `write`，并携带去重后的受影响资源

### Scenario: 写入执行中途失败且结果不确定

- **WHEN** 潜在写工具已经进入物理执行，随后抛出异常且系统无法证明资源未发生变化
- **THEN** 实际 effect 必须为 `unknown`，并按可能写入进行后续安全处理

## 实际 effect 必须沿统一工具运行链传递

实际 effect 必须（MUST）沿 `ToolExecutor`、`ToolRegistry`、`ToolCallOrchestrator` 到 `AgentLoop` 的结果链传递，不得依赖工具名称分支或在 AgentLoop 中重新猜测。

### Scenario: 内建工具 effect 完整传递

- **WHEN** 内建工具完成一次调用并返回实际 effect
- **THEN** 编排器和 AgentLoop 必须收到相同 kind、资源、执行状态和判定原因

### Scenario: 未适配工具安全降级

- **WHEN** 旧工具或外部工具没有返回实际 effect
- **THEN** 系统必须依据执行是否开始及静态安全类别生成保守 effect；潜在写工具执行后的未知结果不得降级为 read

## 只读导航和系统查询必须报告与执行事实一致的 effect

系统必须（MUST）依据工具是否进入执行、是否完成以及是否改变外部资源记录实际 effect。成功的只读浏览器导航和通过安全判定的原子只读系统查询必须记录为 `read`，不得因工具静态类别或通用回退而记录为 `write`。

### Scenario: 浏览器成功导航到只读资源

- **WHEN** `browser_navigate` 成功加载网页或本地只读资源，且没有修改外部资源
- **THEN** 实际 effect 必须为 `read`，并记录完成状态和目标资源

### Scenario: 导航执行前被策略拒绝

- **WHEN** 浏览器导航在进入物理执行前被诊断 capability 或安全策略拒绝
- **THEN** 实际 effect 必须为 `none`，并记录拒绝原因

### Scenario: 只读导航执行后失败

- **WHEN** 浏览器导航已经开始但以加载错误结束，且工具能够证明没有修改外部资源
- **THEN** 实际 effect 必须保持为失败的 `read` 尝试，不得自动升级为潜在写入

### Scenario: Plan 模式执行原子系统查询

- **WHEN** `execute_command` 的单一原子命令被安全判定为只读系统查询
- **THEN** Plan 模式必须允许执行，并沿统一运行链返回 `read` effect
