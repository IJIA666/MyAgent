## 新增需求

### 需求: Plan模式下写操作工具的动态裁剪与配置 (Dynamic Tool Stripping in Plan Mode)
系统必须（MUST）在 `AppConfig` 全局配置中支持配置参数 `enable_plan_tool_stripping`（布尔值，默认值应为 `false`）。
当 `enable_plan_tool_stripping === true` 且当前 `workMode === 'Plan'` 时，在 LLM 请求的 `tools` 定义字段装配阶段，系统必须（MUST）动态过滤剔除所有声明为写倾向（`securityCategory === 'write'`）的敏感 Tool 定义。

#### 场景: 开启裁剪配置时的 Plan 模式物理过滤
- **WHEN** 全局配置 `enable_plan_tool_stripping` 设为 `true` 且会话处于 `Plan` 模式，发起 LLM 调用时
- **THEN** 系统动态排除所有写操作工具声明，大模型在 API variables 的 tools 数组中看不见这些工具，彻底从物理层面杜绝越权调用的可能。

#### 场景: 关闭裁剪配置时的 Plan 模式软性规约
- **WHEN** 全局配置 `enable_plan_tool_stripping` 设为 `false`，会话处于 `Plan` 模式，发起 LLM 调用时
- **THEN** 系统不改变 tools 数组的工具集，依然保留写操作工具的声明，但依靠末尾消息气泡的心智约束（心智轨）和底层安全审查网的拦截来防御。
