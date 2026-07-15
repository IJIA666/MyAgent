# 系统提示词竞品调研

> 调研开始日期：2026-07-15  
> 调研对象：Claude Code、Codex、OpenCode、Hermes Agent、OpenClaw  
> 调研目的：为 MyAgent 系统提示词优化提供跨项目源码事实；全部批次持续维护在本文件中

## A. Claude Code

### A.1 结论摘要

Claude Code 的优势不在于“有一份短而优雅的系统提示词”。它的默认提示词同样很长，包含明显的模型版本补丁、A/B 开关、强措辞和产品专属说明，直接复制文本没有价值。

真正值得借鉴的是它把 prompt 当成运行时系统治理：

1. 默认提示词由多个具名章节组成，而不是一个编号规则字符串；
2. 静态主干、动态会话章节、项目规则、系统状态和专项任务提示彼此分离；
3. 只为当前实际启用的工具和能力注入对应说明；
4. Bash、沙盒、Git 等细节主要跟随工具描述，不长期堆在全局人格提示词中；
5. 默认缓存动态章节，只有明确说明原因的章节才允许逐轮重算；
6. 自定义 Agent、完全替换和尾部追加具有明确而不同的优先级；
7. compact 负责保存事实、用户意图和未完成工作，不会在恢复后重新赋予“最高指挥官”一类人格。

对 MyAgent 最直接的启示是：当前问题不只是文案不够优雅，而是基础规则、项目规则、阶段性 Shell 能力、技能索引、动态状态和会话恢复语义没有形成稳定的职责边界。

### A.2 证据范围与可信度

本批证据按以下优先级解释：

1. `D:\projects\Agents\claude-code-analysis\src` 中的 Claude Code 源码快照；
2. `D:\projects\Agents\claude-code-analysis\analysis\04g-prompt-management.md`，仅作交叉验证；
3. MyAgent 当前工作区中的实际调用链与测试。

Claude Code 源码快照时间主要为 2026-05-23。本文只描述该快照能够证明的行为，不把其中的内部 A/B 分支视为所有公开版本的稳定契约。

### A.3 Claude Code 的真实装配链路

核心链路不是“读取一个 prompts.ts 字符串”，而是：

```text
工具集合 / 模型 / settings / MCP / 工作目录
                  ↓
constants/prompts.ts::getSystemPrompt()
  ├─ 静态主干章节
  ├─ 动态章节注册与解析
  └─ 静态/动态缓存边界
                  ↓
utils/queryContext.ts::fetchSystemPromptParts()
  ├─ defaultSystemPrompt
  ├─ userContext
  └─ systemContext
                  ↓
utils/systemPrompt.ts::buildEffectiveSystemPrompt()
  ├─ override / coordinator / agent
  ├─ custom / default
  └─ append
                  ↓
QueryEngine.ts → query(...)
```

涉及的主要源码：

- `src/constants/prompts.ts`
- `src/constants/systemPromptSections.ts`
- `src/utils/queryContext.ts`
- `src/utils/systemPrompt.ts`
- `src/context.ts`
- `src/QueryEngine.ts`
- `src/tools/BashTool/prompt.ts`
- `src/services/compact/prompt.ts`

### A.4 默认提示词是章节数组，不是单字符串红线

`getSystemPrompt()` 返回 `Promise<string[]>`。普通交互路径的静态主干顺序是：

1. `getSimpleIntroSection()`：身份、任务领域和网络安全边界；
2. `getSimpleSystemSection()`：输出可见性、权限拒绝、系统标签、Prompt Injection、hooks 和自动压缩；
3. `getSimpleDoingTasksSection()`：完成软件工程任务的行为原则；
4. `getActionsSection()`：按可逆性和影响范围判断高风险动作；
5. `getUsingYourToolsSection(enabledTools)`：仅针对已启用工具给出选择说明；
6. `getSimpleToneAndStyleSection()`：用户可见文本风格；
7. `getOutputEfficiencySection()`：沟通效率；
8. `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`：静态与动态缓存分界；
9. 解析后的动态章节。

这套文本本身并不精简。源码中仍可看到 `IMPORTANT`、`NEVER`、模型版本 counterweight、内部用户分支和产品反馈入口。因此不能得出“Claude Code 靠更少规则获得更好行为”的结论。

更准确的结论是：Claude Code 允许规则较多，但尽量把规则放到明确章节，并通过条件判断避免把无关能力全部注入。

### A.5 静态主干与动态章节的职责

#### A.5.1 静态主干

静态主干描述跨会话相对稳定的行为：

- 如何理解软件工程请求；
- 工具拒绝后不要原样重试；
- 修改前先读取相关代码；
- 不做未请求的扩展；
- 高风险、共享状态和外部可见动作需要确认；
- 优先使用专用工具；
- 用户可见文本如何表达。

它不会维护“阶段 3 允许哪些 Shell 符号、阶段 4 又允许哪些结构”这样的产品迁移状态。

#### A.5.2 动态章节

普通交互路径注册的动态章节包括：

- `session_guidance`：根据 AskUserQuestion、Agent、Skill 等工具是否存在而生成；
- `memory`：加载当前 memory 说明；
- `env_info_simple`：工作目录、Git、平台、Shell、OS、模型等事实；
- `language`：仅在用户配置语言偏好时加入；
- `output_style`：仅在配置输出风格时加入；
- `mcp_instructions`：按当前 MCP 连接状态生成；
- `scratchpad`、`frc`、`summarize_tool_results` 等能力说明。

其中大多数章节只在会话生命周期内计算一次。MCP 连接可能逐轮变化，因此使用显式的 uncached 入口，并在调用处写明缓存失效原因。

#### A.5.3 语言规则不干预内部推理

Claude Code 的语言章节要求使用指定语言进行响应、解释、注释和用户沟通，并保留技术术语与代码标识符原文。它没有要求模型使用指定语言进行“内部逻辑和推理链”。

这说明语言规则应约束可观察输出，而不是声称控制模型内部推理过程。

### A.6 Prompt 缓存是显式工程边界

`systemPromptSection(name, compute)` 默认缓存章节结果，直到 `/clear` 或 `/compact` 等生命周期事件清理。

只有 `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)` 会逐轮重算。该 API 名称和必填原因刻意提高了新增缓存破坏点的门槛。

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 又把跨组织可缓存的静态前缀与用户/会话动态内容分开，使 API 层可以复用稳定前缀。

值得借鉴的是“默认稳定、例外显式”，而不是把 `stable/context/volatile` 这些缓存实现说明直接写给模型。Claude Code 的边界标记主要服务 API 缓存逻辑；MyAgent 当前把“稳定人设层、100% 缓存命中”等注释也发送给模型，这些文字对模型完成任务没有帮助。

### A.7 项目规则、系统状态与 system prompt 分离

`src/context.ts` 将上下文拆成两个对象：

#### A.7.1 userContext

- CLAUDE.md 及发现的 memory 文件；
- 当前日期。

这些内容按会话缓存。项目规则不会硬编码进默认提示词模块。

#### A.7.2 systemContext

- 会话开始时的 Git 状态、当前分支、主分支、最近提交；
- 内部调试使用的 cache breaker。

Git 状态文本明确声明它只是会话开始时的快照，不会在会话中自动更新。这避免模型把旧状态误认为实时事实。

Claude API 的 `userContext/systemContext` 是其自身请求基础设施的一部分。MyAgent 主要适配 OpenAI 协议，未必能原样复制字段，但仍应保留语义边界：项目规则、环境事实和基础人格不应混成一组永久红线。

### A.8 工具局部提示，而非全局能力矩阵

`getUsingYourToolsSection(enabledTools)` 只生成全局层面的工具选择原则，例如优先 Read/Edit/Write/Glob/Grep，独立工具调用可以并行。

更详细的 Bash 契约位于 `src/tools/BashTool/prompt.ts`：

- 工作目录与 Shell 状态语义；
- timeout 与后台参数；
- 复合命令的 `&&`、`;` 使用建议；
- Git 操作说明；
- sandbox 开启后的文件系统、网络限制和逃生条件；
- sandbox 关闭时完全不生成 sandbox 章节。

因此 Claude Code 的模型只会在 Bash 工具实际存在时看到 Bash 描述，只会在沙盒实际启用时看到沙盒限制。它没有让基础提示词维护一份平台版本和阶段性的 Shell 禁用结构列表。

这不意味着 Claude Code 不需要工具安全规则；它只是把规则放在最接近真实执行能力的位置。真正的拒绝和隔离仍由工具与运行时强制执行，prompt 负责帮助模型正确使用能力。

### A.9 覆盖、替换和追加具有不同语义

