# 探索主题: 模块化顶层架构重构

## 1. 问题定义
随着代码规模的增长，当前项目 `src/` 根目录下的文件呈现出杂乱散落的状态（如 `session.ts`, `command.ts`, `mcp-client.ts`, `virtual-mcp.ts`, `tools.ts` 等），职责边界（如 UI 交互、工具执行、大模型调度）相互纠缠。为了保障后续代码的可维护性，并贴合“学习与实践 Agent”的初衷，系统急需确立一套高度内聚的模块化目录（Package）规范。

## 2. 关键发现与调研结果
通过对本地 `D:\projects\Agents` 目录下的四大主流 Agent 项目的深度源码调研，发现了三种不同的架构模式：

- **OpenClaw (完美验证 Agent 认知架构)**：
  在其 `src/` 目录下，直接采用了强烈的认知隐喻来进行模块划分：`llm/`（大脑接口）、`memory/` 与 `trajectory/`（记忆与轨迹）、`tools/` 与 `skills/`（手脚能力）、`channels/` 与 `gateway/`（外部交互通道）。这种拆分方式极具学术和实践价值。
- **Hermes-Agent (混合分层模型)**：
  将核心引擎封闭在 `agent/` 目录，将外部接入放在 `gateway/`，将厂商底层 API 封装在 `providers/`，这是最典型的内核-外设隔离设计。
- **Claude-Code (特性驱动模式)**：
  更偏向前端和组件化，存在 `commands/`、`screens/`、`tools/`、`memdir/`、`skills/`，按特定功能块平行铺开，适合庞大且零碎的命令行交互式应用。
- **Tinypace-AI-Desktop (重型服务网关模式)**：
  Electron 侧几乎清一色放置在 `services/` 目录（如 `AIChatService`, `MCPServerManager` 等），采用类似后端微服务的 Service Manager 模式。

**核心洞察**：
对于一个旨在学习 Agent 的项目，**OpenClaw** 的架构分层对我们最有启发。摒弃传统的 `services/` 或扁平化目录，直接映射 AI 的认知体系（大脑、躯干、感官）能够让我们在编写每一行代码时，都明确它在 Agent 整体生态中的定位。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：传统职责层 (`core/`, `tools/`, `cli/`) | 方案 B：Agent 认知架构 (`brain/`, `action/`, `interface/`) | 方案 C：服务网关层 (`services/`) |
| :--- | :--- | :--- | :--- |
| **直观性与重构成本** | **极佳 ✓**（无脑迁移） | 良好（需要明确重新界定业务概念） | 差（需引入依赖倒置与庞大的 Service Manager） |
| **学习与学术对齐度** | 一般（传统的 MVC/Node 惯性） | **极佳 ✓**（完美契合项目“学习 Agent 技术”初衷） | 差（偏向传统分布式后端的惯性思维） |
| **长远扩展性** | 良好 | **极佳 ✓**（未来接入记忆引擎、长期规划模块时有明确的坑位 `memory/`, `planning/`） | 一般 |

**推荐路径**：
**方案 B（Agent 认知架构模式）**。
参考 OpenClaw 的实践，我们将采用如下顶层分包：
1. `src/brain/`（核心引擎）：存放 `session.ts` 等直接与大模型流转、解析相关的逻辑。
2. `src/action/` 或 `src/tools/`（执行组件）：存放 `mcp-client.ts`, `virtual-mcp.ts`, `toolRegistry.ts` 等充当 Agent 手脚的功能。
3. `src/interface/` 或 `src/cli/`（交互边界）：存放 `command.ts`, `index.ts`（引导层）等直接面向人类用户的输入输出模块。

## 4. 约束、风险与未知项
- **模块间的循环依赖**：在迁移文件时，如果不小心，`brain` 层可能会逆向依赖 `interface` 层。必须在拆分时严格遵守从外向内（`interface` -> `brain` -> `action`）或者单向总线的数据流规范。
- **入口位置**：`index.ts` 既是 `cli` 的启动点也是全局单例组装区，应当属于 `boot` 层或留在最外层，而不是强行塞入某个特定子域中。
- **对长周期闭环任务的支持度顾虑**：将思考 (`brain`) 与执行 (`action`) 物理分离，不仅不会限制未来演进为长时间驻留后台的闭环体（如 Hermes），反而因为底层基建工具调用的硬核逻辑被收敛在 `action` 层，使得 `brain` 层可以非常轻量且纯粹地演进出异步状态机引擎 (`state-machine`) 或长期任务队列 (`task-loop`)。物理模块划分不锁定运行时范式。

## 5. 否决方案
- **Tinypace 的重型服务化架构 (`services/`)**：对于非分布式的纯本地进程化 Agent，过度封装 Service 会导致状态满天飞，降低开发效率，已被否决。
