# simple-agent-core

## Purpose
实现基本的 Agent 能力，包括会话上下文的管理、安全的本地文件沙箱控制、动态大模型配置支持以及提供交互式命令行终端（REPL）体验。

## Requirements

### Requirement: 会话上下文管理
系统必须（MUST）在内存中完整维护当前会话的消息队列（包括 System Prompt、User Messages、Assistant Responses，以及所有 Tools 调用输入与反馈），并在发起大模型请求时完整传递。

#### Scenario: 多轮连续对话上下文追踪
- **WHEN** 用户在命令行 REPL 终端输入首轮问题“我想要在工作区创建一个名为 demo.txt 的文件”，紧接着输入第二轮问题“在其中写入内容 'hello'”
- **THEN** 系统的会话管理器必须成功将之前的上下文和工具执行状态链条发送给大模型，使大模型理解第二轮请求的目标，进而发起写入工具调用。

#### Scenario: 多轮工具调用的上下文连续性
- **WHEN** 模型在一轮响应中同时给出了 `reasoning_content` 和一个 `tool_call`，并且工具执行完毕将结果发回给模型进行第二轮响应时
- **THEN** 系统必须将上一轮的完整 `reasoning_content` 和拼接好的 `tool_calls` 作为上下文严格按原样压入消息历史栈中，确保二次调用不报错且思考链不丢失。

### Requirement: 授权路径绝对安全沙箱
系统在执行文件读取（readFile）、写入（writeFile）、列出（listFiles）等本地操作时，必须（MUST）对输入的路径进行绝对路径解析（`path.resolve`），并严格验证其是否处于授权工作区根目录下。验证时必须（MUST）包含系统路径分隔符（`path.sep`）或进行完全相等匹配，防止以同前缀的目录名进行逃逸。若发现路径试图越界，必须立即予以拦截，禁止调用底层文件系统，并向大模型返回明确的越权阻断错误。

#### Scenario: 阻断恶意路径遍历与越权操作
- **WHEN** 大模型受到提示词诱导或自主尝试通过工具读取外部路径（例如试图传入绝对路径 `C:\Windows\win.ini`，或者利用相对路径 `../../etc/passwd` 试图穿透授权工作区）
- **THEN** 文件工具处理器必须立刻拦截此操作，不得触发 any 底层读写 API，并向大模型返回 “Access Denied: Path is outside the authorized directory” 的错误回显，以确保本地系统安全。

#### Scenario: 阻断同前缀目录越位逃逸
- **WHEN** 模型或用户输入了被解析为与授权工作区同前缀但属于另一个文件夹路径的参数（例如工作区为 `/authorized/path`，输入解析结果为 `/authorized/path-secret`）
- **THEN** 文件工具处理器必须识别到该路径缺乏物理分隔符分界，判定其溢出了授权工作区安全边界，立刻拦截此操作并返回安全拒绝报错。

### Requirement: 动态模型配置切换
系统必须（MUST）支持通过外部 `.env` 环境变量加载 `DEEPSEEK_API_KEY`、`DEEPSEEK_API_URL` 以及 `DEEPSEEK_MODEL`，使系统在启动时动态调用对应的大语言模型。配置的加载必须由独立的配置管理模块（`config.ts`）统一完成，会话管理模块（`session.ts`）通过构造函数参数接收已加载的配置值，不得自行读取 `process.env` 或包含硬编码的默认 API Key。

#### Scenario: 动态更改模型名称并生效
- **WHEN** 用户在 `.env` 配置文件中将模型名称变量更改为兼容的另一个模型，并重新运行 Agent
- **THEN** 系统的 API 请求客户端在发起会话时，必须自动使用并传递修改后的模型名称

#### Scenario: 动态控制深度思考力度与边界参数
- **WHEN** 用户希望通过 `.env` 或运行时配置调整思考强度（如 `high` 或 `disabled`），或者调整最大令牌数
- **THEN** 系统必须通过配置映射（如 `ModelProfile`）将这些参数解耦并动态渲染为请求的 Payload，不能将特定模型的思考字段硬编码死在请求流中。

#### Scenario: 强制锁定推理链使用简体中文
- **WHEN** 大语言模型由于原生强化学习倾向而在遇到专业英语术语时发生内部推理语言偏转（如转用英文推理）
- **THEN** 系统的初始化系统提示词（System Prompt）必须存在强约束力，强制要求模型内部逻辑链和最终输出均始终维持在简体中文。

### Requirement: 交互式命令行 REPL 循环
系统必须（MUST）基于 Node.js 原生的 `readline` 模块提供交互式的命令行对话循环。界面应能够清晰区分用户输入区与大模型回显区，且在发生 Tools 工具调用时，必须将工具调用的名称、参数及执行状态清晰打印在终端，使用户掌握 Agent 的行为。
系统必须（MUST）能够动态更新命令行提示符（Prompt），以在视觉上反映当前正在使用的活动模型（例如 `用户 [deepseek-v4-pro] > `）。
此外，系统必须支持在接受输入后判断内容是否为系统指令（以 `/` 前缀起始）。若是，则拦截调用相应的内部系统命令处理程序（如模型切换），而不将此内容发送给大语言模型；否则作为正常的对话消息推入会话上下文。