`buildEffectiveSystemPrompt()` 的优先级是：

```text
override
  > coordinator
  > agent
  > custom system prompt
  > default system prompt
```

`appendSystemPrompt` 除 override 外通常追加在最终提示词末尾。

关键行为：

- `customSystemPrompt` 是替换默认提示词，不是默认追加；
- 普通模式下，自定义 Agent prompt 可以替换默认主提示词；
- proactive 模式下，Agent prompt 才作为领域说明追加到精简的自主 Agent 默认提示后；
- `appendSystemPrompt` 是正式的追加策略通道。

这避免“无论切换成什么 Agent，都继承整份通用红线，再叠加更多角色规则”的无限累积。

### A.10 Compact 与恢复不会重新塑造人格

Claude Code 将 compact 作为独立专项任务：

- 明确禁止工具调用；
- 保存用户请求、技术决策、文件、错误、修复、未完成任务和当前工作；
- 区分完整 compact 与只总结最近部分；
- summary 进入继续会话时，只说明这是前一段对话的摘要；
- 需要自动继续时，要求直接恢复最后任务，不复述摘要、不重新寒暄。

它没有把恢复后的模型描述成“最高指挥官”，也没有声称此前工作由“子单元”完成，更不会要求模型只给战略指令、禁止继续实际实现。

这说明 compact/handoff 的职责是恢复事实与连续性，不应改变 Agent 的权限、身份或工作方式。

### A.11 与 MyAgent 当前实现的直接对照

| 维度 | Claude Code | MyAgent 当前实现 |
|---|---|---|
| 主提示形态 | `string[]` 具名章节 | 单个长字符串，固定 10 条编号规则 |
| 静态/动态边界 | API 可识别边界，章节级缓存 | 用 XML 和 HTML 注释描述三层，但全部进入同一 system 消息 |
| 工具说明 | 根据 enabled tools 注入；细节位于工具 prompt/schema | 基础提示词长期包含 Bash/PowerShell 平台矩阵 |
| 项目规则 | userContext 独立注入 | 同时进入 system prompt，并逐轮追加到最新 user 消息 |
| 技能 | 能力存在时注入指导，正文按需加载 | system prompt 放技能索引，选中技能正文逐轮注入；方向基本合理 |
| 环境事实 | 单独环境章节，陈述 CWD、Git、平台、Shell、OS | system prompt 只保留 OS，且把阶段性语法能力写成规则 |
| 语言 | 约束响应、说明和注释 | 要求简体中文“内部逻辑和推理链” |
| 权限拒绝 | 原样重试禁止，原因不明时按现有工具处理 | 两套错误恢复规则重复描述，近期又追加“拒绝后不得替代执行” |
| compact/handoff | 保存事实并自然继续 | summary 后追加“最高指挥官/子单元/只给战略指令”人格声明 |
| 测试 | 结构、组合、缓存和模式行为 | 大量断言具体中文句子、固定规则数量和阶段 4 文案 |

#### A.11.1 已确认的局部规则重复注入

`RuleManager` 初始化和规则刷新时调用：

```text
SessionContext.updateSystemPrompt(globalRules, localRules, skills)
```

因此 `localRules` 已进入首条 system 消息。

`model-request-assembler.ts` 每轮又调用：

```text
contextAdapter.assemble(..., ruleManager.getLocalRules(), ...)
```

`DefaultContextAdapter` 再把同一份局部规则追加到最新 user 消息的 `[SYSTEM NOTE]` 中。由此可以确认，MyAgent 当前对局部项目规则存在双重注入，而不只是代码结构上看起来可能重复。

#### A.11.2 当前测试限制了自然演进

`prompt.test.ts` 明确锁定：

- 三层 HTML/XML 标记的具体中文文本；
- `SYSTEM_RULES.length === 10`；
- 每个规则常量必须完整出现在最终提示词；
- 阶段 4 的具体 Shell 句子；
- Linux/macOS 当前禁用结构的具体词汇。

这些测试能防止历史问题回归，但同时把阶段性补丁固化成长期契约。若要重构，测试应转向验证行为边界，例如：

- 实际启用什么工具，就只注入对应能力说明；
- 项目规则只出现一次；
- 工具拒绝后不原样重试；
- system prompt 不声称不存在的沙盒；
- handoff 不改变 Agent 身份和执行职责；
- 环境事实与基础行为原则分离。

### A.12 可借鉴与不可照搬

#### A.12.1 建议借鉴

1. 把提示词从“常量数组”提升为具名 section 的装配模型；
2. 将稳定行为、环境事实、工作区规则、技能正文和专项 prompt 分开；
3. 工具细节跟随实际工具定义，基础提示词只保留选择原则；
4. 根据工具是否启用决定是否注入对应指导；
5. 默认缓存章节，动态失效必须显式说明原因；
6. 明确定义 replace 与 append，而不是所有规则永久叠加；
7. compact 只恢复上下文，不重新塑造人格；
8. 测试结构和行为，不锁定规则数量与整段文案。

#### A.12.2 不建议照搬

1. 不复制 Claude Code 的长篇 coding 指令；MyAgent 的目标是通用 Agent；
2. 不复制 Anthropic 内部用户、模型发布和 A/B counterweight 分支；
3. 不复制 Claude 专属 URL、反馈命令、模型名称和产品入口；
4. 不把 Claude API 的 `userContext/systemContext` 字段直接假定为 OpenAI 标准能力；
5. 不复制 Bash-only 的工具体系；MyAgent 已显式拆分 Bash 与 PowerShell；
6. 不因 Claude Code 使用强措辞，就继续堆叠更多 `MUST/NEVER/CRITICAL`。

### A.13 第一批调研后的判断

Claude Code 不能为 MyAgent 提供一份可以直接翻译的“优雅系统提示词”。它提供的是更有价值的工程方向：

> 把 prompt 视为可组合、可缓存、可覆盖、与工具能力同步的运行时契约，而不是不断追加的全局规则文本。

如果后续进入 MyAgent 方案阶段，优先处理的不是逐句润色，而是以下边界：

1. 移除局部规则的双重注入；
2. 把 Shell 细节下沉到 Bash/PowerShell 工具契约；
3. 删除会改变身份的 handoff 文案；
4. 将系统提示词拆成少量具名章节，但不照搬 Claude Code 的复杂缓存运行时；
5. 将测试从具体句子迁移到结构与行为契约。

这些仍是基于 Claude Code 单一竞品的阶段性结论。若要形成最终方案，还应按用户指定的下一批竞品继续调研后再收敛。

## B. Codex

> 调研日期：2026-07-15  
> 调研状态：已记录当前完成的源码核对；部分运行时排序仍列为待补证项

### B.1 结论摘要

Codex 同样不能提供一份可直接复制的“短而优雅”系统提示词。仓库中的默认基础模板约 21KB，包含人格、AGENTS.md 解释协议、进度沟通、计划、持续执行、验证、代码规范和最终回复格式等大量产品行为说明。

真正值得 MyAgent 借鉴的是它在内部和 OpenAI 请求层保留了语义边界：

1. `base_instructions` 保存模型/产品级基础行为；
2. `developer_instructions` 承载运行模式和产品侧附加策略；
3. AGENTS.md 作为独立 user context 片段进入会话；
4. 工具定义通过 Responses API 的 `tools` 字段单独传递；
5. personality 是基础模板中的受控变量，不是无条件追加的另一套人格；
6. 标准 Responses API 使用顶层 `instructions`，Responses Lite 则把相同语义映射成前置 `developer` 消息。

这与 MyAgent 当前把多种内容拼成单一 system 字符串、再把局部规则追加到最新 user 消息的实现明显不同。

### B.2 证据范围

本批直接读取：

- `D:\projects\Agents\codex\codex-rs\protocol\src\prompts\base_instructions\default.md`
- `D:\projects\Agents\codex\codex-rs\protocol\src\openai_models.rs`
- `D:\projects\Agents\codex\codex-rs\core\src\client.rs`
- `D:\projects\Agents\codex\codex-rs\core\src\client_common.rs`
- `D:\projects\Agents\codex\codex-rs\core\src\context\user_instructions.rs`

并通过仓库只读索引定位：

- `app-server-protocol` 中的 `base_instructions` 与 `developer_instructions` 字段；
- `collaboration-mode-templates` 中的协作模式 developer instructions；
- `models-manager` 中的人格头和协作模式预设；
- `core/src/agents_md.rs` 与 context 模块中的项目规则链路。

### B.3 基础指令、人格与请求角色

