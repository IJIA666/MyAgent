## 改造原因

当前仓库的本地工具运行时存在重复装配问题：`ToolRegistry` 与 `LocalFileSystemMcpServer`（virtual-mcp）各自独立维护一套本地工具目录和对应的执行器。同一批本地工具在运行时存在两套组织方式，导致以下后果：

- **认知负担增加**：新加入者需要理解两套工具组织逻辑及其差异，才能正确扩展工具。
- **审批与元数据链重复**：审批资源提取、`claimCapability` 与访问元数据查询等横切能力需要在两套门面上各铺设一次，易产生覆盖遗漏。
- **扩展点治理困难**：若要新增一种横切能力（如输出裁剪、调用审计），必须在两套路径上同步实现，否则会出现"看起来有实则没生效"的隐性缺陷。

跨项目竞品调研（Claude Code、opencode、Hermes Agent、OpenClaw）的一致结论是：**统一内部工具运行时模型，让 MCP 明确退回"外部工具接入机制"角色**，而不是让内置工具先伪装成 MCP 再接入。本提案采纳该方向，并对当前架构做相应调整。

## 变更内容

核心目标：消除本地工具重复装配，建立**唯一内部工具运行时模型**。

1. **消除重复装配**：`ToolCatalog`、`ToolExecutor`、`ToolAccessMetadataProvider` 只保留一套实例来源，成为本地工具运行时的唯一真源。
2. **`ToolRegistry` 收缩为统一门面**：对外暴露统一调用入口与本地工具元数据查询入口，对内聚合本地工具与外部 MCP 工具。
3. **`LocalFileSystemMcpServer` 职责降级**：从"工具装配中心"降为薄协议适配层——若确有不可迁移的外部调用方依赖其 MCP 入口则保留适配；仓库内测试应优先迁移到统一运行时，完成迁移后移除。
4. **`McpToolManager` 保持外部 MCP 边界**：继续负责外部 MCP 工具的发现、连接、断线恢复与调用路由，但不再承载任何本地工具装配职责。

不兼容变更标记：**无 BREAKING**。调整面向内部架构重组，对外暴露的 `ToolCallOrchestrator` 接口链不应受影响。

## 业务能力

### 新增业务能力

- `unified-tool-runtime`: 统一内部工具运行时模型，本地工具仅通过唯一装配源暴露，消除重复组织带来的不一致性。

### 修改业务能力

- 无单独业务能力增量。本次 spec delta 统一收敛在 `unified-tool-runtime` 下，用于约束本地工具运行时与 `virtual-mcp` 的实现边界。

本次需要生成增量 spec，但只针对**本地工具运行时收敛**这一条变化补充约束；`McpToolManager` 的现有外部 MCP 生命周期能力并非本次新增能力，不应重复生成一份独立 spec。

## 影响范围

- `src/adapters/tools/toolRegistry.ts` — 统一门面改造
- `src/adapters/tools/virtual-mcp.ts` — 职责降级或移除
- `ToolExecutionContext`、审批资源提取、`claimCapability` 等横切逻辑路径需要通过验证确认仍只经过一个明确边界
