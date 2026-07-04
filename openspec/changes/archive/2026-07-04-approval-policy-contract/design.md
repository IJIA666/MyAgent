## 背景

当前审批链路的 choice 生成逻辑分散在两层：
```
工具 checkSafety() → HumanApprovalPlugin（硬编码 once/always/deny）
                      → facade.ts（通过 allowedPrefix 推导是否有 always）
                        → 用户选择 → HumanApprovalPlugin（硬编码 once→call grant, always→session grant）
```

缺少一个独立的策略层来标准化此流程。

## 目标与非目标

**目标：**
1. 引入 `SafetyOperation` 标准化操作描述，替代 `checkSafety()` 当前的多字段格式
2. 创建 `ApprovalPolicy` 中央策略服务，根据操作类型、WorkMode 和资源类型动态生成 choice 列表
3. `facade.ts` 从 `ApprovalRequest.choices` 渲染选项，不再硬编码 UI 逻辑
4. `HumanApprovalPlugin` 通过 `ApprovalPolicy.mapChoiceToEffect()` 将 choiceId 映射为授权效果，不再自行判断
5. 每个内置工具注册资源提取器，`ApprovalPolicy` 用于二次校验资源真实性

**非目标：**
- 工具层 `checkSafety()` 迁移到新 `SafetyOperation` 接口（由后续 change 完成）
- CLI 以外的 UI 通道适配
- 持久化规则管理 UI
- 第三方 MCP 工具的自动审批

## 架构决策

### D1：分层契约对齐

```
┌─────────────────────────────────────────────────────────┐
│  工具层 (checkSafety)                                    │
│  新增返回 SafetyOperation { resources, riskReason, ... } │
├─────────────────────────────────────────────────────────┤
│  中央策略层 (ApprovalPolicy)                              │
│  validate + resolveChoices + mapChoiceToEffect            │
├─────────────────────────────────────────────────────────┤
│  UI 层 (facade.ts)                                       │
│  仅渲染 ApprovalRequest.choices，返回 choiceId            │
├─────────────────────────────────────────────────────────┤
│  授权映射层 (HumanApprovalPlugin)                          │
│  choiceId → PendingGrant | PersistentRuleEffect | deny   │
├─────────────────────────────────────────────────────────┤
│  安全提交层 (AgentLoop)                                    │
│  flush: call register → session whitelist → persistent disk │
└─────────────────────────────────────────────────────────┘
```

### D2：SafetyOperation 接口定义

```typescript
// plugin-types.ts
interface SafetyOperation {
  /** 原子资源列表 */
  resources: SafetyResource[];
  /** 触发审批的风险原因 */
  riskReason: string;
  /** 操作类别 */
  operationCategory:
    | 'file-read' | 'file-write' | 'file-edit' | 'file-delete'
    | 'file-move' | 'file-copy'
    | 'command-execute';
  /** 人类可读的操作摘要（用于审批 UI 展示） */
  summary: string;
}
```

`SafetyCheckResult` 新增 `operation?: SafetyOperation` 字段，与现有 `resources`、`targetPath` 并行存在。过渡期两者共存。

### D3：ApprovalPolicy 中央策略服务

```typescript
// ApprovalPolicy.ts
class ApprovalPolicy {
  /** 资源提取器注册表：工具名 → (args) → SafetyResource[] */
  private resourceExtractors: Map<string, ResourceExtractor>;

  /**
   * 校验操作描述并生成可信的审批请求。
   * 1. 使用注册的提取器重新计算资源，与 SafetyOperation.resources 交叉校验
   * 2. 根据资源类型 + WorkMode 生成 choice 列表
   * 3. 第三方工具无提取器 → 仅允许 call 或 deny
   */
  resolve(request: {
    toolName: string;
    toolArgs: Record<string, unknown>;
    operation: SafetyOperation;
    workMode: string;
  }): ApprovalRequest;
}
```

### D3.1：审批决策传输契约同步升级

既然 UI 的职责被收敛为“渲染 `ApprovalRequest.choices` 并原样回传 `choiceId`”，那么审批服务的外部决策动作也必须同步升级，不能继续停留在 `once/always/deny` 这组历史语义上。否则 UI 仍然需要额外猜测“`always` 在当前场景究竟代表 `session` 还是 `persistent`”，中央策略层的收敛目标就被破坏了。

因此本 change 采用以下决策传输契约：

```typescript
interface ApprovalDecision {
  action: ApprovalChoiceId; // 'call' | 'session' | 'persistent' | 'deny'
}
```

`ApprovalService.registerApprovalHandler()` 也需要拿到 `ApprovalRequest`（或等价的 `choices/message` 元数据），这样 CLI/UI 才能渲染真实策略结果，而不是回退到 `allowedPrefix` 语义猜测。

### D4：资源提取器注册

每个内置工具在 `virtual-mcp.ts` 注册时，同时注册资源提取器：