默认 `base_instructions` 模板虽然很长，但内容主要约束可观察行为，不要求模型控制或暴露“内部推理语言”，也不会把缓存命中率等实现说明写成任务规则。

`ModelInfo::get_model_instructions(personality)` 的已确认行为是：

1. 模型配置存在 `model_messages.instructions_template` 时优先使用模板；
2. 将选定 personality 文本替换进模板占位符；
3. 没有模板时回退到模型 `base_instructions`；
4. 模型不支持指定 personality 时只记录警告并回退。

`core/src/client.rs::build_responses_request()` 证明标准 Responses 路径分别传递：

```text
instructions = prompt.base_instructions.text
tools = create_tools_json_for_responses_api(...)
input = conversation ResponseItems
```

Responses Lite 不使用顶层 `instructions`，而是在 input 前插入 `AdditionalTools` developer item 和基础指令 developer item，再接原会话。这说明 Codex 保持的是语义层级，而不是依赖唯一传输字段。

### B.4 工具与项目规则边界

`Prompt` 数据结构分别保存 `input`、`tools`、`parallel_tool_calls`、`base_instructions` 和 `output_schema`。工具在发送请求时独立序列化，所以基础提示词只需说明跨工具原则，不需要复制每个工具的参数、平台支持和拒绝条件。

`core/src/context/user_instructions.rs` 将项目规则建模为 `UserInstructions`/`ContextualUserFragment`：

- 消息角色为 `user`；
- 使用 `# AGENTS.md instructions` 标记；
- 正文包裹在 `<INSTRUCTIONS>...</INSTRUCTIONS>`；
- 可以携带对应目录以说明作用域；
- 它是独立上下文片段，不是拼在真实用户问题末尾的 `[SYSTEM NOTE]`。

基础提示词只负责解释 AGENTS.md 的目录作用域、深层规则优先级和指令层级；运行时上下文负责提供具体规则正文。这形成“解释协议”和“实际规则内容”的分工。

### B.5 与 Claude Code 及 MyAgent 的对照

| 维度 | Claude Code | Codex | MyAgent 当前实现 |
|---|---|---|---|
| 基础提示 | 多个具名 section | 模型级 `base_instructions` 模板 | 固定规则拼成单一 system 字符串 |
| 动态扩展 | dynamic sections、user/system context | developer instructions、context fragments | 动态信息与基础规则混合 |
| 项目规则 | CLAUDE.md 放入 userContext | AGENTS.md 独立 user fragment | local rules 同时进 system 和最新 user |
| 工具 | 工具 prompt/schema 独立 | Responses `tools` 独立字段 | Shell 能力矩阵长期写在基础提示词 |
| 人格 | 输出风格 section / Agent prompt | instructions template 的 personality 变量 | 多种规则平铺叠加 |
| API 适配 | Anthropic context/cache 语义 | 标准 Responses 分层，Lite 确定性降级 | 内部模型先丢失边界，再拼文本补偿 |

两项竞品的共同点比文案更重要：都没有把项目规则、工具 Schema、动态环境和基础人格永久焊接成一段不可分割的字符串。

上一批已通过 MyAgent 调用链确认局部规则双重注入：`RuleManager` 把 `localRules` 写入 system prompt，`model-request-assembler` 又将其交给 `DefaultContextAdapter`，后者追加到最新 user 消息末尾。Codex 的独立 contextual fragment 进一步说明，这种重复不是 OpenAI 协议所迫。

### B.6 可借鉴与不可照搬

建议借鉴：

1. 内部建模区分 base、developer、project context、user request 和 tools；
2. provider 支持时使用原生 `instructions/developer/user` 语义；
3. provider 不支持时由适配层确定性降级，不让业务层手写 `[SYSTEM NOTE]`；
4. 项目规则作为独立、带来源和作用域的上下文片段；
5. personality 作为基础模板变量；
6. 工具能力以当次实际 Schema/描述为准，基础提示词不维护阶段性能力清单。

不建议照搬：

1. 不复制 Codex 的长篇 coding-agent 模板；
2. 不把 MyAgent 限定为 CLI 编码助手；
3. 不复制 Codex 专属工具名、UI 格式和文件引用规则；
4. 不假定所有 OpenAI 兼容服务都正确支持 developer 角色；
5. 在证据不足前不照搬 Codex 的完整优先级和缓存策略。

### B.7 待补证项与阶段判断

尚待后续按需要深入的 Codex 入口：

1. `developer_instructions` 在 config、collaboration mode、agent role 和 turn override 间的最终优先级；
2. sandbox/approval developer instructions 的生成与变更时机；
3. environment context、workspace roots 和权限状态的插入位置；
4. skills 与插件说明的按需披露；
5. compact/resume 后各层上下文如何保持一致；
6. general-purpose 与 coding CLI 模板的选择边界。

现有证据已经支持以下低风险方向：项目规则只保留一条注入路径；handoff 不改变 Agent 身份；工具能力跟随实际工具；内部上下文模型保留基础策略、产品策略、项目规则、用户请求和工具附件的边界；测试验证角色、顺序、唯一性和行为，而不是固定中文句子。

最终重写方案仍应等 OpenCode、Hermes 和 OpenClaw 调研完成后再收敛。

## C. OpenCode

> 调研日期：2026-07-15  
> 源码快照：`D:\projects\Agents\opencode` 当前工作树  
> 调研状态：主请求装配、项目规则、工具局部提示、Agent 模式和 compaction 链路已闭环

### C.1 结论摘要

OpenCode 同样不是靠一份简短、统一的基础提示词工作。它按模型维护多套约 7–15KB 的模板，默认模板本身也包含重复强措辞、极短回复限制、编码规范和产品专属说明，不能作为 MyAgent 的文案范本。

它真正值得借鉴的仍是运行时边界：

1. 按实际模型选择基础模板；Agent 有自定义 prompt 时明确替换模型模板；
2. 环境、项目规则、MCP、skills 和本轮 system override 以确定顺序动态装配；
3. 工具通过独立 `tools` 结构传递，并在发送前按合并后的 permission ruleset 过滤；
4. Bash、PowerShell 5.1、PowerShell 7 和 cmd 的差异跟随 Shell 工具描述动态生成；
5. 项目根规则进入 system，嵌套目录规则在读取相关文件时按需附加，并有明确去重状态；
6. build/plan 的能力差异主要由权限强制，plan 文案是条件性的 synthetic user reminder；
7. compaction 使用无工具专项 Agent，摘要后恢复原 Agent、模型、tools 和本轮 system，不改变身份。

### C.2 主要源码证据

本批直接核对：

- `packages/opencode/src/session/system.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/llm/request.ts`
- `packages/opencode/src/session/instruction.ts`
- `packages/opencode/src/session/reminders.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/core/src/session/compaction.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/tool/read.ts`
- `packages/opencode/src/tool/shell/prompt.ts`
- `packages/opencode/src/session/prompt/default.txt`

模型模板目录还包含 `anthropic.txt`、`codex.txt`、`gpt.txt`、`gemini.txt`、`kimi.txt`、`meta.txt`、`trinity.txt` 等文件。文件大小从约 7KB 到 15KB 不等，说明 OpenCode 选择的是“针对模型维护完整模板”，而不是一份极小的通用 prompt。

### C.3 最终装配顺序

`session/prompt.ts` 每轮并行取得：

```text
skills
environment
project instructions
MCP instructions
conversation model messages
```

其中传给 LLM 的动态 system 数组顺序是：

```text
environment
→ project instructions
→ MCP instructions（存在时）
→ skills（允许且存在时）
→ structured-output 说明（需要时）
```

`session/llm/request.ts::prepare()` 再构造最终 system：

```text
agent.prompt（存在时）
  或 SystemPrompt.provider(model)（模型基础模板）
→ session 动态 system 数组
→ user.system（本轮存在时）
```

随后插件 `experimental.chat.system.transform` 可以变换整个 system 数组。

这形成了明确的覆盖语义：`agent.prompt` 不是在模型模板后再追加一套人格，而是替换模型基础模板；环境、项目规则等运行时上下文仍继续追加。本轮 `user.system` 排在动态上下文之后。

对普通 provider，system 数组被转换为 `role: system` 的模型消息；OpenAI OAuth 路径则写入 provider options 的 `instructions`，不再重复生成 system 消息。也就是说，OpenCode 与 Codex 类似，先保留内部语义，再按 provider 能力映射传输格式。

### C.4 环境、references、skills 与 MCP

`session/system.ts` 的环境段只陈述实时事实：

- 精确模型 ID；
- 工作目录和 workspace root；
- 是否为 Git 仓库；
- 当前平台和日期。

可访问的额外项目目录以 `<available_references>` 独立列出，不把它们伪装成工作区根目录。

