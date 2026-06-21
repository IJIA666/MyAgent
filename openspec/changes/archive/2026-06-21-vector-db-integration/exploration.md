# 探索主题: 引入 RAG 与长效记忆系统的架构规划

## 1. 问题定义
随着智能助手在处理大规模项目、非结构化知识库（如 PDF/Obsidian 笔记）以及需要长效对话记忆的场景中越来越普遍，纯依靠 System Prompt 注入或简单的文本正则搜索已无法满足要求。本项目急需引入 RAG（Retrieval-Augmented Generation，检索增强生成）与长效记忆机制，以低延迟、高准确度、低成本的方式增强智能助手的知识沉淀、会话记忆与项目文档协同更新能力。

## 2. 关键发现与调研结果
- **代码库现状**：
  
  - **基于工具的实时检索**：当前项目已在 [search.ts](file:///d:/Projects/MyAgent/src/adapters/tools/tools/filesystem/search.ts) 等工具中实现了基于 ripgrep/glob 的代码库文本实时正则匹配，基本具备了 "Agentic Search" 的雏形。
  
  - **缺乏语义和长效记忆**：目前项目缺少持久化的向量存储库或后台自省记忆机制，在处理长文本分块检索、跨会话记忆（Long-term Memory）以及非代码静态知识库时无法进行自动召回或提炼沉淀。

- **核实与洞察**：
  
  通过对主流 Agent 开源项目源码的追踪与竞品检索，以下是各项目针对 RAG / 长效记忆的**具体应用场景 (做了什么)**与**具体工程实现 (怎么做的)**：
  
  - **OpenClaw 的向量记忆与 Wiki 机制**：
    
    - **向量记忆做了什么**：主要用于长效偏好记忆与结构化背景召回。每个记忆条目是一个 `MemoryEntry` 结构，存储字段包含：`id` (随机 UUID )、`text` (清洗后的记忆文本内容)、`vector` ( OpenAI 格式 1536 维特征向量)、`importance` (大模型评估的重要度权重值)、`category` (划分 `"user"` | `"agent"` | `"project"` | `"other"` 类别进行过滤) 和 `createdAt` (创建毫秒时间戳)。
    
    - **向量记忆怎么做的**：
      1. **前置过滤与清洗**：在存储前通过 `looksLikePromptInjection` 正则拦截带有 "ignore previous instructions" 等 prompt 注入模式的危险记忆，并剥离系统封套元数据（如 `Sender (untrusted metadata):` 等信道噪音）和媒体标记。
      2. **库初始化与数据写入**：通过动态加载 `@lancedb/lancedb` 模块并连接数据库。如 memories 表不存在，则先建表并插入一条初始结构以强类型锁定 Schema 。利用 embedding 驱动计算查询向量，最后执行 `table.add` 追加。
      3. **检索召回与距离转换**：利用大模型提取用户最近一轮输入内容，生成 Query 向量。调用 `table.vectorSearch(vector).limit(limit)` 进行召回。因 LanceDB 默认返回 L2 距离，代码通过公式 `score = 1 / (1 + distance)` 将其转换为 `0-1` 相似度分值，仅召回 `score >= 0.5` 的条目。最终通过 HTML 转义（ `escapeMemoryForPrompt` ）拼接后作为大模型 Context 的一部分。
    
    - **Wiki 机制做了什么与怎么做**：将项目笔记库编译为以 claims (证据/信念点)、contradictions (事实冲突) 和 questions (待解决问题) 为节点的 Markdown 库，并输出机器缓存 `.openclaw-wiki/cache/agent-digest.json` 。在 Prompt 组装阶段，系统按评分公式召回最关键的 4 个高冲突/高疑问 Wiki 页的Claims摘要直接注入 Prompt 中。召回的评分公式为：`Score = Contradictions.length * 6 + Questions.length * 4 + min(ClaimCount, 6) * 2 + min(TopClaims.length, 3)`。
    
    - **记忆整合与做梦机制做了什么**：工程化模拟人类的睡眠记忆整合过程（ Consolidation ）。将长效记忆分为“短期记忆（ Turn recalls / 临时片段）”与“长期记忆”。在系统空闲期通过 Cron 任务触发“做梦服务”（ `runShortTermDreamingPromotionIfTriggered` ），在独立的隔离会话中异步运行。大模型会自省分析“最近召回的短期记忆片段”，将它们融合成梦境叙事报告（ `dreaming-narrative` ），最后将符合长期巩固条件的记忆“晋升”（ promote ）并追加写入到 `MEMORY.md` 主记忆文件中。
    
    - **记忆整合与做梦机制怎么做的**：
      1. **评分与过滤算法**：在做梦期间分析近期发生的短期 Recall 数据，使用“记忆评分公式”计算候选片段权重分：`Score` 特征包括 `frequency` (频次)、`relevance` (语义相关度)、`diversity` (多样性)、`recency` (利用半衰期衰减天数 `recencyHalfLifeDays` 随时间衰减分值)、`consolidation` (巩固度) 和 `conceptual` (概念相似分)。
      2. **候选筛选与晋升写入**：只筛选 `Score >= minScore`，且被召回次数与独立 query 频次达到最低阀值的片段，并将其限制在 `maxPromotedSnippetTokens` 大小以内写入 `MEMORY.md`。
      3. **梦境叙事日记 (Dream Diary)**：大模型基于晋升后的记忆片段重新运行一次生成逻辑，编写“梦境叙事” ( Narrative ) 归档至梦境报告，解释这些事实的关联和巩固意图。
  
  - **Claude Code 的自省记忆与魔法文档**：
    
    - **会话记忆做了什么**：不依赖向量数据库，利用 Markdown 文本作为记忆的承载体，记录当前会话的全局画像与开发进展。定义了 9 大核心 Markdown 分区：`# Session Title` (会话标题), `# Current State` (待办与下步动作), `# Task specification` (原始任务要求与设计决策), `# Files and Functions` (关联文件说明), `# Workflow` (常用 bash 命令行), `# Errors & Corrections` (踩坑与用户纠偏记录), `# Codebase and System Documentation` (系统核心组件架构), `# Learnings` (教训与避坑总结), `# Key results` (特定表格/数据输出)。
    
    - **会话记忆怎么做的**：
      1. **后台自省与限额触发**：主对话继续进行时，系统挂载 `postSamplingHook`。当会话 Token 增量或工具调用数达到设定阀值，且大模型最后一轮无未决工具时（处于自然对话间歇），安全触发更新。
      2. **派生隔离智能体运行**：大模型主进程非阻塞，后台通过 `runForkedAgent` 派生一个隔离的子大模型（ Forked Subagent ）。系统限制其只能通过 `canUseTool` 调用 `FileEditTool` 修改指定的 Markdown 记忆路径。
      3. **Token 自主裁剪**：限制单节 `2000` 词、总文件 `12000` 词。在更新前计算词数，如超限，则在 Prompt 尾部强力追加 `CRITICAL: The session memory file exceeds...` 警告，迫使子智能体自省裁剪历史陈旧记忆，完成文本的自主压缩。
    
    - **魔法文档自演化做了什么与怎么做**：设计了 Magic Docs 机制。系统注册读取监听器，一旦大模型通过文件读取工具读到以 `# MAGIC DOC: [title]` 标记的 Markdown 文档，就将其放入跟踪列表。在对话结束空闲时，后台派生的子智能体会自动分析对话进展，将涉及该文档主体的技术决策和变动增量同步回文件，实现 README 或架构设计文档的随代码演进。
  
  - **OpenCode 的外部生态记忆层 (Supermemory)**：
    
    - **做了什么与怎么做**：核心库中主要依托工具级服务 `FileSystemSearch` ( glob/grep 命令行) 对代码库进行无索引实时精准查找。在生态层面（如 `opencode-supermemory` ），它将长效持久化记忆和外部多源知识库（ Notion , Gmail 等）托管给第三方的 **Supermemory** 引擎。该引擎结合了知识图谱与语义搜索，在跨会话中动态构建并自动更新用户偏好与事实关系，通过持续学习机制处理不同文档间的事实矛盾。

  - **Hermes Agent 的可扩展记忆提供商与异步预取**：
    
    - **做了什么 (应用场景与工具)**：设计了插件化的 `MemoryProvider` 架构，支持多后端切换（如 `supermemory`、`retaindb`、`mem0` 等）。大模型可调用 `supermemory_store` / `supermemory_search` 主动管理显式记忆。此外，它支持 **“自动对话摄取”**：开启 `auto_capture` 后，在每个对话 Turn 后清洗并暂存对话历史，当会话结束 ( `on_session_end` ) 或切换 ( `on_session_switch` ) 时，将全量对话整合成 `full_session` 格式的文档批量上传并更新记忆网。它还支持 **“多容器隔离”** ( `container_tag` )，利用 `{identity}` 变量根据智能体不同的虚拟身份自动对向量库数据进行物理区隔。
    
    - **怎么做的 (数据流与去重公式)**：
      1. **前置异步预取 (prefetch)**：在新 Turn 开始大模型生成前，系统利用 `MemoryManager` 提取用户最近 200 字符的输入作为 Query 向量，向 Supermemory 接口发送异步预取。
      2. **语义与事实去重 (_deduplicate_recall)**：从预取接口拉取持久静态事实 ( `static` )、近期动态事实 ( `dynamic` ) 及语义回忆 ( `search_results` ) 后，在后台使用哈希集合对这些重合度极高的知识段落执行严格的去重过滤。
      3. **时间与分值转换格式化**：去重后取 Top-K (默认 10 )。系统将时间戳换算为相对时间（如 `[just now]`, `[5m ago]`, `[2d ago]` ），将相似度转换为百分比，组装为形如 `- [2d ago] [86%] User prefers dark mode` 的行注入 Prompt 头部（用 `supermemory-context` 标签包裹），以帮助大模型直观判断记忆的时效度与关联度。
      4. **后台多线程写入**：为了规避网络 IO 阻塞主线对话响应，当触发 `on_memory_write` 时，系统自动通过派生 Python 独立后台线程（ `threading.Thread(daemon=False)` ）异步完成向量存储操作，优化响应延迟。

  - **Codex 的双阶段异步记忆管道 (Memory Pipeline)**：

    - **两阶段异步机制**： **异步提取记忆** 是 Codex 核心，通过 Stage 1 并发大模型提炼 rollout 摘要并落库，Phase 2 独占锁通过自省更新 `MEMORY.md` 。

    - **任务冷却退避**： **防 token 浪费** 机制通过设置 Phase 2 冷却期为 6 小时（ `PHASE2_SUCCESS_COOLDOWN_SECONDS` ），Stage 1 并发受 `max_running_jobs` 限制。

    - **悲观锁与重试**： **任务悲观加锁** 使用 SQLite `BEGIN IMMEDIATE` 进行，对失败任务限制 3 次重试，新 rollout 更新则重置重试计数。

    - **稳定排序选择**： **稳定排序读取** 逻辑筛选符合保质期的非空 rollout 摘要，按引用频次排序并以 `thread_id ASC` 进行稳定排序返回。

    - **Git差分自省**： **减少 token 盲读** 利用本地 Git 差分生成只读 `phase2_workspace_diff.md` ，派生无网络沙箱子智能体根据 diff 更新本项目的 `MEMORY.md` 。

  - **Gemini CLI 的分层静态规则与 JIT 目录级召回**：

    - **多级规则分层**： **规则静态分层** 将记忆规整为 `Global` 、 `Extension` 、 `Project` 与 `User Project` 4 级，使大模型操作不同范围时遵循对应约束。

    - **JIT 目录回溯**： **即时动态召回** 在读写文件时触发 `discoverContext` ，自受访目录 `accessedPath` 起向上回溯扫描至受信任根目录。

    - **多系统级去重**： **防止重复载入** 通过维护 `loadedPaths` 和文件系统级 Identity 去重，以应对 Windows 等大小写不敏感环境，降低 token 消耗。

    - **指令组装注入**： **指令组装注入** 将新检索到的各级 Gemini 规则文本通过 `concatenateInstructions` 拼接后直接追加注入 System Prompt 。

  - **Tinypace AI Desktop 的 RAG 二进制子进程管理**：

    - **独立二进制模块**： **外部模块集成** 将 RAG 功能托管给独立二进制文件 `tinypace-ai-docstore` ，暴露 `3105` 端口 HTTP `/v1` 接口由 GUI 和 CLI 交互。

    - **大纲了解构化**： **文档结构分析** 通过 `/v1/documents/:id/analyze` 对 PDF 或 Markdown 自动切片解析大纲，支持节点级语义查询。

    - **进程生命周期**： **进程生命周期** 依靠 Electron 主进程 `DocstoreService.ts` 进行 `spawn` 挂载，注入对应系统及配置环境变量。

    - **进程残留探测**： **无轮询开销** 记录 PID 文件，通过 `process.kill(pid, 0)` 优雅进行进程存活状态探测，避免轮询 PowerShell 命令。

    - **端口强制释放**： **端口清理释放** 对 Windows 定制 `gracefulKillOnWindows` 机制，先发 `SIGTERM` ，超时后通过 netstat 和 `taskkill /F` 强制杀死并清理端口。
## 3. 方案对比与推荐方向
为了给项目规划最佳的检索与记忆机制，针对三种路径进行了多维度对比：

| 评估维度 | 方案 A (纯 Agentic Search 实时检索) | 方案 B (传统向量 RAG 检索) | 方案 C (混合检索机制 Hybrid RAG) |
| :--- | :--- | :--- | :--- |
| **实时代码检索** | 极佳 ✓ (实时无延时) | 较差 ✗ (极易因修改导致索引失效) | 极佳 ✓ (代码部分走实时搜索) |
| **长效记忆管理** | 无法实现 ✗ | 优 ✓ (依赖向量空间语义计算) | **极佳** ✓ (大模型自省生成 Markdown 记忆) |
| **外部静态知识库** | 效率极低 ✗ (需遍历大文件) | 优 ✓ (分块向量化检索) | 优 ✓ (分块或编译为 machine-digest) |
| **可读性与可调试性** | 较高 ✓ | 极低 ✗ (向量数据对人是黑盒) | **极高** ✓ (记忆文件人类可直接编辑修改) |
| **系统架构复杂度** | 极低 ✓ (无需外部依赖) | 中 ✗ (集成本地向量库与嵌入模型) | 较高 ✗ (需后台子智能体与文件隔离) |
| **总体分析结论** | 简单但局限于代码 | 不适合高频更新的代码开发 | **最优选**。融合代码实时性与长效文本记忆 |

**推荐路径**：
本项目引入检索与记忆时，推荐采用 **方案 C (混合检索机制 Hybrid RAG)** 并分阶段落地：

- **第一阶段：轻量非阻塞提炼 (Lightweight Hook Memory)**
  - 在 `SessionEnd` 钩子中异步非阻塞调用 LLM 提炼近期对话的事实与经验，追加写入 `MEMORY.md` ；同时支持通过 `# MAGIC DOC` 头部注册项目文档的自动同步。并在下一次启动大模型推理前的 `BeforeModel` 钩子中加载该记忆文件并注入 System Prompt 。此阶段不涉及 Sub-Agent 实例。

- **第二阶段：子智能体隔离 (Forked Sub-Agent Sandboxing)**
  - 将第一阶段的记忆提炼与写入迁移至隔离的 Forked AgentLoop 子实例中。通过限制其可调用的工具集合，强制只允许其使用修改特定记忆路径（如 `MEMORY.md` ）的工具权限，实现安全沙箱化，解决大模型自省时的文件越权隐患。

- **第三阶段：混合向量检索 (Vector DB Integration)**
  - 当项目静态非结构化文档（如 PDF 协议规范）和长期记忆文件的 Token 体量超出单次限制时，在 `ports/driven/` 下抽象 `VectorDbPort` 接口，在 adapters 中实现基于 LanceDB 或 `sqlite-vec` 的本地向量数据库，对大规模知识进行语义切片与相似度召回。

## 4. 约束、风险与未知项
- **Token 额外开销风险**：
  
  - **开销控制**：后台自省智能体运行每次都会产生独立的大模型 API 调用。需要像 Claude Code 一样严格设计初始化和更新阀值（如 Token 增长限制和对话自然空闲期判断），防止 Token 账单翻倍。
  
- **路径修改越权隐患**：
  
  - **沙箱隔离**：后台智能体在执行 `FileEditTool` 或 `FileWriteTool` 写入记忆和更新文档时，必须在 `canUseTool` 中拦截并强制限定改写路径，绝对禁止其修改项目核心代码。

## 5. 否决方案
- **纯向量代码库检索 (Code-to-Vector RAG)**：
  
  - **否决原因**：在开发过程中，文件内容会高频改变。若将整个代码库完全向量化，增量索引同步的延迟会造成大模型获取过时的代码信息，从而引发开发幻觉；且向量匹配无法做到类似 ripgrep/LSP 那样 100% 精准定位函数定义。
