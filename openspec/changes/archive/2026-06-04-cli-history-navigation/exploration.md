# CLI 终端命令历史切换探索 (Exploration)

## 1. 需求澄清
用户希望在终端交互界面中，能够像使用原生 Shell 一样，通过**上下方向键（Up/Down Arrow Keys）**快捷切换并回溯之前输入过的历史命令或对话。

## 2. 现有代码库分析
当前系统的 CLI 是在 `src/interface/cli.ts` 中基于 Node.js 原生的 `readline` 模块构建的：

```typescript
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: completer
    });
```

### 为什么现在上下键不好使？
实际上，Node.js 原生的 `readline` 模块是**自带**方向键历史记录功能的。但我们在代码中存在一个关键的“状态丢失”缺陷：

在处理形如 `/skill`、`/mcp` 等 Slash Command 时，由于需要将 `stdin` 流转交给子命令（比如有些交互式命令可能需要接管终端），我们执行了：
```typescript
      if (input.startsWith('/')) {
        // 彻底关闭并解绑原有的 readline 监听
        rl.close();
        try {
          await dispatchCommand(input, { session, rl });
        } finally {
          // 重新初始化 REPL 界面
          initRl();
        }
      }
```
**根因：** 每次遇到 `/` 命令，我们都会销毁当前的 `rl` 实例并重新 `createInterface`。而原有的命令历史记录（存储在 `rl.history` 中）随着实例的销毁被**彻底清空**了。因此导致上下键在执行完命令后失效，无法追溯之前的输入。

## 3. 解决方案设计探究
要实现跨越 `rl` 实例生命周期的历史记录，我们需要将历史状态“提升”到外部维护。

### 方案 A：外部维护 history 数组并透传（推荐）
在 `cli.ts` 模块顶层（或 `startCli` 闭包内）维护一个 `const commandHistory: string[] = []` 数组。
根据 Node.js 官方文档（>= v15.8.0），`createInterface` 支持传入 `history` 参数，用以初始化初始历史记录。
```typescript
    const commandHistory: string[] = [];
    
    // ... 在 initRl 内部：
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: completer,
      history: commandHistory // 将历史状态与外部绑定
    });
```
由于传递的是数组的引用，`readline` 内部在新增历史命令时，会直接 `push` 到这个 `commandHistory` 中。当旧的 `rl` 被 close，新的 `rl` 被 create 时，依然挂载这同一个数组引用，从而实现**命令历史的跨生命周期无缝继承**。

### 方案 B：全局持久化（高级增强）
除了内存跨实例保留，还可以考虑在 `session.ts` 退出时或运行时，将 `commandHistory` 持久化到 `.myagent/sessions/history.log`，这样哪怕重启应用，之前的命令也能用上下键找回来（类似于 bash 的 `.bash_history`）。

## 4. 结论与下一步建议
这是一个完全可行且成本很低的优化需求。只需要修改 `src/interface/cli.ts` 中的几行代码，引入外部数组维持 `history` 状态即可。

无需大规模重构，也没有第三方依赖风险。我们可以直接进入 `/openspec-apply` 或 `/openspec-propose` 环节进行实现。
