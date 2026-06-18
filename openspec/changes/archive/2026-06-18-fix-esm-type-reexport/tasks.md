## 1. 修正类型重导出

- [x] 1.1 修改 `src/action/native-tools/terminal.ts`，将对 `TaskInfo` 的重导出更改为显式内联类型导出 `type TaskInfo`。
- [x] 1.2 修改 `src/action/native-tools/terminal.ts`，将对 `WorkMode` 的重导出更改为显式内联类型导出 `type WorkMode`。
- [x] 1.3 修改 `src/brain/context.ts`，将对 `ApiUsage` 和 `ContextTokenUsage` 的重导出更改为显式类型重导出 `export type { ApiUsage, ContextTokenUsage }`。
- [x] 1.4 修改 `src/interface/command.ts`，将对 `CommandContext` 和 `CommandResult` 的重导出更改为显式类型重导出 `export type { CommandContext, CommandResult }`。

<!-- checkpoint: npm run build -->

## 2. 验证运行与测试

- [x] 2.1 本地执行 `npm run dev` 启动 Agent，验证是否不再出现模块静态解析错误，且控制台能正常进入交互流。
- [x] 2.2 本地执行单元测试，保证类型导出的修补没有破坏任何已有的逻辑与测试断言。

<!-- checkpoint: npm run test -->
