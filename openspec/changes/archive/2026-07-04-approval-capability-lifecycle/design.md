## 背景

### 当前状态

```
用户批准 → HumanApprovalPlugin (isProcessing = true)
  ├── once → 写入会话白名单 ❌（应不写）
  └── always → 写入会话白名单 ⚠️（context.ts 白名单方法在 isProcessing 时会抛错）

工具执行 → virtual-mcp → tool.execute(args, execContext, signal, interactionPort)
  └── execute 内部 → secureResolveWritePath(targetPath) — 不传 sessionContext → 查不到白名单 → 抛拒绝访问
```

### 三个需要解决的关键问题

1. **`toolCallId` 缺失**：`agent-loop.ts` 的 `toolCall.id` 存在于 LLM response 中，但未透传到 BeforeTool hook 和 execute 路径。
2. **Busy lock 阻塞**：插件执行期间 `isProcessing = true`，白名单方法不可用。
3. **并发隔离**：多个并发工具调用不能共享全局"当前 toolCallId"状态。

## 目标与非目标

**目标：**
1. `once` 只对本次工具调用生效，不写任何白名单
2. `always` 按资源类型（read/write）分别写入会话白名单
3. 所有文件读写工具 `checkSafety()` 和 `execute()` 双端传递上下文
4. `checkSafety()` 返回 `SafetyResource[]`，按工具类型正确标注 read/write
5. 插件管线内的授权效果在安全条件下提交

**非目标：**
同 proposal。

## 架构决策

### D1：HookContext.toolCall 扩展 id + 新增 pendingGrant

```typescript
// plugin-types.ts
interface HookContext {
  toolCall?: {
    id: string;            // 新增
    name: string;
    arguments: Record<string, unknown>;
  };
  /** 插件可在此字段返回授权 grant，由 AgentLoop 在安全条件下提交 */
  pendingGrant?: PendingGrant;
}

type PendingGrant =
  | { type: 'call'; toolCallId: string; toolName: string; resources: SafetyResource[] }
  | { type: 'session'; toolCallId: string; resources: { access: 'read' | 'write'; normalizedPath: string }[] };
```

### D2：AgentLoop 条件提交 pendingGrant

`agent-loop.ts` 在 BeforeTool 管线完成后执行以下逻辑：

```
if (
  pipeline 正常返回 &&
  context.control.action === 'continue' &&
  context.pendingGrant?.toolCallId === currentToolCallId  // 防止串号
) {
  switch (pendingGrant.type) {
    case 'call':
      // 在注册点计算 argumentsDigest，确保 claimCapability 侧有可靠的摘要比对源
      const digest = computeArgumentsDigest(toolCall.arguments);  // e.g. JSON.stringify(Object.keys(args).sort().map(k => [k, args[k]]))
      sessionContext.registerCallCapability({ toolCallId, toolName, resources, argumentsDigest: digest });
      break;
    case 'session':
      for each resource:
        if access === 'read' → addTemporaryReadWhitelist(normalizedPath)
        else → addTemporaryWriteWhitelist(normalizedPath);
      break;
  }
}
```

**失败路径安全**：后续插件抛错 → `control.action === 'abort'` → grant 不提交。并发工具调用各自有独立的 pendingGrant，互不影响。

### D3：ToolExecutionContext——调用级上下文

新增调用级上下文，解决 `secureResolve` 无法获取 `toolCallId` 以及并发隔离问题：

```typescript
// context.ts 或新文件
interface ToolExecutionContext {
  sessionContext: SessionContext;
  toolCallId: string;
  toolName: string;
  argumentsDigest: string;  // 规范化参数摘要，用于令牌匹配
  claimedResources: SafetyResource[];  // 当前调用已领取的授权资源
}
```

`virtual-mcp.ts` 在 execute 边界创建此上下文，并传入工具和 `secureResolve`：

```
agent-loop
  → toolRegistry.callTool(name, args, sessionContext, signal, toolCallId)
    → virtual-mcp.callTool({ name, arguments: args }, sessionContext, signal, toolCallId)
      → 创建 ToolExecutionContext { sessionContext, toolCallId, toolName, argumentsDigest }
      → 在 execute 前 claim 一次性令牌（匹配 toolCallId + argumentsDigest），将 claimedResources 存入 ToolExecutionContext
      → tool.execute(args, toolExecContext, signal, interactionPort)
      → execute 内部 secureResolveWritePath(path, execContext)  // execContext 即 ToolExecutionContext
```

