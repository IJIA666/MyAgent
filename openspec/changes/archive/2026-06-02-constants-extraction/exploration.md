# 探索主题: 硬编码常量剥离与 Prompt 引擎化

## 1. 问题定义
当前系统的 `SessionManager` 中存在大段硬编码的 `systemPrompt`，且 `cli.ts` 与 `command.ts` 存在重复的 `COLOR_*` ANSI 样式常量。
虽然目前能正常工作，但随着 Agent 向复杂化演进，我们需要支持工具的动态上下文注入、外接记忆存储、以及多端 UI 的适配。这些硬编码会成为未来架构迭代的瓶颈。

## 2. 关键发现：四大主流 Agent 横向对比

通过对 `Claude-Code`、`Hermes-Agent`、`OpenClaw` 和 `Tinypace-AI-Desktop` 四个业界标杆项目的源码追溯，我们发现它们都不约而同地抛弃了单纯的“硬编码 Prompt”与“硬编码样式”，并各自演化出了适应其场景的高维架构：

| 项目名称 | 核心定位 | 提示词 (Prompt) 构建机制 | 界面样式 (UI Style) 分离策略 |
| :--- | :--- | :--- | :--- |
| **Hermes-Agent** | Python 闭环能力体 | **三层缓存引擎** (`prompt_builder.py`)：将 Prompt 严格划分为稳定层（人设/工具基准）、上下文层（工作区约束）与易变层（短期记忆），极致优化了 LLM 的 Prefix Cache（前置缓存命中率）。 | 采用了专业的终端渲染流控制，将输出管理集中于 `display.py`，业务代码逻辑完全被屏蔽了色彩等终端表现层细节。 |
| **OpenClaw** | 常驻后台多端网关 | **上下文引擎** (`src/context-engine/`)：不存在写死的文本块，通过底层的 `registry` (注册表) 与 `delegate` (委派) 设计模式，在每一轮运行时动态拼装外部插件能力与全局会话状态。 | **无头化 (Headless)**：系统自身作为 Daemon 运行剥离了原生 UI，完全依赖 `src/channels/` 将大模型的纯元数据流转为分发给不同 IM 平台（如 Slack）的标准化结构。 |
| **Claude-Code** | 官方重型 TUI 终端 | **流式查询引擎** (`src/QueryEngine.ts`)：在长周期的循环状态机中，实现自动化阶段性目标与多轮次微调 Prompt 的自动交织注入。 | **全量视觉抽离**：利用 `React Ink` 框架将控制台变为组件树，所有的终端色彩与排版规范被统一收拢并封锁在 `src/outputStyles/` 目录中。 |
| **Tinypace** | 桌面原生客户端 | **异步双端注入**：Node.js 主进程负责采集庞杂的系统级软硬件上下文，通过 WebSocket 源源不断地把最新状态流（State Flow）推给作为后脑的独立 Python 子进程完成编排。 | **极致物理隔离**：样式、动效统统交给了 Electron 的 React 渲染进程独立把控。系统的中央调度与大模型流转完全是一堆纯净的 JSON 数据。 |

**核心共识洞察**：
1. **Prompt 正在从静态文本变为计算图**：一个能够应对工业级场景的 Agent，绝不仅仅是塞一段“你是一个专业助手”。它的 Prompt 是一个复杂的工厂模块，需要动态挂载工具集元数据、当前报错信息的注入回溯以及外部工作区环境的实时投射。
2. **UI 隔离是基础防腐规范**：无论是使用专门的样式配置夹（如 Claude-Code）还是完全进程分离（如 Tinypace），ANSI 代码都不应该再暴露并散落在如 `cli.ts` 甚至是 `command.ts` 这样的业务路由血管之中。

## 3. 方案设计与推荐方向

### 方案 A：系统样式分离 (Theme Layer)
将所有用于控制台渲染的 ANSI 常量抽离为一个独立的接口层样式系统。
**推荐路径**：创建 `src/interface/theme.ts`，导出标准化的颜色常量或包裹函数。杜绝底层业务逻辑（如 `SessionManager`）与渲染端耦合。

### 方案 B：上下文引擎化 (Context Engine / Prompt Builder)
打破静态 Prompt，引入动态构建机制。
**推荐路径**：
1. **身份基座外置化**：将 Agent 的基础准则（如安全沙箱限制、中文要求）剥离为 `src/brain/prompts.ts` 或外部 `.md` 模板。
2. **构建器模式**：在 `SessionManager` 中引入 `ContextBuilder` 概念，支持按照层级（稳定层、环境上下文层、易变层）动态组装 System Prompt，为将来接入 MCP 工具链状态监控与历史记忆压缩预留插槽。

## 4. 约束与下一步
- **风险**：不要过度设计，当前只需实现基础的 `PromptBuilder` 骨架与基座文本的外挂化，暂时不引入太复杂的缓存机制（如 Anthropic Prompt Caching），等未来 Token 量上去后再行迭代。

**结论**：方案已明确。可以直接通过提出一个新的 change 提案来落地这一机制。
