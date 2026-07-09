## 改造原因

当前工具子系统存在严重的职责混淆：`ToolRegistry`（[toolRegistry.ts](src/adapters/tools/toolRegistry.ts)）和 `LocalFileSystemMcpServer`（[virtual-mcp.ts](src/adapters/tools/virtual-mcp.ts)）同时承担五类非内聚职责：

1. **工具目录** — 本地工具路由 + MCP 工具发现（`tools/list` 语义）
2. **工具执行** — `callTool()` 执行分发 + 能力认领（`tools/call` 语义）
3. **资源提取器** — `getResourceExtractors()` 暴露适配器内部概念给核心层
4. **审批元数据** — `registerExtractorsForBuiltinTools()` 按工具名集中硬编码
5. **浏览器工具注册** — 浏览器工具直接在 `LocalFileSystemMcpServer` 中构造

这导致三个具体问题：

- **核心层反向依赖适配器**：`src/core/usecases/engine/session.ts` 将 `toolRegistry` 强转为具体实现后调用 `getResourceExtractors()`，核心层已越过 `ToolRegistryPort` 端口，直接依赖适配器内部能力
- **硬编码集中膨胀**：`registerExtractorsForBuiltinTools()` 通过工具名分支维护资源提取规则，并直接读取 `process.cwd()`，新增工具类型会持续加重这个中心化分支点
- **大中心类不稳**：`virtual-mcp.ts` 同时负责内建工具实例化、浏览器工具注册、资源提取器维护、能力认领、MCP 兼容调用边界——任何一类工具的变更都可能触及其余逻辑

对标 `opencode`（`tool/registry.ts` 负责目录，`session/tools.ts` 负责解析与权限桥接）、`hermes-agent`（registry 仅承担注册表职责，审批适配层刻意隔离）和 `openclaw`（工具策略下沉为独立 pipeline），当前设计把工具发现、执行、元数据全部压在同一条实现链路上，违背了端口-适配器架构的分层原则。

## 变更内容

- **拆分 ToolRegistry 为三个独立边界**：
  - `ToolCatalog`：负责本地工具与 MCP 工具的可见目录（`tools/list` 语义）
  - `ToolExecutor`：负责 `tools/call`、参数进入执行边界、能力认领、结果包装
  - `ToolAccessMetadataProvider`：负责资源提取器、访问模式、审批前置元数据，作为独立契约供核心层使用
- **消除核心层强转依赖**：`session.ts` 不再将 `toolRegistry` 强转为具体实现，改为通过新增的 `ToolAccessMetadataPort` 端口获取元数据；现有 `ToolRegistryPort` 保持兼容，对外不引入行为级不兼容变更
- **内建工具模块化注册**：浏览器工具、文件工具、搜索工具各自提供注册清单及访问元数据，替代 `registerExtractorsForBuiltinTools()` 集中式名称分支
- **端口收敛**：`ToolRegistryPort` 回归核心能力（目录 + 执行），新增 `ToolAccessMetadataPort` 独立承载元数据查询

本次为架构重构，工具的外部调用行为保持不变，审批流程、能力认领时序、工具完成回写顺序均不受影响。

## 业务能力

### 新增业务能力

- `tool-catalog`: 工具目录管理与发现——本地工具与 MCP 工具的统一定义注册与查询
- `tool-executor`: 工具执行调度——参数进入、执行分发、结果包装与能力认领
- `tool-access-metadata`: 工具访问元数据——资源提取器、访问模式声明与审批前置元数据契约

### 修改业务能力

- `virtual-mcp-server`: `LocalFileSystemMcpServer` 的内部职责将被拆解，内建工具实例化与浏览器工具注册不再集中在此大中心类
- `tool-concurrency-lock`: 能力认领逻辑迁移至 `ToolExecutor` 边界，锁的触发点不变
- `native-tools-extension`: 内建工具的注册清单由集中式 `registerExtractorsForBuiltinTools()` 迁移为各工具自带元数据

## 影响范围

| 层级 | 受影响模块 | 影响性质 |
|:---|:---|:---|
| **端口层** | `src/ports/driven/tools/ToolRegistryPort.ts` | 收窄为核心能力（目录+执行），新增 `ToolAccessMetadataPort` |
| **核心引擎** | `src/core/usecases/engine/session.ts` | 消除强转依赖，改用独立元数据端口 |
| **工具适配器** | `src/adapters/tools/toolRegistry.ts`、`virtual-mcp.ts`、`index.ts` | 核心拆分，大中心类解构 |
| **内建工具** | `src/adapters/tools/impl/` 下 14 个工具实现文件 | 各工具附带元数据注册，不再依赖集中式分支 |
| **安全层** | `src/core/usecases/security/ApprovalPolicy.ts` | 适配资源提取器契约来源变化 |
