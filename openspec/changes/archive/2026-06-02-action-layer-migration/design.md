## 背景

作为 `modular-architecture` 重构的 Phase 1，我们需要剥离位于项目根目录下的大量工具执行层逻辑。当前，诸如 `virtual-mcp.ts`, `mcp-client.ts`, `tools.ts`, `toolRegistry.ts` 等直接与外部环境交互的基础设施代码都扁平地散落在 `src/` 根目录。

## 目标与非目标

**目标:**
- 将本地工具执行逻辑（`tools.ts`, `toolRegistry.ts`）安全移至 `src/action/`。
- 将外部 MCP 通信与组装逻辑（`mcp-client.ts`, `virtual-mcp.ts`）安全移至 `src/action/`。
- 提供统一的 `src/action/index.ts` 门面供外部（主要是 `session.ts` 和 `command.ts`）进行黑盒调用。

**非目标:**
- 不改变任何 MCP 或本地工具内部的实现流转逻辑。
- 不干预或重构大模型的调度逻辑、界面交互逻辑（这属于 Phase 2 和 Phase 3 的职责）。

## 架构决策

- **门面模式隔离边界（Facade）**: 通过 `src/action/index.ts` 聚合所有行动层的对外接口，强制 `src/session.ts` 和 `src/index.ts` 只能从 `src/action/index.js` 导入类。这样在未来如果 `action` 模块内部继续细分出 `mcp/` 和 `local/` 目录时，可以免受外部重构影响，实现真正的模块解耦。

## 风险与权衡

- **路径断裂风险**: TypeScript 中的 ESM 导入对于扩展名极其敏感（必须以 `.js` 结尾）。移动文件后相对路径如果更新遗漏，会导致运行时报错。
  - **应对机制**: 严格使用 `tsc --noEmit` 进行静态类型和依赖检查，同时在重构后使用测试命令进行端到端验证。
