# simple-agent-core

## Purpose
实现基本的 Agent 能力，包括会话上下文的管理、安全的本地文件沙箱控制、动态大模型配置支持以及提供交互式命令行终端（REPL）体验。

## Requirements

### Requirement: 会话上下文管理
系统必须（MUST）在内存中完整维护当前会话的消息队列（包括 System Prompt、User Messages、Assistant Responses，以及所有 Tools 调用输入与反馈），并在发起大模型请求时完整传递。

#### Scenario: 多轮连续对话上下文追踪
- **WHEN** 用户在命令行 REPL 终端输入首轮问题“我想要在工作区创建一个名为 demo.txt 的文件”，紧接着输入第二轮问题“在其中写入内容 'hello'”
- **THEN** 系统的会话管理器必须成功将之前的上下文和工具执行状态链条发送给大模型，使大模型理解第二轮请求的目标，进而发起写入工具调用。

### Requirement: 授权路径绝对安全沙箱
系统在执行文件读取（readFile）、写入（writeFile）、列出（listFiles）等本地操作时，必须（MUST）对输入的路径进行绝对路径解析（`path.resolve`），并严格验证其是否处于授权工作区根目录下。若发现路径试图越界，必须立即予以拦截，禁止调用底层文件系统，并向大模型返回明确的越权阻断错误。

#### Scenario: 阻断恶意路径遍历与越权操作
- **WHEN** 大模型受到提示词诱导或自主尝试通过工具读取外部路径（例如试图传入绝对路径 `C:\Windows\win.ini`，或者利用相对路径 `../../etc/passwd` 试图穿透授权工作区）
- **THEN** 文件工具处理器必须立刻拦截此操作，不得触发任何底层读写 API，并向大模型返回 “Access Denied: Path is outside the authorized directory” 的错误回显，以确保本地系统安全。

### Requirement: 动态模型配置切换
系统必须（MUST）支持通过外部 `.env` 环境变量或集中配置文件 `config.json` 加载 `DEEPSEEK_API_KEY`、`DEEPSEEK_API_URL` 以及 `DEEPSEEK_MODEL`，使系统在启动和请求时动态调用对应的大语言模型。

#### Scenario: 动态更改模型名称并生效
- **WHEN** 用户在 `.env` 配置文件中将模型名称变量更改为兼容的另一个模型，并重新运行 Agent
- **THEN** 系统的 API 请求客户端在发起会话时，必须自动使用并传递修改后的模型名称。

### Requirement: 交互式命令行 REPL 循环
系统必须（MUST）基于 Node.js 原生的 `readline` 模块提供交互式的命令行对话循环。界面应能够清晰区分用户输入区与大模型回显区，且在发生 Tools 工具调用时，必须将工具调用的名称、参数及执行状态清晰打印在终端，使用户掌握 Agent 的行为。

#### Scenario: 启动命令行交互循环并响应
- **WHEN** 用户通过终端启动项目主程序并进行第一次提问
- **THEN** 系统必须在终端以清晰美观的格式显示交互提示符，并在接收到用户输入后，实时输出 Agent 的交互状态（包括“正在思考中...”、“调用工具 readFile...”），直至该轮对话结束并等待下一次用户输入。
