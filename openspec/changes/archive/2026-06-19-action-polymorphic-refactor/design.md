## 背景

当前智能体的本地内置工具（如 `readFile`, `writeFile`, `globSearch` 等）在 `LocalFileSystemMcpServer` 中通过一个臃肿的 `switch-case` 语句来进行路由与分发调用。
这种设计存在以下问题：
1. **违背开闭原则 (OCP)**：任何新增、删除或重构内置工具的操作，都必须修改 `LocalFileSystemMcpServer` 核心类，增加了引入 Bug 的风险。
2. **测试粒度粗**：没有规范的 `NativeTool` 接口定义，各个本地内置工具无法做到 100% 独立于服务器进行单元测试，其高内聚性未得到体现。

因此，亟需对本地内置工具的管理、路由和调用逻辑进行面向对象多态插槽化重构。

## 目标与非目标

**目标:**
1. 抽象出统一的 `NativeTool` 接口契约，规定工具的名称、Schema 定义与执行方法。
2. 将原有的零散物理函数（如 `readFileTool`）彻底重构合并为实现了 `NativeTool` 接口的多态实例，消除代码冗余。
3. 重构 `LocalFileSystemMcpServer`，使用 `Map<string, NativeTool>` 动态注册容器来取代原有的 `switch-case` 硬编码分发。
4. 彻底重构测试用例，使单元测试直接基于各 `NativeTool` 实例运行，确保 100% 绿灯。

**非目标:**
1. 本次重构不包含对 `AgentLoop.chat` 异步生成器的重构与解耦。
2. 不会将本地内置工具进程化或网络化，依然保留进程内虚拟 MCP 执行模式。

## 架构决策

### 1. 抽象 NativeTool 接口契约
在 `src/action/types.ts`（或 `src/action/virtual-mcp.ts`）中定义标准的 `NativeTool` 接口：
```typescript
export interface NativeTool {
  readonly name: string;
  readonly definition: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string> | string;
}
```

### 2. 构造器依赖注入模式
针对像 `loadSkill` 等需要访问外部依赖（例如 `loadSkill` 获取函数）的工具，采用**构造器依赖注入**。
- `LoadSkillTool` 类的构造函数接收可选的 `loadSkill?: (name: string) => string | null` 依赖参数。
- 这样能保持工具本身的高测试隔离性，单元测试中可以直接传入 mock 的 `loadSkill` 函数进行独立测试，无须依赖 `LocalFileSystemMcpServer` 的完整实例。

### 3. 多态插槽动态注册表
在 `LocalFileSystemMcpServer` 内部持有 `private toolsMap = new Map<string, NativeTool>()` 容器。
- 提供 `register(tool: NativeTool)` 注册插槽。
- 在构造 `LocalFileSystemMcpServer` 时，基于传入的 options 自动实例并注册所有的内置工具。
- `getTools()` 动态聚合返回 `Array.from(this.toolsMap.values()).map(t => t.definition)`。
- `callTool(request)` 统一采用 `this.toolsMap.get(request.name)` 获取并调用，完全消除硬编码 `switch-case`。

## 风险与权衡

- **[风险点] 依赖引用循环**：在引入独立的 `NativeTool` 类定义时，如果过度导入周边模块，可能引起模块之间的循环引用。
  - **缓解策略**：在 `src/action/tools` 目录下为各工具定义独立的实现文件，从核心的 `virtual-mcp.ts` 导入 `NativeTool` 契约，避免相互循环导入。
- **[风险点] 行为退化与测试破坏**：修改本地工具的 Schema 声明可能导致 LLM 调用失败。
  - **缓解策略**：各个 `NativeTool` 的 `definition` 属性必须精确复制自原有的 `toolsDefinition` 声明，确保在大模型调用的工具声明上不发生任何修改。原有测试需要直接改写为测试对应的 `NativeTool` 实例的 `execute` 方法。
