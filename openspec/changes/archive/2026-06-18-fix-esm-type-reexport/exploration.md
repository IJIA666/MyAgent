# 探索主题: tsx运行环境下重导出TS类型导致ESM加载报错问题

## 1. 问题定义
在执行 `npm run dev` 启动 Agent 时，Node.js 报告语法错误：
`SyntaxError: The requested module './terminal-engine.js' does not provide an export named 'TaskInfo'`
导致程序无法成功启动。核心痛点在于在 ESM (ECMAScript Modules) 规范下，由 TypeScript 接口（Interface）重导出时，由于类型在编译/转译阶段被擦除，导致 Node.js 在运行时对依赖模块执行静态导入校验时无法找到对应的导出。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 在 `src/action/native-tools/terminal-engine.ts` 中定义并导出了 `TaskInfo` 接口（第 17 行）。
  - 在 `src/action/native-tools/terminal.ts` 中通过如下方式进行重导出：
    ```typescript
    export {
      TaskInfo,
      activeTasks
    } from './terminal-engine.js';
    ```
  - 由于 Node.js 运行在 ESM 模式下并使用 `tsx`（背后使用 `esbuild` 快速转译），转译后的 `terminal-engine.js` 不会输出任何有关 `TaskInfo` 的物理代码。但在 `terminal.js` 中却依然在静态 `export` 列表中保留了对 `TaskInfo` 的导出，触发了 Node.js v22.22.1 的严格静态模块加载校验报错。
- **核实与洞察**：
  - 通过联网搜索和 TS/ESM 规范分析，在现代 ESM 环境（尤其是使用 `esbuild`、`tsx` 或 `Vite` 等快速转译器且配置了严格模块解析时），必须显式地将类型导入/重导出标记为 `type`。
  - TypeScript 提供了显式类型重导出语法（如 `export type { TaskInfo }` 或 `export { type TaskInfo }`），这会让转译器安全地擦除此项，不会在最终的 JS `export` 列表中保留，从而避免运行时加载报错。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：显式声明 `export type` / `type` | 方案 B：关闭 ESM 静态校验 / 改回 CommonJS | 结论 |
| :--- | :--- | :--- | :--- |
| **兼容性** | 完美兼容 TypeScript 和 ESM 规范，不影响编译行为 ✓ | 需要重构整个项目模块规范，破坏 ESM 现代标准 ✗ | 方案 A 占优 |
| **开发成本** | 极低（仅需添加 `type` 关键字） ✓ | 极高（需要修改 `tsconfig.json` 或 `package.json`） ✗ | 方案 A 占优 |
| **代码规范** | 符合现代前端/TS 开发最佳实践 ✓ | 会引入潜在的模块解析混淆和副作用 ✗ | 方案 A 占优 |

**推荐路径**：
使用 **方案 A**。对 `src/action/native-tools/terminal.ts` 进行修改，将类型重导出修改为显式类型导出：
```typescript
export {
  type TaskInfo,
  activeTasks
} from './terminal-engine.js';
```
同时，经排查 `src/brain/context.ts` 中也存在类似的重导出（如 `export { ApiUsage, ContextTokenUsage } from './TokenEstimator.js';`），若在后续执行中同样触发此类错误，也应统一重构为显式的 `export type { ... }` 格式。

## 4. 约束、风险与未知项
- **约束**：在修改时需确保 TypeScript 编译器版本支持 `export { type X }` 语法（TS 3.8+ 支持 `export type`，TS 4.5+ 支持 inline `type`）。当前项目使用最新的 `tsx` 和 Node 22，理论上完全支持。

## 5. 否决方案
- **改回 CommonJS 方案**：虽然 CommonJS 对类型擦除的导出没有静态校验，但在本项目已全面建立在 ESM 构建体系上的情况下，退回到 CommonJS 会导致大量依赖解析报错，产生大量级联修改成本，故予以否决。
