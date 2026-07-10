## 新增需求

### 需求: HumanApprovalPlugin 必须消费显式工具策略端口

`HumanApprovalPlugin` 必须从 `ToolPolicyPort` 获取安全判定，不得从 `ToolRegistryPort.getTool()` 的返回值探测或调用 `checkSafety()`。

#### 场景: 安全工具直接放行

- **WHEN** ToolPolicyPort 返回 `status: 'pass'`
- **THEN** HumanApprovalPlugin 必须继续执行后续 BeforeTool 中间件
- **THEN** 不得创建 suspend 事件或 pendingGrant

#### 场景: 策略明确拒绝

- **WHEN** ToolPolicyPort 返回 `status: 'deny'`
- **THEN** HumanApprovalPlugin 必须把控制状态设置为 abort，并使用策略消息说明原因
- **THEN** 不得进入用户审批流程

#### 场景: 策略要求用户审批

- **WHEN** ToolPolicyPort 返回 `status: 'suspend'`
- **THEN** HumanApprovalPlugin 必须继续复用现有 SafetyOperation、ApprovalPolicy、ApprovalService 和授权效果映射流程
- **THEN** 用户可见的 choices 必须由 ApprovalPolicy 生成，插件不得自行扩大授权范围

#### 场景: 单元测试替换策略实现

- **WHEN** 测试构造 HumanApprovalPlugin
- **THEN** 测试可以注入只实现公开 evaluate 契约的 ToolPolicyPort
- **THEN** 测试不得通过 `as unknown as` 为 ToolRegistryPort.getTool() 伪造 checkSafety 方法

### 需求: 策略来源重构不得改变授权生命周期

从工具对象探测迁移到策略端口后，现有授权效果和能力令牌时序必须保持不变。

#### 场景: 用户选择单次放行

- **WHEN** 用户对 suspend 请求选择 call
- **THEN** ApprovalEffectApplier 必须在实际执行前注册一次性能力
- **THEN** 内建工具执行边界必须在执行前领取该能力
- **THEN** 编排器必须在成功、失败或中止后的 finally 中消费该能力

#### 场景: 用户审批外部 MCP 工具

- **WHEN** 无可信资源提取器的外部 MCP 工具进入 suspend 流程
- **THEN** ApprovalPolicy 必须只提供 call 和 deny
- **THEN** 空 resources 的 call capability 只表示本次精确调用获批，并必须在远端执行前按调用 ID、工具名和参数摘要领取
- **THEN** 领取失败时不得调用远端工具，也不得授予任何路径访问范围

#### 场景: tail call 进入审批管线

- **WHEN** AfterTool 产生一个 tail call
- **THEN** tail call 必须使用独立 toolCallId 重新经过 BeforeTool 和 ToolPolicyPort 评估
- **THEN** 不得复用主调用的策略结果或能力令牌
