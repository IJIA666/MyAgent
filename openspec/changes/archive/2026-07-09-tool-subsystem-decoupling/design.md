## 背景

工具子系统当前的物理结构如下：

```
src/ports/driven/tools/
└── ToolRegistryPort.ts     # 端口契约（getTools / callTool / getTool / close）
src/adapters/tools/
├── toolRegistry.ts          # ToolRegistry 实现（包装 LocalFileSystemMcpServer + McpToolManager）
├── virtual-mcp.ts           # LocalFileSystemMcpServer（内建工具实例化 + 浏览器注册 + 资源提取器 + MCP 边界）
├── impl/                    # 14 个工具实现（filesystem/ browser/ system/ skill/ git/ interaction/）
└── index.ts                 # 导出
```

核心问题链：

1. **核心层反向依赖**：`src/core/usecases/engine/session.ts` 将 `toolRegistry` 强转为 `ToolRegistry` 具体类后调用 `getResourceExtractors()`，绕过 `ToolRegistryPort` 端口契约
2. **大中心类过载**：`LocalFileSystemMcpServer` 在构造函数中集中实例化所有内建工具（文件、系统、git、skill、交互），同时构造浏览器工具实例，维护 `resourceExtractors` Map，处理 MCP `tools/list` 和 `tools/call` 语义
3. **集中式硬编码**：`registerExtractorsForBuiltinTools()` 按工具名分支维护资源提取规则，并直接读取 `process.cwd()`
4. **浏览器工具耦合**：浏览器工具的 9 个类直接在 `virtual-mcp.ts` 中 import 并构造，新增浏览器工具能力需同时改两个文件

对标参考：
- **opencode**：`tool/registry.ts` 只负责目录与筛选，`session/tools.ts` 负责解析、权限桥接与执行，会话状态与工具注册未揉在一起
- **hermes-agent**：`tools/registry.py` 仅承担注册表职责，`acp_adapter/edit_approval.py` 刻意与通用注册表隔离
- **openclaw**：工具策略下沉为独立 `effective-tool-policy` pipeline，不挂在会话管理器上

## 目标与非目标

**目标：**

1. **三层边界分离**：拆分出 `ToolCatalog`（目录）、`ToolExecutor`（执行）、`ToolAccessMetadataProvider`（元数据）三个独立对象，各拥有单一变更原因
2. **消除核心层强转**：不再让 `session.ts` 将 `ToolRegistryPort` 强转为具体实现，元数据查询通过新增 `ToolAccessMetadataPort` 端口进行
3. **元数据去中心化**：`registerExtractorsForBuiltinTools()` 的集中式名称分支迁移为各工具定义自带 `accessMetadata` 或 `resourceExtractor`
4. **浏览器工具解耦**：浏览器工具注册逻辑从 `LocalFileSystemMcpServer` 构造函数中提取，成为独立的注册清单
5. **端口收敛**：`ToolRegistryPort` 保持对外稳定（`getTools`、`callTool`、`getTool`、`close`），新增端口独立承载元数据

**非目标：**

- **不改工具执行时序**：审批流程、能力认领（`claimCapability`）、工具完成回写（`consumeCapability`）的顺序不变
- **不重写 MCP 协议适配层**：`McpToolManager` 和 MCP 客户端通信协议不在此 change 中改动
- **不改变工具对外的 OpenAI function calling 契约**：`getTools()` 返回的工具描述格式保持不变
- **不在此 change 中引入插件化的工具加载机制**：不实现完全动态的 `ToolPlugin` 接口，工具仍为静态 import
- **不修改 `SessionContext` 或审批流程**：续接刚完成的 `session-context-splitting` 重构成果

## 架构决策

### 决策 1：拆分为 ToolCatalog / ToolExecutor / ToolAccessMetadataProvider（而非更少或更多）

**选择**：三路拆分，边界对齐 MCP 规范中的 `tools/list`（目录）、`tools/call`（执行）和访问控制元数据。

**理由**：

- `ToolCatalog` 与 `ToolExecutor` 的分离依据是 **MCP 协议语义**——`tools/list` 是幂等查询，`tools/call` 是有副作用执行，两者应独立演进
- `ToolAccessMetadataProvider` 与 `ToolExecutor` 的分离依据是 **安全边界**——资源提取器和审批前置元数据应作为独立契约暴露，核心层通过端口访问时不应能触及执行调度
- 三路拆分恰好对应"发现-执行-授权"的经典关注点分离

**替代方案**：
- 拆为 2 个（合并目录+元数据）：被否决，因为目录是工具可见性的概念，元数据是访问控制的概念，合并会模糊安全边界
- 拆为 4 个（单独抽出 `ToolFactory` 负责实例化）：被否决，当前静态 import 足以覆盖内建工具注册，额外的工厂抽象会增加不必要的间接层

