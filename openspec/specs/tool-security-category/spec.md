## 新增需求

### Requirement: 工具安全类别自声明

工具类 **MUST** 暴露自身的安全级别元数据，并实现异步安全校验契约方法，从而将特化的安全判定逻辑从全局及脑插件中彻底解耦。

#### Scenario: 原生工具安全属性与统一 ToolMetadata 契约实现
- **WHEN**：系统加载原生工具实例并查询其配置属性时
- **THEN**：每个系统工具必须实现统一的元数据类型 `ToolMetadata`（包含 name、securityCategory 与可选的 filePathParamKey 元数据字段），且必须实现异步安全审查方法 `checkSafety(args: Record<string, unknown>): Promise<SafetyCheckResult>`。

### Requirement: 审批插件动态确权拦截

系统 **MUST** 在运行时动态评估当前被调工具 of `checkSafety` 返回结果，并执行相应的安全前置核准流，网关插件本身保持通用无状态。

#### Scenario: 高危写操作确权挂起
- **WHEN**：智能体尝试执行工具，且该工具的异步 `checkSafety` 结果返回状态为 `'suspend'`。
- **THEN**：`HumanApprovalPlugin` 插件必须拦截该调用并原地挂起，广播 `suspend` 审批信号等待用户确权。

#### Scenario: 越界只读安全动态申请
- **WHEN**：智能体尝试执行只读工具，且该工具检测到目标物理路径超出授权工作区边界，其 `checkSafety` 返回状态为 `'suspend'` 并带有关联的越界路径。
- **THEN**：插件必须挂起并向用户发起针对该路径的只读授权请求。

#### Scenario: 未知或未实现契约工具的 Default Deny 降级
- **WHEN**：智能体调用了未在 `ToolRegistry` 中注册的工具，或者被调用工具未定义 `checkSafety` 异步安全校验接口方法。
- **THEN**：网关插件必须进行安全反射判定，默认将该工具判定为安全级别 `'write'` 且校验结果状态为 `'suspend'`，强制拦截并挂起进行人工审查。

#### Scenario: 安全状态的共享解耦与回写
- **WHEN**：用户在人机界面通过了审批。
- **THEN**：网关插件必须将授权通过的路径回写到 Brain 层的共享安全服务中，而底层的 Adapter 文件工具在执行实际 I/O 校验时去该共享服务获取白名单，使得网关插件物理上不依赖任何 Action 层工具。

#### Scenario: 缺失元数据旧工具的硬拦截兜底防护
- **WHEN**：智能体调用了未定义安全类别元数据（缺少 `securityCategory` 标记）的存量原生或第三方拓展工具时
- **THEN**：安全重构层必须自动将其降级，默认认定为安全级别 `'write'` 并引发 `waitApproval` 强人机审批拦截，杜绝发生因扩展未适配引起的安全绕过漏洞。

### Requirement: 静态安全类别不得等同于实际副作用

工具静态 `securityCategory` 必须（MUST）继续表示工具能力的潜在风险上界，用于审批、默认拒绝和保守资源控制；系统不得把该字段直接当作本次调用已经发生写入的事实。

#### Scenario: 静态写类别的只读调用

- **WHEN** 一个静态类别为 write 的多态工具在本次参数下被安全策略证明为只读并执行
- **THEN** 审批前置策略仍可按静态风险处理，但运行后行为必须消费实际 read effect

#### Scenario: 缺少实际 effect 的潜在写工具

- **WHEN** 潜在写工具已经执行但没有提供实际 effect
- **THEN** 系统必须降级为 unknown 而不是擅自判定为 read