### D4：令牌三状态状态机

```
registered  ──(claim 成功)──→  claimed  ──(execute 完成/失败/abort)──→  removed
```

| 状态 | 含义 | 何时进入 | 何时离开 |
|:---|:---|:---|:---|
| `registered` | 已注册，但未分配给任何调用 | `flushPendingGrant` 提交 call 类型 grant | `virtual-mcp` claim 成功 |
| `claimed` | 已分配给某次调用，可多次检查 | `virtual-mcp` 执行边界 claim | `agent-loop` consume |
| `removed` | 已消费，不可再检查 | execute 完成/失败/Abort 后的 `consumeCallCapability` | — |

**关键规则**：
- 一次调用内可以多次检查 `claimedResources`（Move 有 2 个路径，ReadMany 有 N 个路径）
- 其他调用的 `toolCallId` 不能 claim 已被领取的令牌
- `claim` 和 `consume` 是原子操作（通过 SessionContext 上的 Map 加锁隔离）
- AbortSignal 触发时由 agent-loop 的 finally 块执行 consume

```typescript
interface CallCapability {
  toolCallId: string;
  toolName: string;
  resources: SafetyResource[];
  argumentsDigest: string;
  state: 'registered' | 'claimed' | 'removed';
  claimedBy?: string;  // claim 时填入 toolCallId
  createdAt: number;
}

// SessionContext 方法
claimCapability(toolCallId: string, toolName: string, args: Record<string, unknown>): SafetyResource[] | null;
consumeCapability(toolCallId: string): void;
hasClaimedResource(toolCallId: string, access: 'read' | 'write', normalizedPath: string): boolean;
```

### D5：SafetyResource 与 SafetyCheckResult 扩展

```typescript
// SafetyResource.ts（新文件）
type SafetyResource =
  | { kind: 'path'; access: 'read' | 'write'; normalizedPath: string }
  | { kind: 'command-prefix'; prefix: string };

// plugin-types.ts
interface SafetyCheckResult {
  status: 'pass' | 'deny' | 'suspend';
  message?: string;
  safePrefix?: string;
  targetPath?: string;           // 保留向后兼容
  resources?: SafetyResource[];  // 新增
}
```

### D6：secureResolve 新增 ToolExecutionContext 重载

`base.ts` 新增重载，保留原签名向后兼容：

```typescript
// 原签名不变
export function secureResolveWritePath(targetPath: string, sessionContext?: SessionEventPort): string;

// 新增重载：接受 ToolExecutionContext（其中包含 sessionContext + toolCallId + claimedResources）
export function secureResolveWritePath(targetPath: string, execContext: ToolExecutionContext): string;
```

重载实现优先检查 `execContext.sessionContext.hasClaimedResource(toolCallId, access, normalizedPath)`（`hasClaimedResource` 是 `SessionContext` 的方法，通过 `ToolExecutionContext.sessionContext` 访问；`secureResolveReadPath` 传入 `'read'`，`secureResolveWritePath` 传入 `'write'`），再检查 session 白名单，最后检查沙箱边界。读/写 access 严格隔离，不可交叉。

### D7：HumanApprovalPlugin once/always 路径

```typescript
// beforeToolMiddleware
const toolCallId = context.toolCall?.id;
const resources = safetyResult.resources ?? [];
const pendingGrant: PendingGrant | null = (() => {
  switch (decision.action) {
    case 'once':
      return { type: 'call', toolCallId, toolName: toolCall.name, resources };
    case 'always':
      // 按 access 分类收集路径资源
      const sessionResources = resources
        .filter(r => r.kind === 'path')
        .map(r => ({ access: r.access, normalizedPath: r.normalizedPath }));
      return { type: 'session', toolCallId, resources: sessionResources };
    default:
      return null;
  }
})();
context.pendingGrant = pendingGrant;  // 由 AgentLoop 安全提交
```

### D8：checkSafety 生成 SafetyResource[] 的规则

