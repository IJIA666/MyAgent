# 探索主题: 智能体工作流生命周期拆解与插件化解耦

## 1. 问题定义

为了实现高内聚低耦合的智能体执行引擎，需要重构当前 ` AgentLoop ` (定义于 [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts)) 模块。当前该模块将核心的 ReAct 推理状态机与众多的支撑服务（Token 水位校验与压缩、System Prompt 一致性校验、缓存击穿诊断、Loop Prevention 死循环熔断、readFile 后的 JIT 规则注入、文件落盘与 Tracer 日志记录）硬编码耦合在一起，导致主循环逻辑臃肿、扩展新拦截机制困难且极难编写隔离的单元测试。因此，本项目需要评估是否可以将智能体工作流程拆解为清晰的“生命周期”，并通过一套“插件/拦截器”机制实现横切关注点的高效解耦。

## 2. 关键发现与调研结果

- **代码库现状**：

  - **职责过度堆积**：当前项目的核心推理执行器 ` AgentLoop ` 拥有 460 多行代码，主循环 ` chat ` 中嵌入了本应作为切面的 Token 预算计算、防爆压缩触发、缓存一致性检测等逻辑，破坏了单一职责原则。

  - **缺乏拦截契约**：在 ` chat ` 的工具执行前后、LLM 请求前后，均没有标准的可扩展插槽，使得任何逻辑变动或新工具辅助逻辑的引入（例如 JIT 规则注入）必须直接在 ` AgentLoop ` 中做破坏性修改。

- **核实与洞察**：

  - **事件驱动解耦**：深入调研了 ` Agents/claude-code ` 架构，其核心大循环与基于 Hooks 的事件高度解耦。其定义了极其细致的 ` HOOK_EVENTS ` 事件列表（共 27 个生命周期节点），允许插件（如 ` builtinPlugins.ts `）动态添加 TypeScript 函数钩子（` addFunctionHook `）或 Shell 钩子，对核心步骤进行拦截或阻断。

  - **冲突解决机制**：` claude-code ` 在面临插件并发控制与参数突变时，具有以下处理机制：(1) **对于权限决定**，在 ` executeHooks ` 中采用 ` deny > ask > allow ` 的优先级聚合投票算法，确保最严格的安全规则生效；(2) **对于参数修改**，支持插件在 ` PreToolUse ` 节点返回 ` updatedInput ` 修改工具参数，在 ` PostToolUse ` 节点返回 ` updatedMCPToolOutput ` 修改工具输出，通过异步生成器 ` yield ` 流传，由外层依次覆盖消费。但对于 ` messages ` 上下文数组，其直接将原始数组引用传给 ` FunctionHook `，没有进行 Immer 级别的事务性沙箱隔离，因而仍存在隐式突变的冲突风险。

  - **纯函数式架构**：深入调研了 ` Agents/opencode ` 架构，其在 ` packages/core ` 中利用 ` Effect-ts ` 库编写纯函数式控制流。在 ` session/runner/llm.ts ` 中通过 ` llm.stream ` 进行单次 provider 迭代，并通过 Fiber 异步并发调度工具执行（` toolMaterialization.settle `），最后利用 ` compaction.compactIfNeeded ` 完成上下文压缩。

  - **切面副作用隔离**：` opencode ` 的 ` packages/core/src/plugin.ts ` 巧妙地结合了 ` Immer ` 对 Hook 进行副作用隔离。在触发 Hook（如 ` catalog.transform `）时，若出参包含对象，会使用 ` createDraft ` 生成 Draft 传给各个插件，由插件在 Draft 上做就地修改，Hook 链执行完毕后再通过 ` finishDraft ` 统一提交。

  - **异常隔离与缓存优化**：深入调研了 ` Agents/hermes-agent ` 架构，其在 ` hermes_cli/plugins.py ` 中实现插件生命周期调度（` invoke_hook `）。其具备两个显著特征：(1) **异常硬隔离**，遍历执行插件回调时，每个回调均以独立的 ` try-except ` 捕获隔离，防止单一插件崩溃瘫痪主 ReAct 循环；(2) **提示词缓存友好**，在 ` pre_llm_call ` 钩子中，插件返回的额外注入上下文永远被 append 到 ` user ` 消息中，而不是突变 ` system prompt `，这使得提示词缓存（Prompt Cache）前缀在大模型请求中保持完全一致，极大降低了首 token 响应延迟和 Token 成本。

  - **配置化钩子契约**：深入调研了 ` Agents/openclaw ` 架构，其在 ` packages/agent-core/src/agent-loop.ts ` 中定义了强类型的 ` AgentLoopConfig ` 配置化钩子契约：(1) **执行前拦截**，` beforeToolCall ` 回调接收参数与上下文，若返回 `{ block: true }`，则用阻断信息代替实际的工具调用结果写入上下文；(2) **执行后覆盖**，` afterToolCall ` 接收工具结果，允许返回一个更新对象以原地改写 ` content `，` isError ` 等值，便于无缝挂载 JIT 规则和处理大文本截断；(3) **多轮上下文转换与终止**，` transformContext ` 和 ` prepareNextTurn ` 提供更粗粒度的上下文修剪（如 Compaction）和下一轮配置动态合并插槽，彻底将外围优化策略从大循环中隔离出来。

  - **压缩钩子拦截**：深入调研了 ` Agents/codex ` 架构，在 ` hooks/src/registry.rs ` 中设计了针对上下文压缩生命周期的 ` PreCompact ` 与 ` PostCompact ` 钩子，支持插件控制是否终止或跳过压缩；同时在面临多个钩子并发修改参数的冲突时，采用以最后完成的执行结果为准的仲裁机制（` latest_updated_input `）。

  - **双向模型代理**：深入调研了 ` Agents/gemini-cli ` 架构的 ` HookSystem `，其 ` BeforeModel ` 钩子支持在大模型请求前拦截修改入参或直接返回 Mock 响应短路请求，` BeforeToolSelection ` 支持动态控制大模型可选的工具集，` AfterTool ` 支持通过 ` tailToolCallRequest ` 发起尾随工具调用并覆盖当前工具结果。

  - **持久状态调度**：深入调研了 ` Agents/tinypace-ai-desktop ` 架构，其 ` TaskExecutionManager.ts ` 并非 ReAct 大循环内的单步拦截，而是采用基于数据库驱动（Database-driven）的测试流状态持久化调度，支持跨应用重启的暂停和恢复；其 Skill 仅作为包含 ` SKILL.md ` 的静态规则包管理。

