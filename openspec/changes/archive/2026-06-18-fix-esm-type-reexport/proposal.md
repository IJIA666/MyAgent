## 改造原因

在本地执行 `npm run dev` 启动 Agent 时，系统因 `SyntaxError: The requested module './terminal-engine.js' does not provide an export named 'TaskInfo'` 报错而阻断。其根本原因在于 Node.js 运行在现代 ESM 模式下，并且使用 `tsx` 快速转译，此时 TypeScript 接口（Interface）等纯类型信息在转译后被完全擦除。

然而，在重导出这些类型时，如果未使用显式的 `type` 关键字，转译器会在转译出的 JS `export` 列表中保留该导出，从而导致 Node.js 运行时在静态导入校验时无法在源文件中找到该名称。为了保证 Agent 的正常启动与本地开发调试流程，现在必须解决该类类型的 ESM 重导出冲突。

通过深度审查，发现不仅 `TaskInfo` 存在这一缺陷，全局中以下纯类型（Interface/Type）的直接重导出在运行时同样存在静态导入校验报错的重大崩溃隐患：
- `src/action/native-tools/terminal.ts` 中重导出的类型别名 `WorkMode`；
- `src/brain/context.ts` 中重导出的接口 `ApiUsage` 和 `ContextTokenUsage`；
- `src/interface/command.ts` 中重导出的接口 `CommandContext` 和 `CommandResult`。

## 变更内容

将项目中所涉及的 TypeScript 纯类型重导出语句进行修正，显式地加上 `type` 关键字（即 `export type { ... }` 或 `export { type ... }`），以便转译器在输出 JavaScript 代码时能正确且安全地将这些类型导出剔除，避免运行时的 ESM 静态校验报错。

具体涉及的优化项为：
1. 修正 `src/action/native-tools/terminal.ts` 中对 `TaskInfo` 和 `WorkMode` 的导出；
2. 修正 `src/brain/context.ts` 中对 `ApiUsage` 和 `ContextTokenUsage` 的导出；
3. 修正 `src/interface/command.ts` 中对 `CommandContext` 和 `CommandResult` 的导出。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

- **受影响的代码文件**：
  - `src/action/native-tools/terminal.ts`
  - `src/brain/context.ts`
  - `src/interface/command.ts`
- **影响的系统行为**：
  - 仅影响本地的启动与调试流程（如 `npm run dev`），不改动任何核心业务逻辑，且不包含破坏性的 API 变更。