### 决策 2：新增 ToolAccessMetadataPort 端口（而非在 ToolRegistryPort 上继续堆方法）

**选择**：在 `src/ports/driven/tools/` 下新增 `ToolAccessMetadataPort.ts`，定义 `getResourceExtractor(toolName)` 和 `getAccessMetadata(toolName)` 等方法。`ToolRegistryPort` 的既有方法保持兼容。

**理由**：

- 当前 `ToolRegistryPort` 已被 `ToolRegistry` 实现，若继续在其上添加元数据方法，会继续把执行和元数据揉在同一个端口里
- 新增独立端口符合接口隔离原则（ISP），核心层只依赖它真正需要的元数据契约
- `session.ts` 中对 `toolRegistry` 的强转调用 `getResourceExtractors()` 可改为注入 `ToolAccessMetadataPort`

**替代方案**：
- 在 `ToolRegistryPort` 上新增 `getResourceExtractors()` 方法：被否决，会把端口继续膨胀，且让核心层能通过同一端口访问到执行语义

### 决策 3：元数据迁移为工具定义自带（而非保留集中式分支）

**选择**：在 `NativeTool` 接口上新增可选字段 `resourceExtractor` 和 `accessMetadata`。工具构造时自声明其元数据，`ToolAccessMetadataProvider` 聚合所有工具的元数据。

**理由**：

- 当前 `registerExtractorsForBuiltinTools()` 按工具名 switch-case 分支，新增工具时必须同步修改此函数——这是典型的开闭原则违反
- 工具自带元数据后，新增文件搜索工具无需碰 `virtual-mcp.ts` 或任何中心类，只需在自己的定义文件中声明 `resourceExtractor`
- 对标 opencode 和 hermes-agent，工具元数据均为工具自身属性，不是注册中心的配置

**NativeTool 扩展方向**：

```typescript
export interface NativeTool {
  readonly securityCategory: 'read' | 'write';
  readonly name: string;
  readonly executionMode?: ExecutionMode;
  // 新增：工具自带的资源提取器
  readonly resourceExtractor?: (args: Record<string, unknown>, cwd: string) => SafetyResource[];
  // 新增：工具的访问元数据
  readonly accessMetadata?: ToolAccessMetadata;
}
```

**替代方案**：
- 保留 `registerExtractorsForBuiltinTools()` 但外部化配置：被否决，无法解决跨文件修改问题
- 使用装饰器注册元数据：被否决，TypeScript 装饰器在 ESM 下的实验性状态不契合项目稳定性要求

### 决策 4：LocalFileSystemMcpServer 收缩为 MCP 适配边界（而非继续做大中心类）

**选择**：`LocalFileSystemMcpServer` 收缩为 MCP 协议的适配层——接收 `tools/list` 和 `tools/call` 请求，内部委托给 `ToolCatalog` 和 `ToolExecutor`。不再直接持有工具实例化和资源提取器的所有权。

**理由**：

- 当前 `LocalFileSystemMcpServer` 在构造函数中 import 并实例化所有内建工具 + 浏览器工具，本质是手动依赖注入容器。拆分后，工具目录和执行各自独立，MCP Server 仅负责协议适配
- 浏览器工具 9 个类的 import 和构造可从 `virtual-mcp.ts` 移到浏览器工具自身的 `index.ts` 注册清单

**替代方案**：
- 保留 `LocalFileSystemMcpServer` 但只擦除资源提取器：被否决，半拆不拆会让后续清理更困难

### 决策 5：浏览器工具注册独立化（而非继续在 virtual-mcp.ts 中构造）

**选择**：在 `src/adapters/tools/impl/browser/` 下新增 `browser-tool-registry.ts`，导出浏览器工具的注册清单函数（返回 `NativeTool[]`）。`ToolCatalog` 在初始化时调用各模块的注册清单进行聚合。

**理由**：

- 当前浏览器工具的 9 个类 import 和构造全部在 `virtual-mcp.ts` 构造函数中，新增浏览器工具能力需改动两个文件
- 独立注册清单后，浏览器工具的内部迭代不再触及其他模块

## 目标文件结构

```
src/ports/driven/tools/
├── ToolRegistryPort.ts           # 不变（getTools / callTool / getTool / close）
├── ToolAccessMetadataPort.ts     # 新增：资源提取器与访问元数据查询
├── McpManagerPort.ts             # 不变

src/adapters/tools/
├── ToolCatalog.ts                # 新增：工具目录管理（聚合各模块注册清单）
├── ToolExecutor.ts               # 新增：工具执行调度（能力认领 + 结果包装）
├── ToolAccessMetadataProvider.ts # 新增：元数据聚合（实现 ToolAccessMetadataPort）
├── toolRegistry.ts               # 重构：委托给 ToolCatalog + ToolExecutor
├── virtual-mcp.ts                # 收缩：MCP 协议适配（委托给 ToolCatalog + ToolExecutor）
├── impl/
│   ├── browser/
│   │   ├── browser-action.ts     # 不变
│   │   └── browser-tool-registry.ts  # 新增：浏览器工具注册清单
│   ├── filesystem/
│   │   └── index.ts              # 微调：导出工具自带元数据
│   ├── system/
│   │   └── index.ts              # 微调：导出工具自带元数据
│   └── ...
└── index.ts                      # 微调：导出新增类
```

