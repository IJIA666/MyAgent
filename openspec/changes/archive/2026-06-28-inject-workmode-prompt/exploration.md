# 探索主题: 系统提示词动态注入安全工作模式

## 1. 问题定义
目前 MyAgent 的安全工作模式（Safe、Auto、YOLO、Plan）只在终端和文件系统的底座拦截网（例如 `terminal.ts` 和 `file-system.ts`）中进行物理硬编码过滤。
系统提示词（System Prompt）在组装时并没有传入当前的 `WORK_MODE` 变量，这导致大模型在生成命令时处于“不知情”状态：
- 在 **Plan（只读）模式**下，大模型仍然频繁生成写操作和文件删除命令，导致其调用被底层物理掐断，并产生死循环；
- 在 **YOLO（免审）模式**下，大模型不知情，可能会在生成交互时依然过多地向用户做多余的提问和提醒，无法发挥免密放行的高效优势。

为了在生成阶段和拦截阶段实现协同，需要将安全模式（WORK_MODE）动态且优雅地注入系统提示词（System Prompt）。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 系统提示词在 [prompts.ts](file:///d:/projects/MyAgent/src/core/usecases/brain/prompts.ts) 中的 `buildSystemPrompt` 拼装，包含 `stable` (绝对静态)、`context` (上下文稳定) 和 `volatile` (高频变动，不予缓存) 三层 XML 物理结构。
  - 目前 `<volatile_context>` 层只有 `<date>`, `<cwd>`, `<os>` 三个标签，没有注入安全工作模式变量。
  - `workMode` 变量在 `SessionContext`（基于 [SessionEventPort.ts](file:///d:/projects/MyAgent/src/ports/driven/session/SessionEventPort.ts)）中通过 `getWorkMode()` 维护。
- **核实与洞察**：
  - **Claude Code 真实机制**：深入分析其源码 [messages.ts:L3331-3338](file:///d:/projects/Agent/claude-code-analysis/src/utils/messages.ts#L3331) 发现，其在进入 `Plan` 模式时，会组装一段强力的限制性提醒文本（`Plan mode is active. You MUST NOT make any edits...`），但该文本并没有塞入 `system` 消息。
  - **动态消息气泡与 `<system-reminder>` 机制**：该文本通过 `getPlanModeInstructions` 被组装为一个 `UserMessage[]`。为了防止与普通用户提问混淆，它会在组装时通过 `wrapMessagesInSystemReminder` 将内容统一用 `<system-reminder>\n...\n</system-reminder>` 进行物理包裹。
  - **缓存友好与注意力机制的平衡**：通过在多轮交互的消息队列的偏后位置以临时气泡追加工作模式状态，不仅强力约束了大模型的越权意图，而且完全绕开了最头部静态 System Prompt 改变造成的 Context Cache（上下文缓存）雪崩。
  - **Opencode 动态 Tool 裁剪机制**：深入分析其源码 [runner/llm.ts:L196-205](file:///d:/projects/Agent/opencode/packages/core/src/session/runner/llm.ts#L196) 发现，其拥有更为硬核的防护机制：在 LLM 调用前执行 `tools.materialize(permissions)`。如果当前权限（如 Plan 只读状态）禁用了某些写动作，系统在组装给 LLM 接口的 `tools` 定义时会**物理裁剪剔除**这些工具。大模型因在 Tool Definitions 中看不见写工具，从源头消除了大模型尝试生成越权 Tool 调用的可能，完全杜绝了拦截碰撞带来的往返延迟。
  - **Openclaw 级联式插件钩子链**：深入分析其源码 [plugins/hooks.ts:L372](file:///d:/projects/Agent/openclaw/src/plugins/hooks.ts) 发现，其提供了极其灵活的生命周期钩子（如 `transformSystemPrompt`），允许外围的安全控制面 ACP 通过插拔式级联链来动态合并与装配提示词，而无需侵入核心状态变量。这揭示了通过解耦内存状态（Control Plane）和渲染展现（View Plane）来规避忙锁死锁的设计范式。
  - **Hermes Agent “一次渲染”缓存铁律**：深入分析其源码 [system_prompt.py:L125-130](file:///d:/projects/Agent/hermes-agent/agent/system_prompt.py#L125) 发现，为了保证大模型前缀缓存命中率最大化，其在整个会话期间**只在启动时渲染一次 System Prompt，后续轮次完全复用，中途严禁重刷**（仅在 Context 压缩时重建）。为了缓存，它被迫牺牲了提示词中动态 `cwd` 和运行态变量的实时感知。这强力印证了“中途重刷 System Prompt 会彻底破坏 Prompt Cache”的行业共识。而本方案 C（尾部气泡注入）通过将动态变量剥离到消息尾部的 UserMessage，既保全了长前缀的缓存，又实现了零感知延迟，在设计上实现了对 Hermes 妥协方案的本质超越。





## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：在系统提示词 `volatile_context` 中注入 | 方案 B：作为 `local_rules` 随 context 层注入 | 方案 C：动态对话尾部追加法 (尾部气泡注入) [终极推荐] | 选型分析 |
| :--- | :--- | :--- | :--- | :--- |
| **缓存效率** | 极低 ✗ (沿用既得设计。现有 `cwd` 与 `date` 早已击穿 System Prompt 缓存；加之模式变动，头部缓存彻底无命中可能) | 极低 ✗ (修改模式导致 rules 变动，使 context 层缓存雪崩) | **极高 ✓** (剥离所有动态参数让 System Prompt 彻底静态。虽最末条动态 User 消息哈希无法缓存，但保全了历史长前缀的最大化命中) | **方案 C 完美胜出** |
| **忙锁安全度** | 低 ✗ (在 Hook 降级触发时同步刷新 System Prompt 会触发 `isProcessing` 忙锁断言崩溃) | 低 ✗ (同上，修改 rules 需要重写并冻结配置) | **极高 ✓** (降级时仅修改内存中 `workMode` 状态，在 LLM 请求发送前在循环外层进行动态尾部组装，无需修改 `messageHistory` 首条消息，完全避开忙锁) | **方案 C 完美胜出** |
| **模型感知精准度** | 高 ✓ (标签语义明确) | 中 ✗ (容易分散注意力) | **高 ✓** (以系统通知气泡紧贴用户提问传入，模型对其有极高遵循度) | 方案 A/C 均占优 |

**推荐路径**：选择 **方案 C (动态对话尾部追加法) 作为核心骨架，并将“动态工具物理裁剪”作为安全增强的可选配置，由用户在 config 中进行权衡取舍**。

方案 C 的核心价值链在于：
1. **修复历史遗留缓存缺陷**：彻底从 System Prompt (`messageHistory[0]`) 中剥离高频变化的 `volatile` 层（包括 `workMode`、当前目录 `cwd` 和动态日期），使原本名存实亡的 System Prompt 真正转变为“绝对静态”的缓存高命中层。
2. **长前缀缓存最大化（心智轨）**：将高频变化的变量（`cwd`, `workMode`, `date`）合并打包为 `<system-reminder>` 标签，追加在**最后一条 User 消息的末尾**传入。这只会牺牲最新一条消息本身的缓存，但挽救了整场会话多轮历史的缓存大局。
3. **规避忙锁设计**：模式修改与降级只作用于 Session 内存状态，完全跳过 `messageHistory` 修改链，从根本上解决并发冲突。

## 4. 约束、风险与未知项
- **动态拼装时机**：拼装必须发生在 `LlmPort.chat` 发起之前的瞬时 payload 组装期，且仅作为给大模型 API 的临时输入，不强行追加到物理的 `SessionContext` 的历史消息栈中，以防产生持久消息污染。
- **降级锁释放**：降级触发时，只需执行轻量级的内存状态切换：`sessionContext.setWorkMode('Safe')`，无需立即重刷 System Prompt。由于其后的 LLM 请求会在下一次外圈交互时自动附带新的模式，因此感知是天生同步且安全的。
- **【核心痛点】动态工具裁剪与缓存命中率的权衡 (Tool Stripping vs. Cache Hit)**：
  在 LLM API 协议中，`tools` 数组定义属于前置哈希前缀。当用户或系统动态切换到 `Plan` 模式并启用“动态工具裁剪”时，工具列表的改变会**直接导致那一轮会话的历史缓存全部失效击穿**。
  - *设计决策*：系统应将“动态工具物理裁剪”设计为一项**可选的增强配置**（例如 `enable_plan_tool_stripping: true`）。对于极其看重缓存费用和响应速度的用户，可以关闭此项，在 `Plan` 模式下工具集保持不变，仅依赖心智轨（`<system-reminder>` 气泡）进行行为规约；对于把安全性放在绝对第一位的用户，则可开启此项，物理封死写工具，并在横跳切换时接受当轮缓存击穿的代价。


## 5. 否决方案
- **方案 A (系统提示词尾部注入)**：虽然它对缓存击穿的恶化并非新问题（原本 `cwd` 和 `date` 就已破坏了缓存），但它因未解决既有缓存弊端而被否决；同时它无法规避 Hook 执行期间 `isProcessing` 忙锁崩溃的问题，故予以否决。
- **方案 B (Context级 Rules 注入)**：缓存雪崩效率过低，增加长文本解析成本，故否决。


