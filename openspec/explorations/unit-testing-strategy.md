# 探索主题: 智能体系统单元测试策略

## 1. 问题定义
由于智能体系统深度依赖外部大语言模型接口与 Model Context Protocol (MCP) 服务等外部进程或网络通信，为了保障核心逻辑（包含沙箱防御、工具分发以及上下文管理）在后续持续迭代中的正确性与稳定性，亟需为系统设计并落地完善的单元测试策略。当前的主要痛点在于外部依赖难以进行有效的隔离与模拟（Mock），且项目当前尚无成熟的测试运行配置与断言管理机制。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 项目为纯 TypeScript + ESM (`"type": "module"`) 架构。
  - 目前的 `package.json` 中没有配置任何测试命令，缺少 `scripts.test` 脚本。
  - 核心的 `src/action/mcp-client.ts`、`src/brain/driver.ts` 等模块与外部 SDK (`@modelcontextprotocol/sdk`、`openai`) 强耦合，这导致编写测试时必须模拟外部的进程生命周期与大语言模型网络请求。

- **对 Agents 目录下 7 个开源/参考项目的源码级调研**：
  我们深入查阅了 `d:\Projects\Agents` 目录下的 7 个参考项目，其测试技术栈与策略归纳如下：
  1. **`gemini-cli` (Google 官方开发 CLI Agent)**：
     - **技术栈**：重度采用 **Vitest** 框架。
     - **测试维度**：涵盖脚本逻辑单元测试（`vitest run`）、沙箱边界集成测试（`test:integration:sandbox` 针对 Docker/Podman/None 容器沙箱边界进行对比验证）、内存测试（`test:memory`）、性能测试（`test:perf`）及大模型评估（`test:always_passing_evals`）。
     - **架构对照**：其沙箱边界测试通过环境变量 `GEMINI_SANDBOX` 切换测试容器，这为我们项目的本地文件沙箱安全边界验证（`secureResolvePath`）提供了自动化矩阵测试的设计参考。
  2. **`openclaw` (开源桌面编程 Agent)**：
     - **技术栈**：采用 **Vitest** 框架。在根目录下使用 `vitest.config.ts` 结合项目矩阵（Vitest Workspace）对多模块及插件扩展进行快速并行测试。
  3. **`codex` (OpenAI 编程 Agent Monorepo)**：
     - **技术栈**：其核心 TypeScript SDK (`@openai/codex-sdk`) 采用 **Jest** (结合 `ts-jest` 与 `ts-node`)，配合 `jest.config.cjs` 进行标准的单元测试及覆盖率统计（`jest --coverage`）。
  4. **`hermes-agent` (Nous Research 开源自进化 Agent)**：
     - **技术栈**：Python 架构项目，使用 **uv** 作为包管理工具，测试驱动使用 **`pytest`**（引入了 `pytest-asyncio` 用于异步测试，`pytest-timeout` 规定 30 秒超时强制退出以防长轮询卡死）。
     - **测试隔离**：将单元测试与集成测试严格物理分离。使用 `@pytest.mark.integration` 标记外部 API 依赖，默认测试排除了这些用例，以确保单元测试在本地的秒级完成与纯离线运行。
     - **架构对照**：其动态技能加载（`skills` 和 `plugins`）在测试中通过局部代理注入进行组件隔离，测试其在加载过程中的依赖自解耦。
  5. **`opencode` (AI 辅助开发工具 Monorepo)**：
     - **技术栈**：采用 **Bun** 运行时与包管理器，其核心包（如 `@opencode-ai/core`）内置并采用 **`bun test`** 运行器执行秒级单元测试，高层级的 E2E 界面测试则采用 **Playwright**。
  6. **`claude-code` (Anthropic 官方 CLI Agent)**：
     - **代码分析**：该副本包含纯核心业务源码。其上下文衍生与缓存共享（Fork Subagent 机制）在设计上对上下文适配器进行了强约束，通过在消息末尾注入差异化专属指令来共享同一历史缓存树。
  7. **`tinypace-ai-desktop` (桌面智能体 Electron 客户端)**：
     - **代码分析**：该项目偏向于 Electron UI 与端侧打包发布，未在 `package.json` 中配置任何自动化单元测试框架或测试脚本。