| 工具 | resources | 说明 |
|:---|:---|:---|
| `ReadFileTool` | `[{ kind:'path', access:'read', normalizedPath }]` | 读操作 |
| `ReadManyFilesTool` | 每个文件一条 `{ kind:'path', access:'read', normalizedPath }` | 多文件读 |
| `ListFilesTool` | `[{ kind:'path', access:'read', normalizedPath }]` | 读操作 |
| `WriteFileTool` | `[{ kind:'path', access:'write', normalizedPath }]` | 写操作 |
| `EditFileTool` | `[{ kind:'path', access:'write', normalizedPath }]` | 写操作 |
| `CreateDirectoryTool` | `[{ kind:'path', access:'write', normalizedPath }]` | 写操作 |
| `DeletePathTool` | `[{ kind:'path', access:'write', normalizedPath }]` | 写操作 |
| `MovePathTool` | `[{ kind:'path', access:'write', src }, { kind:'path', access:'write', dest }]` | 双 write（移动删除源） |
| `CopyPathTool` | `[{ kind:'path', access:'read', src }, { kind:'path', access:'write', dest }]` | source=read, dest=write |
| `ApplyPatchTool` | `[{ kind:'path', access:'write', normalizedPath }]` | 写操作 |
| `GrepSearchTool` | `[{ kind:'path', access:'read', normalizedPath }]` | 读操作 |

### [Amend 修正] D9：DeletePathTool 审批路径收敛

**问题**：当前 `DeletePathTool.execute()` 内部自行调用 `sessionContext.waitApproval()`（`directory-manager.ts:187`），且 `virtual-mcp.ts` 通过原型链遮蔽 `waitApproval` 来避免二次弹窗（`virtual-mcp.ts:249-254`）。这种双重审批路径与新 `ToolExecutionContext` 方案冲突——`ToolExecutionContext` 不含 `waitApproval`，proposal 也明确不扩 `ApprovalPort`。

**决策**：将 `deletePath` 收敛到统一的 `checkSafety → HumanApprovalPlugin` 路径，消除特殊分支。

```typescript
// DeletePathTool.execute() — 移除 waitApproval
async execute(args: Record<string, unknown>, execContext: ToolExecutionContext): Promise<string> {
  const targetPath = args.targetPath as string;
  const safePath = secureResolveWritePath(targetPath, execContext);
  // 审批已由 checkSafety + HumanApprovalPlugin 前置处理，此处直接执行
  if (!existsSync(safePath)) {
    return `目标路径不存在，无需删除："${targetPath}"。`;
  }
  // ... 删除逻辑
}
```

```typescript
// virtual-mcp.ts — 移除 deletePath 特殊遮蔽
// 删除以下代码块（约第 249-254 行）：
// if (request.name === 'deletePath' && sessionContext) {
//   contextToPass = Object.assign(Object.create(...), ...);
// }
// 替换为直接传入 ToolExecutionContext：
const resultText = await tool.execute(args, toolExecContext, signal, interactionPort);
```

**影响**：`DeletePathTool` 的 execute 签名从 `(args, sessionContext?: SessionEventPort & ApprovalPort)` 改为 `(args, execContext: ToolExecutionContext)`，与其他工具保持一致。`checkSafety()` 已有沙箱检查逻辑（`directory-manager.ts:145-163`），无需额外改动。

### [Amend 修正] D10：Tail call 工具调用的 toolCallId 透传

**问题**：`agent-loop.ts` 有两处 `callTool()` 调用——主调用（第 642 行）和 tail call（第 693 行）。原设计只笼统提及"将 toolCallId 传入 callTool()"，未区分两个调用点。tail call 如果缺少 toolCallId，其触发的审批将无法获得有效的 `context.toolCall.id`，导致 pendingGrant 无法生成。

**决策**：tail call 与主调用享有同等的 toolCallId 生命周期。

```
// agent-loop.ts 两处调用点均传入独立 toolCallId
// 主调用（第 642 行）:
const mcpResult = await this.toolRegistry.callTool(
  functionName, actualArgs, this.context, this.interactionPort, signal, toolCall.id
);

// Tail call（第 693 行）:
const tailCallId = generateToolCallId();  // 独立生成
// 同样走 beforeTool 管线，传入 HookContext.toolCall.id = tailCallId
const tailResultRaw = await this.toolRegistry.callTool(
  tailCall.name, tailCall.args, this.context, this.interactionPort, signal, tailCallId
);
```