## 3. 方案对比与推荐方向

我们将当前项目的重构方向分为三个方案：

- **方案 A（当前硬编码架构）**：不做任何生命周期抽象，将拦截、诊断、落盘直接写入核心 ReAct 执行器。

- **方案 B（极简切面解耦）**：仅将 ` AgentLoop ` 拆出几个局部服务（如 TokenWatermarkService, PreToolUseService），在主循环的关键行手动注入调用。

- **方案 C（生命周期插件架构）**：参照 ` claude-code ` 核心思想，定义完整的智能体生命周期 Hooks（如 ` beforeRequest `、` beforeToolCall ` 等），提供 Plugin 规范，主循环完全由 Hook 事件驱动。

| 评估维度 | 方案 A | 方案 B | 方案 C | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| **核心流程清晰度** | 差 ✗ | 中 ✗ | 极佳 ✓ | 方案 C 将主循环完全解耦为状态机框架，最清晰 |
| **新特性扩展能力** | 弱 ✗ | 中 ✗ | 极强 ✓ | 方案 C 通过实现新 Plugin 即可热插拔，无须动核心逻辑 |
| **控制流灵活性** | 强 ✓ | 中 ✗ | 复杂 ✗ | 方案 A 局部控制非常直接；方案 C 需要精细的 Hook 返回值设计来控制 Loop 重启/中断 |
| **测试隔离性** | 弱 ✗ | 良 ✓ | 极佳 ✓ | 方案 C 的插件可 100% 独立编写单元测试，极易 Mock |

**推荐路径**：

选择 **方案 C（生命周期插件架构）**。

虽然方案 C 的类型契约与控制流机制设计难度最高，但它能提供最优的工程整洁性，且可以优雅地借鉴 ` claude-code ` 经过生产验证的 Hook Event 设计思路，把 Token 水位检测、死循环熔断、JIT 规则注入、缓存失效分析全部做成 Plugin 随生命周期热插拔。

