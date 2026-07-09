# 探索主题: 工具子系统解耦

## 1. 问题定义
当前工具子系统的主要问题不是“工具很多”，而是目录发现、执行分发、审批兼容、资源提取、访问语义等多种职责压在同一条实现链路上，尤其集中在 `ToolRegistry` 与 `LocalFileSystemMcpServer`。C 问题的本质是工具域缺少稳定分层，导致核心层反向依赖适配器细节，工具元数据和访问控制也夹带了较多硬编码。

## 2. 关键发现与调研结果
- **代码库现状**：
  - `src/core/usecases/engine/session.ts` 会将 `toolRegistry` 强转为具体实现后调用 `getResourceExtractors()`，说明核心层已越过 `ToolRegistryPort`，直接依赖工具适配器内部能力。
  - `src/adapters/tools/toolRegistry.ts` 同时负责本地工具路由与外部 MCP 管理。`callTool()` 通过重新读取本地工具定义来判断工具是否属于本地执行路径，`getResourceExtractors()` 又继续暴露适配器内部概念。
  - `src/adapters/tools/virtual-mcp.ts` 中 `LocalFileSystemMcpServer` 同时负责内建工具实例化、浏览器工具注册、资源提取器维护、能力认领、MCP 兼容调用边界。
  - `registerExtractorsForBuiltinTools()` 通过工具名集中维护资源提取规则，并直接读取 `process.cwd()`；这是典型的集中式硬编码点。
  - 浏览器工具在 `virtual-mcp.ts` 中直接构造注册，说明工具模块边界还不稳定，新增一类工具仍然需要改“大中心类”。
- **核实与洞察**：
  - MCP 规范明确区分 `tools/list` 与 `tools/call`，并要求服务端负责输入校验、访问控制、输出净化。这支持把“工具目录”“工具执行”“安全/资源元数据”拆开，而不是继续让一个类同时负责所有语义。[MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
  - `opencode` 的工具边界更清晰：
    - `packages/opencode/src/tool/registry.ts` 负责目录与筛选。
    - `packages/opencode/src/session/tools.ts` 负责一次会话内的工具解析、权限桥接与执行。
    - 会话状态与工具注册表并未揉在一起。
  - `hermes-agent` 的 `tools/registry.py` 明确只承担工具注册表职责，而 `acp_adapter/edit_approval.py` 明确声明审批适配层刻意与通用工具注册表隔离，说明特殊审批语义不应继续塞进通用注册中心。
  - `openclaw` 将工具策略下沉为独立 `effective-tool-policy` 流水线，而不是挂在会话管理器里，说明工具访问控制本身也应有独立边界。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：保留现有 ToolRegistry/virtual-mcp 结构，仅补接口 | 方案 B：拆成工具目录、工具执行、访问元数据三个边界 | 结论 |
| :--- | :--- | :--- | :--- |
| 改造成本 | 低 | 中 | A 更低 |
| 解耦效果 | 弱，核心层仍可能越层 | 强，可稳定端口边界 | B 更优 |
| 硬编码治理 | 弱，工具名分支仍集中存在 | 中到强，可迁移到工具定义元数据 | B 更优 |
| 可扩展性 | 新增工具类型仍易改到中心类 | 更利于扩展浏览器、MCP、资源类工具 | B 更优 |
| 端口清晰度 | 弱，适配器概念继续泄漏 | 强，核心仅依赖必要契约 | B 更优 |

**推荐路径**：选择方案 B，但控制在工具域内做分层，不要扩散成整个运行时大重写。

建议的解耦边界如下：

1. `ToolCatalog`
   - 负责本地工具与外部 MCP 工具的可见目录。
   - 对应 `tools/list` 语义。

2. `ToolExecutor`
   - 负责 `tools/call`、参数进入执行边界、能力认领、结果包装。
   - 不负责资源提取器注册，也不负责目录展示。

3. `ToolAccessMetadataProvider`
   - 负责资源提取器、访问模式、审批前置所需元数据。
   - 作为独立契约供核心层使用，而不是让核心层强转 `ToolRegistry`。

4. 内建工具模块化注册
   - 浏览器工具、文件工具、搜索工具各自提供注册清单及访问元数据。
   - `registerExtractorsForBuiltinTools()` 这种集中按名称分支的逻辑应迁移为工具定义自带元数据。

5. 端口收敛
   - `ToolRegistryPort` 继续只承载真正需要的核心能力。
   - 如果核心层需要访问元数据，则新增独立端口，不在现有 registry 端口上继续堆能力。

## 4. 约束、风险与未知项
- `agent-loop -> ToolRegistryPort.callTool -> virtual-mcp -> tool.execute()` 是真实执行链路，任何拆分都不能破坏审批、能力认领与工具完成回写的顺序。
- 当前资源提取器是否已经稳定到值得上升为独立契约，需要在后续 proposal 中进一步定稿。
- 如果只把 `ToolRegistry` 拆成多个类，但仍让 `SessionManager` 手动拼装并强转访问具体实现，核心问题不会消失。
- 浏览器工具数量已经不少，若元数据迁移不完整，容易在拆分过程中丢失审批或访问语义。

## 5. 否决方案
- **继续扩充 `virtual-mcp.ts`**：这会让更多工具类型与资源语义继续沉积在大中心类中。
- **只新增 `getXxx()` 接口，不处理核心层强转依赖**：这属于把泄漏包装得更体面，本质未变。
- **把资源提取器与审批逻辑继续上提到 `SessionManager` 或 `AgentLoop`**：只会把耦合从适配器层转移到编排层。
- **一次性把所有工具改成完全独立插件化框架**：对当前项目阶段过重，风险高于收益。
