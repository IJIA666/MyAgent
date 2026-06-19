## 新增需求

### Requirement: 工具安全类别自声明

工具类必须暴露自身的安全级别元数据，从而将安全类别判定逻辑从全局常量中解耦。

#### Scenario: 原生工具安全属性暴露
- **WHEN**：系统加载原生工具实例。
- **THEN**：每个原生工具实例必须包含 `readonly securityCategory: 'read' | 'write'` 属性。

### Requirement: 审批插件动态确权拦截

系统必须在运行时动态评估当前被调工具的 `securityCategory` 属性，并执行相应的安全前置核准流。

#### Scenario: 高危写操作确权挂起
- **WHEN**：智能体尝试执行带有 `securityCategory = 'write'` 属性的工具（如 `writeFile` ）。
- **THEN**： `HumanApprovalPlugin` 插件必须拦截该调用并原地挂起，广播 `suspend` 审批信号等待用户确权。

#### Scenario: 越界只读安全动态申请
- **WHEN**：智能体尝试执行带有 `securityCategory = 'read'` 属性的工具且目标物理路径超出授权工作区边界。
- **THEN**：插件必须挂起并向用户发起针对该路径的只读授权请求。

#### Scenario: 未知或非法工具安全降级
- **WHEN**：智能体调用了未在 `ToolRegistry` 中注册的第三方或幻觉工具。
- **THEN**：系统必须默认将其判定为 `securityCategory = 'write'` ，并强行挂起进行前置安全审批。
