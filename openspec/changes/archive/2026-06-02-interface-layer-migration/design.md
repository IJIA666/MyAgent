## 背景

在顺利完成了 `action` 层和 `brain` 层的抽离后，我们迎来了模块化架构的最后一块拼图：交互边界（Interface）和系统启动层（Boot）的分离。目前的 `index.ts` 文件承载了太多职责，它不仅要处理环境初始化、依赖装配，还要负责 `readline` 的绑定、ANSI 颜色的渲染以及大模型事件流的订阅，严重违背了单一职责原则。

## 目标与非目标

**目标:**
- 将所有的终端输入/输出处理逻辑彻底收拢在 `src/interface/`。
- 将已有的 `command.ts` 同步纳入 `interface` 层管理。
- 将 `src/index.ts` 缩减为纯粹的依赖装配容器（Bootstrapper）。

**非目标:**
- 不改变现存的终端 UI 展现样式或彩色输出效果。
- 暂不引入其他的重量级 CLI 框架，继续沿用现有的 `readline` 和 `@clack/prompts`。

## 架构决策

- **分离交互（Interface）与组装（Boot）**: `src/index.ts` 不再持有任何 UI 相关的闭包状态。它仅负责在顶层实例化核心组件（`SessionManager` 和 `McpToolManager`），然后将 `SessionManager` 实例作为依赖项传递给 `src/interface/` 提供的启动函数（如 `startCli(session)`）。这确保了交互层只关心展示，而不需要知道底层组件是如何被初始化的。

## 风险与权衡

- **事件流迁移风险**: 原 `index.ts` 中的核心逻辑是迭代消费 `session.chat()` 产生的异步事件流并打印到屏幕。在物理搬迁这些代码时，需要确保退出机制（`SIGINT` 中断拦截）、死锁防护和全屏错误清空等边缘情况的代码完好无损地迁移至 `cli.ts`。
