# IJIA Agent (极简受控智能体)

一个基于 TypeScript 的极简 Agent 系统，具备沙箱化本地文件工具、扩展 MCP 协议客户端以及 REPL 终端会话管理能力。

本项目不仅是一个可运行的智能体，更是探索 **Harness + Skill**（约束框架 + 可插拔技能）前沿工程范式的实践平台。

---

## 💡 核心设计思想：Harness + Skill 范式

在 Agent 的工程化落地中，本项目摒弃了 LangChain/LangGraph 等预设死流程图的重型框架，采用了更具灵活性与可控性平衡的 **Harness + Skill** 范式。

### 1. Harness (约束框架/安全缰绳)
Harness 负责为大模型设定清晰、可执行的“行为边界与安全规则”，让大模型在清晰边界内自主决策，而非无序自由发挥，主要包含：
*   **最大迭代次数限制**：在 [session.ts](src/brain/session.ts) 中对 ReAct 推理循环设置了硬性最大轮数上限（默认 10 轮），防止模型在处理复杂或模糊任务时陷入无限工具调用的死循环，控制 Token 消耗。
*   **沙箱文件路径强隔离**：在 [tools.ts](src/action/tools.ts) 的本地文件读写工具中强制引入 `secureResolvePath` 校验。所有相对路径操作都必须被局限在授权的工作区根目录下，从根本上杜绝路径穿越（Path Traversal）等安全越权行为。
*   **黑匣子追踪记录 (Tracer)**：在 [tracer.ts](src/brain/tracer.ts) 中对每一次迭代的上下文、推理过程（Reasoning Chain）、工具调用及其返回值进行格式化，以 JSONLines 格式持久化到 `.myagent/traces` 中，用于事后评测与分析。
*   **请求中断控制**：集成 `AbortController` 机制，支持在模型推理流生成过程中通过双击 `ESC` 或系统信号强行安全终止。

### 2. Skill (动态加载技能)
Skill 将特定领域的 SOP 与业务逻辑封装为独立、轻量的 Markdown 文件（放在 `.agent/skills/` 下），其加载机制采用**渐进式披露**策略：
*   **全局大纲感知**：系统启动时，[prompts.ts](src/brain/prompts.ts) 仅将各技能的名称与简短描述（Metadata）挂载到 `<available_skills>` 系统提示词块中，使大模型建立基本的“技能目录检索”心智，而不直接倾倒具体的技能详情。
*   **自主拉取正文**：当大模型评估任务需要某个特定领域知识时，主动发起 Function Calling 调用 `load_skill(name)` 工具。由本地虚拟 MCP 读取对应的 `SKILL.md` 的 Markdown 正文并返回。
*   **优雅上下文注入**：[DefaultContextAdapter.ts](src/brain/adapters/DefaultContextAdapter.ts) 负责将获取的技能文本以 `<transient_skill>` 的形式**动态插入到最后一条 User 消息之前**。这样既能让模型感知技能，又维持了 Assistant `tool_calls` 与 Tool 返回结果消息的相邻性，避免破坏大模型底层协议中“tool 消息必须紧随 assistant tool_calls 之后”的强物理邻近限制。

---

## 🛠️ 技术栈与依赖

*   **开发语言**：TypeScript (基于 ESM 规范编译运行)
*   **运行时环境**：Node.js >= 20.11
*   **核心依赖**：
    *   `openai`：集成 OpenAI 兼容协议（完美适配 DeepSeek-V3/R1 等具备 Reasoning 推理链输出的模型）。
    *   `@modelcontextprotocol/sdk`：集成 Model Context Protocol (MCP) 标准，支持 stdio 传输层进行外部工具的挂载。
    *   `@clack/prompts`：用于 CLI 交互中流畅优美的交互式菜单呈现。
    *   `gray-matter`：用于解析技能 `SKILL.md` 顶部的 YAML Frontmatter 结构。
    *   `dotenv`：全局环境变量热载。

---

## 📁 目录与模块结构

