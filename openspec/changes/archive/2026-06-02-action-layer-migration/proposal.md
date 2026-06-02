## 改造原因

作为大型重构项目 `modular-architecture` 的首个阶段（Phase 1），当前 `src/` 根目录下的文件过于扁平且职责混杂。我们将执行与外部接口调用的“行动能力”剥离到一个独立且高内聚的 `src/action/` 模块中，为后续 `brain`（大脑逻辑）与 `interface`（交互边界）的顺利抽离打下基建基础。

## 变更内容

- 建立 `src/action/` 顶层目录。
- 迁移核心执行层代码：将 `mcp-client.ts`, `tools.ts`, `toolRegistry.ts`, `virtual-mcp.ts` 移动至 `src/action/`。
- 新增 `src/action/index.ts` 门面文件，统一对外暴露 `action` 层的能力，隐藏内部结构。
- 更新全量项目中对上述文件的依赖导入路径。

## 业务能力

### 新增业务能力
无。本次为纯技术目录重构，不涉及新增业务逻辑。

### 修改业务能力
无。所有原有的工具执行与虚拟 MCP 能力维持现有 spec 行为规范，仅改变物理存储路径与模块引用逻辑。

## 影响范围

- 核心工具模块的物理目录结构变更（`src/*.ts` -> `src/action/*.ts`）。
- 牵涉到入口层 `index.ts`、命令层 `command.ts` 和会话控制层 `session.ts` 中针对工具模块依赖导入路径的修正。
