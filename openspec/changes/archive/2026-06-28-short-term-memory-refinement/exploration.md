# 探索主题: 短期记忆回溯与高级噪点治理

## 1. 问题定义
在长链路任务中，大模型面临两大短期记忆（Context RAM）危机：
1. **中型输出噪音与 Lost-in-the-Middle 现象**：工具产生的输出在未达到大文件硬拦截阈值时直接塞入上下文，导致模型注意力漂移；同时高价值信息若在 messages 中段容易被模型忽略。
2. **逻辑规划死锁**：当智能体做出了错误的修改导致代码编译卡死在死胡同中时，由于短期记忆缺乏有效的撤销（Undo/Rollback）与物理回退，智能体容易在错误的脏工作区和上下文里原地打转。

## 2. 关键发现与调研结果
- **本地代码库现状**：
  - [CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/brain/CompactionService.ts) 拥有硬截断和后台异步语义摘要（`triggerAsyncCompactionIfNeeded`）双套机制。然而这套摘要属于 **Session 会话级后台异步行为**，旨在防范长期会话超限，无法为单次工具输出提供强同步、无延迟、极高精度的实时折叠。
  - [ToolDispatcher.ts](file:///d:/projects/MyAgent/src/core/usecases/engine/ToolDispatcher.ts#L31) 的 `handleLargeToolOutput` 目前仅对超过 `largeToolOutputLimit`（默认 8000 字符）的大文本进行落盘和折叠。对于普通中型输出无能为力。
  - [SessionContext.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts#L43) 中的 `messageHistory` 缺乏分支/回溯逻辑。
- **竞品调研：Claude Code 的短期记忆与快照方案**：
  深入剖析了 `Agent/claude-code-analysis` 的源码，提炼出其在短期记忆和快照治理上的三大核心工程实践：
  1. **基于本地冷备份数据库的物理快照与回滚 (File Checkpointing & Rewind)**：
     - **源码实现**：[src/utils/fileHistory.ts](file:///d:/projects/Agent/claude-code-analysis/src/utils/fileHistory.ts)。
     - **备份逻辑**：它没有直接依赖外部 Git 操作，而是在用户全局配置目录下维护了一个基于 `{filePathHash}@v{version}` 的物理冷备份数据库（存放在 `file-history/<SessionID>/` 下）。
     - **时机控制**：文件被 Edit 或 Add 前，调用 `fileHistoryTrackEdit` 提前备份原始内容；每轮 Turn 结束时调用 `fileHistoryMakeSnapshot` 对检测到 mtime 发生变化的文件备份为递增版本（v2, v3...）；执行回退（`fileHistoryRewind`）时，若文件在快照点不存在则调用 `unlink` 物理删除，若不一致则调用 `restoreBackup` 将冷备份写回以恢复原始状态和权限。
  2. **多模态对象主动剥离 (Media Stripping)**：
     - **源码实现**：[src/services/compact/compact.ts:stripImagesFromMessages](file:///d:/projects/Agent/claude-code-analysis/src/services/compact/compact.ts#L145)。
     - **实现机制**：在执行历史压缩提炼前，自动将 user 消息和 tool_result 中所有的大体积 `image` 和 `document` 块替换为 `[image]` / `[document]` 占位符，消除了海量图片荷载对 Token 窗口的吞噬。
  3. **细粒度差异化 Token 预算头部截断 (Differential Token Budgeting)**：
     - **源码实现**：[src/services/compact/compact.ts L122-132](file:///d:/projects/Agent/claude-code-analysis/src/services/compact/compact.ts#L122)。
     - **截断策略**：对读盘文件规定 `POST_COMPACT_MAX_TOKENS_PER_FILE = 5000`，对外部载入技能规定 `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5000`。若超出限额强行对其执行**头部截断**。这确保了技能与配置的核心头部指引能被完整保留。
- **竞品调研：OpenCode 的短期记忆与快照方案**：
  深入剖析了 `Agent/opencode` 的源码，其核心设计亮点在于：
  1. **基于项目专属隐藏 Git 仓库的内容寻址物理快照 (Hidden Git-Repo Content-Addressed Snapshot)**：
     - **源码实现**：[packages/core/src/snapshot.ts](file:///d:/projects/Agent/opencode/packages/core/src/snapshot.ts)。
     - **备份逻辑**：它在全局数据目录下为每个项目开辟一个独立的隐藏 Git 对象仓库（`snapshot/<project-id>/<worktree-hash>`），避开了直接在用户项目当前分支进行 commit 造成的物理污染。
     - **时机与动作**：调用 `Snapshot.capture` 通过 Git 写入树（`git.tree.capture`）生成一个唯一的快照 `TreeID`；还原时，直接基于该 `TreeID` 执行受限制的 `checkout` 或者 selective `restore`。这不仅避免了冷备份多个文件产生的磁盘膨胀，同时利用了 Git 底层 C 语言级的内容寻址高性能。
  2. **双向行级/字节保底对齐截断算法与过期回收 (Line/Byte-aligned Preview & Retention)**：
     - **源码实现**：[packages/core/src/tool-output-store.ts](file:///d:/projects/Agent/opencode/packages/core/src/tool-output-store.ts)。
     - **双向对齐算法**：设置 `MAX_LINES = 2000` 和 `MAX_BYTES = 50KB` 阈值。截断时优先按行（`\n`）将文本对折为首尾两段，保留行完整度；若对折后仍然超出字节配额，则降级为按字节数强制截断，中间插入 `... output truncated; full content saved to [path] ...`。这极大提升了大文本折叠在终端展示时的排版美观度和可读性。
     - **定期生命周期清理**：后台以 Schedule 启动一小时一次 of `cleanup` 循环，自动删除在 `tool-output/` 临时目录下创建时间超过 7 天（`RETENTION = Duration.days(7)`）的历史文件。
- **竞品调研：OpenClaw 的上下文网关抽象**：
  深入剖析了 `Agent/openclaw` 的源码，其核心架构设计在于：
  1. **高层抽象的上下文转换钩子网关 (`transformContext` Hook)**：
     - **源码实现**：[packages/agent-core/src/types.ts](file:///d:/projects/Agent/openclaw/packages/agent-core/src/types.ts#L187)。
     - **设计思想**：OpenClaw 核心库本身并不内置任何具体的 Pruning、Compaction 剪裁算法或 Cache TTL 机制，而是仅提供此统一钩子网关。它允许外层插件在 LLM 调用前对高层消息进行截断与重构，成功实现了短期记忆业务层与物理投递层的解耦。
- **竞品调研：Hermes Agent 的轨迹压缩与首尾保护策略**：
  深入剖析了 `Agent/hermes-agent` 的源码，其核心设计亮点在于：
  1. **“首尾双保 + 中段有损压缩”算法 (Head & Tail Protection with Middle Compression)**：
     - **源码实现**：[trajectory_compressor.py L8-15, L93-98](file:///d:/projects/Agent/hermes-agent/trajectory_compressor.py#L8)。
     - **工作机制**：当历史会话 Token 数量超限时，Hermes 采取了高度精细化的“剪中段”策略：
       - **首段强行保护**：绝对不裁剪第一轮交互（包括系统提示词、用户的首个提问、首个 GPT 响应和首个工具结果），防范最初始的全局目标和指令丢失。
       - **尾段强行保护**：绝对不裁剪最后 $N$ 轮（默认 `protect_last_n_turns = 4`）的近期工具调用和推理结论，为智能体保留了最新的“工作 RAM”。
       - **中段语义压缩**：仅将“第 2 轮 Tool 响应”到“最后第 $N$ 轮”之间的中段消息历史执行 LLM 总结，将其提炼并替换为单条 human 摘要消息（Summary Notice），而后续的工具执行链保持完整。
     - **技术优势**：该算法极其精妙地对抗了 Lost-in-the-Middle 现象（LLM 对 Prompt 开头和结尾的敏感度高，中段容易遗忘）。通过提炼中段噪音而死死护住首尾，既极大地压缩了 Token，又最大程度地维持了智能体的任务连贯性。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：工具大输出 LLM 语义摘要 | 方案 B：基于物理备份数据库的快照回溯与分区分叉 | 方案 C：动态 Token 预算与 Lost-in-the-Middle 策略 (含首尾双保中段压缩) | 方案 D：去中心化配额的启发式差异化压缩 (含行级对折与外带持久化引用) |
| :--- | :--- | :--- | :--- | :--- |
| **Latency 延迟开销** | 高 ✗ (每次工具大输出都需要同步调用一次 LLM 提炼) | 低 ✓ (仅做本地文件写回/删除和历史还原) | 无/低 ✓ (仅在触及水位线时针对中段执行一次 LLM 提炼) | 极低 ✓ (启发式正则匹配/行对折切分/同步外带写盘) |
| **语义真实度 (无幻觉)** | 中 ✗ (存在幻觉和细节丢失风险) | 极高 ✓ (原始备份 100%还原) | 极高/中 ✓ (首尾 100% 真实，仅中段有摘要损耗) | 极高 ✓ (提取准确结构/支持外带文件 100% 日志保全) |
| **物理文件一致性** | 无 (仅限内存) | 极高 ✓ (使用冷备份还原，解决物理脏改回退难题) | 无 | 无 |
| **决策纠错能力** | 低 | 极高 ✓ (可物理与内存一键纠错回档重试) | 低 | 低 |

### 🚀 推荐路径：
我们决定**采用“分阶段进化”的务实策略**：

1. **第一阶段（性价比最高，优先落地）**：
   - 联合实施 **方案 D（去中心化工具配额差异压缩）** 与 **方案 C（首尾双保中段压缩与动态 Token 预算）**。
   - **双轨结合的 Pruning 时机控制（方案 D 优化）**：
     - **时机定义**：在 `ToolDispatcher` 同步拦截阶段，每次工具返回时立即进行检测。
     - **外带持久化引用（解决日志失真与内存膨胀冲突）**：若工具输出超出了其去中心化声明的 `max_lines` 和 `max_bytes` 配额，**立即将完整的原始输出写入外带大输出目录**（如 `.myagent/tool-outputs/`），并在内存 `messageHistory` 中将内容写入为**带有原始文件路径引用的复合消息历史结构**（例如 `CompoundToolResultContent`，包含行级对折预览和 `originalPath` 物理路径引用）。
     - **优势**：这保证了会话落盘的物理日志（`transcript.jsonl`）完美保真（有完整文件的路径引用，可回溯真实原始数据），同时极大减轻了内存垃圾回收压力（防范大搜寻大编译报错导致 OOM），最终送大模型的仅仅是折叠裁剪预览，完全实现逻辑和物理层面的统一。
   - **配额去中心化**：借鉴 OpenCode 设计，工具在各自注册的元数据中明确声明属于该工具自身的 `max_lines` 和 `max_bytes` 配置项，让治理权解耦下放给工具层。
   - 采用**双向行级 + 字节保底**截断算法对超出工具配额的大文本进行行完整度折叠。
   - 借鉴 Hermes Agent，实现**“首尾双保 + 中段有损压缩”算法**。为 System Prompt、最近 N 轮 Raw 消息分配强保护配额，仅对中段 messages 触发 Compaction，消解 Lost-in-the-Middle 风险。
2. **第二阶段（高阶攻坚，冷备份物理快照回溯）**：
   - 实施 **方案 B（物理快照回溯）**。
   - **实施边界与时机控制（方案 B 优化）**：为了避免高频无脑快照带来巨大的系统开销和磁盘膨胀，快照应与项目中已有的 `securityCategory`（安全分类）机制深度协同。
   - 仅当工具的 `securityCategory` 属于 `edit` / `write`（即具有物理文件脏改副作用的敏感写操作，例如 [WriteFileTool](file:///d:/projects/MyAgent/src/adapters/tools/impl/filesystem/file-system.ts#L27) 和 [EditFileTool](file:///d:/projects/MyAgent/src/adapters/tools/impl/filesystem/file-system.ts#L27)）在执行前卡关（checkSafety）成功时，才精准触发 `fileHistoryTrackEdit`，在临时沙箱目录（如 `.myagent/backups/`）对源文件执行备份，并在每轮 Turn 结束时完成 Snapshots；回退时通过 unlink 物理删除后增文件，通过 copyFile 写回备份以恢复原始状态。

## 4. 约束、风险与未知项
- **冷备份目录的自动清理**：方案 B 会产生大量文件备份，必须在 Session 正常关闭时注册清理回调（Cleanup Registry），彻底物理销毁该 Session 产生的所有临时备份，避免污染用户磁盘。
- **外部非幂等副作用局限**：物理快照回退仅局限于工作区代码文件系统，无法撤销网络请求、大模型 API 计费等外部非幂等副作用。

## 5. 否决方案
- **无同步控制的纯内存快照回溯**：由于物理文件和外部状态脏改后心口不一，极易诱发严重的语义回滚攻击，因此被票决否绝。
