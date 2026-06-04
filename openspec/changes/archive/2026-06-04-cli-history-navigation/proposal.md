# Proposal: CLI 终端历史记录跨实例保留

## 1. 背景与问题点 (Background)
在现有的 `src/interface/cli.ts` 设计中，为了能够将终端输入权移交给诸如 `/skill` 等系统命令，我们在遇到斜杠命令时，会主动调用 `rl.close()` 销毁当前的 `readline` 实例，并在命令结束后重新 `createInterface()`。
这种高频销毁重建的架构导致了 Node.js 原生的 `history`（命令记忆）数组丢失。用户无法通过键盘的“上/下方向键”去翻找之前输入过的话，极大地影响了连续交互的心流体验。

## 2. 目标 (Goals)
- **无缝衔接**：在当前 Node.js 进程存活期间，确保所有的输入记录（包括普通对话和 `/` 命令）都能被保留。
- **低成本修复**：最大程度复用 Node.js 自身的 `readline` 原生方向键逻辑，避免手动实现按键拦截器。

## 3. 非目标 (Non-Goals)
- **跨重启持久化**：本阶段只实现单次进程（单次启动应用）的内存级别记忆，暂不实现类似 `.bash_history` 的磁盘文件持久化存储。

## 4. 推荐方案 (Proposed Solution)
采用“状态提升（State Hoisting）”策略：
在 `startCli` 的外层作用域定义一个常量数组 `commandHistory`。每次调用 `initRl()` 创建 `readline` 实例时，利用 Node.js v15+ 提供的 `history` 配置项，将该数组以引用形式透传给原生模块。由底层原生模块负责管理推入和翻找，而我们仅提供持久的外部存储载体。

## 5. 替代方案考量 (Alternatives Considered)
- *拦截键盘按键强行接管*：需要引入 `keypress` 事件和光标操作库来模拟原生历史回填，代码复杂度极高且容易产生换行或光标乱跳的 Bug。被否决。