```typescript
type ResourceExtractor = (args: Record<string, unknown>) => SafetyResource[];

// 示例
writeFileExtractor: (args) => {
  const path = secureResolveWritePath(args.targetPath as string);
  return [{ kind: 'path', access: 'write', normalizedPath: path }];
};
```

`ApprovalPolicy` 在 `resolve()` 中调用提取器，与 `operation.resources` 比对。不匹配时拒绝执行。

### D5：Choice 生成规则

```typescript
type ApprovalChoiceId = 'call' | 'session' | 'persistent' | 'deny';

// Choice 按资源类型动态生成
const RULES: Record<string, ApprovalChoiceId[]> = {
  'path+read':     ['call', 'session', 'deny'],        // 文件读
  'path+write':    ['call', 'session', 'deny'],        // 文件写
  'command-prefix': ['call', 'persistent', 'deny'],    // 命令
  'hardline':      ['deny'],                            // 危险命令
  'sensitive-file': ['call', 'deny'],                   // .env 等
  'untrusted':     ['call', 'deny'],                    // 第三方工具
};
```

`deny` 作为显式 choiceId 参与模型，UI 永远渲染它。

### D6：choiceId → Effect 映射

```typescript
function mapChoiceToEffect(
  choiceId: ApprovalChoiceId,
  operation: SafetyOperation,
  toolName: string
): {
  type: 'call' | 'session' | 'persistent' | 'deny';
  payload?: PendingGrant | { resources: ... } | { prefix: string };
} {
  switch (choiceId) {
    case 'call':
      return { type: 'call', payload: { ...pendingGrant } };
    case 'session':
      return { type: 'session', payload: { resources: [...pathResources] } };
    case 'persistent':
      return { type: 'persistent', payload: { prefix: commandPrefix } };
    case 'deny':
      return { type: 'deny' };
  }
}
```

`persistent` 仅对 `command-prefix` 资源类型生效；对其他资源类型降级为 `call`。

### D7：HumanApprovalPlugin 适配

当前硬编码逻辑：
```
decision.action === 'once'  → call grant
decision.action === 'always' → session grant (文件) / persistent (命令)
```

改为通过 `ApprovalPolicy` 委托：
```
ApprovalPolicy.resolve(...) → choices
用户选择 choiceId
ApprovalPolicy.mapChoiceToEffect(choiceId, operation, toolName) → effect
根据 effect.type 生成 pendingGrant | persistentRuleEffect | deny
```

### D8：AgentLoop 提交逻辑扩展

在现有授权效果提交逻辑中新增 `persistentRuleEffect` 分支。`pendingGrant` 继续只承载 `call/session`，`persistent` 不再伪装成 `pendingGrant` 的一个变体：

```typescript
case 'persistent':
  SecurityService.getInstance().saveSecurityAllowlist([...whitelist, prefixRule]);
  break;
```

### D8.1：组合根装配点

`HumanApprovalPlugin` 当前在 `session.ts` 中通过 `new HumanApprovalPlugin()` 直接注册，因此 `ApprovalPolicy` 的注入不能只停留在设计图里，必须落到组合根：

```typescript
const approvalPolicy = new ApprovalPolicy(...);
this.pluginRegistry.register(new HumanApprovalPlugin(approvalPolicy));
```

否则 `ApprovalPolicy` 虽然在类型和任务里存在，但运行时没有真实注入入口，change 无法闭合。

### D9：向后兼容降级策略

未迁移工具的 `checkSafety()` 仍返回旧格式（`targetPath` + `resources`），`HumanApprovalPlugin` 在 `SafetyOperation` 缺失时从旧字段组装等效的操作描述：

```typescript
const operation: SafetyOperation = safetyResult.operation ?? {
  resources: safetyResult.resources ?? (
    safetyResult.targetPath
      ? [{ kind: 'path', access: tool.securityCategory ?? 'write', normalizedPath: safetyResult.targetPath }]
      : []
  ),
  riskReason: safetyResult.message ?? `工具 "${toolCall.name}" 请求授权`,
  operationCategory: tool?.securityCategory === 'read' ? 'file-read' : 'file-write',
  summary: safetyResult.message ?? toolCall.name
};
```

## 风险与权衡

| 风险 | 缓解策略 |
|---|---|
| 资源提取器注册遗漏 | `virtual-mcp` 注册时强制检查提取器，日志 warn 未注册工具 |
| 第三方工具只能 call 级 | 默认 fail closed，显式声明为安全策略 |
| 旧工具 checkSafety 格式过渡 | 降级组装 `SafetyOperation`，日志 warn 未迁移工具 |
| choice 集合动态变化导致 UI 重排 | `deny` 固定在末尾，其余按顺序渲染 |
| 提取器与实际 checkSafety 逻辑不一致 | `ApprovalPolicy` 交叉校验，不匹配拒绝执行 |
