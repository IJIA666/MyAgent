## 1. 新建子组件 (Create Sub-Components)

- [x] 1.1 新建 `src/interface/views/widget-renderer.ts`，将原本位于 `src/interface/cli.ts` 中的 `renderContentWithWidgets`、`redrawHistory` 以及大段 Token 监控面板格式化输出（拼装 `console.log` 的部分）移入其中，封装为无状态渲染工具，补齐相关 TypeScript 类型定义与简体中文注释。
- [x] 1.2 新建 `src/interface/io/input-listener.ts`，创建 `InputListener` 类，收拢原本位于 `src/interface/cli.ts` 中的 `readline` 实例控制、双击 ESC 监听、Ctrl+C SIGINT 捕获以及命令行自动补全（completer）和回车整行文本提交监听，以 Getter 形式提供对 `isGenerating` 状态的响应式查询。

<!-- checkpoint: npm run build -->

## 2. 新建门面与分发层改造 (Create Facade & Refactor Dispatcher)

- [x] 2.1 新建 `src/interface/facade.ts`，创建 `CliFacade` 类作为主控制器，组合 `InputListener`、`WidgetRenderer` 与 `CommandDispatcher`。重新实现对大脑层事件订阅渲染和 Token 回显面板输出的控制逻辑，实现对外部导出的统一门面。
- [x] 2.2 修改 `src/interface/command.ts` 中关于命令路由分发的逻辑。当交互式菜单（如 `@clack/prompts`）弹出时，通过门面回调调用 `InputListener.pause()` 挂起输入，退出菜单或指令执行完毕后，调用 `InputListener.resume()` 重获控制台输入焦点，避免输入冲突。

<!-- checkpoint: npm run build -->

## 3. 系统启动适配与全量质量校验 (Interface Adaptation & Quality Verification)

- [x] 3.1 改造 `src/interface/cli.ts` 文件，移除其内的具体业务代码，仅作为轻量级门面代理层，将 `startCli`、`redrawHistory` 和 `renderContentWithWidgets` 对外导出接口委托给对应的 `CliFacade` 与 `WidgetRenderer`，确保 `src/index.ts` 启动端及测试端无缝兼容。
- [x] 3.2 运行项目的静态规则校验 `npm run lint` 和全量单元测试 `npm run test`，审查重构后的大脑层流式会话和 UI 交互的稳定性与合规性。

<!-- checkpoint: npm run test -->
