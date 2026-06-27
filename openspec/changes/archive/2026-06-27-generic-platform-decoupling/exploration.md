# 探索主题: 平台环境特化硬编码与解耦重构

## 1. 问题定义
智能体通用框架（Agent Platform）应该作为纯净、通用的应用底座而存在。然而在目前项目的源码演进中，存在多处“将特定运行时、特定语言规范、特定第三方提供商限制或特定的操作系统属性”直接硬编码在核心逻辑或核心提示词（System Prompt）中的技术债务。这极大阻碍了平台在多语言、多操作系统（macOS / Linux / CI 容器环境）以及多第三方大模型提供商（OpenAI 等）中的平滑迁移与通用性。

## 2. 关键发现与调研结果

- **代码库现状**：
  1. **无状态执行引擎硬编码 OS 细节 (terminal-engine.ts)**：
     - 在 [terminal-engine.ts L285-307](file:///d:/projects/MyAgent/src/adapters/tools/tools/system/terminal-engine.ts) 中，硬编码了针对 `win32` 的 npm/npx 漏洞重定向（通过 `resolveNpmCliPath` 去找物理 npm-cli.js 文件），以及针对 powershell 特异性的乱码字符集防御（注入重设 UTF8 指令）。这类偏向 Windows 操作系统的微观修复直接写在进程调度底座中，降低了跨沙箱和跨平台的通用可维护性。
  2. **第三方大模型适配器限制反向污染领域层 (MemoryService.ts)**：
     - 在 [MemoryService.ts L124](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts) 中，长期记忆的批处理嵌入方法硬编码了 `const BATCH_SIZE = 10`。
     - **分析**：阿里的 DashScope `text-embedding-v3` 确实限制了单次批量上限为 10。然而，这个具体的“提供商限制”属于外部适配器层的局限，直接反向硬编码进核心领域层的 `MemoryService` 会使得在使用支持大批量并发（如 OpenAI）的嵌入端时，被迫将其分拆为每次 10 个的低效串行调用。
  3. **核心稳定提示词操作系统声明冲突 (prompts.ts)**：
     - 在 [prompts.ts L19](file:///d:/projects/MyAgent/src/core/usecases/prompts.ts) 的 `BASE_SYSTEM_PROMPT`（稳定缓存层）中，硬编码了“你当前运行的宿主操作系统是 Windows”。
     - 与此同时，在 `buildSystemPrompt` 拼装时，易变上下文层（`volatile_context`）中又会通过 `<os>${osStr}</os>` 动态输出当前真实物理平台（例如 macOS/Linux 下会输出 `darwin` 或 `linux`）。
     - 这导致大模型在非 Windows 环境下运行时，会接收到自相矛盾的冲突指令（ stable 区声称为 Windows，volatile 区声称为 darwin ），干扰模型推理精准度。

- **核实与洞察 (开源竞品深度分析)**：
  通过对主流开源智能体项目的系统提示词引擎的源码进行深度逆向审计，发现了高度一致的**“缓存冷热隔离 + 环境探测动态下沉”**最佳实践：
  
  *   **Claude Code (constants/prompts.ts)**：
      - 预留了 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'` 作为物理分界符。
      - 分界符**之前**是纯粹的 Static content（如开发风格规范、高危阻断等不变量），完美命中提供商（如 Anthropic）的静态 Prompt Caching；
      - 分界符**之后**则是动态探测出的实时环境变量。Claude Code 绝不在静态区硬编码操作系统类型，而是调用 Node 的 `os` 库检测当前环境并在边界线后动态拼装为 `<env>` XML 标签。
  
  *   **OpenClaw (system-prompt.ts & system-prompt-params.ts)**：
      - **主提示词架构 (`system-prompt.ts`)**：OpenClaw 的主 `buildSystemPrompt` 拼装设计非常纯粹。在拼装核心人设及代码规范时，**完全没有提及任何具体的操作系统限制**。它刻意将 `date`、`cwd` 等高频变动的瞬时信息以追加的形式强行压在系统提示词的**最末尾**返回。这最大化了上方长达数百行静态指南在 API 端的缓存命中率。
      - **运行时特征隔离 (`system-prompt-params.ts`)**：所有具体的 `host`、`os`（操作系统）、`shell` 类型等底层硬件环境信息，被完全隔离并归纳在 `RuntimeInfoInput` 结构中。这些特征由 `buildSystemPromptParams` 在运行时进行探测。
      - **割裂拼接机制**：在 API Payload 层面，通过 `SYSTEM_PROMPT_CACHE_BOUNDARY` 分隔符，将这些探测出来的操作系统与物理环境信息动态追加在边界线**下方**。这杜绝了因环境变化导致静态核心提示词缓存失效，同时也使得大模型能够完美获知当前的物理 OS，并保持高频交互中静态前缀缓存的绝对不失效。
  
  *   **Hermes Agent (agent/system_prompt.py)**：
      - **三层拼装模型 (Three-Tier Assembly)**：Hermes 采用极度清晰的提示词分层——`stable`（稳定人设/通用工具指南/操作系统动态适配段）、`context`（工作区本地的 AGENTS.md 规则）、`volatile`（高频抖动的时间戳/会话 ID/记忆快照）。
      - **跨平台自适应提示 (`_resolve_platform_hint`)**：Hermes 定义了专门的平台提示语解析器。它不在核心常亮里写死特定的操作系统名称。而是调用 `_resolve_platform_hint` 根据实际物理探测到的 `platform_key`（如 `windows`），在 `stable` 稳定层尾端注入对应 OS 专属的安全命令规范（如 Windows 原生命令限制、复合操作符限制）。这既确保了 stable 稳定层的最大化缓存命中率，又完全根除了因为硬编码导致跨环境运行时的语义冲突问题。
      - **绝对缓存策略**：Hermes 在会话启动时将该提示词组装好后，直接缓存在 `agent._cached_system_prompt` 字段中。整个会话生命周期内**绝不在中途重新拼装渲染其中的稳定和环境段落**。这是最顶级的 Prompt Caching 实践。
  
  *   **OpenCode (session/system.ts & session/prompt.ts)**：
      - **模型特定的多模板路由 (`provider(model)`)**：OpenCode 定义了多套针对特定品牌/提供商的人设模板（如 `PROMPT_ANTHROPIC`、`PROMPT_GEMINI`、`PROMPT_GPT` 甚至 `PROMPT_KIMI`）。运行时通过当前正在对话的模型 ID 进行动态条件路由分发，这有效避免了大模型在运行时因为吃下竞争品牌的系统人设而产生的“品牌认知分裂”。
      - **环境常亮彻底下沉**：主静态模板中没有任何特定的宿主平台操作系统信息。所有具体的 `ctx.directory`（当前目录）、`process.platform`（物理操作系统，如 win32 / darwin）及当天日期在运行时才由 `SystemPrompt.environment` 探测，拼装为 `<env>` XML 标签注入到最终发送负载中。
      - **项目引用关系扩展 (`available_references`)**：支持从全局和局部工作区中自动搜寻并加载 `<available_references>`，为模型提供立体的跨目录依赖图谱引导。

---

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：全面适配器自治与通用配置驱动 (推荐) | 方案 B：硬编码穷举与特化条件分支判断 | 结论 |
| :--- | :--- | :--- | :--- |
| **平台通用性** | **高**：核心层（Usecase/Domain）对操作系统、大模型提供商特性实现零耦合 | **低**：核心代码中充斥着各类 OS 和提供商的 `if-else` 分支判断 | A 占优 |
| **维护成本** | **低**：新增 OS 或模型特性时仅需新建适配器，核心代码无痛扩展 | **高**：每次环境迁移均需对核心主循环和领域服务动手术 | A 占优 |
| **批处理效率** | **高**：分批大小（Batch Size）下沉至适配器内，充分榨干各模型批吞吐性能 | **低**：所有模型强行被最弱者的 Batch Size 10 拖慢速度 | A 占优 |

**推荐路径（最后设计蓝图与物理修改地图）**：

1. **核心人设 OS 特征去硬编码与占位符动态装配 (prompts.ts 重构)**：
   *   **`prompts.ts` 修改图谱**：
       - 将 [prompts.ts](file:///d:/projects/MyAgent/src/core/usecases/prompts.ts) 中的 `BASE_SYSTEM_PROMPT` 常量里原本硬编码的 `5. 【终端命令原子化与 Windows 安全】...` 全段移出。
       - 替换为占位符：`5. 【终端命令安全性约束】\n{{OS_SECURITY_INSTRUCTIONS}}`。
       - 在 `prompts.ts` 中新增常量映射 `OS_INSTRUCTIONS_MAP`：
         ```typescript
         const OS_INSTRUCTIONS_MAP: Record<string, string> = {
           win32: `你当前运行的宿主操作系统是 Windows。当你需要使用 execute_command 工具执行命令时：
            - 必须且仅能执行单一、原子的 Windows 原生命令（例如使用 'tasklist' 替代 'top/ps'，使用 'ipconfig' 替代 'ifconfig'）。
            - 绝对禁止使用任何复合连接符、重定向符、分号、换行或管道符（如 &, &&, |, ||, ;, <, >, \\n 等）将多个独立操作拼接为单条长命令，否则将被沙箱引擎强制拦截执行。`,
           darwin: `你当前运行的宿主操作系统是 macOS (Darwin)。当你需要使用 execute_command 工具执行命令时：
            - 必须且仅能执行单一、原子的 POSIX 命令。
            - 绝对禁止使用复合连接符或重定向管道符连接多条命令，否则将被拦截。`,
           linux: `你当前运行的宿主操作系统是 Linux。当你需要使用 execute_command 工具执行命令时：
            - 必须且仅能执行单一、原子的 POSIX/Linux 命令。
            - 绝对禁止使用复合连接符或重定向管道符连接多条命令，否则将被拦截。`
         };
         ```
       - **模块级一次性装配**：在 `prompts.ts` 的模块级（即常量的正下方，进程启动时执行一次），一次性完成占位符替换：
         ```typescript
         const osPlatform = process.platform;
         const osInstruction = OS_INSTRUCTIONS_MAP[osPlatform] ?? OS_INSTRUCTIONS_MAP.linux;
         const RESOLVED_BASE_PROMPT = BASE_SYSTEM_PROMPT.replace('{{OS_SECURITY_INSTRUCTIONS}}', osInstruction);
         ```
       - 重构 `buildSystemPrompt` 拼装方法：
         直接将 `RESOLVED_BASE_PROMPT` 常量（而非在每次调用时重新 replace 的动态临时变量）组装并压入 `parts` 的 `stable` 冷缓存层，彻底维护其语义上的“绝对静态不变性”。
       - **单测维护**：更新 `prompts.test.ts` 中对 `RESOLVED_BASE_PROMPT` 断言的单元测试，保证覆盖所有的 OS 条件分支。

2. **长期记忆拆批逻辑完全下沉 (MemoryService.ts 与 EmbeddingPort 适配器重构)**：
   *   **`MemoryService.ts` 修改图谱**：
       - 彻底删除 [MemoryService.ts L124](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts) 中硬编码的 `const BATCH_SIZE = 10;` 以及手写的串行 `for` 拆批分块调用。
       - 将其精简为直接一次性提交全部文本给 Embedding 驱动层：
         ```typescript
         const embeddings = await this.embeddingPort.embed(texts);
         ```
       - **`DashScopeEmbeddingAdapter.ts` 修改图谱**：
         - 在 [DashScopeEmbeddingAdapter.ts](file:///d:/projects/MyAgent/src/adapters/llm/DashScopeEmbeddingAdapter.ts) 的 `embed(texts)` 方法内部，自理分批逻辑（单次批上限为 10），并在适配器内并发发送请求、平铺聚合后返回。
       - **`OpenAiEmbeddingAdapter.ts` 维护**：
         - OpenAI 适配器继续采用原生的大批量一次性提交，充分榨干其并发网络带宽，从而让 OpenAI 环境下的记忆索引性能提升数倍。

3. **Windows 底层终端命令修复解耦 (terminal-engine.ts 重构)**：
   *   将 powershell 命令转译及 npm-cli 劫持修补逻辑从进程调度引擎底座中剥离，移入宿主操作系统适配器中。

---

## 4. 约束、风险与未知项
- **向后兼容性**：移动 `BASE_SYSTEM_PROMPT` 中的操作系统说明，需要对目前正在运行的部分单测（可能包含对提示词字符串的正则断言）进行适配修改，需注意对齐。

## 5. 否决方案
- **在领域层堆砌 OS 分支代码**：被完全否决。因为在核心逻辑层不断加入类似 `if (platform === 'win32') {} else if (platform === 'linux') {}` 的代码会很快让主循环无法维护。
