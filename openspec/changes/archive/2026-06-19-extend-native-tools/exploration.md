# 探索主题: 原生工具扩展与竞品调研

## 1. 问题定义
在当前的 `MyAgent` 系统中，除了基础的文件读写/编辑/列表和 Glob/Grep 搜索外，许多核心操作（如目录创建、文件删除、复制/移动、进程与任务管理、Git 查看等）都需要大模型调用 `executeCommand` 组装命令行去执行。这带来了三大痛点：
1. **平台兼容困难**：Windows 与 Linux/Unix 在常用指令及其选项（如 `mkdir`、`rm`、`grep` 与 `find`）上存在巨大差异，大模型容易在环境识别和参数拼接上出错。
2. **安全风险较高**：终端命令的参数很难实现百分之百的沙箱隔离和安全过滤，极易因高危参数（如 `rm -rf`）或路径穿越造成工作区外的系统损坏。
3. **输出解析开销大**：终端输出的 stdout 杂乱且包含 ANSI 颜色控制字符，大模型难以高容错地提取有效信息，造成 Token 浪费。

本探索的目标是通过深入调研行业优秀 Agent（如 Claude Code 与 OpenCode ）的原生工具链设计，评估对 `MyAgent` 现有原生工具进行扩展的可行性与具体方案。

## 2. 关键发现与调研结果
- **代码库现状**：`MyAgent` 现有原生工具链共 8 个（ReadFile, WriteFile, EditFile, ListFiles, LoadSkill, GrepSearch, GlobSearch, ExecuteCommand）。除读写搜之外的交互均被推给终端执行，缺乏结构化操作 API。
- **核实与洞察**：通过对 `Agents` 目录下全部开源/参考项目进行源码深入分析，整理如下：
  1. **Claude Code**：包含十多个维度 40+ 个原生工具，特色在于通过 LSP 进行精准代码级分析，以及利用 `git worktree` 做工作区隔离和一整套异步 Task 任务调度。
  2. **OpenCode**：整体工具结构与 Claude Code 保持高度对齐。其核心包含 12 个内置工具，其特色在于明确内置了基于 Git Patch 的统一代码修补工具（ `ApplyPatch` ），并计划提供仓库概览工具（ `repo_overview` ），以便大模型宏观把握项目拓扑。
  3. **Hermes Agent**：具备极强的多媒体处理与外部系统集成能力（ 80+ 个工具文件 ）。其特色在于内置了极为完善的 Web Headless 浏览器交互工具集、支持 Anthropic 的桌面操作系统控制能力（ Computer Use ）、以及由安全卫士（ Tirith ）和写操作人工审批（ Write Approval ）构成的极高强度安全拦截防护网。
  4. **OpenClaw**：支持万物皆可扩展的插件式（ Extension-First ）架构，内置 130+ 个扩展。其特色在于通过 NVIDIA OpenShell 沙箱隔离命令执行，支持包括 read-only、workspace-write 在内的细粒度 Codex 沙箱策略；并实现了延迟加载工具搜索机制（ Tool Search ），避免上下文膨胀（ Context Bloat ）。
  5. **Codex**：使用 Rust 架构实现硬核系统安全。其特色在于自主实现基于 Bubblewrap（ Linux 下的 `bwrap` ）与 Windows Sandbox 的强沙箱执行环境；并在 `parse_command.rs` 中内置了庞大的命令语法树深度分析解析引擎，全面防范高危的恶意参数注入。
  6. **Gemini CLI**：面向长上下文与状态逻辑进行了大量优化。特色在于提供了批量并行读取工具（ `read-many-files` ）、自知型的说明文档拉取工具（ `get-internal-docs` ）、任务确认总线（ `confirmation-bus` ）以及包括记忆、话题与状态追踪在内的一系列原生辅助工具。
  7. **TinyPace AI Desktop**：是一个 Electron 桌面客户端。其特色在于通过 Preload 脚本和 IPC 主进程双向桥接，向 Agent 提供了包含文件选择器弹出、系统通知推送、托盘控制及截屏在内的 OS UI 级原生交互能力。

### Claude Code 原生工具分类梳理

#### 1. 文件与目录操作类
* **FileReadTool / FileWriteTool / FileEditTool**：负责精确的局部和全局文件读写，以及基于文本特征匹配的局部增量修改。
* **NotebookEditTool**：针对 `.ipynb` Jupyter 笔记本文件的专用修改工具，防止大文件覆盖与元数据错乱。

#### 2. 文件检索类
* **GlobTool / GrepTool**：在没有集成极速检索工具（如内置的 bfs/ugrep）时，用于提供 glob 路径过滤和 grep 文本正则搜索。

#### 3. 命令行执行类
* **BashTool / PowerShellTool**：在不同平台下执行终端原子命令，Windows 下优先适配 PowerShell 以防别名冲突。

