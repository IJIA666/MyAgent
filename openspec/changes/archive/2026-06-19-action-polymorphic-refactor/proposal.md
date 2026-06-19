## 改造原因

目前智能体在调用本地文件系统内置工具（如 `readFile`, `writeFile`, `globSearch` 等）时，采用了耦合度极高的硬编码路由机制：
1. **违背开闭原则 (OCP)**：本地虚拟 MCP 服务器 `LocalFileSystemMcpServer` 在执行工具分派时，内部通过一个庞大的 `switch-case` 语句来进行判断与直接调用。这意味着只要增加、修改或废弃任何本地内置工具，都必须被迫侵入修改核心的分发服务器类文件 `virtual-mcp.ts`。
2. **测试粒度过粗**：由于本地工具逻辑（如 grep 搜索、终端执行等）没有标准化的接口定义，难以直接针对单个本地工具实例进行隔离的单元测试，必须在测试中通过拼装整个 `LocalFileSystemMcpServer` 甚至整个大系统进行透传测试，降低了测试的精准度。

为了让本地工具的管理可插件化、松耦合，需要对 Action 层的工具装配与路由架构进行多态插槽式重构。

## 变更内容

1. **抽象 NativeTool 契约接口**：定义标准的 TypeScript 工具插件接口 `NativeTool`，规定工具名、JSON Schema 格式的 definition 声明以及 `execute` 执行方法。
2. **工具多态插件化改写**：将原先在 `src/action/tools.ts` 中暴露的具体物理函数（如 `readFileTool`, `globSearchTool`）重构为一个个实现了 `NativeTool` 接口的标准化类/对象实例，解耦具体实现。
3. **消除硬编码 Switch 分发**：重构 `LocalFileSystemMcpServer`，改用动态注册字典模式。在初始化时动态注册所有已启用的 `NativeTool` 实例，在 `callTool` 分发时通过 Map 字典直接检索并物理调用，彻底清空 switch-case 硬编码。

## 业务能力

### 新增业务能力
- `action-polymorphic-slots`: 本地文件系统等内置工具的多态插槽式插件重构，消除硬编码路由。

### 修改业务能力
<!-- 本次变更属于 Action 层的底层纯技术架构重构，不涉及既有已定义的业务逻辑行为变更，故无修改业务能力 -->

## 影响范围

* **受影响代码**：
  * `src/action/tools.ts`：文件内零散的具体工具执行函数改写为多态工具插件对象。
  * `src/action/virtual-mcp.ts`：类结构重构，删除 `switch-case` 分发，改为持有 `Map<string, NativeTool>` 插槽表。
  * `src/action/toolRegistry.ts`：在初始化 `LocalFileSystemMcpServer` 时进行插件注册，或由虚拟服务器自行完成内建注册。
* **受影响 API**：
  * 本地内置工具与外部 MCP 工具在 `ToolRegistry` 的调用契约层保持不变，保证大循环 `AgentLoop` 对工具的分发无感。
* **依赖关系**：
  * `src/action/virtual-mcp.ts` 移除对零散工具具体方法的硬编码 import 依赖，仅依赖统一的插件接口。
