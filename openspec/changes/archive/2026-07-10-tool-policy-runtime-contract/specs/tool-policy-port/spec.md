## 新增需求

### 需求: 工具安全评估必须通过显式端口

系统必须提供独立的工具安全策略端口，以工具调用描述和当前会话事件契约为输入，返回现有 `SafetyCheckResult`，不得要求核心层取得适配器工具对象。

#### 场景: 评估内建工具调用

- **WHEN** BeforeTool 阶段评估一个已注册内建工具
- **THEN** 策略端口必须调用该工具真实的 `checkSafety(args, sessionContext)`
- **THEN** 必须原样保留 `status`、`message`、`safePrefix`、`targetPath`、`resources` 和 `operation`

#### 场景: 识别已有会话授权

- **WHEN** 内建工具的目标资源已存在于当前会话授权中
- **THEN** 策略评估必须向 `checkSafety()` 传递当前 `SessionEventPort`
- **THEN** 工具可以返回 `status: 'pass'`，不得因为策略端口缺少会话状态而重复挂起

#### 场景: 未知工具 fail closed

- **WHEN** 工具既不在内建工具集合中，也不在当前 MCP 工具描述缓存中
- **THEN** 策略端口必须返回 `status: 'deny'`
- **THEN** 系统不得为无法执行的未知工具创建审批请求

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

