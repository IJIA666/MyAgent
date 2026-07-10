## 新增需求

### 需求: 外部 MCP 工具必须进入统一策略入口

系统必须保留外部 MCP 工具所属 server 和受支持的 annotations 字段，使其在 BeforeTool 阶段能够被策略端口识别，而不是作为来源不明的工具处理；端口契约不得暴露具体 MCP SDK 类型。

#### 场景: 评估已注册 MCP 工具

- **WHEN** 模型调用当前 MCP 工具目录中已注册的外部工具
- **THEN** 策略适配器必须返回 `status: 'suspend'`
- **THEN** 安全操作必须标记为 `external-tool`，并在摘要中包含 server 和工具名

#### 场景: MCP 工具已从目录移除

- **WHEN** MCP 重连、刷新或关闭后某工具不再存在于当前描述缓存
- **THEN** 后续对该工具的策略评估必须返回 `status: 'deny'`
- **THEN** 不得使用刷新前的陈旧 descriptor 创建审批请求

### 需求: MCP annotations 只能用于风险提示

系统必须把 MCP annotations 视为不可信提示，不得据此独立执行自动放行或扩大授权范围。

#### 场景: 外部工具声明只读

- **WHEN** 外部 MCP 工具声明 `readOnlyHint: true` 或 `destructiveHint: false`
- **THEN** 策略结果仍必须为 `status: 'suspend'`
- **THEN** annotations 只能改变审批提示文本

#### 场景: 外部工具声明破坏性或开放世界访问

- **WHEN** annotations 包含 `destructiveHint: true` 或 `openWorldHint: true`
- **THEN** 审批提示必须说明对应风险
- **THEN** 不得由 annotations 生成路径资源、会话授权或持久授权

### 需求: 无可信资源提取器的 MCP 工具只能单次授权

外部 MCP 工具在没有宿主侧可信资源提取器时，用户审批选项必须限制为 call 和 deny。

#### 场景: 用户批准一次外部工具调用

- **WHEN** 用户选择 call 放行已挂起的 MCP 工具
- **THEN** 系统必须注册绑定本次 toolCallId、toolName 和参数摘要的一次性能力
- **THEN** 外部 MCP 执行边界必须在调用远端 server 前领取该能力；能力缺失、已领取或参数摘要不匹配时必须拒绝执行
- **THEN** resources 为空不得被解释为任意路径授权
- **THEN** 不得写入 session 或 persistent 白名单

#### 场景: 空资源能力成功领取

- **WHEN** 外部 MCP 的一次性能力已注册且 resources 为空数组
- **THEN** `claimCapability()` 返回空数组必须表示精确调用授权有效，而不是授权缺失
- **THEN** 远端调用完成、失败或中止后，编排器必须消费该能力

#### 场景: MCP server 没有额外信任配置

- **WHEN** MCP server 按现有配置被启用，但没有额外的信任等级字段
- **THEN** 工具仍可进入 suspend 审批流程
- **THEN** 系统不得因为缺少本变更未定义的 trust 配置而直接禁用现有 MCP 工具
