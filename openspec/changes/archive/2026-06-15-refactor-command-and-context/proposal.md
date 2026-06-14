# 提案: 深度解耦上帝路由器与过载上下文 (refactor-command-and-context)

## 1. 背景与痛点 (Motivation)
在 `internal-refactor-v1` 阶段，我们成功剥离了 `SessionManager` 的强耦合逻辑，解救了整个 Agent 侧的运行流。但在 UI 交互层与存储层，依然残留了两个体积超过 300 行的“大块头”：
1. **上帝路由器 `src/interface/command.ts` (375 行)**：
   目前所有的 `/` Slash 命令（如 `/model`, `/mcp`, `/history`, `/rollback` 等）全都在 `command.ts` 内通过巨型的 `switch-case` 并在同一个文件内编写具体实现。这种发散式的设计违背了开闭原则（OCP），每增加一个新指令，都要修改这个庞大的文件。
2. **重度上下文 `src/brain/context.ts` (353 行)**：
   `SessionContext` 本应只作为纯粹的数据模型（维护对话历史与 ID），但它内部却揉合了大量的 Token 消耗估算（`estimateSnapshotTokens`）、水位计算等复杂的算法逻辑，导致其变得异常臃肿。

## 2. 核心目标 (Goals)
- **命令模式化**：对 `command.ts` 实施 Command Pattern 重构，将不同指令分散到独立的模块文件中，实现系统级指令的“热拔插”。
- **模型提纯**：将 `context.ts` 中的算法计算部分剥离为独立的 `TokenEstimator`，让 `SessionContext` 回归充血模型的本质。
- **平滑过渡**：重构后的行为对上层用户必须完全透明，且不能破坏终端中异步渲染的光标拦截流。

## 3. 非目标 (Non-Goals)
- 本次变更不修改 `cli.ts` 内部基于 `readline` 的交互式读写循环。
- 不引入任何新的 Slash 命令，仅是对现存指令进行物理位置重组。
