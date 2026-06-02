## 改造原因

当前系统存在两个阻碍开发连续性与使用效率的核心痛点：第一，会话状态完全驻留在内存中，应用一旦重启便彻底丢失全部记忆；第二，交互终端中的斜杠命令强制要求拼写全称，缺乏补全机制，心智与按键负担重。为应对日益长期伴随式的开发诉求，必须在保持内核纯净的同时提升 CLI 的生产力体验。

## 变更内容

- 引入“纯手动显式恢复（Explicit Resume）”的时间线穿越机制：每次启动仍保持 100% 干净初态以防脏读，仅通过新增的 `/history` 和 `/resume <id>` 命令主动干预记忆。
- 在每个回合交互结束后，将会话上下文（messageHistory）静默序列化并落盘至 `.myagent/sessions/<sessionId>.json`。
- 集成 Node.js 原生的 `readline` 补全器（Completer），在完全不引入外置重型 UI 框架的前提下，支持使用 `<Tab>` 键对所有斜杠命令进行极简、安全的前缀自动补全。

## 业务能力

### 新增业务能力
- `session-persistence`: 提供基于工作区目录的 JSON 格式单会话状态持久化与反序列化加载。
- `cli-autocomplete`: 基于 readline 内置机制的斜杠命令补全。

### 修改业务能力

## 影响范围

- `src/brain/session.ts`（新增 `saveState`, `loadState` 及 `sessionId` 维护逻辑）
- `src/interface/command.ts`（新增 `/history` 和 `/resume` 指令分发与执行逻辑）
- `src/interface/cli.ts`（挂载 `completer` 配置选项）