skills 只有在 `skill` 工具未被 Agent 权限禁用时才注入；system 中提供可用技能的详细索引，并要求使用 skill 工具按需加载正文。MCP instructions 也会按 Agent 权限和本轮 session permission 过滤：一个 MCP server 的相关工具全部禁用时，其说明不会进入 prompt。

这比“无论工具是否可用，都永久告诉模型存在某能力”更可靠。提示词描述与当次真实可用工具集合保持同步。

### C.5 项目规则：根规则与按需嵌套规则

`session/instruction.ts` 支持：

- 全局 `AGENTS.md`，并可兼容 `~/.claude/CLAUDE.md`；
- 从当前目录向 workspace root 搜索项目 `AGENTS.md`、`CLAUDE.md` 或已弃用的 `CONTEXT.md`；
- 配置中的本地 glob instruction；
- 配置中的 HTTP/HTTPS instruction，读取超时为 5 秒。

项目级自动发现采用“首类文件名命中”策略，不会同时叠加每一种规则文件。最终 system 片段保留来源：

```text
Instructions from: <absolute path or URL>
<content>
```

更深目录的规则不是每轮全量扫描并放进 system。`ReadTool` 读取文件时调用 `instruction.resolve()`，沿文件目录向上寻找未加载的 instruction，随后将正文作为 `<system-reminder>` 附在这次 read 工具结果中。

去重有两层：

1. 当前 assistant message 的 `claims` 防止同一路径重复附加；
2. 历史 read 工具结果的 `metadata.loaded` 防止后续消息再次加载已出现规则。

这比 MyAgent 当前把相同 `localRules` 同时放入 system 和最新 user 尾注更精确：稳定根规则只有一条主路径，作用域更深的规则只在真正访问对应文件时出现。

### C.6 Shell 差异跟随工具描述

`tool/shell/prompt.ts` 根据实际 shell 名称和平台动态渲染工具描述，至少区分：

- Bash/类 Unix shell；
- PowerShell 7+（`pwsh`）；
- Windows PowerShell 5.1（`powershell`）；
- `cmd.exe`。

它会向模型说明参数、`workdir`、timeout、输出截断、路径引用、专用文件工具优先级和复合命令建议。

PowerShell 7 明确说明支持 `&&`/`||`；PowerShell 5.1 则建议使用 `cmd1; if ($?) { cmd2 }`，避免使用不受支持的 `&&`。这是模型使用指导，不是额外的“复合命令开关”或提示词阶段矩阵。真正执行不了的语法仍由所选 shell 自己报错。

因此 OpenCode 支持此前阶段 4 的正确边界：

> 运行时知道当前是什么 shell，工具描述据此给出准确指导；权限系统决定工具是否可调用；不要让全局系统提示词长期维护语法白名单或迁移阶段。

不过 OpenCode 的工具提示同样很长，并包含 Git/PR 产品流程、专用工具名和平台专属例子。MyAgent 应借鉴定位方式，不照搬文本体量。

### C.7 Agent、plan 与权限

内置 Agent 中：

- `build` 没有自定义 prompt，使用模型基础模板，能力由默认 permissions 与用户配置合并；
- `plan` 也没有完整自定义 prompt，主要通过 permissions 禁止 edit，只允许计划文件等有限路径；
- `explore` 使用专项 prompt，并将工具收窄到 grep/glob/list/bash/web/read 等探索能力；
- `compaction`、`title`、`summary` 是隐藏专项 Agent，使用独立 prompt，默认将所有工具设为 deny。

plan 模式说明由 `session/reminders.ts` 条件性附加到最新 user message，标记为 `synthetic: true`。从 plan 切回 build 也只注入一次 build-switch reminder。模式文案不会永久进入基础模板，而权限限制不依赖模型是否听从文案。

这个边界值得 MyAgent 保留：prompt 解释当前模式，permission/runtime 强制当前模式；两者职责不同。

### C.8 Compaction 与自然恢复

OpenCode 的 compaction 采用专项隐藏 Agent：

- 使用独立 `PROMPT_COMPACTION`；
- tools 为空，permission 为 `* = deny`；
- 压缩请求作为 user message 加入历史；
- 插件可以追加 context 或替换 compaction prompt；
- 多次压缩时会更新 anchored summary，保留仍然为真的细节、移除过时信息并合并新事实。

摘要模板固定保存：

- Objective；
- Important Details；
- Work State（Completed/Active/Blocked）；
- Next Move；
- Relevant Files。

并要求保留精确路径、符号、命令、错误字符串、URL 和标识符，不在摘要中提及“发生过压缩”。

自动恢复有两种路径：重放压缩前最后一个真实 user 请求，或者注入一条 synthetic user 消息，内容只是“有下一步就继续，不确定就澄清”。恢复消息沿用原 Agent、model、tools、format 和 `user.system`。

因此 OpenCode 与 Claude Code 的证据一致：compaction 的职责是保存任务连续性，不应把恢复后的 Agent 改成“最高指挥官”，也不应禁止它继续实现。

### C.9 不应照搬的部分

1. 默认模板是 coding CLI 专用，且规则重复、强措辞较多；
2. 多模型完整模板会产生明显维护成本，MyAgent 不必为每个模型复制一整套正文；
3. 默认模板把回复限制为少于四行并多次重复，不适合通用助手；
4. Shell 工具描述夹带 Git commit/PR 工作流，不是通用 Shell 契约；
5. HTTP 远程 instruction 每轮读取的成本与失败语义需要单独评估，不能无条件复制；
6. OpenCode 的 AGENTS/CLAUDE 兼容优先级是自身产品选择，不必原样作为 MyAgent 标准。

### C.10 对 MyAgent 的直接启示

OpenCode 进一步强化了以下方案方向：

1. 基础 prompt 只保留跨任务、跨工具的稳定行为；
2. Shell/PowerShell 语法和平台信息下沉到实际工具描述；
3. 项目规则只保留一次稳定注入，嵌套作用域按实际文件访问加载；
4. skills 和 MCP 必须根据当次权限及工具可用性过滤；
5. Agent 自定义 prompt 使用明确 replace 语义，模式差异由 permission 强制；
6. plan/切换/结构化输出等短期状态使用条件性 reminder，不污染长期基础 prompt；
7. compaction summary 保存事实和下一步，恢复时沿用原执行身份；
8. provider adapter 负责把内部语义映射到 `instructions/system/messages/tools`，业务层不手写重复尾注。

## D. 编码 Agent 组三项目阶段性横向判断

截至 Claude Code、Codex、OpenCode 三个编码 Agent，已经出现稳定共识：

| 问题 | 共同方向 |
|---|---|
| 基础 prompt 是否要很短 | 不一定；三者都不短，质量主要来自职责边界而非字数 |
| 工具细节放在哪里 | 跟随实际工具 prompt/schema，而不是全局能力矩阵 |
| 项目规则如何进入 | 独立上下文片段或具名 section；避免与用户请求尾注重复 |
| 动态环境如何进入 | 单独环境段，陈述可验证事实 |
| Agent/模式如何切换 | 明确 replace/conditional reminder；权限由运行时强制 |
| skills/MCP | 根据真实可用性和权限注入，正文按需披露 |
| compaction | 保存目标、事实、状态、下一步，自然恢复原执行身份 |
| provider 差异 | 内部先保留语义边界，适配层再映射协议字段 |

因此，MyAgent 后续优化不应先“润色十条规则”，而应先修正装配模型：删除局部规则双重注入、移除虚假沙盒和内部推理语言、下沉 Shell 细节、修正 handoff 身份、建立少量具名 section 与确定性 provider 映射。

这仍是编码 Agent 组的阶段性结论。MyAgent 的目标是通用 Agent，最终方案还需要 Hermes Agent 与 OpenClaw 这一组通用 Agent 的源码证据校正，尤其关注长期记忆、用户环境、外部动作和非项目目录能力。

## E. Hermes Agent

> 调研日期：2026-07-15  
> 源码快照：`D:\projects\Agents\hermes-agent` 当前工作树  
> 调研状态：system prompt 构建、持久化缓存、工具/skills、项目规则、逐轮 context 和压缩恢复链路已闭环

### E.1 结论摘要

Hermes 是这一批中第一个真正以通用个人 Agent 为核心目标的项目。它运行在 CLI、TUI、桌面端和大量消息平台上，支持长期记忆、skills、plugins、定时任务、浏览器、终端、远程执行环境和子 Agent。

它的提示词架构与三个编码 Agent 的共同方向一致，但对缓存边界要求更强：

