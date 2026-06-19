## 背景

智能体现有的内置原生工具在物理与逻辑组织上存在水平切分不足与紧耦合的问题。具体表现为：
1. 18 个原生工具及其 helper 平铺在 `src/action/native-tools/`，且全局工具名契约散落，未按业务 Feature 内聚。
2. 脑部的 `HumanApprovalPlugin` 插件直接静态引入了具体工具内部的校验逻辑（如 `terminal-config.ts` 中的工作模式判定，`terminal-guard.ts` 中的终端命令危险初筛，以及 `base.ts` 中的路径越界判定），导致脑皮层 Core 强耦合具体工具细节，违背了六边形架构中 Domain Core 仅依赖外围 Adapter 抽象契约的原则。

## 目标与非目标

**目标:**
1. **物理Feature内聚**：将 `native-tools` 下的所有扁平文件按 Feature 划分为 `git`、`filesystem`、`system` 和 `skill` 子包。各子包专属的 helpers 与 constants 局限于子包内部闭环。
2. **契约化逻辑解耦**：在 `NativeTool` 契约中引入异步的 `checkSafety` 规范，实现安全知识在工具内部的封装。
3. **网关无状态改造**：将 `HumanApprovalPlugin` 网关重构为通用的无状态拦截挂起网关，彻底移出对具体工具类及其安全判定 helper 的直接依赖。
4. **编译期解耦批量注册**：在各子包提供统一的 `index.ts` 暴露 `NativeTool` 实例数组，在 `virtual-mcp.ts` 中通过包引入并批量注册，免去逐个静态实例化的强耦合。

**非目标:**
1. 不在此次变更中改动外部 MCP 客户端（`mcp-client.ts`）的安全逻辑，仅限对系统内置的原生工具链进行此规范重构。
2. 不在此次变更中修改底层的物理 I/O 操作（如实际的文件读写命令、具体的 terminal 执行引擎）。
3. 不更改系统的 ReAct 主调度循环（`agent-loop.ts`），安全卡关依然在 `BeforeTool` 生命周期钩子上发生。

## 架构决策

### 1. 安全判定契约（Ports）化设计
在 `NativeTool` 接口中添加异步安全核查规范，支持传入可选的会话上下文以供安全状态（如临时白名单）获取：
```typescript
checkSafety(args: Record<string, unknown>, sessionContext?: unknown): Promise<SafetyCheckResult>;
```
所有内置工具类均实现该方法。安全网关插件仅基于该通用契约对工具执行安全卡关，避免脑插件静态 import 各工具的安全校验 helper。

### 2. 标准化的 `SafetyCheckResult` 结构
`checkSafety` 方法的返回值定义为包含状态和校验细节的结构体，以支持网关生成友好的提示并按需持久化安全前置策略：
```typescript
export interface SafetyCheckResult {
  status: 'pass' | 'suspend' | 'deny';
  message?: string;      // 用于人机审批时向用户展示的提示语
  safePrefix?: string;   // 终端工具特有，用于安全白名单持久化的前缀
  targetPath?: string;   // 文件工具特有，越界读写的物理目标路径
}
```

### 3. 校验的纯函数（Pure Function）与副作用分离与依赖反转
- `checkSafety` 方法本身必须是无状态、无副作用的。它仅根据调用参数计算出是否有安全隐患并返回结论，绝对不在方法内回写临时读写白名单或终端规则。
- 脑网关插件与底层的 Adapter 工具完全通过 Brain 层的 `SecurityService` 全局安全服务（或上下文共享状态）进行依赖反转间接解耦。当用户在人机界面选择批准（Approve）后，网关仅调用 `SecurityService` 接口将路径或命令写入其内部维护的只读/可写白名单中。
- 底层具体文件操作工具（Adapter）在执行安全路径校验时，去引入并向该 `SecurityService` 查询临时白名单状态（替代原先由 `base.ts` 内存持有），从而彻底断开网关对具体 Action 工具类（如 `base.ts`）的任何逆向物理 `import`。

### 4. 工具 Feature 子包物理结构
重构后的 Action 原生工具层物理目录如下：
- `src/action/tools/base.ts`（共享的路径规范化与白名单状态基础设施）
- `src/action/tools/git/`（收拢 git 系列工具，提供统一 `gitTools` 数组导出）
- `src/action/tools/filesystem/`（收拢文件读写、管理、搜索等工具及 helpers，提供统一 `fileSystemTools` 导出）
- `src/action/tools/system/`（收拢 terminal 终端执行及守卫逻辑，提供统一 `systemTools` 导出）
- `src/action/tools/skill/`（收拢 skill 加载工具，提供统一 `skillTools` 导出）

各子包的 `index.ts` 负责统一暴露出其对应的工具实例列表。

## 风险与权衡

- **[接口不兼容风险与安全降级防范]** -> 对 `NativeTool` 添加 `checkSafety` 是一项 BREAKING 变更。我们将为内置的原生工具全部补齐该方法的实现。对于任何未定义该方法的第三方外部工具，我们坚决防范安全越权漏洞：在网关处执行多态向下转型安全反射判定（`if ('checkSafety' in tool && typeof tool.checkSafety === 'function')`），如果工具未定义该校验方法，则默认将其评估为高危写操作类型，一律强制返回 `suspend` 进行人机卡关审查，建立 Default Deny（默认拒绝）的零信任安全兜底屏障。
- **[测试代码的路径失效]** -> 物理文件的位置重排会导致 `test/action/tools.test.ts` 及其他测试类中的 import 引用断裂。在实施中我们需要同步修改测试代码的头部 import 部分，并将其调整为新的 Feature 子包路径，并确保单元测试通过率维持 100%。
