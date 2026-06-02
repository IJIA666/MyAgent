## 改造原因

作为大型重构项目 `modular-architecture` 的最后收尾阶段（Phase 3），我们需要建立清晰的用户交互边界。当前终端命令分发逻辑（`command.ts`）和 REPL 交互循环逻辑（混杂在 `index.ts` 中）没有实现与启动逻辑的解耦。这会导致如果未来我们需要为这个 Agent 接入新的交互终端（如 WebUI 或桌面端 GUI），启动脚本将被终端 UI 代码深度绑定而难以复用。将其抽离至 `src/interface/` 是建立多模态/多端 Agent 的必经之路。

## 变更内容

- 建立 `src/interface/` 顶层目录。
- 迁移终端命令解析逻辑：将 `src/command.ts` 移动至 `src/interface/command.ts`。
- 抽离终端 REPL 会话逻辑：在 `src/interface/cli.ts` 中封装现有的 `readline` 交互、终端 ANSI 颜色打印与模型事件流订阅渲染逻辑。
- 净化启动入口：重构 `src/index.ts`，剥离所有的命令行展示细节，使其单纯负责配置加载、组件依赖注入，并在最后作为入口调用 `startCli()`。
- 新增 `src/interface/index.ts` 门面文件。

## 业务能力

### 新增业务能力
无。本次为架构边界划分。

### 修改业务能力
无。用户的终端命令交互体验和提示符（Prompt）表现将与原来完全一致。

## 影响范围

- 物理目录结构的新增（`src/interface/`）。
- 启动文件 `src/index.ts` 将被大幅度重构精简。