1. system prompt 在会话开始时构建一次，并持久化到 SQLite；后续进程/网关 turn 原样恢复；
2. `stable/context/volatile` 是组装排序，不是三种逐轮更新频率，最终三层全部冻结进同一会话 prompt；
3. memory、USER profile、skills index、项目规则、平台提示和工具感知指导只在新会话或压缩边界刷新；
4. 本轮 external memory recall、plugin context 和 gateway overlay 追加到当前 user 消息的发送副本，不修改历史；
5. 工具集在初始化时根据 toolsets、服务 `check_fn` 和插件解析，然后冻结；system 只为实际存在的工具加入指导；
6. SOUL.md、MEMORY.md、USER.md、项目 context、skills 和平台 hints 都是正式的用户扩展面，核心 prompt builder 不是日常配置面；
7. 压缩是唯一常规重建 system 的边界，但最新 user 消息始终是当前任务来源，历史摘要不能恢复旧任务或改变身份。

### E.2 主要源码证据

本批直接核对：

- `AGENTS.md`
- `website/docs/developer-guide/prompt-assembly.md`
- `agent/system_prompt.py`
- `agent/prompt_builder.py`
- `agent/prompt_caching.py`
- `agent/agent_init.py`
- `agent/conversation_loop.py`
- `agent/turn_context.py`
- `agent/subdirectory_hints.py`
- `agent/conversation_compression.py`
- `agent/context_compressor.py`
- `model_tools.py`
- `tools/registry.py`

仓库自身开发说明把两个不变量置于核心：会话内 prompt caching 不应被破坏；能力应主要生长在 skills、plugins、MCP、CLI 或服务门控工具等边缘，而不是不断扩大每轮都发送的 core tool schema。

### E.3 三层组装的真实含义

`agent/system_prompt.py::build_system_prompt_parts()` 返回三个具名部分：

#### E.3.1 stable

按条件包含：

- `SOUL.md` 或 `DEFAULT_AGENT_IDENTITY`；
- Hermes 产品帮助入口；
- 通用任务完成、反编造和并行工具指导；
- 只在对应工具存在时加入 memory、session search、skills、kanban、computer-use 等指导；
- 模型族专项执行指导；
- skills index；
- 环境探测、coding workspace 快照和平台提示；
- 当前 Hermes profile 的隔离说明。

#### E.3.2 context

包含：

- 调用方提供的 `system_message`；
- 当前工作目录对应的项目 context 文件。

#### E.3.3 volatile

包含：

- 本地 `MEMORY.md` 快照；
- `USER.md` 快照；
- 外部 memory provider 的 system block；
- 会话开始日期、session ID、model、provider。

这里“volatile”容易被误解。源码最终把三层按 `stable → context → volatile` 合并成一个字符串，并缓存在 `agent._cached_system_prompt`。会话内不会逐轮重算 volatile；它只表示这些输入在下一次新会话或压缩重建时可能变化。

这个命名比 MyAgent 当前把 `stable/context/volatile` 与“100% 缓存命中”注释直接发给模型更合理，因为 Hermes 的层名只存在于代码模型和开发文档，不是模型需要阅读的正文标签。

### E.4 身份与通用 Agent 定位

Hermes 优先从 `~/.hermes/SOUL.md` 加载身份。没有 SOUL 时使用通用默认身份：帮助用户完成问答、代码、分析、创作和工具执行等广泛任务，而不是只声明为 coding CLI。

SOUL 内容会经过安全扫描和长度限制，并占据 system prompt 的第一段。随后构建项目 context 时显式 `skip_soul=True`，避免同一身份文件重复出现。

这对 MyAgent 很有价值：基础身份可以保持短而通用；个性、长期行为和部署方偏好应有正式的 replace/customization surface，而不是不断往固定系统规则末尾追加人格句子。

### E.5 工具感知指导与工具集冻结

Hermes 在初始化时调用 `get_tool_definitions()`，根据 enabled/disabled toolsets、registry `check_fn`、插件和 context engine 得到实际工具 Schema，并保存到 `agent.tools` 与 `agent.valid_tool_names`。

system prompt 使用 `valid_tool_names` 条件性加入指导，例如：

- 没有 memory 工具就不注入 memory 操作说明；
- 没有 session search 就不要求跨会话搜索；
- 没有 skills 工具就不生成 skills index；
- 没有 computer-use 就不加入桌面操作说明；
- 只有 kanban worker 才看到 kanban 生命周期指导。

registry 的 `check_fn` 可以短 TTL 缓存服务可用性，但本次 Agent 的工具快照在初始化结束前形成。Hermes 的核心不变量明确禁止会话中途替换 toolsets；配置变更默认延后到下一会话，只有显式 `--now` 才允许用户主动承担缓存失效。

这与 MyAgent 的正确方向一致：能力说明来自当次真实工具集合，permission/runtime 强制可用性；system prompt 不维护一份与工具实现可能漂移的手工矩阵。

### E.6 Skills：索引冻结，正文按需加载

Hermes 只有在 `skills_list`、`skill_view` 或 `skill_manage` 至少一个工具存在时才生成 skills section。

`build_skills_system_prompt()` 构建的是分类索引和描述，不是把所有 `SKILL.md` 正文塞进 system。正文通过 `skill_view(name)` 按需加载。索引有两层构建缓存：

1. 进程内最多 8 项的 LRU，key 包含 skills 目录、工具、toolsets、平台和 compact categories；
2. 磁盘 `.skills_prompt_snapshot.json`，用 SKILL/DESCRIPTION 文件的 mtime/size manifest 验证。

coding focus 可把非编码类别降级为 names-only，但不会隐藏技能名称，仍可通过 tools 完整加载。

关键点不是磁盘缓存实现，而是生命周期：本会话的 skills index 构建后进入冻结 system。安装或修改技能默认影响下一会话，避免当前对话 prefix 突变。

### E.7 长期记忆与逐轮 recall 分离

Hermes 同时支持两种不同语义：

#### E.7.1 会话快照

`MEMORY.md`、`USER.md` 和外部 memory provider 的静态 block 在会话开始时进入 system prompt。会话中写 memory 只更新磁盘，不会立刻改写已经冻结的 system；新会话或压缩重建时才重新加载。

#### E.7.2 当轮 recall

外部 memory prefetch 和 `pre_llm_call` 插件返回的 context 只追加到当前 user 消息的 API 发送副本。原始 `messages` 列表不被修改，因此这些临时事实不会落进 session history，也不会污染后续每轮上下文。

插件输出过大时可先落盘，再把引用放入 prompt，避免一个插件无限膨胀当轮请求。

这提供了 MyAgent 可直接借鉴的双轨模型：长期稳定事实形成会话快照；实时检索结果属于当轮附件。不能把两者都塞进每轮最新 user 的通用 `[SYSTEM NOTE]`。

### E.8 项目 context 与渐进式子目录规则

会话启动时项目规则按“第一种匹配类型胜出”加载：

1. `.hermes.md` / `HERMES.md`：从 CWD 向上到 Git root；
2. `AGENTS.md`：CWD；
3. `CLAUDE.md`：CWD；
4. `.cursorrules` 或 `.cursor/rules/*.mdc`：CWD。

所有 context 文件会安全扫描、移除特定 frontmatter 并按模型上下文动态限制长度。

更深目录的规则由 `SubdirectoryHintTracker` 渐进发现。它从 read、terminal、search 等工具参数提取路径，只允许当前工作目录树内的目录，最多向上走 5 层；首次触达新目录时加载该目录优先级最高的一份 AGENTS/CLAUDE/cursorrules，并把内容附到工具结果。

tracker 按目录去重，system prompt 不变。这和 OpenCode 的 read-result reminder 形成跨项目共识：作用域规则在相关文件实际被访问时出现，不需要把整个目录树的所有规则永久放入基础 prompt。

### E.9 Platform hints 与非编码表面

Hermes 为 CLI、TUI、Telegram、WhatsApp、Slack 等表面生成不同 platform hint。配置可对单个平台 `append` 或 `replace`，错误配置防御性回退，不影响其他平台。

这些 hints 在会话构建时解析一次，之后冻结。它说明通用 Agent 的沟通风格应跟随实际交互表面，而不是基础 prompt 永久假定“所有输出都在终端”。

对 MyAgent 而言，这比照搬 Claude Code/Codex 的 CLI Markdown 和文件链接规则更合适：核心只定义通用沟通原则，surface adapter 再注入当前渠道限制。

### E.10 Prompt 持久化与 provider cache

`_restore_or_build_system_prompt()` 在第一轮构建 system 后将完整字符串写入 session SQLite。后续恢复会话时：

