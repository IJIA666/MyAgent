## 改造原因

现有 `src/interface/cli.ts` 源码长度达 424 行，在单一文件中杂糅了大量的异质职责：它既强依赖 `readline` 模块监听终端键盘按键（包含双击 ESC 中断/回退操作）进行 `REPL` 输入管理，又依赖 `@clack/prompts` 渲染高级交互菜单，同时还在内部深度耦合了大量的控制台彩化输出排版、ANSI 转义和 Token 监控面板渲染等视图细节。这导致用户界面层（UI）的展现逻辑与交互控制流、底层的输入捕获以及命令分发路由交织在一起，极大增加了代码的复杂度，降低了控制台界面的独立可测性和后续交互能力的扩展弹性。

为了提高用户界面层的模块正交性与清晰度，我们需要对 `cli.ts` 进行一次深度的职责剥离，将输入捕捉、命令分发与视图渲染解耦，使其成为职责单一的原子化模块，并以门面模式统一承接对外的交互。

## 变更内容

1. **引入门面模式**：引入 `CliFacade` 作为终端用户界面的核心协调层，将原有的 `startCli` 作为 Facade 门面方法保留，外层装配层可零感集成。
2. **输入与输出解耦**：
   - 提取 `InputListener` 类负责 `readline` 实例的生命周期维护、`stdin` 按键监听捕获（包括 Ctrl+C、双击 ESC、退出等按键拦截）以及向 Facade 传递输入事件流。
   - 提取 `WidgetRenderer`（或 `Renderer`）专门处理控制台彩化输出、卡片折叠微件解析以及 Token 监控面板格式化输出逻辑。
3. **命令路由分发**：将交互菜单 `showInteractiveMenu` 与 `/` 路由逻辑分发抽离，由 `CommandDispatcher` 进行斜杠命令解析及执行协调，并合理进行 `readline` 句柄控制权的挂起与复位。
4. **保持接口向前兼容**：大脑层 `SessionManager` 与界面层的交互契约，以及 `src/index.ts` 启动调用签名完全保持不变。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

- 物理文件结构调整：
  - 新增 `src/interface/facade.ts` 文件。
  - 新增 `src/interface/io/input-listener.ts` 文件。
  - 新增 `src/interface/views/widget-renderer.ts` 文件。
  - 修改 `src/interface/cli.ts` 为轻量门面转发或平替。
  - 修改 `src/interface/command.ts` 中的调用依赖。
- 外层启动文件 `src/index.ts` 的调用契约保持 100% 兼容。
