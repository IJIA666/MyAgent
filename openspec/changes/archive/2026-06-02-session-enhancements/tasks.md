## 1. 持久化存储底层机制构建

- [x] 1.1 在 `src/brain/session.ts` 中新增 `sessionId` 属性及其 getter
- [x] 1.2 在 `src/brain/session.ts` 中实现 `saveState()` 和 `loadState()` 私有或公有方法，使用 `fs.promises.writeFile/readFile` 操作 `.myagent/sessions/<sessionId>.json`
- [x] 1.3 在 `session.ts` 的 `chat()` 流水线末尾（以及 `rollback` 方法中）埋点调用 `saveState()` 实现自动静默落盘

<!-- checkpoint: npx tsc --noEmit -->

## 2. 命令行补全能力挂载

- [x] 2.1 在 `src/interface/cli.ts` 中定义 `completer` 函数，对传入的 `line` 进行前缀匹配，返回候选斜杠指令数组
- [x] 2.2 在 `createInterface` 初始化时挂载该 `completer`

<!-- checkpoint: npx tsc --noEmit -->

## 3. 历史会话管理入口

- [x] 3.1 在 `src/interface/command.ts` 中新增 `/history` 命令处理逻辑，读取并格式化打印 `.myagent/sessions` 目录下的 JSON 文件列表
- [x] 3.2 在 `src/interface/command.ts` 中新增 `/resume <id>` 命令处理逻辑，调用 `session.loadState(id)` 并使用 `redrawHistory` 刷新终端展示

<!-- checkpoint: npx tsc --noEmit -->
