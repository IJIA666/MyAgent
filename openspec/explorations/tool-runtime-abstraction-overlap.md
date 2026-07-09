# 探索主题: 工具运行时抽象重叠与装配耦合治理

## 1. 问题定义
当前工具子系统已经开始拆分 `ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider` 等对象，方向是正确的，但总体装配仍存在抽象重叠：`ToolRegistry`、`LocalFileSystemMcpServer`、组合根三者共同参与同一批本地工具的组织、路由和元数据提供，导致职责分布不够利落，认知成本偏高。

## 2. 关键发现与调研结果
- **代码库现状**：`src/adapters/tools/toolRegistry.ts` 同时实现 `ToolRegistryPort` 与 `ToolAccessMetadataPort`，它既是执行路由门面，又是元数据查询门面。
- **代码库现状**：`src/adapters/tools/virtual-mcp.ts` 内部也持有 `ToolCatalog` 与 `ToolExecutor`，并负责注册全部本地工具；随后 `ToolRegistry` 又从 `LocalFileSystemMcpServer` 取出同一批工具再构建一次自己的 `ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider`。
- **代码库现状**：组合根 `src/index.ts` 把同一个 `toolRegistry` 同时作为工具注册表和工具访问元数据端口注入 `SessionManager`，说明接口隔离在类型层面成立，但运行时对象并没有真正隔离。
- **代码库现状**：组合根还内联了技能加载、Embedding 适配器选择和工具注册表装配逻辑，使入口文件承担了部分基础设施选择策略。
- **核实与洞察**：问题不在于有没有抽象，而在于“抽象层次过多但角色没有拉开”。本地工具本来就不是外部 MCP 进程，继续保留一层“虚拟 MCP Server”语义，需要证明它确实提供了稳定价值，否则更像额外包装。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：保留 `virtual-mcp` 语义，继续局部修补 | 方案 B：压缩本地工具装配层次，明确单一门面 | 结论 |
| :--- | :--- | :--- | :--- |
| 改动成本 | 低 | 中 | A 占优 |
| 认知负担 | 高，仍要理解两套本地工具门面 | 低，职责更清晰 | B 占优 |
| 后续扩展元数据与审批 | 中 | 强 | B 占优 |
| 保留 MCP 兼容叙事 | 强 | 中 | A 略优 |
| 真正降低耦合 | 弱 | 中到强 | B 占优 |

**推荐路径**：采用方案 B。将本地内建工具视为“进程内工具提供者”，不要继续在语义上强行模拟一层完整的虚拟 MCP Server。`ToolRegistry` 应收缩为统一门面，只负责聚合本地提供者与外部 MCP 管理器；`ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider` 则只保留一套实例来源，避免同一批工具被重复包裹。

## 4. 约束、风险与未知项
- 若仓库后续明确要求“所有工具都必须统一为 MCP 语义”，则需要先证明 `virtual-mcp` 这层在测试、协议一致性或可观测性上提供了不可替代的价值。
- `ToolExecutionContext`、审批资源提取和 `tool.execute()` 的契约已经依赖当前装配形态，收缩层次时要避免打破现有审批链。
- 组合根里内联的 `loadSkill`、Embedding 适配器选择逻辑，也可能需要顺手迁入专门的工厂或 provider，但不应与工具层收缩混成一次改动。

## 5. 否决方案
- **继续沿用当前两层本地工具门面，只补注释解释**：无法降低真实复杂度，只是把理解成本转嫁给维护者。
- **把所有工具相关职责都并回 `ToolRegistry`**：会把正在形成的目录、执行、元数据分离重新合并回一个更大的类，方向错误。