#### 4. 对话与人机交互类
* **AskUserQuestionTool**：遇到不确定或高风险决策时，主动向用户提问。
* **BriefTool**：向用户生成总结与摘要。

#### 5. 计划与任务管理类
* **EnterPlanModeTool / ExitPlanModeTool**：让 LLM 进入和退出计划设计模式，在此模式下优先进行分析规划而不是盲目编码。
* **VerifyPlanExecutionTool**：在计划执行完毕后自动进行质量和目标契约的核对。
* **TaskCreateTool / TaskGetTool / TaskListTool / TaskUpdateTool / TaskStopTool / TaskOutputTool**：一整套用于后台异步任务生命周期管理的工具，大模型无需挂起等待耗时任务，能够并发执行。

#### 6. 隔离与环境恢复
* **EnterWorktreeTool / ExitWorktreeTool**：在 Git 环境下，自动将修改隔离至单独的 git worktree 分支工作目录中执行，保障主工作区的安全和清洁。

#### 7. 语言服务与分析
* **LSPTool**：对接项目语言对应的 LSP（Language Server Protocol），提供符号跳转定义、引用查找和类型级 Lint 校验。

#### 8. MCP 标准协议集成
* **MCPTool / ListMcpResourcesTool / ReadMcpResourceTool / McpAuthTool**：提供对接 Model Context Protocol 服务的工具注册、资源读取和权限验证。

#### 9. 网络搜索与抓取
* **WebSearchTool / WebFetchTool**：用于在线搜索和解析特定 URL 的 HTML 文本。

#### 10. 团队协同与通知
* **TeamCreateTool / TeamDeleteTool / SendMessageTool**：启用多智能体协同（Agent Swarms）时进行 Agent 间的消息传递与团队管理。
* **PushNotificationTool / SubscribePRTool**：推送系统通知与 GitHub Webhook 状态订阅。

### OpenCode 原生工具分类梳理

#### 1. 文件与代码编辑类
* **ReadTool / WriteTool / EditTool**：基础的文件读写与基于纯文本特征精确匹配的局部增量修改。
* **ApplyPatchTool**：基于 Git 统一 diff 格式（ Unified Diff ）应用 Patch 补丁修改代码，在大规模、复杂逻辑重构时比纯文本匹配更为稳定和鲁棒。

#### 2. 文件检索类
* **GlobTool / GrepTool**：用于提供 glob 路径过滤 and grep 文本正则搜索，与 Claude Code 保持对齐。

#### 3. 命令行执行类
* **BashTool**：执行终端原子命令。

#### 4. 对话与人机交互类
* **QuestionTool**：需要用户确认或提供信息时主动发起交互提问。

#### 5. 辅助与外部集成类
* **SkillTool**：用于加载和执行预定义的 Skill 技能库规则。
* **TodoWriteTool**：提供向项目中写入 TODO 任务的功能。
* **WebFetchTool / WebSearchTool**：用于在线搜索和解析特定 URL 的 HTML 文本。

#### 6. 计划与预备扩展工具
根据 `builtins.ts` 中的规划， OpenCode 正逐步支持并迁移以下工具：
* **repo_overview**：用于对整个 repository 的拓扑结构和关系进行宏观概览的工具。
* **task**：用于异步挂起任务管理的工具集。
* **LSP**：对接语言服务的代码类型与定义跳转工具。

### Hermes Agent 原生工具分类梳理

#### 1. 媒体与视觉处理类
* **image_generation_tool / video_generation_tool**：图像与视频的多媒体生成工具。
* **transcription_tools / tts_tool / voice_mode**：语音与文字的双向转换与交互工具。
* **vision_tools**：为大模型提供视觉解析的分析工具。

#### 2. 浏览器交互与桌面控制类
* **browser_tool / browser_camofox / browser_cdp_tool**：内置的无头浏览器客户端，支持渲染网页并抽取 DOM 结构，通过视觉或 CDP 精准提取元素。
* **computer_use_tool**：原生支持模拟桌面级的屏幕鼠标拖拽与键盘敲击（ 对应 Anthropic Computer Use 协议 ），使 Agent 能直接控制操作系统。

#### 3. 多智能体派发与协同类
* **delegate_tool / send_message_tool**：支持把复杂的大任务派发给子 Agent 进行执行并管理其状态。
* **mixture_of_agents_tool**：支持多模型、多智能体的结果整合与混合写作。

#### 4. 沙箱代码执行与环境类
* **code_execution_tool**：支持在隔离的 Docker 容器或物理沙箱中运行 Python / Bash 代码以防系统受损。
* **env_probe / env_passthrough**：检测与透传当前宿主系统的环境变量与参数配置。

