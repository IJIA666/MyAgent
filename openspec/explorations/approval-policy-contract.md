# 探索主题: 中央审批策略与选择契约

## 1. 问题定义

当前 UI 层（`facade.ts`）需要通过 `allowedPrefix` 的有无来猜测权限语义，且审批选项（once/always/deny）在 UI 中硬编码。新增审批场景需要同时改三层代码。同时，审批 choice 集合不应是固定的"3 选项"，而应由中央策略根据操作类型、风险等级和 WorkMode 动态决定。

Claude Code 的实测证据支持这一方向：其 Bash/PowerShell 的"不要再询问"选项是条件生成的，受全局策略开关及 permission suggestions 是否存在影响，choice 集合会根据策略和调用上下文动态变化。

---

## 2. 安全不变量

1. **第三方工具默认 fail closed**：无可信资源提取器时只允许 `call` 级授权或拒绝
2. **读授权不得升级为写授权**：`read` 和 `write` 白名单必须严格隔离
3. **hardline 命令始终拒绝**：即使 YOLO 模式下也拒绝

---

## 3. Choice 按资源类型限制

| 资源类型 | 支持的选择项 | 说明 |
|:---|:---:|:---|
| 文件读 (`path, read`) | `call`, `session` | 持久化文件读规则暂不实现 |
| 文件写/删/移动 (`path, write`) | `call`, `session` | 同上 |
| 命令前缀 (`command-prefix`) | `call`, `persistent` | 命令白名单本身是持久化的；不实现"会话级命令白名单" |
| hardline 命令 | `deny` | 不透出选择项 |
| 敏感文件（`.env` 等） | `call`（推荐仅 call） | 建议不允许会话级放行 |
| 无可信提取器的第三方工具 | `call` 或 `deny` | fail closed |

---

## 4. 标准化操作描述（工具层契约）

工具 `checkSafety()` 返回操作描述，不包含授权规则：

```typescript
interface SafetyOperation {
  resources: SafetyResource[];
  riskReason: string;
  operationCategory:
    | 'file-read' | 'file-write' | 'file-edit' | 'file-delete'
    | 'file-move' | 'file-copy'
    | 'command-execute';
  /** 仅用于 approval 消息展示 */
  summary: string;
}
```

### 原子资源类型

```typescript
type SafetyResource =
  | { kind: 'path'; access: 'read' | 'write'; normalizedPath: string }
  | { kind: 'command-prefix'; prefix: string };
```

---

## 5. 分层契约

```
┌─────────────────────────────────────────────────────────┐
│  工具层 (checkSafety)                                    │
│  职责: 报告标准化操作描述，包含原子资源列表                  │
│  输出: SafetyOperation                                   │
├─────────────────────────────────────────────────────────┤
│  中央策略层 (ApprovalPolicy)                              │
│  职责: 校验操作描述，生成可信的选择项                        │
│  输出: ApprovalRequest { choices: ApprovalChoice[] }      │
├─────────────────────────────────────────────────────────┤
│  UI 层 (facade.ts)                                       │
│  职责: 渲染选择项并返回 choiceId，不执行任何授权操作         │
│  输出: choiceId                                          │
├─────────────────────────────────────────────────────────┤
│  授权执行层 (HumanApprovalPlugin)                          │
│  职责: 根据受信任的 choiceId 执行确定的授权操作              │
│  输入: choiceId（非工具层原始数据）                         │
└─────────────────────────────────────────────────────────┘
```

---

## 6. 中央策略层的校验职责

`ApprovalPolicy` 服务对操作描述执行以下校验：

1. **资源真实性校验**（仅内置工具）：使用中央注册的资源提取器，从原始 `toolCall.arguments` 重新计算资源，与工具层报告的 `SafetyResource` 对比。不匹配则拒绝。
2. **可信边界划分**：第三方工具没有注册的资源提取器，默认只允许 `call` 级审批。
3. **choiceId 推导**：根据 WorkMode、资源类型、已有规则计算可用的 choiceId 列表。

```typescript
type ApprovalChoiceId = 'call' | 'session' | 'persistent';

interface ApprovalChoice {
  choiceId: ApprovalChoiceId;
  label: string;         // 如 "单次放行" / "本次会话始终放行" / "永久放行"
  description?: string;
}

interface ApprovalRequest {
  id: string;
  message: string;
  choices: ApprovalChoice[];
}
```

### 授权执行

```typescript
function applyChoice(choiceId: ApprovalChoiceId, operation: SafetyOperation, session: SessionContext): void {
  switch (choiceId) {
    case 'call':
      break; // 不写白名单，通过 tool-call-scoped 临时标记传递
    case 'session':
      for (const r of operation.resources) {
        if (r.kind === 'path') {
          if (r.access === 'read')
            session.addTemporaryReadWhitelist(r.normalizedPath);
          else
            session.addTemporaryWriteWhitelist(r.normalizedPath);
        }
      }
      break;
    case 'persistent':
      // 仅内置工具 + 仅命令前缀，策略层校验后可写入持久化白名单
      break;
  }
}
```

---

## 7. 跨项目参考

- **Claude Code**：审批 choice 集合根据策略和调用上下文动态变化。实测 Bash(openspec list --json 2> $null)、PowerShell(openspec list --json)、PowerShell(openspec new change) 三条命令均仅展示 Yes/No。源码确认"不要再询问"选项是条件生成的，受 `shouldShowAlwaysAllowOptions()` 全局策略门控及 `suggestions.length > 0` 共同控制。
- **OpenCode**：`once` 通过 `Deferred.succeed()` 直接放行；`always` 存入 `InstanceState.approved` 内存数组，仅当前会话生效。
- **OpenClaw**：`allow-once` / `allow-always`，`allowedDecisions` 可只含 `[allow-once, deny]`。

---

## 8. 风险与否决方案

### 风险
- **第三方工具不可信**：无法校验其资源描述的真实性。方案：默认 fail closed，只允许 `call` 级。
- **资源提取器可维护性**：每个内置工具需注册一个提取器，新增工具时容易遗漏。建议通过工具基类强制实现。
- **向后兼容**：过渡期未迁移的 `checkSafety()` 仍返回旧格式，策略层需要降级处理。

### 否决方案
- **让工具直接返回 `PermissionUpdate[]`**（Claude Code 风格）：第三方工具可构造永久授权规则，可信边界太宽。
- **UI 层通过工具名推断授权语义**：把权限知识塞回展示层，与分层契约目标冲突。
- **单一按钮映射多个 choice**：混合 `session/persist` 时无法表达差异化语义。