## 4. 约束、风险与未知项

  - **异步状态安全**：部分插件的执行是异步的。为了防止在异步等待中持有失效的沙箱引用，我们将利用管道中间件（ Middleware / 洋葱模型 ）调度异步更新，或者在异步操作前后显式地执行 ` finishDraft ` 提交和 ` createDraft ` 重构，确保异步上下文的状态安全。

  - **控制指令冲突**：当多个插件在同一个周期返回互斥控制流指令时，必须在内核中定义优先级 arbitration（ 仲裁 ）机制。我们设定优先级为：` abort `（ 强行终止 ） > ` restart `（ 重启循环 ） > ` continue `（ 顺延放行 ），一旦产生冲突，以最高等级信号为准，以保障主控流决策链的一致性。

  - **插件变更追踪**：全插件驱动架构容易导致对上下文的变更成为黑盒。我们将利用 ` Immer ` 的 ` produceWithPatches ` 记录每个插件修改的 JSON Path 及具体值（ Patch 机制 ），将其写入 trace 调试日志，实现针对上下文变动路径的强可观测性。

  - **顺序拓扑调度**：插件执行存在先后依赖（ 如 JIT 规则注入必须在 Token 计算插件之前执行 ）。插件注册时将支持显式的 ` weight `（ 权重优先级 ）或 ` after: ['JitPlugin'] ` 依赖树配置，在内核初始化阶段进行拓扑排序调度，确保 Hook 链按预期顺序执行。

  - **缓存失效风险**：外围上下文或即时规则的注入插件如果直接拼接或修改 ` system prompt `，会导致提示词缓存（ Prompt Cache ）前缀失效。在设计时需借鉴 ` hermes-agent ` ，将其 append 到最近的 ` user ` 消息或对话历史尾部，降低推理成本与响应延迟。

## 5. 否决方案

- **方案 B（极简切面解耦）**：

  - **舍弃理由**：由于没有统一的生命周期契约，每次引入新服务依然要在 ` AgentLoop ` 的特定位置增加硬编码。这治标不治本，无法彻底解决 ` AgentLoop ` 重构后继续膨胀的问题。

## 6. 最终方案设计

  - **统一钩子生命**：定义 5 类核心 Hook 事件，包括会话启停（ ` SessionStart ` / ` SessionEnd ` ）、模型前后拦截（ ` BeforeModel ` / ` AfterModel ` ）、工具前后拦截（ ` BeforeTool ` / ` AfterTool ` ）、压缩前后控制（ ` PreCompact ` / ` PostCompact ` ）以及工具过滤（ ` BeforeToolSelection ` ），实现核心控制流的插件化插桩。

  - **强控返回值流**：每个 Hook 支持强类型的 ` HookControl ` 返回值契约（ 例如返回 ` { action: 'restart' } ` ），允许像 ` TokenWatermarkPlugin ` 这样的插件在拦截到 Token 水位超标并触发压缩后，指示 ` AgentLoop ` 重启当前循环或终止后续步骤，避免只读通知的局限。

  - **隔离沙箱修改**：借鉴 ` opencode ` ，对修改上下文（ ` messages ` 或 ` context ` ）的 Hook 插件，通过类似 ` Immer ` 的机制将上下文打包为 ` Draft ` 传入。所有修改均在 ` Draft ` 沙箱中完成，并在 Hook 链执行完毕后统一通过不可变（ Immutable ）更新合并状态，消除并发修改的冲突隐患。

  - **异常硬隔离护**：每个插件 Hook 注册的执行都用独立的 ` try-catch ` 包裹，捕获的异常仅作诊断记录（ ` Warning ` 级日志 ），保证任何单一扩展插件发生故障不会瘫痪智能体的 ReAct 主推理循环。

  - **缓存友好注入**：对于需要即时注入的上下文或 JIT 规则插件，强制将其 append 附加到最近的 ` user ` 消息或对话历史尾部，严禁频繁篡改 ` system prompt ` 前缀，以保障大模型提示词缓存（ Prompt Cache ）的最大化命中，降低首 token 延迟和 API 推理成本。