#### 5. 安全合规与行为审计防线
* **tirith_security / threat_patterns**：内置了名为 Tirith 的安全卫士，实时拦截可能出现的恶意命令注入、文件越权或目录穿越。
* **write_approval / approval**：极具特色的前置审核网关，若 Agent 试图调用可能造成数据损毁的写操作或命令，工具会挂起并原生地向用户发送审批弹窗，获得人工显式授权后才向下流转。

#### 6. 看板与辅助整合类
* **kanban_tools / todo_tool / cronjob_tools**：内置了看板、定时任务和待办事项的原生管理能力。

### OpenClaw 插件与沙箱工具分类梳理

#### 1. 命令行沙箱执行类
* **openshell**：对接 NVIDIA OpenShell CLI ，提供通过镜像本地目录或 SSH 协议执行远程命令的沙箱后端。

#### 2. 工具动态搜索与延迟加载机制
* **Tool Search**：设计了专门的工具检索器， LLM 无需在初始提示中加载所有内置或扩展工具的 Schema ，而是通过动态查询的方式按需引入，彻底规避了上下文膨胀与注意力分散问题。

#### 3. 细粒度安全与审批网关
* **Codex App-Server Integration**：支持 stdio/websocket 双重通信形态的 Codex 服务托管，提供 read-only 、 workspace-write 以及 danger-full-access 级别的底层物理沙箱隔离，并具有 on-request / on-failure 多重人工确认安全策略。

### Codex, Gemini CLI 与 TinyPace AI Desktop 工具链特色梳理

#### 1. 深度安全检测与沙箱执行
* **Sandboxed Exec-Server / bwrap**： Codex 提供了极其强悍的 Bubblewrap 和 Windows Sandbox 硬沙箱执行机制，并在底层通过自建的编译级命令词法/句法解析（ `parse_command.rs` ）对 LLM 拼装的命令进行静态分析，防范越权和拼接注入。

#### 2. 并行吞吐与自知文档工具
* **read-many-files**： Gemini CLI 原生封装了批量读文件工具，允许 Agent 一次性拉取多个目标代码文件，显著规避了多次轮询的并发瓶颈与网络延迟。
* **get-internal-docs**： 提供了将 Agent 项目自身的设计规范、用法指引和开发说明以结构化 API 提供给 LLM 的“自知”工具，使得 Agent 无需盲目搜索。

#### 3. 桌面操作系统 UI 交互组件
* **Electron Preload / IPC API Bridge**： TinyPace AI Desktop 通过桌面框架主进程桥接，向 Agent 输出了包括弹出文件选择对话框、屏幕截图控制、本地弹窗和系统通知推送等 OS 原生桌面交互 API 。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：扩展原生工具（Native Tools） | 方案 B：仅使用终端命令（executeCommand） | 结论 |
| :--- | :--- | :--- | :--- |
| **安全性** | 高 ✓（可做细粒度参数校验与路径限制） | 低 ✗（命令注入、路径穿越难以百分百过滤） | 方案 A 占优 |
| **跨平台兼容** | 高 ✓（Node.js 原生 API 自动抹平平台差异） | 低 ✗（LLM 需要适配 Windows/Linux 差异） | 方案 A 占优 |
| **解析开销** | 低 ✓（返回结构化 JSON ，节省 Token ） | 高 ✗（解析裸终端 stdout ，容错差） | 方案 A 占优 |
| **开发与维护** | 高 ✗（需编写工具类及参数 Schema ） | 低 ✓（一个通用命令行工具即可） | 方案 B 占优 |

**推荐路径**：
使用**混合模式**。针对高频、高危和严重依赖操作系统的底层核心操作实现原生 TS 工具扩展，而其余长尾或非标准化脚本执行则维持 `executeCommand` 兜底。

### MyAgent 第一阶段原生工具扩展具体方案

结合对 7 个竞品项目工具链的深入剖析，我们为 `MyAgent` 规划的第一阶段原生工具扩展方案包含以下四大核心模块：

#### 1. 结构化目录与路径管理工具（ 跨平台与安全性保障 ）
* **createDirectory**： 封装原生的 `fs.mkdirSync(..., { recursive: true })` ，彻底磨平不同系统下大模型拼接 `mkdir -p` 等选项可能产生的执行报错。
* **deletePath**： 原生封装路径删除（ 支持目录及文件 ），在底层逻辑中**强制校验路径范围**（ 必须局限在授权工作区沙箱内 ），直接防范高危的删除动作并配合前置审批机制。
* **movePath / copyPath**： 原生实现文件/目录的复制与移动，避免跨平台命令（ Windows 的 `move`/`copy` vs Linux 的 `mv`/`cp` ）语法与选项的识别难题。

