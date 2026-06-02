## 1. 终端交互层解耦与迁移

- [x] 1.1 创建 `src/interface/` 目录
- [x] 1.2 将 `src/command.ts` 移动到 `src/interface/command.ts`
- [x] 1.3 创建 `src/interface/cli.ts` 文件
- [x] 1.4 从 `src/index.ts` 中将所有的 `readline` 交互逻辑、ANSI 颜色输出逻辑以及 `session.chat()` 事件流的消费打印过程，完整提取到 `src/interface/cli.ts` 提供的一个 `startCli(session: SessionManager)` 函数中
- [x] 1.5 创建 `src/interface/index.ts`，集中导出 `startCli`

<!-- checkpoint: node -e "require('fs').existsSync('src/interface/cli.ts') ? process.exit(0) : process.exit(1)" -->

## 2. 依赖重组与入口清理

- [x] 2.1 修复向下依赖：更新 `src/interface/command.ts`，修正其对 `config`、`brain`、`utils` 等底层的相对导入路径
- [x] 2.2 完善内联逻辑：确保 `src/interface/cli.ts` 正确处理了相关的类型与内部依赖
- [x] 2.3 净化引导层：极限重构 `src/index.ts`，彻底剥离所有的终端交互代码，将其塑造为纯粹的组装脚本，并在结尾调用 `startCli(session)` 驱动主循环

<!-- checkpoint: npx tsc --noEmit -->
