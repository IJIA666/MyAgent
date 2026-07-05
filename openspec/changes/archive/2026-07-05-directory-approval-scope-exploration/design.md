## 背景

当前真实代码中的核心问题，不是“缺少一个可选字段”，而是目录浏览资源的语义在审批链路中被错误压扁了。

现状可以概括为四步：

1. `ListFilesTool.checkSafety()` 越界时上报一个普通 `path` 读资源。
2. `ApprovalPolicy.mapChoiceToEffect()` 在处理 `session` / `always` 时，把资源转成待写入的 grant。
3. `agent-loop.ts` 把 grant 写入 `SecurityService`。
4. `SecurityService` 与 `secureResolveReadPath()` 只支持精确路径命中。

因此，用户即使已经批准 `a/`，系统也只记住“路径 `a` 已获准”，并不会把它解释为“目录 `a` 的后续浏览已经获准”。

这说明本 change 的关键不在于“放宽权限”，而在于把“目录浏览”建模成独立资源类型，并保证该语义能贯穿工具上报、审批映射、授权落库、运行时放行四个环节。

## 目标与非目标

**目标：**

- 让 `listFiles` 的 `session` / `always` 授权对子目录持续生效
- 保持 `readFile` 和所有写操作仍然使用精确路径授权
- 显式建模目录范围读资源，不能把范围语义藏在隐式前缀匹配里
- 所有目录范围命中基于 `getPhysicalRealPath()` 的真实物理路径
- 审批文案明确展示“当前目录及其子目录”的授权含义

**非目标：**

- 不修改任何写权限逻辑
- 不引入新的全局信任等级模型
- 不改变 `once` 的语义
- 本次不处理 `grepSearch`、`globSearch` 的授权语义

## 架构决策

### 决策 1：新增 `directory-scope` 资源分支，而不是给旧接口补可选字段

当前真实代码里的 `SafetyResource` 已经是判别联合，因此不应继续按“旧接口 + 可选 kind”来设计。更准确的方向是新增一个新的联合分支：

```typescript
type SafetyResource =
  | { kind: 'path'; access: 'read' | 'write'; normalizedPath: string }
  | { kind: 'directory-scope'; access: 'read'; normalizedPath: string }
  | { kind: 'command-prefix'; prefix: string };
```

约束如下：

- `directory-scope` 只能用于 `read`
- 普通文件路径仍使用 `kind: 'path'`
- 范围匹配只对显式的 `directory-scope` 生效

这样才能避免误把普通文件读取放大成目录授权。

### 决策 2：本次 change 只修改 `listFiles`

当前用户反馈的是目录逐层浏览问题，因此本次只让以下两个位置输出 `directory-scope` 语义：

- `ListFilesTool.checkSafety()`
- `virtual-mcp.ts` 中 `listFiles` 的资源重建逻辑

这样做的原因很直接：

- `listFiles` 的语义最明确，就是目录浏览
- `grepSearch`、`globSearch` 当前资源模型并不一致，强行并入会让 change 边界失控

因此这两个搜索工具应明确留在后续独立 change 中处理，而不是继续堆到当前 change。

### 决策 3：会话授权载荷必须保留资源 kind

当前制品遗漏了一个关键事实：`session` grant 在落库前会把资源压缩成只剩路径和 access，这会直接丢失 `directory-scope` 信息。

因此必须同时修改：

- `src/core/usecases/plugins/plugin-types.ts`
- `src/core/usecases/security/ApprovalPolicy.ts`
- `src/core/usecases/engine/agent-loop.ts`

设计要求是：

- `PendingGrant` 的会话授权资源必须保留 `kind`
- `ApprovalPolicy.mapChoiceToEffect()` 不能把 `directory-scope` 降级成普通 `path`
- `agent-loop.ts` 必须根据资源 kind 分流写入不同白名单

如果这一步不做，前面的工具侧建模全部都会失效。

### 决策 4：读白名单拆分为“精确路径”与“目录范围”两条通道

`SecurityService` 中不应把所有读授权都统一改造成前缀匹配，而应保留两套独立语义：

- 精确路径读白名单：服务于 `readFile` 等普通路径访问
- 目录范围读白名单：服务于 `listFiles` 这种目录浏览访问

读检查顺序为：

1. 先检查精确路径读白名单
2. 再检查目录范围读白名单
3. 两者都未命中时，再走原有的边界校验和审批逻辑

写检查完全不读取目录范围白名单。

### 决策 5：目录范围命中必须基于真实物理路径

简单的字符串前缀比较存在明显风险：

- `a` 可能误命中 `a2`
- 相对路径可能绕过
- 软链接可能把访问带出原授权目录

因此目录范围判定必须：

1. 对授权根路径和目标路径分别调用 `getPhysicalRealPath()`
2. 基于 `relative(scopeRoot, targetPath)` 判断是否位于该目录树内
3. 仅当相对路径为空，或既不以 `..` 开头也不是绝对路径时，才视为命中

### 决策 6：审批文案只是结果呈现，不是安全边界

审批 UI 需要显示：

- 普通路径读：`允许读取 {path}`
- 目录范围读：`允许读取 {path} 及其子目录`

但要明确，真正的安全边界来自资源 kind 和白名单分流，不来自文案本身。因此文案修改只能作为结果呈现层面的收尾动作，不能替代前面三层的正确建模。

## 受影响模块与改动要点

| 模块 | 改动 |
|:---|:---|
| `src/core/usecases/security/SafetyResource.ts` | 新增 `directory-scope` 联合分支 |
| `src/core/usecases/plugins/plugin-types.ts` | 修正 `PendingGrant`，保留会话授权资源 kind |
| `src/adapters/tools/impl/filesystem/file-system.ts` | `ListFilesTool.checkSafety()` 上报 `directory-scope` |
| `src/adapters/tools/virtual-mcp.ts` | `listFiles` 资源重建逻辑改为 `directory-scope` |
| `src/core/usecases/security/ApprovalPolicy.ts` | 识别 `directory-scope`，并在 `session` / `always` 映射时保留该语义 |
| `src/core/usecases/engine/agent-loop.ts` | 根据资源 kind 分流写入精确读白名单或目录范围读白名单 |
| `src/core/usecases/security/SecurityService.ts` | 新增目录范围读白名单与子树命中判定 |
| `src/adapters/tools/impl/base.ts` | 读路径放行逻辑接入目录范围白名单 |

## 风险与权衡

| 风险点 | 缓解策略 |
|:---|:---|
| 资源建模与真实代码类型不一致 | 直接按现有判别联合扩展，不再使用“可选 kind 默认 path”的伪兼容方案 |
| `directory-scope` 在会话授权链路中丢失 | 修改 `PendingGrant`、`ApprovalPolicy`、`agent-loop.ts`，保证 kind 贯穿全链路 |
| 目录范围授权误放大到写操作 | 写白名单完全独立，不读取目录范围读授权 |
| 把 `grepSearch`、`globSearch` 一起打包导致 change 边界失控 | 明确排除出本次 change，后续如需支持再单开 change |
| 目录范围命中被软链接绕过 | 所有判断基于 `getPhysicalRealPath()` |