#### 2. 高吞吐高容错的代码编辑与查看工具（ 吞吐量与 Token 优化 ）
* **readManyFiles**： 允许 Agent 一次性并行拉取多个目标相对路径的文件内容（ 单次上限为 10 个 ）。为防止上下文爆仓（ Context Bloat ）与大模型截断幻觉，**废除物理硬截断，采用前置体积熔断与拒签机制**。一旦内部检测到所请求的批次文件总体积或 Token 预测值超限，工具直接报错熔断并返回拒签信息（ 包含超限清单及文件体积 JSON 列表 ），由大模型自主发起分批拉取。为降低决策难度，在返回“拒签错误”时，会附带文件的首尾若干行及方法类定义概览，方便大模型评估如何按需精细化读取。
* **applyPatch（ 严格模式补丁与特征块替换双轨并行 ）**： 鉴于自研模糊匹配（ Fuzzy Matching ）算法在行偏置及相似结构下极易引入偏置覆盖风险，我们**废除自研模糊匹配，实行“双轨并行”机制**：
  1. **严格 Patch 模式**：采用成熟的标准 Unified Diff 库进行解析，一旦大模型输出的补丁出现上下文错位、行号冲突，工具绝不尝试模糊猜测，直接强硬报错熔断。
  2. **上下文签名特征块替换（ Signature-based Block Replace ）**：作为替代和主力修改工具，大模型可提供 `[startLine, endLine]` 大致范围、期望原文特征签名 `expectedContent`（ 提供 2-3 行 ）以及替换新内容 `replacementContent`。工具在指定行范围的邻域滑动窗口匹配特征签名，成功定位后执行块替换。该工具对大模型的行号偏移和缩进幻觉具备天然的高容错率。

#### 3. 只读型 Git 辅助工具（ 状态快速感知 ）
* **gitShowStatus**： 原生封装只读的 `git status` ，以结构化 JSON 格式返回给大模型，避免其不得不解析控制台繁杂的 stdout 。
* **gitShowDiff**： 原生包裹只读 `git diff` （ 内置最大展示行数阈值 ），为大模型呈现局部代码的增量变化。
* **gitShowLog**： 原生封装只读 `git log -n <count>` 工具，使大模型能检索最近的项目重构脉络与 commit 提交信息，对其理清未知代码库的历史演变具有极其关键的辅助作用。

#### 4. 前置人工审批总线与安全网关（ 确权安全防护 ）
* **WriteApproval 意图确权凭证机制（ 异步解耦设计 ）**： 为规避底层工具执行挂起导致的长连接超时与上下文断裂，**废除底层挂起审批，采用“异步意图请示 + 一次性临时凭证验证”机制**：
  1. **意图层请示**：大模型在推断出需要执行 `deletePath` 、覆盖写或非白名单高危命令时，禁止直接调用工具，必须先在会话中以纯文本向用户说明请示并阐明目标路径。
  2. **凭证分发卡关**：当用户在界面中明确回复“同意/批准”时，底座框架会将该一次性确权凭证（ `approval_token` ）隐式分发并注入到大模型的下轮会话状态中。
  3. **工具物理阻断**：敏感底层工具在执行时强制校验传入的 `approval_token` 参数的合法性与时效。未携带有效凭证的调用一律物理阻断报错，彻底防范大模型幻觉越权、自动运行危险删除命令的风险。

#### 5. 统一扁平化 Schema 规范
* **扁平化结构约束**： 鉴于系统主要适配 OpenAI 协议标准且对接 DeepSeek API ，为降低大模型的决策混淆度，所有原生工具的 `parameters` 声明一律**强制保持单层扁平化结构**，严禁使用多重嵌套的 parameters 类型；在 description 中详细注明工具边界与适用场景。

## 4. 约束、风险与未知项
- **LSP工具链集成难度高**： LSP 协议对当前运行环境及语言解析器有很强依赖，封装难度大，需列为长期非核心任务。
- **任务并发与隔离的复杂性**： 实现类似于 Claude Code 的 `TaskCreate` 后台进程生命周期管理需要更稳定的进程间通信（ IPC ）或流式日志缓冲机制，以防子进程僵死。
- **特征签名算法的重合冲突风险**： 在“上下文签名特征块替换”中，若大模型提供的期望原文特征签名 `expectedContent` 过于简短且在该区域存在相似的重复结构（ 如连续的 `}` ），可能导致滑动窗口匹配定位模糊。必须约束模型在 description 中提供足够区别度的上下文签名。
- **凭证流转的状态连贯性**： 临时授权凭证（ `approval_token` ）的生成、生命周期管理与上下文注入，需要底座框架进行稳健的设计，避免由于会话重置或多轮折返导致大模型丢失凭证。

## 5. 否决方案
- **完全依靠终端命令**：被舍弃。在跨平台场景下由于命令和参数细节不统一，且极难防止恶意路径删除或恶意命令注入，容易带来极其严重的安全和工程可靠性风险。