## 风险与权衡

| 风险 | 缓解策略 |
|:---|:---|
| **执行链路断裂**：agent-loop → ToolRegistryPort.callTool → virtual-mcp → tool.execute() 的时序若被打破，审批和能力认领顺序可能错乱 | 保持 `ToolExecutor.execute()` 的调用时序与当前 `callTool()` 内部逻辑一致，能力认领点不变 |
| **端口碎片化**：新增 `ToolAccessMetadataPort` 后若继续增加端口，可能导致依赖注入复杂度上升 | 本 change 仅新增一个端口，仅替换 `session.ts` 中的强转使用点，不扩散到无关核心模块 |
| **元数据迁移不完整**：14 个工具文件中部分工具的 `resourceExtractor` 逻辑较复杂，可能在拆分时遗漏场景 | 按工具类别分批迁移（先文件工具 → 系统工具 → 浏览器工具），每批完成后运行对应测试 |
| **virtual-mcp.ts 收缩不彻底**：若 MCP 适配层继续持有工具实例引用，拆分效果打折扣 | `LocalFileSystemMcpServer` 的构造函数改为接收 `ToolCatalog` 和 `ToolExecutor` 实例，自身不再 import 工具实现 |
| **编译面广**：`virtual-mcp.ts` 的 `NativeTool` 接口扩展后，14 个工具文件可能需要适配 | `resourceExtractor` 和 `accessMetadata` 字段设为可选，不实现元数据的工具编译不受影响 |

## 迁移计划

### 步骤 1：端口与契约定义（无破坏性）

1. 新建 `ToolAccessMetadataPort.ts` 端口接口
2. 扩展 `NativeTool` 接口（`resourceExtractor`、`accessMetadata` 可选字段）
3. 新建 `ToolCatalog.ts`、`ToolExecutor.ts`、`ToolAccessMetadataProvider.ts` 骨架类

> 此阶段无行为变更，仅新增文件和接口定义。

### 步骤 2：目录与元数据迁移

1. 实现 `ToolCatalog`：聚合各模块工具注册清单
2. 实现 `ToolAccessMetadataProvider`：聚合各工具的元数据
3. 将 `registerExtractorsForBuiltinTools()` 的逻辑按工具名分解，写入各工具定义的元数据字段
4. 创建浏览器工具独立注册清单 `browser-tool-registry.ts`

> `ToolRegistry` 内部开始委托给新对象，但公开 API 不变。

### 步骤 3：执行链路迁移

1. 实现 `ToolExecutor`：迁移 `callTool()` 核心执行逻辑
2. 收缩 `LocalFileSystemMcpServer`：MCP `tools/list` → 委托 `ToolCatalog`，MCP `tools/call` → 委托 `ToolExecutor`
3. 消除 `session.ts` 中的 `ToolRegistry` 强转

### 步骤 4：清理

1. 移除 `virtual-mcp.ts` 中不再需要的 import
2. 移除 `registerExtractorsForBuiltinTools()` 函数
3. 确认 `ToolRegistryPort` 的 4 个方法保持不变

### 回滚策略

- 步骤 1 纯增量（新增文件 + 接口扩展），无破坏性
- 步骤 2 修改 `ToolAccessMetadataProvider` 实现和工具元数据，`registerExtractorsForBuiltinTools()` 可暂时保留为 fallback
- 步骤 3 涉及执行链路，需在 `ToolExecutor` 与当前 `callTool()` 双轨运行验证后再切换
- 每个步骤独立提交，出问题可 `git revert` 单步回滚

## 未决问题

1. **`ToolAccessMetadataPort` 的具体方法签名**：当前仅规划 `getResourceExtractor(toolName)` 和 `getAccessMetadata(toolName)`，但 `ApprovalPolicy` 可能需要更细粒度的查询——需在 implementation 阶段根据实际调用方定稿

2. **`NativeTool.resourceExtractor` 的 cwd 参数来源**：当前 `registerExtractorsForBuiltinTools()` 直接读取 `process.cwd()`，迁移到工具定义后是否需要改为由调用方注入 cwd

3. **双轨运行策略**：步骤 3 的 `ToolExecutor` 与旧 `callTool()` 是否需要短暂共存（feature flag 控制），还是直接切换
