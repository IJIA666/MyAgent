## 背景

在 Node.js 环境下以 ESM 模式运行 TypeScript 代码时，若通过 `tsx` (基于 `esbuild`) 进行即时转译，纯 TypeScript 类型（如 `interface` 和 `type`）会被擦除。

在现有的代码中，有几处重导出写法因没有标记为 `type`，导致在生成的 JS 中被保留为物理导出，最终引起静态解析 `SyntaxError`：
1. `src/action/native-tools/terminal.ts` 对 `TaskInfo` 和 `WorkMode` 的重导出。
2. `src/brain/context.ts` 对 `ApiUsage` 和 `ContextTokenUsage` 的重导出。
3. `src/interface/command.ts` 对 `CommandContext` 和 `CommandResult` 的重导出。

为了保证 Agent 能正常启动并平稳运行，必须全局修复所有这类由于重导出被转译为实体导致 ESM 静态解析失败的隐患。

## 目标与非目标

**目标:**
- 修复本地运行或在其他模块引入时由于类型擦除导致的模块解析报错，使 Agent 在交互式和执行态各链路均能正常运行。
- 对所有受影响的重导出类型采用符合 TS 与 ESM 规范的显式类型导出语法（`export type { ... }` 或 `export { type ... }`）。
- 保证对应用运行时逻辑没有任何侵入或行为改变。

**非目标:**
- 不做任何业务逻辑层面的代码修改。
- 不退回至 CommonJS 模块规范，不调整全局的 `tsconfig.json` 配置。

## 架构决策

- **决策一：对重导出的类型启用显式类型标记**
  - **具体改动**：
    1. 在 `src/action/native-tools/terminal.ts` 中，将重导出修改为：
       ```typescript
       export {
         type WorkMode,
         getWorkMode,
         setWorkMode,
         loadWorkMode,
         saveWorkMode,
         loadAllowedCommands,
         saveAllowedCommands,
         extractSafePrefix,
         checkWhitelist
       } from './terminal-config.js';

       export {
         type TaskInfo,
         activeTasks
       } from './terminal-engine.js';
       ```
    2. 在 `src/brain/context.ts` 中，将重导出修改为：
       ```typescript
       export type { ApiUsage, ContextTokenUsage } from './TokenEstimator.js';
       ```
    3. 在 `src/interface/command.ts` 中，将导出修改为：
       ```typescript
       export type { CommandContext, CommandResult };
       ```
  - **理由**：
    通过显式地将类型加上 `type` 修饰符（无论是 inline 类型前缀还是在括号外整体加上 `type` 关键字），打包器/转译器在将其转换为运行时 JS 的过程中，能准确识别并剥离这些仅作为类型修饰的名词，从而使导出的都是实际运行时存在的类或对象，解决 Node.js ESM 环境对缺失导出的崩溃式静态拦截。

## 风险与权衡

- **风险点**：类型导出语法对于老版本 TypeScript（如 TS 3.8 以前）可能有兼容性限制。
- **缓解策略**：经核实，当前项目使用的 TypeScript 版本为 `5.3.3`，且 `tsx` 为 `4.7.1`，属于非常现代的版本，完全支持 inline `type` 导出语法，因此此项修改不存在任何构建兼容风险。由于其在转译期工作，运行时无开销，因此是一次安全的无损修改。
