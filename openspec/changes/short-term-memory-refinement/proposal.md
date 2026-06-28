## 改造原因

随着智能体（Agent）在复杂工程开发场景中的长链路交互增加，面临两大短期记忆（Context RAM）危机：
1. **中型输出噪音与 Lost-in-the-Middle 现象**：工具产生的输出（如编译报错、大范围搜索）经常处于 3000-8000 字符的尴尬区间，未达到现有大文件一刀切截断阈值（8000 字符）却直接塞入上下文，导致大模型注意力漂移；最新、最具调试价值的编译错误若在中段容易被模型遗忘。
2. **逻辑规划死锁**：当智能体做出了错误的修改导致代码编译卡死在死胡同中时，由于短期记忆缺乏有效的撤销与物理回退，智能体容易在错误的脏工作区和上下文里原地打转。

为了攻克上述挑战，我们需要实现一套高精准度的上下文去噪、Token 控制与物理快照回滚子系统。

## 变更内容

我们将实现对短期记忆上下文的动态高精度治理：
1. **去中心化工具配额与双向折叠**：允许工具模块在注册元数据中自定义配额，超出时同步写盘至外带文件并对内存中的文本执行双向行级 + 字节保底折叠。
2. **首尾双保中段压缩算法**：针对 Token 窗口超限，强行保护 System Prompt 和最近交互，仅对中段 messages 触发 LLM Compaction。
3. **安全分类协同的冷备份快照回溯**：协同已有 `securityCategory` 机制，在敏感写操作执行前对物理文件进行冷备份；并在需要回滚时一键执行物理 checkout 与内存回档，保障一致性。

此大任务采用“分阶段进化”的拆分策略：优先落地第一阶段（Compaction 与 Pruning 去噪），随后落地第二阶段（冷备份物理回滚）。

## 业务能力

### 新增业务能力

- `short-term-memory-compaction-and-pruning`: 落地工具去中心化配额折叠、外带大输出持久化引用、以及对抗 Lost-in-the-Middle 的首尾双保中段压缩能力。
- `short-term-memory-checkpoint-rollback`: 协同安全分类机制对敏感写操作进行冷备份拦截，提供项目沙箱冷备份快照与一键物理回退能力。

### 修改业务能力

无。

## 影响范围

* **受影响代码**：
  * [src/core/usecases/engine/ToolDispatcher.ts](file:///d:/projects/MyAgent/src/core/usecases/engine/ToolDispatcher.ts)：拦截大输出并支持去中心化工具配额定义。
  * [src/core/domain/context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts)：支持复合消息历史结构并实现无损折叠。
  * `src/core/usecases/brain/CompactionService.ts`：实现首尾双保中段有损压缩算法。
  * 新增 `src/core/usecases/brain/FileHistoryService.ts`：承载本地沙箱物理冷备份与 Checkout 还原能力。
