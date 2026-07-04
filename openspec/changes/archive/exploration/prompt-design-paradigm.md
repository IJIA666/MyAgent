# 探索主题: 智能体提示词设计范式与系统工程化对齐

## 1. 问题定义
在开发智能体（Agent）时，开发者常感觉系统提示词（System Prompt）过于死板、机械，甚至充斥着“必须(MUST)”、“绝对禁止(MUST NOT)”等命令性语气，限制了模型的创造力。我们需要探究在工业级 Agent 系统工程中，提示词的设计范式是应当追求“高确定性的硬规则（Hard Rules）”，还是“自适应的柔性动态指示（Flexible Prompts）”。

## 2. 关键发现与调研结果
- **代码库现状**：在当前的 `MyAgent` 以及 `Claude Code` / `Hermes Agent` 源码中，系统提示词大多包含多条加粗的红线规范（如最小重构、禁止复合命令、超时和未知报错硬阻断等），带有强烈的工程指导性。
- **竞品项目静态分析（针对动态提示词装载与编译）**：
  深入剖析 `Agents` 目录下的优秀开源项目，它们在规避“静态提示词僵化与脆弱性”上的工业级实现如下：
  1. **Claude Code 的“模块化提示词编译器（Prompt Compiler & Boundary Marker）**：在 [prompts.ts](file:///d:/Projects/Agents/claude-code/src/constants/prompts.ts#L444) 的 `getSystemPrompt` 中，Claude Code 将系统提示词拆分为十多个独立的 `systemPromptSection` 模块（如 `env_info_simple`, `scratchpad`, `output_style`, 以及动态加载的 `mcp_instructions`）。更硬核的是，它在静态内容和动态内容之间设置了 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`（边界标记），让大模型服务商的 Prompt Cache 能够 100% 稳定缓存高价值的静态法典区，大幅拉低了运行延迟与 token 损耗。
  2. **OpenClaw 的“异步具身提示词回调（Async Embodied Prompts Callback）**：在 [agent-harness.ts](file:///d:/Projects/Agents/openclaw/packages/agent-core/src/harness/agent-harness.ts#L393-L405) 中，OpenClaw 支持将 `systemPrompt` 挂载为一个异步计算函数。在每个交互轮次（Turn）发起前，运行时将环境变量 `env`、当前会话状态实例 `session`、模型 `model`、思维级别 `thinkingLevel`、实际激活的工具集 `activeTools` 以及资源对象 `resources` 作为具身 Facts 传入回调，从而生成针对当前环境深度定制的系统提示词。这使得提示词能随工具链和环境的变化自适应伸缩，彻底解决了“硬编码静态提示词在缺失工具环境下的退化”问题。
  3. **Hermes Agent 的“前缀缓存保温三层结构（Three-Tier Invariant & Platform Overrides）”**：在 [system_prompt.py](file:///d:/Projects/Agents/hermes-agent/agent/system_prompt.py) 中，Hermes 为了解决规则死板与前缀缓存命中（Prefix Cache）的冲突，在源码文件头注释中明确定义并拼装了三层结构：(a) `stable` Tier（包含身份 SOUL.md/DEFAULT_AGENT_IDENTITY 以及并发工具调用指南 PARALLEL_TOOL_CALL_GUIDANCE），该层通过一次会话内绝不重绘保证上游缓存永远温暖；(b) `context` Tier（动态扫描当前工作区下的 `AGENTS.md` / `.cursorrules` 等就地挂载）；(c) `volatile` Tier（注入高频变化的 Memory 动态快照和 SessionID/时间戳）。同时，它提供了 `_resolve_platform_hint` 平台提示重写机制，根据宿主机配置动态 `replace` 提示词内容，消除了死板规则与物理操作系统环境的排异反应。
  4. **OpenCode 的“结构化压缩与错误类型解耦（Structured Compaction & ToolResult Classification）**：在 [to-llm-message.ts](file:///d:/Projects/Agents/opencode/packages/core/src/session/runner/to-llm-message.ts#L39-L68) 中，OpenCode 在将工具执行反馈转译给 LLM 时进行了强类型的分类处理。如果捕获到报错（status == 'error'），它会自动在 `ToolResultPart` 注入由错误码、具体内容组成的错误元数据，并显式标记 `resultType: "error"` 传递给模型，实现了底层逻辑对“错误判定”的直接解耦，消除了模型语义正则的脆弱性。同时，其在发生上下文压缩时自动生成包裹在 `<conversation-checkpoint>` 和 `<summary>` 标签下的结构化提示词，成功防范了提示词因对话长背景产生的漂移。
- **核实与洞察**：
  通过对业界（如 Anthropic Prompt Guide, System Prompting in Agentic Systems 等）的最新实践进行检索，提炼出以下核心共识：
  1. **从“玄学咒语”走向“操作手册”**：工业级 Agent 的 System Prompt 本质上是系统的“物理规律”。为了防止 LLM 在长 Trace 交互中产生认知漂移（Cognitive Drift）和碰运气行为，必须使用结构清晰的 XML 标签和命令性语言（MUST / SHALL）定义物理边界与红线防御。
  2. **静态宪法与动态注入分离（Modular Prompts）**：控制提示词变动与前缀缓存命中的折中原则：
     - **Stable Layer (静态稳定层 - 启动时动态编译，会话中绝对固化)**：定义不可动摇的物理定律（如文件沙箱、终端安全、报错阻断等）。**它的动态性仅发生在系统冷启动初始化阶段**（根据当前 OS、可用工具 facts 等编译生成），一旦会话开始进入执行循环（Agent Loop），该层必须在随后的所有 Turn 中**绝对保持静态字节不变**，以保全大模型上游的前缀缓存（Prefix Cache）命中，减少延迟。
     - **Volatile Layer (动态注入层 - 位于缓存边界之后)**：根据高频变动的信息（如 Memory 动态快照、时间戳、瞬时上下文等）动态装载，必须置于提示词的最末尾（利用边界标记隔离），以防其变动导致 Stable 层的缓存暖命中完全破产。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：全静态硬编码 | 方案 C：静动分离三层架构 | 方案 D (推荐)：结构化错误特征动态注入 | 方案 E (推荐)：具身环境 Prompt 编译器 |
| :--- | :--- | :--- | :--- | :--- |
| **硬编码依赖度** | 极高 ✗ (字面量硬写死在 Prompt) | 较高 ✗ (规则字面量依然存在) | **极低 ✓ (报错解析解耦，由代码分类注入)** | **低 ✓ (根据当前沙箱与 OS 动态组合编译)** |
| **异常检测鲁棒性**| 差 ✗ (报错文本改变即规则失效) | 差 ✗ (依然依赖模型语义正则匹配) | **极极高 ✓ (底层统一映射，模型仅路由 XML 标签)** | 一般 ✓ (主要改善环境适配，不解决异常变化) |
| **异构环境适应力**| 差 ✗ (在缺失某些工具的沙箱会阻碍运行) | 差 ✗ (静态提示词规则会与实际环境冲突) | 中等 ✓ (保持一致的异常路由) | **极极高 ✓ (依据可用工具 facts 动态生成规则)** |

**推荐路径与迭代路线（务实演进）**：
结合当前架构现状与 OpenAI 协议的具体特征，剔除冗余设计后，本项目的提示词鲁棒性提升采取极简的务实演进策略：

1. **当前阶段：方案 C 基础落地（已完成）**
   - **状态**：通过 `mcp-stability-enhancement` 与 `agent-error-attribution-constraint` 两个活跃变更，`BASE_SYSTEM_PROMPT` 的三分支规约设计成功落地，保障了未知异常下的强卡关拦截与人机协作。
   - **缓存与 OS 编译**：当前 `buildSystemPrompt` 已是 stable -> context -> volatile 三层层级。由于 OS 特定指令已在模块加载时完成了一次性编译固化，且 OpenAI 协议下的 Prefix Cache 是由模型服务商自动触发的，当前的分层顺序已是最优工程实践，无需任何额外改动。
2. **未来长期演进：方案 D 的 JSON 元数据注入（等痛点驱动，优先级：中）**
   - **触发条件**：当前基于文本字面量正则匹配的异常拦截在本项目运行中已足够有效。未来若遇到因“匹配文案改变导致分类失效”的真实痛点时，再行启动此演进。
   - **协议适配**：改动时，不采用 XML 标记，而是直接在 `ToolResult` 报文中以 OpenAI 协议契合度更高的 **JSON 属性** 直接回传底层 TypeScript 解析后的错误分类标签，保障解析的极高鲁棒性。
3. **降级预留：方案 E 的冷启动具身（优先级：低，有需要时再考虑）**
   - **价值重估**：在 OpenAI 协议下，可用工具的能力声明（Capability Annotation）是通过每次 API 请求中携带的 `tools` 参数原生解决的，模型通过 Function Calling 已能完全获悉可用工具及其 Schema。因此，在系统提示词中重复声明“你有浏览器/MCP工具”属于完全冗余。
   - **保留价值**：方案 E 仅在“需要消除因某些工具不可用带来的规则噪音（如在无浏览器环境时剔除浏览器使用限制以减少 token）”时有微小价值。但当前此类规则极少，增量价值微乎其微。故将其从下一步计划中移除，降为“有明确噪音痛点时再考虑”的预留机制。

## 4. 约束、风险与未知项
- **Cache 命中失效**：如果动态注入的信息混入了 Stable 层，会导致大模型服务商的 Prompt Cache 命中率下降，增加额外开销。
- **提示词膨胀（Prompt Bloat）**：规则越加越多会导致大模型漏掉部分指令（Attention Decay），必须定期审计并剥离失效的“死板”规则。

## 5. 否决方案
- **纯柔性自适应指示（方案 B）**：完全不加硬性 MUST 规则，完全交由大模型自由发挥。在修改文件和调用终端命令时，幻觉与越权概率呈指数级飙升，严重违背安全稳定性底线，故坚决否决。