```text
MyAgent/
├── .agent/                  # 智能体全局规则与技能库存放目录
│   ├── global_rules.md      # 全局硬性规则
│   └── skills/              # 扩展技能目录 (内含 docx, pdf 等技能下的 SKILL.md)
├── .myagent/                # 系统运行时数据落盘目录
│   ├── sessions/            # 历史对话会话 JSON 状态
│   └── traces/              # 结构化 ReAct 迭代黑匣子日志 (JSONL)
├── src/
│   ├── index.ts             # 系统启动入口，负责环境与核心组件装配
│   ├── action/              # 执行层（动作层）
│   │   ├── tools.ts         # 本地内置工具声明与沙箱路径校验
│   │   ├── toolRegistry.ts  # 中央路由管理台，负责本地/外部 MCP 工具路由
│   │   ├── virtual-mcp.ts   # 进程内的本地虚拟 MCP 服务端实现
│   │   └── mcp-client.ts    # 远端 stdio MCP 客户端，管理子进程生命周期与安全变量
│   ├── brain/               # 推理层（大脑与上下文层）
│   │   ├── session.ts       # 核心 ReAct 调度器，执行 chat 推理循环与规则加载
│   │   ├── context.ts       # 会话历史消息栈与状态文件持久化
│   │   ├── contextLoader.ts # 动态加载规则与递归检索、缓存技能文档
│   │   ├── driver.ts        # OpenAI 兼容协议客户端，支持 Reasoning 推理流与工具累加
│   │   ├── prompts.ts       # 系统级 Prompt 的组装与 available_skills 暴露
│   │   └── adapters/        # 上下文组装适配器（如 DefaultContextAdapter 组装注入）
│   ├── config/              # 配置管理层
│   │   ├── loader.ts        # 配置文件引导、插值与防御性冻结
│   │   ├── mcp-env.ts       # 外部 MCP 进程环境隔离与安全环境变量白名单
│   │   └── models.ts        # 内置模型特征（如思考等级）与连接工厂
│   └── utils/               # 工具类
│       └── env.ts           # 环境变量正则替换与递归插值解析
```

---

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
复制并配置全局环境变量文件：
```bash
cp .env.example .env
```
在 `.env` 中按需填写大模型接口信息：
*   `DEEPSEEK_API_KEY`：API 密钥。
*   `DEEPSEEK_API_URL`：API 基础地址。
*   `DEEPSEEK_MODEL`：模型名称，如 `deepseek-v4-flash`。
*   `AUTHORIZED_WORKSPACE_DIR`：限定本地文件工具只能访问的绝对路径沙箱范围（默认当前工作区）。

### 3. 配置外部 MCP 服务器（可选）
复制并编辑外部工具配置文件：
```bash
cp mcp_config.example.json mcp_config.json
```
在 `mcp_config.json` 中添加你需要挂载的外部 stdio 启动的 MCP Server。

### 4. 启动终端 REPL 交互
```bash
npm run dev
```

---

## ⌨️ 终端交互与快捷键

*   **输入 `/`**：调出全屏操作菜单，支持直接选择调用临时技能、切换模型、查看工具清单、回滚/恢复历史对话、查看帮助等。
*   **快捷键 `双击 ESC`**：
    *   **在生成中**：强行安全中断响应流。
    *   **在空闲时**：单步撤销（回滚）上一轮的对话内容。
*   **斜杠指令（Slash Commands）**：
    *   `/skill <name> <task>`：临时调用指定技能执行任务。
    *   `/model <id>`：动态切换当前大语言模型。
    *   `/rollback [N]`：回滚前 N 轮历史上下文记忆（默认 1 轮）。
    *   `/history`：查看保存的历史会话列表。
    *   `/resume <id>`：恢复指定的历史会话上下文。
    *   `/mcp <list|enable|disable> [name]`：管理与查阅 MCP 扩展服务。
    *   `/reload-rules`：重新读取并锁定最新的全局和项目局部规则。
    *   `/tool list`：查看当前已挂载的可用外部工具清单。
    *   `/help`：显示帮助。
    *   `exit / quit`：安全关闭并退出程序。