- 存储值存在且 Model/Provider 行匹配当前运行时：原样复用；
- session row 缺失：正常首次构建；
- stored prompt 为 null/empty：记录 warning 并重建；
- Model/Provider 身份过时：记录 stale runtime 并重建。

这解决了网关每轮创建新 Agent 实例时的 prefix 稳定问题。Anthropic 路径进一步在 system 和最近三条可承载消息上设置 cache-control breakpoint，但 provider 标记只是优化；真正的前提仍是 Hermes 自身保持 prompt 字节稳定。

MyAgent 不一定需要立即复制 SQLite prompt snapshot，但应明确两个不同问题：

1. 代码层 section 如何稳定组装；
2. 长生命周期/重建 Agent 时如何保证同一会话复用完全相同的 system 字节。

### E.11 Compaction 的边界与历史摘要语义

Hermes 只在成功完成 context compression 后失效并重建 system prompt。重建前会重新加载 memory，重建后把新 prompt 写回当前或新 session；若摘要失败，则原消息和原 system 均保持不变，不旋转会话。

压缩摘要显式标记为“reference only”，并要求：

- 最新 user 消息是唯一当前任务来源；
- 历史任务、进行中状态、pending asks 和 remaining work 不能自动恢复；
- 用户说 stop/undo/never mind/切换话题时必须立即终止摘要中的旧工作；
- 摘要不得降低 system 中长期 memory 的优先级；
- 保留必要事实以避免重复已做工作，但不把摘要当成新指令。

源码还保留并清理旧版“resume exactly from Active Task”前缀，注释明确指出这种历史文案会劫持后续回复。

这对 MyAgent 当前 handoff 是直接反证：把压缩后的模型称为“最高指挥官”、把旧工作称为“子单元已完成”、要求“只给战略指令”都会改变行为身份，并可能让旧摘要压过最新用户请求。正确恢复语义应是事实连续性，而不是角色晋升。

### E.12 不应照搬的部分

1. Hermes 的 system prompt 仍然很长，包含大量模型族补丁、产品帮助、profile、coding posture 和订阅说明；
2. 三层命名中的 `volatile` 容易误解，若 MyAgent采用应改成更准确的 `session_snapshot`；
3. skills 文案使用“部分相关也必须加载”等强制措辞，可能造成过度加载；
4. context 文件 prompt-injection 扫描依赖启发式，不能把扫描结果当成安全隔离；
5. 完整 prompt 持久化会产生配置更新何时生效、敏感信息存储和 provider 切换校验等额外责任；
6. ephemeral system prompt 会改变当轮 system 字节，虽然是显式功能，仍会牺牲该次 prefix cache，不能滥用。

### E.13 对 MyAgent 的直接启示

Hermes 将此前编码 Agent 结论扩展到通用助手场景：

1. 基础身份应短、通用，并允许正式 replace；
2. 将 system 内部结构命名为 `base / session context / session snapshot`，不要把缓存实现注释发给模型；
3. system 在会话内冻结，memory、rules、skills 更新默认下个会话生效；
4. 当轮 recall/plugin/gateway context 作为结构化 turn attachment，只进入发送副本；
5. 工具和指导必须根据实际 tool snapshot 同步，新增能力优先走 skill/plugin/MCP 或门控工具；
6. 项目根规则一次注入，子目录规则随文件/命令实际触达渐进加载；
7. platform/surface 限制由适配器条件注入；
8. compaction 只保存事实，最新用户请求永远决定当前任务；
9. 若未来支持跨进程网关，需要考虑 prompt snapshot 持久化，而不仅是进程内字符串缓存。

Hermes 证明“通用 Agent 需要更多能力”并不意味着“把所有能力都写进全局系统提示词”。它选择的是稳定会话快照、边缘扩展、按需正文和逐轮临时附件的组合。

## F. OpenClaw

### F.1 定位与结论

OpenClaw 是通用个人 Agent，而不是只服务代码仓库的编码 Agent。它同时覆盖 CLI、消息渠道、浏览器、记忆、技能、插件、子 Agent 和定时/心跳任务，因此比 Claude Code、Codex、OpenCode 更接近 MyAgent 的长期定位。

OpenClaw 的 system prompt 仍然不短。值得学习的不是正文措辞，而是它把“稳定前缀、动态后缀、项目上下文、provider 差异、工具能力和压缩恢复”分成了不同的数据与生命周期：

- `buildAgentSystemPrompt()` 是接收显式参数的纯渲染边界；
- `resolveAgentSystemPromptConfig()` 解析 owner、TTS、memory citation、delegation 和 workspace-only 等配置；
- embedded runner 收集当前模型、Shell、渠道、工具、skills、context files、sandbox、heartbeat 等事实；
- provider contribution 只能提供 `stablePrefix`、`dynamicSuffix` 和少量 section override；
- 最终 provider adapter 再决定如何把生成结果送给实际模型。

这比让 `prompts.ts` 同时读取环境、猜测能力、拼接身份和处理 provider 差异更容易验证。

### F.2 固定结构不等于固定全文

OpenClaw 的完整 prompt 有稳定的章节骨架，包括工具、执行偏好、安全、skills、workspace、文档、sandbox、时间、消息渠道、heartbeat 和 runtime 等；但章节是否出现取决于真实输入：

- 未启用 sandbox 时不生成 sandbox 章节；
- 没有对应工具时不生成相关工具指导；
- 渠道能力、消息动作、voice 和 heartbeat 来自当前 runtime；
- memory 章节会根据当前 context engine 是否已经接管记忆而关闭，避免重复注入；
- 子 Agent 与工具受限场景使用精简模式，而不是复用完整主 Agent prompt。

因此，OpenClaw 的“固定”是 section contract 固定，不是每轮强行发送同一批假设。

### F.3 明确的 prompt cache 边界

`src/agents/system-prompt.ts` 在稳定前缀后插入 `SYSTEM_PROMPT_CACHE_BOUNDARY`。边界以上按内容 hash 缓存，边界以下放置更可能变化的内容。

稳定侧主要包含：

- 身份、通用工具和安全规则；
- skills 索引；
- workspace 与稳定 project context；
- 已启用 sandbox 的稳定描述；
- provider 的 `stablePrefix`。

动态侧主要包含：

- 动态 Project Context；
- approval UI、owner identity；
- messaging、voice、reaction、heartbeat；
- conversation/subagent context；
- runtime 信息；
- provider 的 `dynamicSuffix`。

稳定项目文件还使用确定性排序。已知顺序是 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`TOOLS.md`、`BOOTSTRAP.md`、`MEMORY.md`；同级再按 basename 和规范化路径排序。`HEARTBEAT.md` 被显式归为动态文件。

这提供了比“把所有动态信息删掉以追求 cache”更可靠的方案：先定义生命周期，再把真正稳定的前缀做成确定性字符串。

### F.4 Provider 只能贡献，不应接管全部 prompt

OpenClaw 的 provider contribution contract 只允许：

- 在稳定部分追加 `stablePrefix`；
- 在动态部分追加 `dynamicSuffix`；
- 覆盖 `interaction_style`、`tool_call_style`、`execution_bias` 三类有限章节。

它保留了 legacy hook 以兼容旧扩展，但主边界并不鼓励 provider 任意替换整份产品身份。这一点适合 MyAgent：OpenAI、Anthropic、Gemini 适配器可以调整协议和模型特有提示，却不应各自复制一套完整产品 prompt。

### F.5 Project context、memory 与 skills

OpenClaw 的稳定 bootstrap 文件和逐日记忆不是同一种东西：

- `AGENTS/SOUL/IDENTITY/USER/TOOLS/BOOTSTRAP/MEMORY` 作为已知项目/身份文件处理；
- `memory/*.md` 默认不全部塞入 system，而是通过 memory search/get 按需读取；
- `/new` 或 `/reset` 可以一次性带入近期 daily memory，但不把它永久变成基础前缀；
- 子 Agent 默认只接收 `AGENTS.md` 和 `TOOLS.md`，避免复制主 Agent 的全部个人上下文。

skills 也采用“索引常驻、正文按需”：prompt 中只提供名称、描述、精确位置和内容派生版本，模型需要时再读取 `SKILL.md`。是否可见还受运行时、配置 allowlist 和插件启用状态约束。

这与 Hermes 的 metadata index、Claude Code 的按需 skill、OpenCode 的 skill tool 形成一致方向：能力发现可以进入稳定提示，但大段能力说明不应预加载。

### F.6 Codex 作为宿主时的协议适配

OpenClaw 没有假设所有模型都必须接收完全相同的消息布局。对于 native Codex，它利用 Codex 自身的上下文机制：