**关键规则**：
- tail call 的工具调用同样需要 beforeTool 管线（含 HumanApprovalPlugin），因为 tail call 可能是危险操作
- tailCallId 必须独立生成，不与主调用的 toolCallId 共享
- 两个调用点的 toolCallId 生成/透传/consume 流程完全一致

### [Amend 修正] D11：NativeTool.execute 接口契约迁移

**问题**：当前 `NativeTool.execute`（`virtual-mcp.ts:58-63`）第二参数类型为 `SessionEventPort`，签名如下：

```typescript
execute(
  args: Record<string, unknown>,
  _sessionContext?: SessionEventPort,
  signal?: AbortSignal,
  _interactionPort?: InteractionPort
): Promise<string> | string;
```

新方案 `virtual-mcp` 将创建 `ToolExecutionContext`（含 `sessionContext` + `toolCallId` + `claimedResources` + `hasClaimedResource()`），需要作为 execute 的第二参数传入。仅改 `DeletePathTool` 而保持 `NativeTool` 总契约不变，会导致其余 20+ 个工具的类型契约断层。

**决策**：扩展 `NativeTool.execute` 第二参数为联合类型 `ToolExecutionContext | SessionEventPort`。

```typescript
// NativeTool 接口更新（virtual-mcp.ts）
execute(
  args: Record<string, unknown>,
  _context?: ToolExecutionContext | SessionEventPort,
  signal?: AbortSignal,
  _interactionPort?: InteractionPort
): Promise<string> | string;
```

**迁移策略（三类工具分别处理）**：

| 工具类别 | execute 接收的 context 类型 | 适配方式 |
|:---|:---|:---|
| **文件工具**（WriteFile, EditFile, ReadFile, ReadManyFiles, ListFiles, CreateDirectory, DeletePath, MovePath, CopyPath, ApplyPatch, GrepSearch） | `ToolExecutionContext` | 从 `execContext` 中提取 `claimedResources`，传入 `secureResolve{Read,Write}Path` 的 `ToolExecutionContext` 重载 |
| **命令工具**（Bash, PowerShell） | `ToolExecutionContext` | 当前仅依赖 `sessionContext` 做持久化命令白名单，从 `execContext.sessionContext` 获取，无需感知 capability |
| **Browser 工具**（BrowserNavigate、BrowserClick、BrowserEnsureLogin 等 9 个） | `ToolExecutionContext` | **必须显式适配**：`BrowserSession.getTenantIdFromContext()` 通过顶层 duck-typing 检查 `getTenantId`，`ToolExecutionContext` 将该方法封装在 `sessionContext` 子对象中。每个 browser tool 的 `execute` 必须从 `execContext` 中提取 `sessionContext` 后传入 `getTenantIdFromContext(sessionContext)`，否则静默回退到 `'default'` 租户 |
| **其他非文件工具**（git, system, skill, interaction） | `SessionEventPort`（兼容） | 保持原有签名不变，`ToolExecutionContext` 中的 `sessionContext` 字段可满足原有需求 |

**virtual-mcp 传参统一**：

```typescript
// virtual-mcp.ts 始终创建 ToolExecutionContext 并传入
const toolExecContext: ToolExecutionContext = {
  sessionContext,
  toolCallId,
  toolName: request.name,
  argumentsDigest: computeDigest(args),
  claimedResources: [],
};
// claim 令牌 → 填充 claimedResources
const claimed = sessionContext.claimCapability(toolCallId, request.name, args);
if (claimed) {
  toolExecContext.claimedResources = claimed;
}
const resultText = await tool.execute(args, toolExecContext, signal, interactionPort);
```

**向后兼容**：
- `SessionEventPort` 类型仍被联合类型接受，非文件工具无需立即修改签名
- 文件工具的 `execute` 内部从 `execContext` 而非 `sessionContext` 获取上下文，编译器会在传入纯 `SessionEventPort` 时报类型错误，迫使其显式适配
- `ToolExecutionContext` 不扩展 `ApprovalPort`（不含 `waitApproval`），与 proposal 非目标一致

### [Amend 修正] D12：hasClaimedResource 增加 access 维度校验

**问题**：原设计 `hasClaimedResource(toolCallId, normalizedPath)` 仅按路径匹配，不校验 read/write 访问类型。这违背了探索文档确立的安全不变量"读授权不得升级为写授权"（`exploration.md:52`）。攻击路径：用户对某路径授权 `read` 后，恶意工具可调用 `secureResolveWritePath`，`hasClaimedResource` 仅匹配路径即返回 `true`，读授权被升级为写。

