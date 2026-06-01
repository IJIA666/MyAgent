## 改造原因

当前的终端命令行交互基于原生的 `readline`，交互体验过于简陋。特别是在动态模型切换（`/model`）等场景下，缺乏直观的状态反馈、持久化保存机制，以及思考等级等运行时参数的动态调整能力。为了在保持底层 Agent 引擎干净解耦的前提下大幅提升测试交互质感，我们需要引入轻量级的 TUI 向导（`@clack/prompts`）进行表面改造。

## 变更内容

- 引入 `@clack/prompts`，在 `/model` 指令触发时暂停对话，显示交互式模型选择菜单。
- 增加终端动态 Prompt 功能，使得提示符能够实时反映当前选中的模型状态（如 `用户 [deepseek-v4-pro] >`）。
- 新增持久化工具模块 `src/utils/env.ts`，利用正则表达式实现对 `.env` 配置的安全回写（无损保留注释，涵盖模型名称及思考等级）。
- 改造模型字典的配置逻辑，严格遵循 DeepSeek 官方 API 标准（`thinking` 嵌套对象），使 `buildExtraPayload` 接收运行时参数联动向导。

## 业务能力

### 新增业务能力
无。本次改动主要为现有业务能力套上交互外观。

### 修改业务能力
- `simple-agent-core`: 扩展 REPL 的表现力，允许动态更改命令行提示符 (Prompt)。
- `dynamic-model-selection`: 模型切换命令不再要求手动敲全名，转为调用交互式向导，同时支持接收额外上下文以配置模型特定参数（思考等级）。
- `config-management`: 环境变量配置机制从只读升级为“带结构保护的读写”，支持将运行时的默认模型设置持久化回 `.env`。

## 影响范围

- 增加三方依赖 `@clack/prompts`。
- 修改 `src/index.ts`（支持动态 Prompt 暴露及流的暂停控制）。
- 修改 `src/command.ts`（接入 `@clack/prompts` 的向导逻辑）。
- 修改 `src/config.ts` 和 `src/session.ts`（支持 payload 的参数透传）。
- 新增 `src/utils/env.ts`。