- `AGENTS.md` 交给 Codex 的规则发现机制；
- `TOOLS.md` 作为继承型 developer instruction；
- `SOUL/IDENTITY/USER` 作为当轮 collaboration developer instruction；
- `HEARTBEAT.md` 只提供文件指针；
- memory 优先走记忆工具，缺少工具时才使用有界 fallback；
- `BOOTSTRAP.md` 作为普通 turn context。

其他 harness 则使用 OpenClaw 自己的 system/context 注入。这说明跨 provider 的统一应发生在语义输入层，而不是要求最终 wire format 完全一样。

### F.7 Prompt mode、子 Agent 与 delegation

OpenClaw 有 `full`、`minimal` 和 `none` 三种 prompt mode：

- `full` 用于完整主 Agent；
- `minimal` 用于子 Agent 或显式工具 allowlist 场景，保留必要的工具、安全、workspace、sandbox、时间和 runtime；
- `none` 只保留最小身份与模型身份。

当 `toolsAllow` 生效时会强制 minimal，并移除 skills prompt，保证描述与实际可用工具一致。

OpenClaw 还有可配置的 delegation `prefer` 文案，会要求主 Agent 保持响应并把非平凡工作交给子 Agent。这个设计至少是显式模式且和工具可用性分离，但不适合作为 MyAgent 默认身份：是否委派应由任务规模和并发收益决定，不能把主 Agent 固定成“只协调、不执行”的领导角色。

### F.8 Sandbox 描述只在真实启用时出现

OpenClaw 只有在 `sandboxInfo.enabled` 为真时才生成 sandbox 章节，并具体描述 Docker runtime、workspace mount/access、browser、elevated 能力以及子 Agent 是否仍在沙盒内。

未启用时没有模糊的“受限环境”“沙盒 Shell”之类文案。这直接说明 MyAgent 不应把权限审批、命令分析或工作目录限制包装成沙盒；只有真实隔离边界存在时，模型才需要收到对应提示。

### F.9 Compaction 保存状态，不改变身份

OpenClaw 的 compaction instruction 要求摘要保留：

- 活跃任务及状态；
- 批处理进度；
- 最近用户请求与已经采取的动作；
- 决策与理由；
- TODO、开放问题、限制；
- 已做承诺与后续动作；
- 路径、代码、错误和各类精确标识符。

多段摘要合并时优先最近状态，并通过 SDK 的 `generateSummary`、重试和 fallback 处理失败。可选的 transcript rotation 会创建 successor session，保留 compaction entry、必要的最近 assistant/tool-result 序列和最新状态项，去除已摘要消息、重复 user message 与过时状态。

整个过程没有“最高指挥官”“子单元”或“只给战略指令”的角色切换。压缩改变的是历史表示形式，不是 Agent 的职责。

### F.10 不应照搬的部分

1. OpenClaw 的完整 prompt 仍包含大量产品功能说明，MyAgent 当前不需要复制消息渠道、语音、heartbeat 等章节；
2. provider contribution、legacy hook 和 native Codex 特殊路径增加了较多扩展复杂度，只有真正接入相应宿主时才有价值；
3. hash cache、provider cache key 和 transcript rotation 是运行时优化，不应先于 prompt 语义修正；
4. delegation `prefer` 是特定运行模式，不应成为默认主 Agent 身份；
5. bootstrap 文件体系适合长期个人助手，但 MyAgent 当前可先保留更小的 local rules + user context 边界；
6. prompt mode 不应演变成多套彼此漂移的全文模板，最好仍由共享 section renderer 裁剪生成。

### F.11 对 MyAgent 的直接启示

1. 使用显式输入构建 prompt，runtime adapter 负责收集事实，renderer 不自行猜测环境；
2. 定义稳定前缀与动态后缀，保证稳定文件确定性排序；
3. provider 只能做有限贡献和 wire-format 映射，不复制整份产品身份；
4. sandbox、工具、memory、skills、渠道提示都必须与实际启用能力一致；
5. 项目规则、长期记忆、逐轮 recall 和子目录规则使用不同生命周期；
6. 子 Agent 可以使用精简 prompt，但不能因 compaction 获得新的领导/从属身份；
7. skills 只常驻紧凑索引，正文按需读取；
8. 压缩摘要保存任务状态与精确事实，最新用户请求继续决定下一步。

## G. 五项目综合结论

### G.1 横向对照

| 维度 | Claude Code | Codex | OpenCode | Hermes | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| 产品定位 | 编码 Agent | 编码 Agent / 执行宿主 | 编码 Agent | 通用个人 Agent | 通用个人 Agent |
| 基础 prompt | 分 section 的长模板 | base instructions + developer/user context | 按模型选择模板 | stable/context/snapshot 组装 | 纯 renderer + 固定 section contract |
| 动态上下文 | user/system context 与动态 section | developer/user context、工具独立 | env/instructions/reminders | turn attachment 到 user message 副本 | cache boundary 以下 dynamic suffix |
| 项目规则 | 根规则 + 动态上下文 | AGENTS 独立注入 | 根规则 + read 时嵌套规则 | 根规则 + 工具触达时子目录 hints | bootstrap/context files + 宿主特化 |
| 工具说明 | 工具局部 prompt | tools 与 instructions 分离 | tool description + 当前 Shell | 工具快照冻结、guidance 按能力生成 | runtime 收集实际工具，mode 可裁剪 |
| Skills | 索引/按需加载 | skill 机制独立于基础正文 | skill tool 按需读取 | metadata index + skill_view | 带版本索引 + 按需读取正文 |
| 记忆 | 产品上下文机制 | memory/上下文机制独立 | 主要依赖项目规则与历史 | session snapshot + per-turn recall | bootstrap memory + memory tools/daily memory |
| Compaction | 保存工作事实与恢复信息 | 保存连续性，不应改身份 | compaction agent 生成结构化摘要 | 摘要仅供参考，最新 user 是当前任务 | 保存任务状态并可旋转 successor transcript |
| Sandbox 表述 | 与真实 sandbox/tool 状态绑定 | 由运行时权限环境提供 | Shell 指导与 policy 分离 | 工具/运行环境事实驱动 | 仅 `enabled` 时生成具体章节 |

#### G.1.1 任务范围与“最小改动”不是通用基础规则共识

- Claude Code 在编码任务章节中明确禁止超出请求增加功能、重构或顺手改进，并限制对未修改代码添加注释。
- OpenCode 按模型模板分别处理：Kimi 要求以最小改动达成目标，Gemini 要求未经确认不得显著扩大范围，默认与 Trinity 模板则采用更强的“除非用户要求，否则不加注释”。这不是统一的产品级规则。
- Hermes 只在 `agent.coding_context` 进入 coding posture 时注入“只修改任务所需内容，不做顺手重构、重命名或格式化”；该模式默认仅在交互式编码表面且位于代码工作区时启用，并允许项目规则覆盖默认值。
- OpenClaw 的通用基础 prompt 没有同类最小重构条款。仅在 gateway task suggestion 能力启用时提供工具，用于记录已确认的范围外后续工作，并明确该工具不会启动工作。

因此，“避免范围蔓延”是编码 Agent 或编码姿态中的常见约束，但不是通用个人 Agent 的基础 prompt 共识。MyAgent 不应把 JSDoc/TSDoc、注释格式和最小重构永久焊接到通用基础规则；这些内容应由项目规则或未来的条件化 coding context 承担。

#### G.1.2 工具选择目标不是减少 Shell 调用

- Claude Code 与 OpenCode 的多套编码模板通常要求文件读取、搜索和编辑优先使用专用工具，把 Bash 保留给真正需要 Shell 语义的系统命令与终端操作；主要理由是结果结构化、便于用户审查，而不是命令本身应尽量少用。
- Hermes 的 coding posture 采用明确分工：`read_file`、`search_files`、`patch`、`write_file` 处理代码文件，`terminal` 处理 Git、构建、测试、系统检查、计算、哈希和时间等任务。
- OpenClaw 的通用基础 prompt 没有“减少 exec”原则，只在具体能力边界上要求改用对应工具，例如 provider 消息必须走消息工具、网关配置优先走 gateway 工具，以及 sandbox 下区分文件工具路径与 exec 路径。

因此，合理目标是根据任务语义和当次真实工具集选择最合适的能力，而不是减少命令调用。文件专用工具与 Shell 的分工应跟随实际启用工具动态生成；不应把 Shell 描述成兜底或天然较差的选择。

#### G.1.3 记忆语义应随召回块出现，而不是依赖静态防幻觉规则

