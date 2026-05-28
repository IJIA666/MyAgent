## 改造原因

为了能够在本地搭建一个低成本、高透明度且安全可控的 AI 智能体（Agent）试验载体。通过使用纯粹的 TypeScript (Node.js) 原生开发，不仅可以深度学习并掌握 Agent 的多轮会话状态管理与现代 Tools 工具调用（Parallel Tool Calling）的底层通信细节，还能为后续构建更加复杂的自主代码协作工具奠定安全沙箱与高可用交互的技术根基。

## 变更内容

- **构建 TypeScript 开发及免编译执行环境**：配置符合现代规范的 Node.js 项目脚手架，集成 `tsx` 免编译执行工具及 `typescript` 编译器。
- **构建内存级连续对话会话管理器**：实现基于内存的 ChatCompletion 历史消息队列管理，支持上下文的自动累积，并直接对接兼容 OpenAI 格式的 DeepSeek 官方 API 端点。
- **构建高度安全的受限文件操作 Tools 处理器**：实现符合现代 Tools 协议（`type: "function"`）的本地函数集，提供 `readFile`（读取文件）、`writeFile`（写入文件）、`listFiles`（列出文件）三大工具。内部引入强路径沙箱拦截器，强制进行绝对路径规范化校验，严格防范任意路径遍历（Path Traversal）隐患。
- **构建交互式终端 REPL 交互循环**：利用 Node.js 官方 `readline` 模块，提供具备精美回显的命令行连续对话流。
- **支持模型与配置的动态无缝切换**：引入 `dotenv` 加密加载机制，支持通过 `.env` 或 `config.json` 动态切换调用的具体模型（如 `deepseek-chat` 等）及端点。

## 业务能力

### 新增业务能力

- `simple-agent-core`: 提供极简 TypeScript 授权文件操作 Agent 的会话管理、受限 Tools 工具调用拦截以及命令行交互的核心业务能力。

### 修改业务能力

### 影响范围

- 本项目为一个全新创建的轻量级 Agent 模块，所有的代码、依赖、配置文件均严格限定在工作区 `d:\projects\MyAgent` 内，对外部操作系统环境及其他项目无侵入。
- 依赖于用户在 `.env` 中安全配置的 `DEEPSEEK_API_KEY` 凭证与目标 `DEEPSEEK_API_URL` 地址。
