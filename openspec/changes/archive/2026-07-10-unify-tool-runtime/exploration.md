# 探索主题: 工具运行时抽象重叠与装配耦合治理

## 1. 问题定义
当前探索的核心，不是“既有 spec 是否允许调整”，而是“什么工具架构长期更优”。从这个角度看，当前仓库的主要问题不是缺少抽象，而是**本地工具运行时被重复装配**：

- `ToolRegistry` 负责对外暴露统一调用门面与元数据查询门面。
- `LocalFileSystemMcpServer` 内部又维护了一套本地工具目录和执行器。
- 组合根 `src/index.ts` 还承担了部分工具装配与依赖选择职责。

结果是：同一批本地工具在运行时存在两套组织方式，既增加认知负担，也抬高后续审批链、元数据链和扩展点治理的复杂度。

## 2. 本仓库现状核实
- `src/adapters/tools/toolRegistry.ts` 同时实现 `ToolRegistryPort` 与 `ToolAccessMetadataPort`，既负责执行路由，也负责资源提取器与访问元数据查询。
- `src/adapters/tools/virtual-mcp.ts` 内部自行聚合 `gitTools`、`fileSystemTools`、`systemTools`、`skillTools`、`interactionTools`、`browserTools`，并构造自己的 `ToolCatalog` 与 `ToolExecutor`。
- `ToolRegistry` 又从 `LocalFileSystemMcpServer.getAllTools()` 取出同一批 `NativeTool`，再次构造 `ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider`。
- 真实执行主链当前是 `ToolCallOrchestrator -> ToolRegistry.callTool -> ToolExecutor.execute`，本地工具调用并不依赖 `LocalFileSystemMcpServer.callTool()` 这条路径。
- 因此，`LocalFileSystemMcpServer` 当前更像“保留着 MCP 形状的本地兼容包装层”，而不是不可替代的真实执行边界。

基于以上事实，可以确认：**重复装配是真问题，但“是否保留 virtual-mcp 语义”需要独立判断，不能直接从既有实现惯性推出。**

## 3. 竞品源码调研结论
本次重点参考 `D:\projects\Agents` 下四个项目：`claude-code-analysis`、`opencode`、`hermes-agent`、`openclaw`。

### 3.1 Claude Code：本地原生工具 + MCP 适配后并入同一工具池
- 本地工具的真源头在 `src/tools.ts`，由 `getAllBaseTools()` 直接列出 `BashTool`、`FileReadTool`、`FileEditTool` 等内置工具。
- 外部 MCP 工具并不是本地工具的基础抽象，而是在 `src/services/mcp/client.ts` 中以 `MCPTool` 为模板转换成内部 `Tool` 对象。
- 最终在 `assembleToolPool()` 中统一合并 built-in tools 与 MCP tools。

结论：**Claude Code 追求的是统一内部工具池，而不是让本地工具先伪装成 MCP。**

### 3.2 opencode：内置工具与 MCP 工具分开建模，在会话层统一投影
- `packages/core/src/tool/builtins.ts` 明确把 shipped built-ins 作为静态内置集合管理，并明确写出 “Keep MCP and plugin transforms separate from this static built-in list”。
- `packages/core/src/tool/registry.ts` 负责内部 canonical registry 的 materialize 与 settle。
- `packages/opencode/src/mcp/catalog.ts` 将外部 MCP 工具转换为 `dynamicTool`。
- `packages/opencode/src/mcp/index.ts` 暴露 `mcp.tools()`，会话层 `packages/opencode/src/session/tools.ts` 再把这些工具并入统一执行表面。

结论：**opencode 明确区分“内置工具运行时模型”和“MCP 工具来源”，统一的是会话工具表面，不是协议壳。**

### 3.3 Hermes：内置工具先注册进统一 registry，MCP 工具后续动态并入同一 registry
- `model_tools.py` 明确说明自己只是 “Thin orchestration layer over the tool registry”。
- `tools/registry.py` 通过模块级 `registry.register()` 管理内置工具注册。
- `tools/mcp_tool.py` 则负责连接外部 MCP 服务器、发现其工具，并把这些工具注册进 Hermes 的同一个 tool registry。

结论：**Hermes 统一的是 registry，不是把内置工具做成虚拟 MCP 服务器。MCP 是外部工具接入机制。**