- MyAgent 当前由 `LongTermMemoryPlugin` 对最新用户消息做向量与关键词双路召回，将排序后的文本作为裸 `<long-term-memory>` 追加到请求副本；召回块没有来源、时间、置信度或冲突信息。静态 `RULE_LONG_TERM_MEMORY` 却将其称为“参考事实”，并限定标签只能位于最新 User 消息，与插件允许追加到 system 消息的兜底路径不一致。
- Hermes 将逐轮召回包装为独立 `memory-context`，明确说明它不是新的用户输入，并将记忆写入范围、过期风险和应保存内容作为专门能力治理；这不是一句全局“有标签就当事实”。
- OpenClaw 只在 `memory_search` / `memory_get` 实际可用时生成 Memory Recall 章节，要求只读取所需片段，并在低置信度时明确说明检查结果；还可以附带来源以供用户核验。

因此 MyAgent 不应保留当前静态 `RULE_LONG_TERM_MEMORY`，但也不能只删规则并继续注入裸文本。更合理的最小迁移是让插件生成自描述的记忆上下文：声明内容是系统召回而非当前用户输入，仅在与当前请求相关时作为可能过时的背景，当前用户消息与可验证实时信息优先；随后从 `SYSTEM_RULES` 删除静态记忆规则。来源、时间和引用可在后续记忆专项中独立建设。

#### G.1.4 基础身份应短、通用且不枚举静态能力

- Claude Code 用一句产品身份说明开头，并在独立工具章节中根据当前模式提供能力指导；其自主 Agent 分支也只要求使用当前可用工具完成工作。
- OpenCode 的多数模板把自身定义为编码 CLI，但不同模型模板差异明显；Kimi 模板采用“运行在用户电脑上的通用 AI Agent”，进一步说明身份与模型模板是独立适配维度。
- Hermes 使用可替换的 `SOUL.md` 作为首选身份，缺省身份覆盖问答、代码、分析、创作和工具执行等通用任务；OpenClaw 的最小模式只保留一句“运行在 OpenClaw 中的个人助手”。两者都不在身份句中静态枚举文件工具。

MyAgent 改造前的 `BASE_SYSTEM_PROMPT_PREFIX` 将自身限定为“本地智能体助手”，只列举读取、写入与列目录三项能力，并使用“极其重要的核心工程红线 / MUST OBEY”作为普通规则标题。这既低估真实工具集，也把通用 Agent 写成编码文件助手。基础身份应缩为产品名与通用助手定位，工具能力由当次真实工具描述提供。默认身份使用项目统一语言即可，回复语言由可选语言配置单独控制；提示词正文语言不等同于强制输出语言。

#### G.1.5 操作系统只需作为事实，Shell 能力不应由静态平台映射声明

MyAgent 当前 `OS_INSTRUCTIONS_MAP` 在基础提示词中按 `process.platform` 注入 Bash/PowerShell 选择、复合语法能力和禁用列表。但系统工具已经按真实平台动态注册：Bash 使用固定 POSIX/Bash 语义，PowerShell 只在 Windows 且可解析到可执行文件时出现；命令语法、风险和权限由统一分析器与策略在运行时判断。

更重要的是，正常运行时的 `DEFAULT_SHELL_COMPOUND_FEATURES` 已启用管道、条件链、重定向、后台和嵌套结构，而 `OS_INSTRUCTIONS_MAP` 的 macOS/Linux 分支仍声称这些结构不受支持。这已经不是保守提示，而是与执行能力冲突的错误信息。

因此应删除 `RULE_TERMINAL_SAFETY`、`OS_INSTRUCTIONS_MAP` 及冷启动占位符替换，只保留 `<os>` 作为当前平台事实。Shell 名称、参数和可用性由当次实际工具 Schema/描述表达，语法失败与权限结果以运行时返回为准。分析器内部遗留的“当前阶段不支持”错误文案属于独立运行时清理项，不应继续通过 system prompt 维护另一份能力矩阵。

### G.2 已形成的跨项目共识

五个项目实现方式不同，但核心方向高度一致：

1. **系统提示词不是一段万能作文。** 它是基础身份、会话快照、项目规则、工具能力和逐轮上下文的组装结果；
2. **能力说明必须与运行时一致。** 工具、sandbox、Shell、skills、memory 和渠道都不能靠静态文案假装存在；
3. **稳定信息与动态信息分层。** 目的既是 prompt cache，也是避免旧状态污染新任务；
4. **工具语法归工具边界。** Shell/PowerShell 差异应根据实际 Shell 写入工具说明，权限和副作用由 runtime policy 判断；
5. **规则按作用域加载。** 根规则只注入一次，嵌套规则在相关路径被访问时出现；
6. **skills 常驻索引、正文按需。** 发现能力不等于预加载全部能力说明；
7. **compaction 只改变历史表示。** 它保存事实、状态与承诺，但不晋升角色、不制造“领导者—子单元”关系；
8. **provider 统一在语义层。** 最终 message role、instructions 字段和 cache marker 可以由 adapter 按协议映射；
9. **应测试结构和行为，而不是固定句数。** 重复注入、无效章节、能力错配、压缩后任务漂移才是真正的回归风险。

### G.3 MyAgent 当前提示词的主要问题

结合当前 `src/core/prompts.ts`、本轮运行日志和前述竞品证据，优先级最高的问题不是“提示词写得不够多”，而是边界混乱：

1. local rules 存在重复注入风险；
2. 固定规则数量和大段统一正文把结构测试变成文案测试；
3. Shell、复合命令、权限策略和 sandbox 概念混在 system prompt 中；
4. 未实际启用 sandbox 时仍有容易让模型误判环境的表述；
5. 要求内部思考使用特定语言，既无法可靠验证，也会干扰模型自然推理；
6. handoff/compaction 注入“最高指挥官”“子单元”和“只给战略指令”，改变了正常执行身份；
7. runtime/channel/provider 差异缺少清晰输入模型，导致正文不断累积特例；
8. 当前测试更容易锁死旧文案，而不是保护真实行为。

### G.4 推荐的目标边界

不建议立刻复制任一竞品的完整框架。MyAgent 当前可以先建立一个较小但正确的输入模型：

```ts
interface PromptInput {
  base: BasePromptContext;
  session: SessionPromptContext;
  runtime: RuntimePromptContext;
  projectRules: ProjectRuleContext[];
  turnAttachments: TurnAttachment[];
}
```

各层职责建议为：

- `base`：短而稳定的产品身份、任务原则和通用安全边界；
- `session`：当前用户偏好、工作模式、provider/model 等会话快照；
- `runtime`：实际 Shell、sandbox、工具、渠道和权限环境；
- `projectRules`：去重后的根规则及按路径渐进发现的嵌套规则；
- `turnAttachments`：只对当前轮有效的 recall、plugin/context、提醒和恢复信息。

renderer 只根据这些显式输入生成 section；provider adapter 再把 section 映射到 `instructions`、developer message、system message 或工具描述。是否缓存是这套边界上的优化，而不是反过来决定语义。

### G.5 推荐实施顺序

1. **先修正确性**：local rules 只注入一次；删除 handoff 的角色晋升与内部思考语言；
2. **再拆 section**：把身份、执行原则、安全、沟通、runtime context 变成可独立生成和测试的部分；
3. **迁移工具细节**：Shell/PowerShell 语法与当前 Shell 能力进入工具说明，system 只保留“使用实际工具并遵守审批结果”；
4. **条件化真实能力**：只有真实 sandbox、memory、skills、MCP、subagent 能力存在时才生成对应提示；
5. **明确生命周期**：根规则、会话快照、逐轮附件、compaction summary 分开；
6. **最后优化缓存和 provider 映射**：先保证行为正确，再引入确定性前缀、hash/cache key 或宿主特化。

第一轮改造不需要建设 Hermes 的 SQLite prompt snapshot，也不需要完整复制 OpenClaw 的 provider contribution 和 transcript rotation。最小有意义范围是：消除重复与虚假信息、恢复正常 Agent 身份、拆开 system/tool/runtime 三类职责，并用行为测试守住边界。

### G.6 最终判断

MyAgent 的提示词问题不能通过“参考 Claude Code 再润色十条规则”解决。五个项目共同证明，优雅来自上下文架构，而不是句子更漂亮：

- system prompt 保持短、稳定、真实；
- 工具自己描述语法与能力；
- runtime 只注入当前事实；
- 项目规则按作用域出现；
- skills/memory 按需加载；
- compaction 保留事实但不改变身份；
- provider 差异留给适配层。

因此后续 OpenSpec 应围绕“简化 system prompt 与统一上下文组装边界”展开，而不是继续在现有大字符串上逐条增删措辞。
