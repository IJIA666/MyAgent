# 探索主题: 长期记忆 RAG 缓存优化与防击穿

## 1. 问题定义
在当前的长期记忆（RAG）召回机制中，由于每次用户输入都会重新触发双路召回（向量相似度与物理关键字匹配），并动态追加到 `systemMessage` 的尾部，导致 System Prompt 的哈希指纹频繁波动。
根据主流大模型平台（如 DeepSeek、OpenAI、Anthropic）的 **Prompt Caching** 前缀匹配机制，任何前置位置的修改（哪怕一个空格的增删或排序变化）都会导致其后所有上下文（包括多轮对话历史）的 KV 缓存全部失效，从而引发大面积的缓存击穿，不仅大幅增加了交互的响应延迟（首字输出延迟），更带来了极高的 Token 成本消耗。

## 2. 关键发现与调研结果
- **代码库现状**：
  * [LongTermMemoryPlugin.ts](file:///d:/Projects/MyAgent/src/core/usecases/LongTermMemoryPlugin.ts#L104-L112) 在 `BeforeModel` 阶段将检索出的 Top-5 召回记忆（`<long-term-memory>`）以 `systemMessage.content += memoryPrompt` 的形式追加写入系统提示词，导致系统提示词在每轮对话中随着用户的最新话题变化而频繁变更。
  * [agent-loop.ts](file:///d:/Projects/MyAgent/src/core/usecases/agent-loop.ts#L579-L618) 的后置缓存校验逻辑 `checkCacheAndCalibrate` 能够监控并报警检测到此类“前置指纹变更”带来的缓存击穿，说明缓存抖动已被作为核心痛点进行指标监控，但缺少架构底座上的避让方案。
- **核实与洞察**：
  * 经联网核实，大模型厂商的 Prompt Caching 采用 **精确的前缀 Token 序列哈希匹配（Exact Token Prefix Matching）**。
  * 最佳实践应遵循 **“Static First, Dynamic Last”**（静态前置，动态置尾）原则。长期的、固定的系统指令必须始终保持不变排在最前，而诸如召回记忆、实时时间、临时用户输入等动态变化的上下文必须往后排放，以最大限度保护长历史会话的缓存状态。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (当前：System Prompt 追加) | 方案 B (推荐：最新 User 消息中注入) | 选型分析 |
| :--- | :--- | :--- | :--- |
| **缓存匹配率** | 极低 ✗ (每次召回不同都会击穿后文缓存) | 极高 ✓ (前置 System 与长历史 100% 缓存) | 方案 B 占优 |
| **首字响应延迟** | 较高 ✗ (需要重新计算长历史 KV) | 极低 ✓ (直接复用前置 KV) | 方案 B 占优 |
| **指令遵循度** | 强 ✓ (作为最高优先级 System 指令输入) | 较强 ✓ (通过 System 引导大模型关联) | 方案 A 略优 |
| **代码改造代价** | 无 (现有实现) | 极低 ✓ (仅调整注入消息数组的目标节点) | 方案 A 占优 |

**推荐路径**：
选择 **方案 B**。
1. 将 `System Prompt` 锁定为纯静态提示词（如系统角色、响应规范、安全规则），确保无论进行多少轮对话，系统提示词前缀的哈希值绝对固定。
2. 将双路召回重排后的 `<long-term-memory>` 块，以“上下文事实补充”的身份，动态拼接在多轮对话数组的 **最新一条 User 消息的前面或内部**（如以 XML 块前置声明包裹）。
3. 这样，静态 System 消息与前期长历史对话的 prefix 不受最新 RAG 变化干扰，缓存命中率可接近 100%，而动态的 RAG 变更只在当前轮次被重新计费。

## 4. 约束、风险与未知项
- **模型理解偏差**：某些大模型对于将参考事实放置在 `user` 角色中可能没有在 `system` 中那么敏感。因此，需要设计并在 `System Prompt` 中显式固定一条关联指令（例如：*“在回答时，请务必参考对话中最新注入的 <long-term-memory> 事实。”*）以保证模型遵循度。
- **滑动窗口边界**：随着历史对话达到限制被压缩/Compacted 时，被折叠的历史消息中包含的 RAG 临时记忆如何清理，需要验证 `CompactionService` 对 user 消息的处理逻辑。

## 5. 否决方案
- **方案 C (仅在首轮对话中注入 RAG 召回)**：该方案被否决。因为在多轮对话交互中，用户的话题往往会随着时间不断转移（从讨论 A 代码转向询问 B 文件），如果仅在首轮注入，大模型在后面的交互中将无法获取与当前最新话题相关的长期记忆 facts，违背了 RAG 的召回本意。

---

## 6. 配置设计与控制参数扩展

为了增强 RAG 机制在生产环境中的灵活性，系统必须支持通过环境变量（`.env`）和 `AppConfig` 全局配置来控制 RAG 的启闭及微调其核心召回指标。

### 6.1 拟新增配置项定义

| 环境变量名 | 配置属性路径 | 类型 | 默认值 | 作用描述 |
| :--- | :--- | :--- | :--- | :--- |
| `AGENT_RAG_ENABLED` | `config.runtimeLimits.ragEnabled` | Boolean | `true` | 是否开启 RAG 召回，若设为 `false` 则在推理前不再注入记忆 |
| `AGENT_RAG_SCORE_THRESHOLD` | `config.runtimeLimits.ragScoreThreshold` | Float | `0.5` | 向量相似度检索得分阈值，低于此分数的记忆要点会被过滤 |
| `AGENT_RAG_RECALL_LIMIT` | `config.runtimeLimits.ragRecallLimit` | Integer | `5` | 混合检索重排（RRF）后最终注入大模型上下文的记忆条数上限 |
| `AGENT_RAG_REFINEMENT_THRESHOLD` | `config.runtimeLimits.ragRefinementThreshold` | Integer | `2` | 触发自省子智能体提炼记忆的最小有效对话轮数限制 |

### 6.2 模块侵入说明
* **配置加载层 (`src/config/loader.ts`)**：
  在 `AppConfig` 的 `runtimeLimits` 中增加上述 4 项解析加载，设置默认降级兜底值，并进行 Object 冻结保护。
* **插件挂载层 (`LongTermMemoryPlugin.ts`)**：
  * 在 `handleBeforeModel` 触发时，首先读取 `ragEnabled` 开关，若为 `false` 直接退出，不执行任何双路检索与注入。
  * 将 `searchResults.filter(r => r.score >= 0.5)` 中的 `0.5` 替换为 `ragScoreThreshold` 的配置读取。
  * 将 `fusedResults.slice(0, 5)` 中的 `5` 替换为 `ragRecallLimit`。
  * 在 `handleSessionEndAsync` 中，将 `effectiveHistory.length < 2` 中的 `2` 替换为 `ragRefinementThreshold`。

---

## 7. 其他核心模块的硬编码配置梳理与优化建议

在排查整个 Codebase 后，我们发现除了 RAG 模块外，**死循环熔断防护** 和 **上下文压缩提炼服务** 也存在多处影响系统灵活性和多环境适配度的硬编码参数，建议一并进行配置抽提。

### 7.1 上下文压缩提炼服务 (`CompactionService.ts`)
目前有 4 处关键的硬编码：
* **硬截断保留条数**：硬编码为 `4` 条（`truncateHistory(4)`）。这限制了在 Token 爆仓进行物理截断时模型能看到的最新上下文深度。建议增加 `AGENT_COMPACTION_RETAIN_COUNT` 配置。
* **异步提炼触发差值**：当累积增量 Token 达到 `5000` 时才会触发异步提炼任务。在大上下文或高频交互中，这个值可能偏高或偏低。建议增加 `AGENT_COMPACTION_TRIGGER_DELTA` 配置。
* **压缩失败降级限制**：连续 `3` 次提炼失败会退化为兜底静态摘要。建议增加 `AGENT_COMPACTION_FAILURE_LIMIT` 配置。
* **最近文件跟踪上限**：反向扫描读写工具记录的文件上限是 `5` 个。建议增加 `AGENT_COMPACTION_RECENT_FILES_LIMIT` 配置。

### 7.2 死循环熔断插件 (`LoopPreventionPlugin.ts`)
* **同一工具相同参数最大执行次数**：硬编码为 `3` 次（`callCount >= 3` 则熔断）。这控制了当模型陷入无意义工具调用时的安全终止门槛。建议抽提为 `AGENT_LOOP_PREVENTION_LIMIT` 环境变量。

### 7.3 优化配置项全景图（建议扩展）

| 环境变量名 | 默认值 | 作用描述 | 推荐修改模块 |
| :--- | :--- | :--- | :--- |
| `AGENT_LOOP_PREVENTION_LIMIT` | `3` | 防熔断中同一工具完全相同参数允许的最大调用次数 | `LoopPreventionPlugin.ts` |
| `AGENT_COMPACTION_RETAIN_COUNT` | `4` | 发生紧急 Token 硬截断时保留的最新的多轮对话消息轮数 | `CompactionService.ts` |
| `AGENT_COMPACTION_TRIGGER_DELTA` | `5000` | 触发异步 Summary 提炼所需的增量累计 Token 数 | `CompactionService.ts` |
| `AGENT_COMPACTION_FAILURE_LIMIT` | `3` | 异步提炼连续失败时，退回到兜底静态摘要的次数上限 | `CompactionService.ts` |
| `AGENT_COMPACTION_RECENT_FILES_LIMIT` | `5` | 压缩后最近被读写的并挂在上下文头部的关联文件路径数 | `CompactionService.ts` |


