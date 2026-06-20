# 探索主题: Agent 系统提示词（System Prompt）优化分析

## 1. 问题定义
目前 MyAgent 项目的 `BASE_SYSTEM_PROMPT` 定义较为简单，仅包含了一些基本的沙盒工作区限制 and 操作系统的原语限制。在实际开发调试中，该提示词缺乏针对“防止过度设计/范围蔓延”、“工具优先使用级”和“交互效率”的精细化控制约束。

在缓存设计上，目前系统虽然通过“一次性初始化后持久保存在消息栈首部”的方式在单会话内保持了 100% 的前缀物理稳定，但也由于这种纯静态设计，使得系统提示词中**完全缺失了环境感知信息**（如当前工作区路径 CWD、OS 版本、Platform 平台以及最近修改的文件）。如果未来要为 Agent 补充这些必要的运行期环境上下文，若不引入动静隔离的缓存边界设计，则会不可避免地导致前缀哈希频繁变动，从而破坏 Prompt Cache 的命中率。因此，本项目旨在实事求是地分析如何优化系统提示词的文本规约和架构设计。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 当前项目的系统提示词定义在 [prompts.ts](file:///d:/Projects/MyAgent/src/brain/prompts/prompts.ts#L10-L21) 中。
  - 核心提示词 `BASE_SYSTEM_PROMPT` 混合了人设、工作区限制、中英文翻译要求和 Windows 原子命令限制。
  - 通过深入阅读 [context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts#L73-L78)，我们确认 `systemPrompt` 在 `SessionContext` 的构造函数初始化时被一次性生成并压入 `messageHistory` 栈顶，后续轮次完全被复用。这确保了在当前会话生命周期内，首条 System 消息前缀是完全固定且能 100% 稳定命中 Prompt Caching 的。
  - 缺点是提示词中完全无法安全拼接任何动态环境参数（如 CWD、时间戳、shell 等），这使得 Agent 运行过程中处于“环境盲区”，增加了因缺乏路径及平台感知而导致工具调用出错的风险。
  - [contextLoader.ts](file:///d:/Projects/MyAgent/src/brain/contextLoader.ts#L11-L29) 中虽然有加载 `global_rules.md`，但此文件目前在物理磁盘上为空，意味着实际运行时没有任何全局规则辅助约束。
- **核实与洞察**：
  - **Claude Code 提示词设计深度调研**：
    - **Block级动静隔离缓存架构 (api.ts & claude.ts)**：
      - `claude-code` 系统提示词在底层并不是以单一字符串形式发送给 Anthropic API，而是拆分为由多个 Content Block 组成的数组。
      - 其核心是 `splitSysPromptPrefix(systemPrompt, options)` 函数。该函数以 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 作为物理分隔符，将系统提示词分为静态块集合和动态块集合。
      - 静态块（如核心人设、工具优先级、代码开发准则）合并为 `staticJoined`，并打上 `cacheScope: 'global'` 标签；动态块（包含频繁变动的当前 CWD、Shell环境、OS 版本、系统 Cutoff 等）合并为 `dynamicJoined`，`cacheScope` 设为 `null`。
      - 底层 API 适配器（`claude.ts` 中的 `buildSystemPromptBlocks`）遍历这些块，将其映射为 `TextBlockParam`。只有静态块才会被赋予 `cache_control: { type: 'ephemeral' }` 属性。
      - 这种设计极其精妙：由于核心静态人设和动态环境感知（CWD, Time）彻底隔离为两个 Content Block，因此最庞大的静态指令不仅可以在当前会话中长效命中缓存，即使在用户**切换项目目录（CWD 变动）、开启新会话**甚至在不同的 Organization/租户中运行时，这部分高达数千 Token 的核心人设也**永远跨会话 100% 缓存共享**。
    - **任务执行边界规范 (Doing tasks)**：
      - `claude-code` 提示词对大模型的修改范围设立了极其严厉的“红线”：
        1. **不做超纲开发**：明确指示不要添加请求之外的 feature，不要进行多余的重构。一个 Bug 修复不需要顺便去清理周围代码，一个简单功能不需要额外的可配置性。
        2. **不乱加注释**：绝对禁止在未做修改的代码中添加 JSDoc、注释或类型注解。只有在逻辑确实不自明时才在修改处加注释。
        3. **不做 speculative（假设性）超前抽象**：规定不做针对假想未来需求的架构设计，三行重复的代码胜过过早引入的类/函数抽象。
    - **工具调用优先级准则 (Using your tools)**：
      - 提示词明确指示大模型，只要有专用的 API 工具，就**绝对禁止**调用通用的终端 Shell 工具（`BashTool`）来执行等价命令：
        - 读文件优先使用专用的读文件 API（如 `FileReadTool`），禁止在 bash 中使用 `cat`、`head`、`tail`、`sed`。
        - 写文件优先使用专用的写文件 API，禁止在 bash 中使用 `echo` 重定向或 `cat <<EOF`。
        - 查找/过滤文件使用专用的 Glob/Grep 检索 API，禁止在 bash 中使用 `find`、`ls`、`grep` 或 `rg`。
        - 终端 Shell（`BashTool`）被严格限定为只能执行编译、测试或者确实无法由 API 覆盖的底层系统管理命令。
    - **安全与影响范围控制 (Executing actions with care)**：
      - 提示词在核心人设中加入了“可逆性与影响半径（Reversibility and Blast Radius）”的评估准则。
      - **高危不可逆操作的二次拦截**：任何涉及破坏性（如删除文件、drop 数据库、kill 进程、覆盖未提交更改）或难逆转的操作（如强制推送、hard reset、修改 CI/CD），模型在静态提示词层面上被强制约束为：**默认必须主动暂停，在文字回复中向用户说明，并由用户交互式批准后方可执行。**
      - 禁止大模型在遇到阻碍时采用“跳过安全校验（如 `--no-verify`）”的捷径去简单回避问题。
  - **OpenCode 提示词设计深度调研**：
    - **多提供商自适应提示词机制 (system.ts)**：
      - `opencode`（基于 Effect-TS 构建的 monorepo agent 平台）在 `system.ts` 中通过 `provider(model)` 方法实现了多模型自适应提示词机制。
      - 它根据当前模型提供商（GPT-4/o1/o3 匹配 `beast.txt`、普通 GPT 匹配 `gpt.txt`、Gemini 匹配 `gemini.txt`、Claude 匹配 `anthropic.txt` 等）动态路由不同的核心基线人设文件。这种模型差异化的基准提示词能最大限度发挥不同大语言模型的固有特性与优势。
    - **极致简短与严格行数控制 (default.txt)**：
      - **行数绝对控制**：规定模型 `You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.`。
      - **单字最佳原则**：明确提出 `One word answers are best.`，并配备了多轮短小问答的 XML 级 `<example>` 示例，严密拦截了 AI 常见的“Here is the answer...”或“Here is what I will do next...”等废话前言和结尾。
      - **严防说教式回复 (Preachy Tone Guard)**：非常犀利地规定，当无法或不能向用户提供帮助时，模型**绝对禁止**去解释“为什么不能”或“这可能导致什么后果”，因为这显得极其说教（preachy）和令人讨厌。模型只能简单说 1-2 句话或直接提供替代方案。
    - **环境感知与依赖安全规范**：
      - 在系统提示词的环境 `<env>` 块中，除了 CWD、平台、Git 状态外，还特意注入了 `<available_references>`，即多工作区/多参考路径目录大纲。
      - **绝对禁止盲猜依赖**：在开发新文件或修改代码引入新库时，规定 `NEVER assume that a given library is available, even if it is well known.`。必须首先检查 `package.json`、`cargo.toml` 等元数据文件，确定当前项目已引入该依赖。
    - **质量与工程校验规约**：
      - **全删注释**：相较于 `claude-code` 稍微宽松的注释规则，`opencode` 采取了更极端的规约：`DO NOT ADD ***ANY*** COMMENTS unless asked`（除非明确被要求，绝对禁止在代码中添加任何注释）。
      - **Lint与编译闭环校验**：要求任务完成后模型**必须**主动在 bash 中运行 lint 和 typecheck。若找不到命令则问用户，并主动引导用户写入项目级 `AGENTS.md` 规约文件中进行固化。
      - **防止过度主动 Commit**：明文规定除非用户明确指令，否则智能体绝对禁止自动执行 Git Commit 操作。
  - **Hermes 提示词设计与缓存策略调研 (system_prompt.py)**：
    - **三层架构组装模式 (Three-Tier Prompt Structure)**：
      - `hermes-agent`（基于 Python-uv 的 Agent）在系统提示词管理中定义了极其规范的三层体系，通过双换行符 `\n\n` 拼接，既隔离了变化，又保障了缓存：
        1. **`stable` (稳定层)**：存放物理不变的 persona 身份信息（可由项目内 `SOUL.md` 自定义，或使用 `DEFAULT_AGENT_IDENTITY` 兜底）、通用任务完成指南、大模型特定调试参数（Gemini/GPT 不同的 conciseness 规约）、静态技能列表、环境 hints 等。
        2. **`context` (上下文层)**：存放与当前运行的工作目录（CWD）直接相关的项目配置信息（如当前路径下发现的 `AGENTS.md`、`.cursorrules` 等）。
        3. **`volatile` (易变层)**：存放每次大模型调用或者 Session 变更时会实时修改的信息（绝不予以缓存）。包含内存记忆（`USER.md` profile 等）和粗粒度时间戳信息。
    - **缓存一致性与单次构建契约 (Single Build Contract)**：
      - 该项目在系统提示词的前置注释中明确声明：*“The agent's system prompt is built once per session and reused across all turns — only context compression triggers a rebuild.”* 整个 System Prompt 字符串只在 Session 初始化时被构建一次，并在内存 `agent._cached_system_prompt` 中进行绝对哈希锁定。只有在发生**历史消息压缩截断（context compression events）**时，才会显式使缓存失效（调用 `invalidate_system_prompt`）并重新组装，从而最大限度地保障上游 Prefix Cache 的“温热（warm）”命中。
    - **粗粒度时间戳设计 (Date-Only Invariant)**：
      - `hermes-agent` 的一大极其优秀的缓存设计在于**不输出“分钟”或“秒级”时间戳**，而是只输出 `Date-only (not minute-precision)`（仅输出天级别的日期，例如 `Conversation started: Saturday, June 20, 2026`）。
      - 提示词注释强调：**高精度的时间变化会导致整段 Prompt 即使在一轮之后也会因哈希变动而让 Prefix Cache 全部失效。** 将日期限制在“天”级，可以确保该 Prompt 在 24 小时内对于 Caching 是完全字节稳定（byte-stable）的；如果大模型需要精准时间，则指导其通过执行专用工具获取。
  - **OpenClaw 提示词与资源加载调研 (resource-loader.ts)**：
    - **系统提示词自动发现机制 (System Prompt File Discovery)**：
      - `openclaw` 包含一个精巧的 `DefaultResourceLoader`。在构建系统提示词时，它定义了 `discoverSystemPromptFile()` 和 `discoverAppendSystemPromptFile()` 自动发现机制。
      - 系统会优先尝试寻找当前工作目录下的本地配置目录（例如 `.openclaw/SYSTEM.md` 和 `.openclaw/APPEND_SYSTEM.md`），若不存在则回退加载全局 `agentDir` 目录下的对应 Markdown 文件。
      - 这种基于标准物理 Markdown 文件的发现机制能够以“零侵入”的形式让用户、团队和特定项目无感覆写（Overwrite）或追加（Append）系统级提示词，极具灵活性与扩展性。
    - **提示词链式转换与拦截器设计 (Settings/Loader Transformer)**：
      - `resource-loader` 提供了 `systemPromptTransform` 和 `appendSystemPromptTransform` 插件钩子机制。这允许核心系统外的插件或运行时拦截并对加载出的基础提示词进行链式转换和加工，为微观代码规约的动态注入提供了非常强健的代码骨架。
  - **通用 Coding Agent 最佳实践**：
    - 过于繁琐的 20 步清单不如画好“红线（Boundaries）”和“质量标准（Goals）”，把剩余的任务拆解和推理权交给模型本身的思考能力。
    - 针对高危或不可逆操作（如 `rm -rf`，删除分支，强制覆盖未提交代码），必须在提示词中强制智能体主动暂停并请求用户确认。

## 3. 方案对比与推荐方向
我们将当前项目的提示词设计与拟优化（融合兼容性单消息动静隔离与 `.agent` 目录矫正）的方案进行对比：

| 评估维度 | 方案 A：完全静态拼接型（当前方案） | 方案 B 改进版：单消息动静边界隔离型（终选方案） | 选型分析 |
| :--- | :--- | :--- | :--- |
| **单会话缓存命中率** | 100% [Y]<br>首条 System 消息在内存中完全复用，长对话前缀绝对物理稳定。 | 100% [Y]<br>静态核心置于单条 System 消息头部，依然能 100% 稳定命中缓存。 | 双方案持平 |
| **环境感知能力** | 无感知 [N]<br>由于害怕破坏前缀缓存，完全无法将当前工作目录（CWD）、系统版本、平台等必要环境信息注入系统提示词。 | 强感知 [Y]<br>在缓存隔离边界后动态拼接当前 CWD、OS 等，提供全方位的环境上下文。 | 方案 B 改进版占优 |
| **跨会话/多目录复用率** | 极低 [N]<br>只要切换了工作路径重新启动，如果试图在 Prompt 里写入新的 CWD，缓存就会因头部哈希变化而全量失效。 | 极高 [Y]<br>通过首个大消息内前置静态核心人设并加物理隔离，跨目录也能复用头部静态缓存，极其高效。 | 方案 B 改进版占优 |
| **代理网关兼容性** | 极高 [Y]<br>单 System 消息。 | 极高 [Y]<br>放弃多 System 消息分块传输，采用单 System 消息拼接以杜绝 OneAPI/LiteLLM 等网关协议转换的报错风险。 | 方案 B 改进版占优 |
| **规则目录定位** | 无 [N]<br>未自动扫描本地自定义规则。 | 强规范 [Y]<br>将本地自定义规则自动发现定位在 `.agent/` 配置与规则中心，确保可跟踪与 Git 多端同步，避免写入易失的临时 `.myagent/`。 | 方案 B 改进版占优 |
| **时间感知精度** | 无时间感知 [N]<br>当前方案完全不包含任何动态环境信息（包括时间戳），大模型运行于时间盲区。 | 高精度 [Y]<br>System Prompt 保持天级，同时新增原生 `get_current_time` 工具按需获取分秒级高精度时间，完美平衡缓存与感知。 | 方案 B 改进版占优 |
| **防止过度设计与超纲代码** | 弱 [N]<br>无任何对于重构、额外新增无用文件或注释的约束，AI 容易自由发挥。 | 强 [Y]<br>增加明确的任务边界红线约束（如“最小重构原则”和“严格遵循规范”）。 | 方案 B 改进版占优 |
| **工具调用规范性** | 弱 [N]<br>大模型倾向于用 shell 命令做各种基础操作，容易在 Windows 环境下产生语法兼容性或沙箱越权错误。 | 强 [Y]<br>强制明确专用 API 工具与终端命令的优先级（优先专用工具，终端仅用于执行或测试）。 | 方案 B 改进版占优 |
| **高危操作安全性** | 弱 [N]<br>无高危操作警示，大模型可能会直接静默执行破坏性代码。 | 强 [Y]<br>在静态 Prompt 写入对破坏性/不可逆操作的强制确认拦截，确保用户知情同意。 | 方案 B 改进版占优 |

**推荐路径**：
选择 **方案 B 改进版（兼容性单消息动静隔离 + 现有配置规则复用）** 对当前项目的系统提示词及缓存架构进行重构：

### 🛠️ 1. 缓存友好型动静物理隔离架构（适配 OpenAI 自动前缀缓存）
- **单 System Message 组装结构与 XML 语义边界（三层架构设计）**：
  - 重写 `src/brain/context.ts` 的 `SessionContext` 初始化，维持单 System 消息结构，使用标准的 XML 标签进行物理加语义的双重隔离（利用清晰的 XML 元素标记能有效提升核心指令块与上下文在长上下文中的结构语义可读性与解析性，避免被大模型误判为一般的 Markdown 排版元素）：
    ```typescript
    const messageHistory = [
      {
        role: 'system',
        content: `<!-- 1. stable (稳定人设层，绝对静态，100% 缓存命中) -->
                 [BASE_SYSTEM_PROMPT (绝对静态的核心指令规范)]
                 
                 <!-- 2. context (上下文环境层，工作区级稳定) -->
                 <context_rules>
                   <available_skills>
                     [全局技能目录大纲 (来自 .agent/skills/)]
                   </available_skills>
                   <local_rules>
                     [现有本地规则 (来自 .agent/global_rules.md 等)]
                   </local_rules>
                 </context_rules>
                 
                 <!-- 3. volatile (易变数据层，高频变动，不予缓存) -->
                 <volatile_context>
                   <date>Sat, Jun 20, 2026 (天级日期)</date>
                   <cwd>d:\\Projects\\MyAgent (当前工作路径)</cwd>
                   <os>Windows</os>
                 </volatile_context>`
      },
      ...
    ];
    ```
  - **三层架构设计与技能目录落位说明**：
    - **`stable` (稳定人设层)**：存放绝对静态的人设指令与红线。作为 Token 的大头，跨 Workspace / 会话物理上 100% 固定。
    - **`context` (上下文环境层)**：存放当前工作区专属的规则配置与技能大纲（`<available_skills>` 和 `<local_rules>`）。因为技能目录并非高频瞬时数据，而是工作区相对稳定的上下文。将其从静态层剥离是为了防范用户在开发调试阶段频繁修改技能而引起整段静态人设缓存击穿。放入 `context` 层不仅保护了顶部的静态人设，还能在同一个工作区开发时共享高频温热的前缀缓存。
    - **`volatile` (易变数据层)**：存放完全随启动路径、时间变化而变动的微小参数。这部分置于尾部，作为牺牲层，即使它高频失效也不影响前面 `stable` 和 `context` 部分的缓存前缀匹配。
  - 静态指令置于头部，动态变量拼接于尾部。即使动态部分改变，头部大段静态 Token 依然能 100% 触发 OpenAI 自动前缀缓存，同时保持最佳的网关兼容性。

### 🕒 2. “天”级粗粒度时间戳限制
- **前缀缓存保护**：System Prompt 中仍旧仅提供“天级”粗粒度时间戳（如 `Date: Saturday, June 20, 2026`），避免分秒级高频变动导致前缀缓存哈希失效。
- **高精度原生时间工具（get_current_time）**：
  - **定位与注册**：在系统工具链中新增一个轻量级的原生时间获取工具 `get_current_time`，并将其正式注册到 `toolRegistry` 中，供 Agent 运行时通过 Tool Call 显式调起。
  - **副作用属性**：该工具属于**只读系统调用，无任何副作用 (Read-Only & No Side Effects)**。
  - **Tool Definition 伪代码草案**：
    ```typescript
    export const getCurrentTimeTool: ToolDefinition = {
      name: 'get_current_time',
      description: '获取当前操作系统的精确高精度时间戳，适用于分析日志时间差、计算操作耗时或需要分秒级精度定位的场景。',
      parameters: {
        type: 'object',
        properties: {}, // 无输入参数，直接返回系统时间
        required: []
      },
      execute: async () => {
        return {
          success: true,
          formattedTime: new Date().toISOString(), // 返回标准 ISO 格式时间
          localTime: new Date().toLocaleString()
        };
      }
    };
    ```
    当 Agent 需要执行排查几分钟前的构建日志、计算执行时长等依赖精确时间的诊断场景时，通过调用此原生工具按需查询，既保护了 Prompt Cache 前缀，又在逻辑上赋予了智能体精准的时间感知能力，同时避免了使用终端执行时间命令带来的系统开销 and 不确定性。

### 📁 3. 现有规则加载与 Token 防爆防御熔断机制
- **沿用现有规则体系**：规则文件直接使用项目已有的定位与命名，即直接从本地 `.agent/` 配置中心（如 `.agent/global_rules.md`、`.agent/rules/guize.md`）中自动加载现有规则，无需进行额外的路径映射（`.myagent/` 本身作为临时与缓存文件存放地，亦无需做规则文件的多余映射）。
- **动态配置爆炸防御机制 (Token OOM 保护)**：在规则文件加载器（如 `contextLoader.ts`）载入这些现有本地规则文件时，引入大小熔断机制（Soft Limit / Truncation）。设定单文件读取阈值为 20KB（或 5000 字符），一旦检测到开发者误操作导致规则文件超大，自动进行物理截断并在尾部注入 `\n[...系统规则过长，已被安全模块截断...]`，从代码底层彻底阻断 Token 溢出引发的全局崩溃。

### 📜 4. 核心规约文本（BASE_SYSTEM_PROMPT）精细重构
在 `BASE_SYSTEM_PROMPT` 中补充以下红线条款：
- **做任务红线 (Doing Tasks)**：
  - **最小重构原则**：仅针对请求的范围进行修改，绝对禁止顺便清理周围代码、增加未请求的 feature。
  - **严格遵循 JSDoc/TSDoc 规范**：修改代码时必须在 API 声明正上方编写严格的 JSDoc/TSDoc 注释（移除类型声明，参数用 `@param name - 描述` 语法，返回值描述采用 `@returns 描述` 语法），非必要不乱加注释，严禁对未修改代码乱加 JSDoc。
- **工具调用级偏好 (Using Tools)**：
  - **专用工具优先**：凡是可用原生工具（如文件读写 `read_file` / `write_to_file`、目录查询 `list_dir`、ripgrep 检索 `grep_search` 等）完成的操作，**绝对禁止**调用通用的终端 Shell 工具（`BashTool`）执行 `cat`, `sed`, `awk`, `find`, `grep` 等等。终端 shell 命令仅用于编译、测试等确实无法由原生工具覆盖的底层系统管理命令。
- **Windows 命令安全与 Blast Radius 控制**：
  - **命令原子化**：强制单次仅执行一个原子的原生 Windows 命令，绝对禁止使用连接符（如 `&&`, `||`, `;`, `&` 等）或复杂的管道（`|`）将多个独立操作拼接为单条长命令。
  - **高危拦截确认**：对任何涉及高危、破坏性或难逆转的操作（如强制覆盖未提交代码、删除本地配置、kill 进程等），模型必须暂停并在文字回复中详细解释，并在征求用户确认后方可调起工具。
- **防说教中立口吻 (Tone Guard)**：
  - 开门见山，如果无法向用户提供帮助，仅用 1-2 句中立回复并给出可替代备选方案，绝对禁止长篇大论去教育用户或做假设性警告。
- **质量校验自测引导（软引导）**：
  - 要求大模型在修改代码后，主动查阅 package.json 或类似元数据文件，主动调用终端执行 lint 和 typecheck 闭环验证。
- **Post-Run Hook 自动硬校验机制（工程硬拦截）**：
  - 鉴于单纯依赖 Prompt 的行为引导在长上下文或复杂任务下存在模型漏执行或“阳奉阴违”的逻辑盲区，本方案提出在代码引擎层建立 **PostRunHook 机制**：即在 Agent 完成一轮任务写操作后，由系统代码底层自动调起本地的 lint / typecheck 工具进行编译级强质量校验。若校验报错，将错误信息自动反馈给 Agent，以此构建高可靠的工程自测闭环，而不单纯寄希望于模型的自觉执行。

---

## 4. 验证计划

### 自动化与测试验证
- **缓存命中率测试**：
  - 编写自动化脚本，在不同 workspace 路径下并发调起 `MyAgent` 执行单次查询。
  - 通过检查 API 返回的 `usage.prompt_tokens_details.cached_tokens`，验证静态 `BASE_SYSTEM_PROMPT` 是否跨项目、跨会话 100% 命中缓存。
- **系统提示词拼接与 XML 隔离测试**：
  - 编写单元测试（对应 `test/session/prompt.test.ts`），断言在 CWD 切换、本地 `.agent/global_rules.md` 等现有规则文件存在/不存在、以及技能目录加载等边缘场景下，最终组装出的单个 System Message 格式与内容完全符合预期，且正确嵌套在 `<dynamic_context>` XML 结构内。
- **配置熔断截断机制（Token OOM 防御）测试**：
  - 编写单元测试，模拟向现有规则文件写入大于 20KB 的超长文本，断言 `contextLoader.ts` 能够自动触发截断并拼入截断占位符，且组装出的提示词长度未超出安全水位线。
- **原生时间工具测试**：
  - 编写单元测试，验证 `get_current_time` 工具是否能正确返回符合标准格式的当前高精度系统时间。

### 手动验证
- **熔断测试**：创建一个巨大的本地规则文件，验证系统是否能正常运行不发生 Token 耗尽或溢出。
- **软硬双重高危拦截测试**：
  - 软拦截：验证当大模型试图执行删除/重置等操作时，是否会在文字中主动暂停并解释。
  - 硬拦截：模拟模型忽略 Prompt 规范直接发出 `rm` 等高危 tool_call 的极端情况，验证底层工具执行引擎（Tool Execution Engine）是否能够被 ApprovalService 强制挂起并向用户弹出显式审批流。
- 验证大模型在修改代码后是否能主动调用 lint 和 typecheck 命令。
- 验证 PostRunHook 机制在 Agent 任务完成时是否能被正确触发，并能成功捕获 lint 错误并反馈给大模型。
- 验证在 System Message 中包含 `.agent/global_rules.md` 和 `.agent/rules/guize.md` 等现有规则文件内容时的合并行为。

---

## 5. 约束、风险与未知项
- **与全局/工作区规则的冲突**：如果在 `BASE_SYSTEM_PROMPT` 中写入了过多的微观代码规范，可能会与用户在 `global_rules.md` 或 `guize.md` 中定制的特定项目规范产生逻辑冲突，因此 `BASE_SYSTEM_PROMPT` 应当只定义宏观的“工程与工具红线”，将微观语言规范交由 JIT 规则插件或局部规则注入。
- **高危拦截的“软硬结合”防线**：大模型在长上下文或高负载推理下，存在“遗忘”System Prompt 中的高危暂停指令而直接抛出危险 tool_call 的风险（“阳奉阴违”）。因此，System Prompt 的软约束仅作为第一道指引防线，必须配合代码库中原有的 ApprovalService，在底层工具执行引擎（Tool Execution Engine）层面建立“硬约束拦截”——当原生工具接收到删除文件、覆盖未提交代码等高危参数时，强制挂起（Suspend）执行流并向用户拉起显式授权，实现“Prompt 软引导 + 引擎硬拦截”的安全闭环。

## 6. 否决方案
- **全量规则硬编码方案**：把所有的代码风格规范、所有的技能详细指南全部糅杂到 `BASE_SYSTEM_PROMPT` 中。这会被舍弃，因为它会导致 Prompt 体积过度膨胀，破坏大模型推理焦点的专注度，并且极大地增加 Token 消耗。
- **多 System 消息架构方案**：将静态和动态部分作为不同的 System 消息发送。这会被舍弃，因为部分严格的中间网关遇到多个 System 消息时会直接报错或丢弃，兼容性风险较高。