**决策**：`hasClaimedResource` 增加 `access` 参数，`secureResolveReadPath` 和 `secureResolveWritePath` 分别传入对应的 access 值。

```typescript
// SessionContext 方法 — 新增 access 参数
hasClaimedResource(toolCallId: string, access: 'read' | 'write', normalizedPath: string): boolean;
```

**实现逻辑**：

```typescript
// SessionContext.hasClaimedResource 实现
hasClaimedResource(toolCallId: string, access: 'read' | 'write', normalizedPath: string): boolean {
  const cap = this.callCapabilities.get(toolCallId);
  if (!cap || cap.state !== 'claimed') return false;
  return cap.resources.some(
    r => r.kind === 'path' && r.access === access && r.normalizedPath === normalizedPath
  );
}
```

**调用端对应**：

```typescript
// secureResolveWritePath 重载：检查 'write'
function secureResolveWritePath(targetPath: string, execContext: ToolExecutionContext): string {
  const normalized = normalizePath(targetPath);
  // 优先检查 call capability（access='write'）
  if (execContext.sessionContext.hasClaimedResource(execContext.toolCallId, 'write', normalized)) {
    return resolveInSandbox(normalized);
  }
  // 再检查 session 白名单…
}

// secureResolveReadPath 重载：检查 'read'
function secureResolveReadPath(targetPath: string, execContext: ToolExecutionContext): string {
  const normalized = normalizePath(targetPath);
  if (execContext.sessionContext.hasClaimedResource(execContext.toolCallId, 'read', normalized)) {
    return resolveInSandbox(normalized);
  }
  // 再检查 session 白名单…
}
```

**MovePath 双 write 示例**：令牌中包含两个 `{ kind:'path', access:'write', ... }`（src + dest），`execute` 中对 src 和 dest 分别调用 `secureResolveWritePath`，均传入 `'write'`，均通过。

## 风险与权衡

| 风险 | 缓解策略 |
|:---|:---|
| pendingGrant 被并发调用覆盖 | 通过 `pendingGrant.toolCallId === currentToolCallId` 条件过滤 |
| 令牌 claim 后 execute 被跳过（Abort） | `consumeCapability` 放在 finally 块，无论成功/失败/abort 都执行 |
| 同一调用内多次路径检查不通过 | `hasClaimedResource` 检查的是 `claimedResources` 数组（同时校验路径+access），不改变状态 |
| 读授权被升级为写授权 | `hasClaimedResource` 同时校验 `access` 维度，`secureResolveWritePath` 传入 `'write'`，读令牌无法通过写检查 |
| `secureResolve` 重载导致调用歧义 | 保留原签名，编译期类型检查保证正确重载选择 |
| 文件 session 授权当前 UI 不可达 | proposal 已明确为非目标 |

## 实施顺序

```
1. 定义 SafetyResource 类型 + SafetyCheckResult 扩展
2. Extend HookContext.toolCall（id）+ 新增 pendingGrant（session 型含 toolCallId）
3. SessionContext: CallCapability 三状态管理 + claim/consume/hasClaimedResource（含 access 维度）
4. ToolExecutionContext 类型定义
5. NativeTool.execute 接口契约迁移：第二参数扩展为 ToolExecutionContext | SessionEventPort
6. base.ts: secureResolve{Read,Write}Path 新增 ToolExecutionContext 重载（含 access-aware 检查）
7. agent-loop: toolCallId 透传（含 tail call）+ pendingGrant 条件提交 + 令牌 consume（含 tail call finally）
8. ToolRegistryPort.callTool + toolRegistry 透传
9. virtual-mcp: 创建 ToolExecutionContext + claimCapability + 传入 execute + 移除 deletePath 遮蔽
10. HumanApprovalPlugin: once/always 区分 + pendingGrant 赋值（session 型含 toolCallId）
11. DeletePathTool: 移除内部 waitApproval，收敛到统一 checkSafety 路径
12. 逐个工具 checkSafety/execute 补传上下文（含 NativeTool 新签名适配）
13. GrepSearchTool 切换解析器
14. 验证（含 deletePath + tail call + 读写隔离场景）
```
