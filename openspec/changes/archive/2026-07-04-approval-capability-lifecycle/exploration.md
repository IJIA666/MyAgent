# 探索主题: 授权执行生命周期 — 修复授权语义与工具断链

## 1. 问题与现状证据

### 1.1 问题 B：审批授权语义未严格区分

`HumanApprovalPlugin.ts:138-149` 在用户审批通过后执行：

```typescript
if (safetyResult.targetPath) {
  // 不区分 decision.action 是 once 还是 always，都写临时白名单
  sessionContext.addTemporaryWriteWhitelist(safetyResult.targetPath);
}
```

**后果**：补传 `sessionContext` 后，`once` 会被意外升级为会话放行。

### 1.2 问题 C：白名单传递断裂

所有工具的 `execute()` 和 `checkSafety()` 调用 `secureResolve{Read,Write}Path(targetPath)` 时均未传递 `sessionContext`。即使白名单已写入，execute 阶段仍因检查不到白名单而抛"拒绝访问"。

### 1.3 工具断链清单

**写操作工具（`execute()` + `checkSafety()` 双端均需补传）**

| 工具 | `execute` 位置 | 当前调用 | 路径参数 | 路径数 |
|:---|:---|:---|:---|:---:|
| `WriteFileTool` | `file-system.ts` | `secureResolveWritePath(targetPath)` 未传上下文 | `targetPath` | 1 |
| `EditFileTool` | `file-system.ts` | 同上 | `targetPath` | 1 |
| `CreateDirectoryTool` | `directory-manager.ts` | 同上 | `directoryPath` | 1 |
| `DeletePathTool` | `directory-manager.ts` | 同上 | `targetPath` | 1 |
| `MovePathTool` | `directory-manager.ts` | 同上（source + dest） | `sourcePath`, `destinationPath` | 2 |
| `CopyPathTool` | `directory-manager.ts` | 同上（source + dest） | `sourcePath`(read) + `destinationPath`(write) | 2 |
| `ApplyPatchTool` | `apply-patch.ts` | 同上 | `targetPath` | **遗漏** |

**读操作工具（同样遗漏）**

| 工具 | 当前路径解析器 | 问题 | 修复方式 |
|:---|:---|:---|:---|
| `ReadFileTool` | `secureResolveReadPath(targetPath)` | 未传上下文 | 补传 `sessionContext` |
| `ReadManyFilesTool` | `secureResolveReadPath()`（多处） | 未传上下文 + 多资源 | 补传 + 展开为多个资源 |
| `ListFilesTool` | `secureResolveReadPath(targetPath)` | 未传上下文 | 补传 `sessionContext` |
| `GrepSearchTool` | `secureResolvePath(targetPath)` | 使用不支持白名单的解析器 | 切换为 `secureResolveReadPath` |
| `GlobSearchTool` | 固定从工作区根扫描 | 不属于断链 | 无需修改 |

---

## 2. 安全不变量

1. **安全裁决必须由确定性工具层执行**，不能依赖模型推理层的自我约束
2. **授权必须有明确的 scope 和生命周期**：call 级（一次调用）、session 级（一次会话）、persistent 级（跨会话）
3. **读授权不得升级为写授权**：`read` 和 `write` 白名单必须严格隔离
4. **hardline 命令始终拒绝**：即使 YOLO 模式下 `rm -rf /`、`mkfs` 等也拒绝
5. **敏感文件始终要求审批**：`.env`、`.ssh/*`、`.git/*` 等在任何模式下都不自动放行

---

## 3. call / session / persistent 语义

| 层级 | 标识 | 持续时间 | 存储位置 | 实现方式 |
|:---|:---|:---|:---|:---|
| **调用级** | `call` | 仅当前工具调用 | 无持久化 | 一次性授权令牌，绑定 `toolCallId` + 工具名 + 规范化资源，消费后失效 |
| **会话级** | `session` | 本次会话 | 内存 | `SecurityService` 按 `sessionId` 隔离的临时白名单 |
| **持久级** | `persistent` | 跨会话 | 磁盘 | `.agent/allowed_commands.json` 或扩展白名单文件 |

