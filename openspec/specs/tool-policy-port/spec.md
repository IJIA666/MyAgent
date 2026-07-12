## 新增需求

### 需求: 工具安全评估必须通过显式端口

> ❌ 已删除 — 旧 `ToolPolicyPort` 返回最终安全决策形成重复契约。已在 `claude-permission-model` 变更中移除。

**Migration:** 工具改为提供 Claude 风格 `checkPermissions`，最终结果由统一工具权限服务产生。

### 需求: Tool Check Permissions Contract

工具端口 MUST 支持 `checkPermissions(input, context)`，返回工具内部的 `allow`、`ask`、`deny` 或 `passthrough`，并由统一权限服务产生最终 `allow`、`ask` 或 `deny`。

#### 场景: Tool passthrough is resolved centrally

- **WHEN** 工具返回 `passthrough`
- **THEN** 统一权限服务 MUST 继续执行规则和模式处理，不得把 `passthrough` 当作允许执行

#### 场景: Tool deny cannot be overridden by mode

- **WHEN** 工具检查返回 `deny`，当前模式为 `auto` 或 `bypassPermissions`
- **THEN** 系统 MUST 保持 `deny`

### 需求: 策略端口与工具目录必须保持契约隔离

工具策略端口必须与 `ToolRegistryPort.getTool()` 的纯元数据查询职责分离。

#### 场景: 构造内建策略适配器

- **WHEN** 组合根构造内建工具目录和策略适配器
- **THEN** 两者必须使用同一批 `NativeTool` 实例
- **THEN** 策略适配器不得通过 `ToolRegistryPort.getTool()`、类型断言或运行时字段探测重新取得 `checkSafety()`

### 需求: 安全决策模型必须保持单一来源

策略端口必须复用现有 `SafetyCheckResult` 和 `SafetyOperation` 语义，不得创建字段含义重复的第二套决策联合类型。

#### 场景: 策略返回安全结果

- **WHEN** 策略端口完成评估
- **THEN** 返回结果的状态字段必须为 `status: 'pass' | 'suspend' | 'deny'`
- **THEN** HumanApprovalPlugin、内建工具和策略适配器必须消费同一共享类型