### 3.4 OpenClaw：descriptor / executor 分离，`core` 与 `mcp` 只是不同执行器种类
- `src/tools/types.ts` 明确把 `owner` 与 `executor` 建模为联合类型，其中 `core`、`plugin`、`channel`、`mcp` 只是不同 kind。
- `src/tools/execution.ts` 只是对不同 `ToolExecutorRef` 做格式化与后续分发准备。
- 该设计显式表达了一个更干净的方向：统一的是 descriptor 与 executor contract，而不是要求所有工具都通过某一种协议壳出现。

结论：**OpenClaw 的方向最接近长期最优解：统一内部工具描述与执行契约，保留多种来源和多种执行器。**

## 4. 方案判断
结合本仓库现状与竞品实现，可以排除两个极端：

- 不是“既然以前有 `virtual-mcp`，就继续围绕它补丁式修修补补”。
- 也不是“所有内置工具都应该通过 MCP 协议导入，统一成 MCP 工具”。

更合理的判断是：

**长期更优的方案，是统一内部工具运行时模型，把 MCP 明确降为一种外部工具来源或协议适配方式，而不是让 MCP 成为所有工具的基础抽象。**

这一定义有三个直接好处：

1. 本地工具可以保持最短执行路径，不为跨进程协议语义背额外包袱。
2. 外部 MCP 工具仍然可以通过适配器进入同一个工具表面，模型侧感知保持统一。
3. 审批、资源提取、访问元数据、输出裁剪等横切能力，可以围绕唯一的内部运行时模型建设，而不是在两套本地门面之间重复铺设。

## 5. 对当前仓库的推荐改法
推荐方向不是“删除一切 MCP 痕迹”，而是**消除本地工具重复装配，建立唯一真源**。

### 5.1 推荐目标结构
- `NativeTool`：继续作为本地内置工具的核心契约。
- `ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider`：只保留一套实例来源，成为本地工具运行时的唯一真源。
- `ToolRegistry`：收缩为统一门面，负责本地工具与外部 MCP 工具的聚合、路由与对外暴露。
- `McpToolManager`：只负责外部 MCP 工具发现、连接、断线恢复与调用。
- `LocalFileSystemMcpServer`：如果仍有调用方需要 MCP 形状，则降为薄协议适配层，委托同一套 `ToolCatalog`/`ToolExecutor`；如果没有真实调用方依赖其 MCP 入口，则应继续收缩甚至移除。

### 5.2 推荐落地原则
- 不再允许 `virtual-mcp` 和 `toolRegistry` 各自重建一套本地工具目录与执行器。
- 不把“本地工具是否长得像 MCP”当作核心目标，而把“是否存在唯一内部运行时模型”当作核心目标。
- 如果保留 `LocalFileSystemMcpServer`，它的职责只能是适配，不应继续承担“工具装配中心”角色。

## 6. 风险与约束
- `ToolExecutionContext`、审批资源提取、`claimCapability` 与 `tool.execute()` 当前已经围绕既有执行链工作，收缩装配层次时必须保证这些横切逻辑仍然只经过一个明确边界。
- 组合根 `src/index.ts` 中的 `loadSkill` 与 Embedding 适配器选择，也存在装配内联问题，但这属于另一条边界，不应和本次工具运行时收缩捆成同一改动。
- 如果后续仍保留 `virtual-mcp-server` 相关 spec，则应同步调整 spec 文案：强调“薄协议适配层”而非“本地工具主运行时”。

## 7. 最终结论
这篇探索原先对“重复装配”问题的识别是对的，但把推荐方案写成“是否继续保留 virtual-mcp 语义”还不够准确。结合竞品源码，更合理的最终结论应为：

**MyAgent 应该统一内部工具运行时模型，而不是统一成 MCP 外壳。**

对当前仓库而言，最优先的改进不是“把内置工具通过 MCP 导入”，而是：

- 让本地工具只有一个真实装配源；
- 让 `ToolRegistry` 成为唯一门面；
- 让 MCP 明确退回“外部工具接入机制”；
- 让 `LocalFileSystemMcpServer` 仅在确有需要时保留为薄适配层。

这条路径既比现状更干净，也和主流优秀竞品的长期演进方向一致。
