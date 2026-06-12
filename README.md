# IJIA Agent (受控通用智能体底座)

本项目是以通用智能助手为长远演进目标的智能体系统。它基于 TypeScript 与 ESM 规范构建，具备沙箱化本地文件工具、可动态配置的外部 Model Context Protocol (MCP) 客户端以及完备的 REPL 终端会话管理能力。

项目在设计之初即贯彻了面向未来的系统化演进思想。在经历 simple-agent-core 极简核心构建、会话持久化、上下文回滚、MCP 动态启停开关、规则缓存以及自动化补全等 15 项核心 Spec（定义于 `openspec/specs` 目录下）的微观重构与级联演进后，已具备了完备的 Harness 控制能力。未来它将作为高内聚的通用智能体底座，不断扩充外部工作流和多领域专业技能包。

---

## 核心设计哲学：Harness + Skill 范式与演进大方向

在 Agentic Systems 的工程落地中，本项目深刻权衡了“完全自主决策”的灵活性与“程序化工作流”的稳定性。我们摒弃了传统的通过硬编码流程图（如 LangChain/LangGraph）来限制 AI 的方式，采用了更具自适应能力的 **Harness + Skill** 范式。

### 1. Harness (约束框架底座)
Harness 作为智能体运行的安全底座，并不预设死板的顺序节点，而是为模型运行提供了一套“安全沙箱与行为守则”：
*   **最大迭代次数限制**：在 [session.ts](src/brain/session.ts) 中对 ReAct 推理循环设置了硬性最大轮数上限（默认 10 轮），防止模型在处理复杂或模糊任务时陷入无限工具调用的死循环，并保障资源消耗可控。
*   **绝对路径沙箱隔离**：在 [tools.ts](src/action/tools.ts) 中对所有涉及本地的操作强制引入 `secureResolvePath` 校验，确保文件读写只在授权的工作区根目录下进行，从底层杜绝路径越界。
*   **黑匣子追踪记录 (Tracer)**：在 [tracer.ts](src/brain/tracer.ts) 中对每一次迭代的上下文、推理过程（Reasoning Chain）、工具调用及其返回值进行格式化，以 JSONLines 格式持久化到 `.myagent/traces` 中，用于分析与后续的 Evals 评测。
*   **中断控制与回滚机制**：集成基于 `AbortController` 的响应中断，支持动态撤销（Rollback）指定轮次的历史记忆，为未来面对更复杂的通用任务提供了高弹性的状态回溯支撑。

### 2. Skill (可插拔动态技能)
Skill 代表具体的业务领域 SOP 或重型外部 Workflow 插件（位于 `.agent/skills/` 目录下），它通过**“渐进式披露”**被大模型消费：
*   **全局大纲感知**：系统在 System Prompt 阶段，仅将技能的 Metadata（名称与简述）在 `<available_skills>` 块中暴露给模型，避免用庞大的具体规则将模型的上下文首字节哈希（Context Caching）冲垮。
*   **按需动态装载**：当模型在处理任务（如读写 Word doc、处理 PDF 等）时，自主评估并发出 `load_skill(name)` 调用。虚拟 MCP 路由将具体的技能正文反馈给模型。
*   **无害化上下文注入**：[DefaultContextAdapter.ts](src/brain/adapters/DefaultContextAdapter.ts) 动态将具体技能以 `<transient_skill>` 系统消息形式插在**最后一条 User 消息之前**。这样既能让模型即时获取 SOP 指导，又避免了因插在 Assistant `tool_calls` 与 Tool 返回结果之间而破坏底层协议邻近原则导致的格式报错。

### 3. 面向未来的演进大方向
项目的最终愿景是构建具备完全自主决策能力的通用智能助手。在架构演进上：
*   **从 simple-agent-core 到通用底座**：我们目前的 TypeScript 极简 Agent 系统是核心基线。随着 15 项 openspec 规格的逐步固化，我们正在将上下文注入引擎、自动补全、环境隔离等能力沉淀为通用基础构件。
*   **外置 SOP 与 Workflow 协同**：未来我们将引入外置的动态 Workflow 编排能力。智能体无需在本地硬编码固定业务逻辑，而是将复杂长链路业务以“外置 workflow”形式作为 Skill 提供给大模型，供其在需要时通过 Harness 载入并遵循，实现自适应任务解决。

---

## 🛠️ 技术栈与依赖

*   **开发语言**：TypeScript (基于 ESM 规范编译运行)
*   **运行时环境**：Node.js >= 20.11
*   **核心依赖**：
    *   `openai`：集成 OpenAI 兼容协议（完美适配 DeepSeek-V4 等具备 Reasoning 推理链输出的模型）。
    *   `@modelcontextprotocol/sdk`：集成 Model Context Protocol (MCP) 标准，支持 stdio 传输层进行外部工具的挂载。
    *   `@clack/prompts`：用于 CLI 交互中流畅优美的交互式菜单呈现。
    *   `gray-matter`：用于解析技能 `SKILL.md` 顶部的 YAML Frontmatter 结构。
    *   `dotenv`：全局环境变量热载。

---

## 📁 目录与模块结构

```text
MyAgent/
├── .agent/                  # 智能体全局规则与技能库存放目录(临时)
│   ├── global_rules.md      # 全局硬性规则
│   └── skills/              # 扩展技能目录 
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
