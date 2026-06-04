# Design: 终端状态提升架构设计

## 1. 核心架构变更

### 1.1 模块作用域变更
在 `src/interface/cli.ts` 的 `startCli` 函数内部最顶层，声明一个用于全生命周期承载终端记忆的数组：
```typescript
const commandHistory: string[] = [];
```
将其放置在 `startCli` 中而不是全局模块顶部的目的是：保证未来如果需要重置整个应用状态或并发实例化时，记忆域是相互隔离且可控的。

### 1.2 注入点设计
在 `initRl` 内部的实例化函数中：
```typescript
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: completer,
      history: commandHistory // [NEW] 注入外部状态
    });
```
由于传递的是同一数组实例的引用，因此旧 `rl` 实例产生的修改（用户输入新命令），对新 `rl` 实例依然可见且有效。

## 2. 依赖项及兼容性
- **底层依赖**：该特性依赖 Node.js `>= v15.8.0` 版本新增的 `history` 参数。考虑到当前主流及工程的运行环境通常已是 Node 18/20，无向下兼容风险。

## 3. 边界处理
- 空输入或过短命令（只敲回车等）：Node.js 底层的 `readline` 默认具备过滤空内容的逻辑，我们无需进行去重或清洗拦截。
- 并发销毁：在我们的命令系统架构中，`rl.close()` 严格遵循串行等待（`await dispatchCommand`），不存在竞争写入条件。