- **业界主流实践调研与工程共识**：
  - **测试运行框架**：在 Node.js/TypeScript (ESM) 的智能体开发生态中，**Vitest** 已成为新一代项目的首选推荐（如 LangChain Node.js 以及本项目中的 `gemini-cli`、`openclaw`），而 **Jest** 则常在已有成熟项目中使用。
  - **MCP 通信测试**：`@modelcontextprotocol/sdk` 官方推荐使用内建的 **`InMemoryTransport`（内存传输通道）**。该通道允许在同一个 Node.js 进程中直接将 Client 实例与 Server 实例进行内存级绑定，完全绕过了物理 Stdio 子进程的启动和 JSON-RPC 的管道传输，从而实现了 100% 确定性的单元测试。
  - **关于单元测试提交 Git 的工程共识**：所有的单元测试源码必须提交至 Git 仓库中。单元测试充当了“活的接口规范文档”，并且是 CI/CD 流水线执行自动化门禁的必要输入。
  - **测试覆盖策略 (Value-Driven vs 100% Coverage)**：软件工程界已达成高度共识，**盲目追求 100% 代码覆盖率是一种反模式（Anti-Pattern）**（即 Goodhart 定律的体现：当指标变成目标时，它就失去了度量价值）。提升最后 20% 的覆盖率往往需要编写极其脆弱的 Mock 桩代码，耗费大量工时却对质量提升毫无帮助。更有甚者，过高、过细的覆盖度会导致测试与内部实现代码发生强耦合（测试脆弱性），从而阻碍系统后续的重构工作。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (Node.js 原生 `node:test` + `tsx`) | 方案 B (Vitest) | 选型分析 |
| :--- | :--- | :--- | :--- |
| **外部依赖** | 零额外安装包（依赖 Node.js 内置环境） ✓ | 需安装 `vitest` 及其相关开发依赖 ✗ | 方案 A 占优 |
| **TypeScript 支持** | 需借助 `tsx` 预加载执行（在 package.json 脚本中配置） | 原生开箱即用支持（内置 esbuild 转换） ✓ | 方案 B 占优 |
| **Mocking 能力** | 支持对象方法 Mock；**无法方便地实现 ESM 模块级 Mock** ✗ | 拥有极强的模块级 Mock (`vi.mock`) 与函数 Mock ✓ | 方案 B 占优 |
| **开发体验** | 拥有基础 of `--watch` 监听模式 | 极速热更新、丰富的错误堆栈以及可视化 UI 界面 ✓ | 方案 B 占优 |
| **参考项目采用率**| `opencode` (采用 Bun Test) / `tinypace` (无测试) | `gemini-cli` / `openclaw` 等主流大型 TS 库均采用 ✓ | 方案 B 占优 |

**推荐路径**：
推荐使用 **方案 B (Vitest)** 作为项目的主要单元测试框架。
**选择理由**：智能体系统的核心行为均深度依赖外部的第三方 SDK 交互（如 MCP 连接通信及 LLM 会话接口）。Vitest 的 `vi.mock` 支持在 ESM 环境下对这些第三方包进行非侵入式替换，能以极低的代码改造代价实现对关键通信接口的完整 Mock，极大地提高测试编写效率。
**覆盖原则**：确立“**价值驱动、重点突破**”的覆盖策略，拒绝以 100% 覆盖率作为行政指令。应将核心精力锁定于沙箱防逃逸安全边界（`tools.ts`）与进程生命周期防泄漏和重名路由阻断（`mcp-client.ts`）等逻辑复杂、安全风险高的核心枢纽，而非无差别覆盖纯配置加载或琐碎的数据传输结构。

## 4. 约束、风险与未知项
- **依赖体积增加**：引入 Vitest 会在开发环境引入几十兆的额外 node_modules 依赖。
- **异步流式测试**：核心会话使用了 Node.js 异步生成器（`AsyncGenerator`），测试断言需要妥善处理异步事件流的迭代判定。

## 5. 否决方案
- **Node.js 原生测试 `node:test` 方案**：予以否决。虽然能实现零依赖，但在 Mock 像 `@modelcontextprotocol/sdk` 这类没有以类实例对象形式暴露出的复杂外部模块时，编写桩代码（stub）和适配层的开发与维护成本过于高昂。
