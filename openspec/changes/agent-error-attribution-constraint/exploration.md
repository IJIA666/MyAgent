# 探索主题: 智能体未知报错归因约束与轻量化规则防御机制

## 1. 问题定义
当前智能体（Agent）在调用工具失败或遭遇未预期的系统级异常时，其行为往往属于概率本能预测（如盲目修改入参、胡乱捏造参数重新尝试），在未知错误面前“碰运气”，这会导致大量无谓的 Token 损耗与不安全行为。为了在单会话和短上下文中彻底根治这一问题，我们需要建立“未知报错归因约束机制”，强制智能体在遇到未知业务错误时停止盲目重试，将真实报错反馈给用户并请求协助。

## 2. 关键发现与调研结果
- **代码库现状**：在当前的 `McpToolManager`（[mcp-client.ts](file:///d:/Projects/MyAgent/src/adapters/tools/mcp-client.ts)）及系统提示词（[prompts.ts](file:///d:/Projects/MyAgent/src/core/usecases/brain/prompts.ts)）中，我们通过引入底层的热重启自愈与在 `BASE_SYSTEM_PROMPT` 中注入第 9 条红线规则，成功拦截了“网络超时”和“Schema 错配”两类特定异常下的瞎碰行为。但这是人工硬编码的防御规则，大模型在面对超出规则范围的未知业务报错（例如临时文件锁冲突、版本不兼容等）时，其概率预测本能依然会触发原地瞎猜的重试。
- **Claude Code 源码静态分析与调研**：
  深入研读 `Agents/claude-code` 源码，我们在其底层异常捕获与容错上发现了极具参考价值的工业级实现：
  1. **MCP 会话过期与物理自愈重试**：在 [mcp/client.ts](file:///d:/Projects/Agents/claude-code/src/services/mcp/client.ts) 的 `callMCPTool` 中，系统通过捕获 `McpSessionExpiredError`（例如 404 + JSON-RPC 代码 -32001）或 `Connection closed` 异常，调用 `clearServerCache` 清除失效连接句柄。在外层循环中，通过 `MAX_SESSION_RETRIES` 次数限制执行 `continue` 重试（自动拉起 fresh client 重新连接并完成握手），该物理重建对上层透明。
  2. **终端大日志溢出截断（防止模型认知退化）**：在 [BashTool.tsx](file:///d:/Projects/Agents/claude-code/src/tools/BashTool/BashTool.tsx) 中，当终端命令（如编译/测试失败）抛出大段报错日志时，系统通过 `buildLargeToolResultMessage` 和 `generatePreview` 进行首尾截断和存盘预览，避免海量日志导致大模型上下文爆仓，保障了模型在分析编译/测试失败时的推演深度与分析决策质量。
- **OpenCode 源码静态分析与调研**：
  深入研读 `Agents/opencode` 源码，该项目在工具调用容错与错误回传的结构化设计上具有显著特征：
  1. **统一的 Transient Error 判定与指数退避重试**：项目在 [retry.ts](file:///d:/Projects/Agents/opencode/packages/core/src/util/retry.ts) 中实现了一个底层的重试机制。通过匹配 `TRANSIENT_MESSAGES`（包含 `etimedout`, `econnreset`, `econnrefused`, `socket hang up` 等瞬时错误），结合 `attempts = 3` 限制与 `delay * Math.pow(factor, attempt)` 指数退避累进等待，提供统一的底层物理防抖能力，其思想与本 change 殊途同归。
  2. **面向 LLM 的结构化错误回传（增强因果感知）**：在 [to-llm-message.ts](file:///d:/Projects/Agents/opencode/packages/core/src/session/runner/to-llm-message.ts) 中，当工具执行状态为 `error` 时，系统不只是简单传递字符串，而是向 LLM 回传包含 `error`、`content` 和 `structured`（结构化错误元数据）的 `ToolResultPart`，并显式标记 `resultType: "error"`。这使模型能够获取到极其丰富和白盒化的故障上下文，为精细的故障反射提供了数据支撑。
- **OpenClaw 源码静态分析与调研**：
  深入研读 `Agents/openclaw` 源码，该项目在运行环境自调整、持久化状态层防错以及可观测性脱敏体系上具备高度的工程成熟度：
  1. **冷启动环境的“CLI 自我热重启（Self-Respawning）”**：在 [entry.respawn.ts](file:///d:/Projects/Agents/openclaw/src/entry.respawn.ts) 中，系统在冷启动阶段如检测到 Windows 栈空间不足（缺失 `--stack-size=8192`）或 TLS 证书链配置问题，会通过 `runCliRespawnPlan` 对自身环境进行重置并重新 `spawn` 自身。这种环境自调节能力极大保障了在异构终端中的冷启动成功率。
  2. **会话转录与持久化状态层的“拼合修复（Transcript Auto-Repair）”**：在 [session-file-repair.ts](file:///d:/Projects/Agents/openclaw/src/agents/session-file-repair.ts) 与 [session-transcript-repair.ts](file:///d:/Projects/Agents/openclaw/src/agents/session-transcript-repair.ts) 中，当本地 JSONL 转录数据由于磁盘或非预期崩溃导致不闭合、损坏时，系统在 replay 前会强制执行拼合修复（如清洗无 role 的损坏行、用 `BLANK_USER_FALLBACK_TEXT` 填充空白 user 消息以迎合 provider 的交替规则限制）。若检测到模型发出了 `toolUse` 但由于异常缺失了对应的 `toolResult`，系统会自动合成为 `[openclaw] missing tool result...` 的特定错误响应填充历史，防止模型在此后 resume 对话时被 provider 的 Schema 检验硬拦截熔断。
  3. **指标特征分析与指纹提取（Fingerprinting）**：在 [embedded-agent-error-observation.ts](file:///d:/Projects/Agents/openclaw/src/agents/embedded-agent-error-observation.ts) 中，系统会对模型提供商报错做脱敏化（Redact）与结构化归集。通过哈希/剔除 requestId 等关键信息并提取错误指纹 `buildObservationFingerprint`，将故障归为标准的 `ProviderRuntimeFailureKind` 类型以作幂等诊断。
- **Hermes Agent 源码静态分析与调研**：
  深入研读 `Agents/hermes-agent` 源码，该项目在自主学习总结（越用越强）与技能边界防御的设计上极具学术与实践价值：
  1. **一等公民工具的“技能自总结迭代（Agent-Managed Skill Synthesis）”**：在 [skill_manager_tool.py](file:///d:/Projects/Agents/hermes-agent/tools/skill_manager_tool.py) 中，Hermes 将“技能管理”设计为一套可供 LLM 调用的核心动作（包括 `create`, `edit`, `patch`, `delete`, `write_file` 等）。当智能体完成一项复杂任务后，能动态自主归纳出成功的方法论，生成带 frontmatter 描述的 `SKILL.md`，或局部 patch 现存技能，实现程序过程性记忆的动态自我增长与进化。
  2. **技能演进的“硬质安全卡关（Symlink & Directory Boundaries Defense）”**：由于赋予了模型自主修改/删除本地技能代码文件的特权，极易因幻觉引发越权删除的恶性事件（如误删根目录）。Hermes 在 `_validate_delete_target` 中构建了硬核的安全防线：(a) 包含校验（Containment），严格限制删除路径必须在指定 skills roots 子目录内；(b) 终极安全防线，严禁删除 skills 根目录；(c) 软链接劫持防御（Symlink Hijacking Defense），通过检测 `_is_path_redirect` 拦截所有试图指向系统其他敏感路径的符号链接/Windows Junction 劫持，构建了坚固的物理边界安全围栏。
  3. **单会话内“测试强制卡关（Verify-Before-Finish）”与精准错误回显**：在 [verification_stop.py](file:///d:/Projects/Agents/hermes-agent/agent/verification_stop.py) 与 [verification_evidence.py](file:///d:/Projects/Agents/hermes-agent/agent/verification_evidence.py) 中，Hermes 通过拦截机制彻底终结了模型修改完代码不作测试就盲目退出的“碰运气”行为。
     - **编辑卡关拦截**：当模型请求结束任务（stop）且检测到有文件被修改（`changed_paths`）时，系统会在 SQLite 数据库中检索本次 session 内是否有新鲜的“测试通过证据”（status == passed）。若无，则强制拦截退出。
     - **错误与命令精准回显**：在拦截时，系统向大模型投喂包含 `Verification status` 与 `Changed paths` 的指令，并在 `_status_detail` 中把上一次运行失败的测试指令与报错日志硬截断（保留核心的 1200 字符）回显给模型，强制模型审视刚刚操作失败的真实反馈，打消幻觉脑补。
     - **临时测试自愈（Ad-hoc Verification）**：对于没有配置现成测试命令的未知 workspace，系统会指示大模型在 `/tmp` 下临时编写 `hermes-verify-` 前缀的 ad-hoc 脚本完成运行校验，在单会话下构筑了极其柔韧的卡关反射反馈链路。
- **核实与洞察**：
  根据对学术界 and 开源前沿中“LLM自我纠错（Self-Correction）与反射自愈”的联网调研，目前的最佳实践指出，LLM 在自我评估时存在“共享盲区”（Shared Blind Spots），即大模型很难直接看出自己刚犯的错误。高效的纠错系统依赖以下三个支柱：
  1. **结构化错误分类法（Structured Error Taxonomies）**：将失败显式划分为 Memory Errors（记忆/检索失效）、Planning Errors（规划/忽略限制）和 Execution Errors（工具执行/语法失效），以便模型根据不同的错误特征采取对偶修复策略。
  2. **验证优先架构（Verify-First Architecture）**：必须依赖非 LLM 校验器（如单元测试、Linter 等确定性工具）提供明确的失败证据，方可激活纠正循环，防止陷入无谓的循环试错和 Token 消耗。
  3. **人机协同确认机制（Human-in-the-Loop Alignment）**：针对非确定性的未知严重异常，由于大模型存在“元认知盲区”（无法靠自我反思发现根本原因），继续强推其自愈不仅会产生逻辑幻觉，还会引发不安全的越权调用。此时的最优解是立即阻断智能体的自主行动，将错误现场完整展示给用户，由人类的经验介入提供因果对齐和操作纠偏，这对于保障单会话内的安全和确定性至关重要。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (废弃)：双阶段诊断关卡 | 方案 B (废弃)：后台审计智能体 | 方案 C (敲定)：轻量提示词规则扩展 |
| :--- | :--- | :--- | :--- |
| **设计复杂度** | 中等 ✗ (需要在 Agent Loop 切入诊断机制) | 高 ✗ (需双模型并发、长 trace 传递) | **极低 ✓ (仅需在系统提示词第 9 条扩增分支)** |
| **共享盲区规避** | 差 ✗ (让 LLM 诊断自身错误存在元认知共享盲区) | 一般 ✗ (异步审计仍有模型认知的盲区局限) | **极佳 ✓ (直接强制阻断重试并向用户求助，不自作主张)** |
| **执行延迟与 Token** | 较高 ✗ (每次报错都强制输出诊断书增加轮次与开销) | 高 ✗ (双 Agent 异步运行开销巨大) | **零额外开销 ✓ (正常运行时无延迟，报错时立刻阻断退出)** |
| **覆盖合理性** | 差 ✗ (大多数小错误不值得强制写诊断报告) | 一般 ✗ (后台审计增加非必要通信) | **极佳 ✓ (仅针对未知重大报错执行精准拦截阻断)** |

**推荐路径**：
选用 **方案 C：轻量提示词规则扩展**。
该方案通过在系统提示词（Prompts）的“异常与防参数幻觉重试规则”中增加针对未知报错的硬拦截约束，以最高确定性、最低侵入性来消除 AI 在未知报错下的碰运气行为。

## 4. 落地细节（轻量提示词规则扩展设计）
拟在 [prompts.ts](file:///d:/Projects/MyAgent/src/core/usecases/brain/prompts.ts) 的 `BASE_SYSTEM_PROMPT` 中，对现有的第 9 条异常规避红线规则进行扩充，划分三个分支：
1. **分支一（网络超时）**：确认是网络/超时错误，使用原参数进行退避重试或向用户报告系统繁忙。
2. **分支二（Schema 校验错配）**：确认为参数 Schema 校验不匹配错误，严禁自行修改或捏造参数，直接抛出异常或向用户汇报。
3. **分支三（其他未知业务错误 - 新增）**：当你接收到的工具报错既不包含网络超时特征，也不包含 Schema 校验特征时（即无法判断具体根因的未知报错，如文件锁冲突、权限不足、未处理的业务异常等），你必须立即停止一切修改参数并尝试重新调用的重试行为。你必须在回复中直接向用户如实陈述你所看到的错误原文、坦承无法判断其根本原因，并请求用户协助确认后再决定下一步的动作。

## 5. 否决方案
- **方案 A（双阶段诊断关卡）**：由于让 LLM 诊断自己犯的错误存在严重的“元认知共享盲区”（大模型很难直接看出自己刚犯的错），且每次报错都强制生成诊断报告，开销大且覆盖范围远超实际需要，故予以废弃否决。
- **方案 B（独立后台审计智能体）**：双智能体设计复杂度极高，异步审计对全局 I/O 和 token 消耗过大，且依然受限于模型本身认知，故予以废弃否决。
- **基于 Workflow 节点硬编码错误路由**：像 LangGraph 一样在系统层面通过硬编码代码处理所有错误路由。此方案将业务处理逻辑与错误耦合写死，丧失智能体的泛化自愈能力，故予以坚决否决。