**跨项目参考**：
- Claude Code：`accept-once` / `destination: 'session'` / `destination: 'localSettings'`
- OpenCode：`once`（`Deferred.succeed()` 直接放行）/ `always`（`InstanceState.approved` 内存数组，非 SQLite，官方文档确认仅当前会话生效）
- Hermes Agent：`once` / `session` / `always`（config.yaml）
- OpenClaw：`allow-once` / `allow-always`

---

## 4. 原子资源类型

只保留两种原子资源，不引入 `path-pair`。多路径操作展开为多个原子资源。

```typescript
type SafetyResource =
  | { kind: 'path'; access: 'read' | 'write'; normalizedPath: string }
  | { kind: 'command-prefix'; prefix: string };
```

### 多路径操作的资源展开

| 操作 | 展开为 |
|:---|:---|
| MovePath(src → dest) | `{ path, access: 'write', src }` + `{ path, access: 'write', dest }` |
| CopyPath(src → dest) | `{ path, access: 'read', src }` + `{ path, access: 'write', dest }` |
| ReadManyFiles([a, b, c]) | `{ path, access: 'read', a }` + `{ path, access: 'read', b }` + `{ path, access: 'read', c }` |
| GrepSearch(rootDir) | `{ path, access: 'read', rootDir }` |
| WriteFile(target) | `{ path, access: 'write', target }` |
| EditFile(target) | `{ path, access: 'write', target }` |

**注意**：Move 的源路径按 `write` 授权（移动会删除源节点），不按 `read`。

---

## 5. call capability 生命周期

### 5.1 安全约束

一次性授权必须满足：
- 绑定到本次 `toolCallId`（UUID），跨调用不可复用
- 绑定工具名称和操作类型
- 资源路径使用规范化后的形式（非原始用户输入）
- 只能消费一次，执行完成后自动失效
- 工具参数发生变化后授权自动失效
- 并发调用之间不能共享授权

### 5.2 生命周期序列

```
HumanApprovalPlugin: once 决策
  ↓ 创建一次性授权令牌（绑定 toolCallId + 资源 + 工具名）
ToolDispatcher / execute():
  ↓ 验证令牌合法性（toolCallId 匹配、资源一致、参数未变）
  ↓ 调用 secureResolve{Read,Write}Path，不走白名单但放行
execute 完成/失败:
  ↓ 令牌自动失效
```

### 5.3 冲突场景处理

| 场景 | 行为 |
|:---|:---|
| 用户批准后修改参数再执行 | 授权失效，需重新审批 |
| 相同参数连续执行两次 | 第一次消费后令牌失效，第二次需重新审批 |
| 两个并发工具调用同时发起 | 各自独立 `toolCallId`，授权互不影响 |
| `checkSafety` 和 `execute` 之间参数被篡改 | 令牌中的规范化资源与 execute 时的实际资源不匹配，拒绝执行 |

---

## 6. 当前 SafetyCheckResult 扩展要求

- `targetPath` 单字段 → 多资源表达（`SafetyResource[]`）
- `status` / `message` / `safePrefix` 保留
- 新增 `resources: SafetyResource[]`

---

## 7. 风险与否决方案

### 风险
- **call 级授权 TOCTOU**：从 checkSafety 到 execute 之间参数可能被篡改。通过绑定 `toolCallId` + 规范化资源 + 参数一致性校验缓解。
- **并发竞态**：一次性授权令牌通过 `AbortSignal` 和 `toolCallId` 索引，不与全局状态耦合。
- **Grep 切换解析器**：从 `secureResolvePath` 切换到 `secureResolveReadPath` 需要验证不影响现有搜索功能。
- **敏感文件绕过**：即使透出 session 选项，UI 也应在策略层预禁用。

### 否决方案
- **path-pair 资源类型**：Move 源路径按 `write` 授权后不需要 path-pair 类型。
- **一次性补传 sessionContext 不先区分 once/always**：会让 once 退化为会话放行。
- **会话级命令前缀白名单**：不在此 change 范围内。
