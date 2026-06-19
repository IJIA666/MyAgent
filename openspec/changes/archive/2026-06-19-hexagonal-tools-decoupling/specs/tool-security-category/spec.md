## MODIFIED Requirements

### Requirement: 工具安全类别自声明

工具类 **MUST** 暴露自身的安全级别元数据，并实现异步安全校验契约方法，从而将特化的安全判定逻辑从全局及脑插件中彻底解耦。

#### Scenario: 原生工具安全属性暴露与校验契约实现
- **WHEN**：系统加载原生工具实例。
- **THEN**：每个原生工具实例必须包含 `readonly securityCategory: 'read' | 'write'` 属性，并必须实现异步安全审查方法 `checkSafety(args: Record<string, unknown>): Promise<SafetyCheckResult>`。

### Requirement: 审批插件动态确权拦截

系统 **MUST** 在运行时动态评估当前被调工具的 `checkSafety` 返回结果，并执行相应的安全前置核准流，网关插件本身保持通用无状态。

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