#### Scenario: 启动命令行交互循环并响应（流式输出）
- **WHEN** 用户通过终端启动项目主程序并进行第一次提问
- **THEN** 系统必须在终端以清晰美观的格式显示交互提示符。并在模型响应时，使用流式输出（Streaming）逐字或逐块打印内容。

#### Scenario: 实时展示模型深度思考过程
- **WHEN** 模型启用了 `thinking`能力并在流中返回 `reasoning_content`
- **THEN** 系统必须实时在终端使用灰色字体打印出模型的思考过程，且该过程的输出不应干扰后续的工具调用展示和正式的回答内容。

#### Scenario: 流式工具调用拼装与过程可视化
- **WHEN** 模型的响应流中包含了零散的 `tool_calls` 碎片
- **THEN** 系统必须在内存中完整拼接 JSON 参数，且在拼接开始或结束后，在终端使用明显的指示符（如 ⚡ 图标和青色高亮）展示正在调用的具体工具名称及参数概览，打破调用期间的黑盒等待状态。

#### Scenario: 动态更新命令行提示符
- **WHEN** 系统启动或用户通过内部指令成功切换了底层大模型
- **THEN** REPL 的输入提示符必须立刻更新以包含新模型的名称标识

### Requirement: 命令路由解耦
为了满足单一职责和开闭原则，所有系统内部指令（Slash Commands）必须通过独立的命令路由模块（如 `command.ts`）进行分发与处理。主交互循环所在的模块（如 `index.ts`）应当只负责 I/O 拦截和请求委托，不得硬编码具体命令的业务逻辑。

#### Scenario: 启动命令行交互循环并响应正常对话
- **WHEN** 用户通过终端启动项目主程序并进行第一次提问
- **THEN** 系统必须在终端以清晰美观的格式显示交互提示符，并在接收到用户输入后，实时输出 Agent 的交互状态（包括“正在思考中...”、“调用工具 readFile...”），直至该轮对话结束并等待下一次用户输入。

#### Scenario: 拦截系统级内部指令
- **WHEN** 用户在提示符下输入 `/model deepseek-reasoner`
- **THEN** 系统拦截此输入，并不将其作为用户对话发给大模型，而是执行环境配置切换逻辑，并打印“切换成功”或失败的系统回显，随后重置输入提示符等待下一轮输入。

### 需求: Agent 自动收集所有可用工具并调度
系统必须（MUST）通过一个专门的、独立于 `SessionManager` 的 `ToolRegistry` 来聚合和管理所有的 MCP 客户端和内置虚拟工具。`SessionManager` 不能再自行管理 MCP 连接或在内部进行工具映射，它只能通过调用 `ToolRegistry.callTool(name, args)` 来分发大模型发起的工具请求。
此外，`SessionManager` 在调度工具执行的迭代循环中，必须（MUST）对每一轮交互产生的工具调用（Tool Calls）指纹（即函数名与参数哈希）进行持续追踪与监控。如果检测到模型在同一轮（一次用户会话）的迭代流转中连续发起了超过 4 次完全相同的工具调用，则必须抛出包含 `HARD BLOCK` 的异常强行阻断死循环。

#### 场景: 发起对内部文件系统的 Tool Call
- **WHEN** 模型返回了一个 `tool_calls` 要求读取文件
- **THEN** SessionManager 必须将请求直接委托给 `ToolRegistry`。`ToolRegistry` 负责查找对应的内置虚拟 MCP Server 进行处理，并将标准结果返回给 SessionManager。

#### 场景: 阻断重复工具调用的死循环 (Loop Prevention)
- **WHEN** 在单次交互的工具循环中，大模型对同一个文件 `nonexistent.txt` 连续执行了第 5 次完全相同的 `readFile` 工具调用（函数名及参数均与前 4 次完全一致）
- **THEN** SessionManager 必须中断当前 ReAct 迭代过程，不再调用 `ToolRegistry`，直接抛出 `HARD BLOCK` 异常以强行终止死循环，保护 Token 不被无限耗尽

### Requirement: 事件驱动的核心会话流
系统的核心大模型调度引擎（如 `SessionManager`）必须（MUST）是一个纯粹的计算核心，通过 `AsyncGenerator<AgentEvent>` 的形式产出流式事件，而不能直接在内部执行 `process.stdout.write` 等具体的终端打印操作。终端交互层必须只作为消费者来处理这些事件，从而实现引擎与 UI 渠道的彻底解耦。

#### Scenario: 引擎产生流式事件并交由外部消费
- **WHEN** 大模型返回了一个打字机文本块（Content Chunk）或开始发起工具调用（Tool Call）
- **THEN** `SessionManager.chat()` 必须通过 `yield` 返回标准化的 `AgentEvent`（如包含类型为 `content` 或 `tool_call_start` 的事件对象），而具体的打印行为由外层的 REPL 循环完成。
