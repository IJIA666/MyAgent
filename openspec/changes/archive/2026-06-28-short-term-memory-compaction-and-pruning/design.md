## 背景

针对中型工具输出引起的 Token 膨胀和 Lost-in-the-Middle 注意力涣散，我们需要在第一阶段具体设计出**去中心化工具配额过滤**与**首尾双保中段有损压缩**的技术方案，实现大文本同步折叠降噪且磁盘日志物理保真的联合解法。

## 目标与非目标

**目标:**
1. **去中心化工具配额定义**：重构工具基础元数据定义，支持工具实例自定义声明 `maxLines` 与 `maxBytes`，实现契约的彻底解耦。
2. **行级对折与字节保底对齐截断**：实现健壮的双向对折截断算法，保留首尾完整行，防范单词与排版被碎切，超出字节限制时降级截断。
3. **带外大输出物理存盘**：截断的完整文本存入 `.myagent/tool-outputs/`，并在内存中记录外带文件路径。
4. **底层契约保全与模型无损**：在内部上下文中使用扩展消息类型，使物理日志落盘自动保全；通过适配器转换还原底层纯净消息接口，对大模型底层完全透明。
5. **首尾双保压缩**：在 `CompactionService` 中精确划定保护区（System Prompt、第一轮交互、最近 N 轮用户级对话），仅对中段 messages 触发 Compaction 提炼。

**非目标:**
1. **实现任何物理文件备份与 Checkout 还原**：本子变更绝不涉及任何针对工作区源文件的备份与回档，这完全属于第二阶段的职责。
2. **在内存中深拷贝完整的巨型文本**：拦截后，内存消息只保留折叠后的预览，防止巨额大文本频繁在内存中进行 JSON 克隆导致的 Node.js 垃圾回收卡顿或内存溢出。

## 架构决策

### 1. 去中心化配额定义与拦截时机
* **工具接口重构**：
  在 `src/ports/driven/tools/ToolRegistryPort.ts` 的 `ToolMetadata`（或对应属性）定义中，新增两个可选的可声明配额：
  ```typescript
  export interface ToolMetadata {
    // ... 已有属性
    maxLines?: number; // 允许的最大行数，超限触发折叠
    maxBytes?: number; // 允许的最大字节数，超限触发折叠
  }
  ```
* **拦截点**：
  重构 `src/core/usecases/engine/ToolDispatcher.ts` 中的 `handleLargeToolOutput`。
  从被调用的 `Tool` 实例上读取该 `maxLines` 与 `maxBytes`，若无则使用系统默认兜底配额（`maxLines = 2000`，`maxBytes = 50 * 1024`，即 50KB）。
  若输出超出配额：
  1. 调用文件写入将完整输出存盘至 `.myagent/tool-outputs/tool_[timestamp]_[uuid].log`。
  2. 触发双向行级 + 字节对折算法，生成折叠预览文本。

### 2. 双向行级与字节保底对折算法
* 算法首先按 `\n` 对文本执行分割。
* 取前半截 $50\%$ 的行和后半截 $50\%$ 的行进行拼接（如 `maxLines = 100`，取前 50 行和后 50 行）。
* 检测拼接后的文本字节数（`Buffer.byteLength`）。若依然超出 `maxBytes`（如大单行情况），则降级为对拼接的首尾两段文本按字节各取 $50\%$ 配额进行截断。
* 在拼接的中段，插入指示器：`\n\n... output truncated; full content saved to [originalPath] ...\n\n`。

### 3. 内存与落盘日志扩展隔离设计
* **内部扩展消息类型**：
  为避免底层网络接口 `ChatMessage`（定义于 `LlmPort.ts`）受到业务污染，在 `src/core/domain/context.ts` 中定义继承子类型 `StoredChatMessage` 用于上下文内部流转与存储：
  ```typescript
  export interface StoredChatMessage extends ChatMessage {
    originalPath?: string; // 完整文本的本地外带路径索引
    isTruncated?: boolean;
  }
  ```
  `SessionContext.messageHistory` 将改用 `StoredChatMessage[]` 类型进行消息承载。由于落盘物理日志（`transcript.jsonl`）是直接将 `messageHistory` 序列化写入，因此这两个扩展字段会自动写入物理日志，完美保真。
* **组装层接口还原**：
  重构 `ContextAdapter.assemble()` 的实现类。在消息组装投递给底层大模型驱动层前，对 `StoredChatMessage` 执行转换和映射。**必须采用解构赋值剥离内部的额外的 `originalPath` 与 `isTruncated` 字段，以确保完整透传包含 `tool_calls`、`tool_call_id`、`name`、`reasoning_content` 在内的所有其它 `ChatMessage` 原始属性**：
  ```typescript
  const { originalPath, isTruncated, ...cleanMsg } = msg;
  ```
  完成投影后，送交大模型底层 API 消费。

### 4. 首尾双保中段压缩（Middle Compaction）
* 当触发 Compaction 时，在 `CompactionService` 中基于 **“User Message（用户交互消息）数量”** 计算锁定边界：
  - **首部保护区**：`messageHistory[0]`（System Instructions），以及第一轮交互（第一个 `role === "user"` 消息、其后的首个 `role === "assistant"` 消息及首个 `role === "tool"` 返回消息）。
  - **尾部保护区**：从后往前数第 $N$（默认 4）个 `role === "user"` 消息的起始索引，直至数组末尾的全部 raw 消息（确保最新轮次的多次工具执行与当前工作 RAM 被完整锁定）。
  - **中段压缩区**：夹在首部保护与尾部保护区中间的 messages 对话块。
* 仅中段消息被取出合并并提炼生成摘要，在原位置用一条带有 `[Summary of Previous Operations: ...]` 的消息替换。

## 风险与权衡

* **[风险点：外带临时大输出文件无限堆积，污染磁盘]** -> **[缓解策略]**：
  在 Session 正常关闭时，通过 `CleanupRegistry` 注册物理删除回调，彻底清空 `.myagent/tool-outputs/` 目录下的缓存。
* **[风险点：中段划分因为交互轮次少发生索引重叠]** -> **[缓解策略]**：
  在 `CompactionService` 划定中段时，必须检测首部保护截止点索引与尾部保护起点索引是否发生交叉（即总交互轮次过短）。若发生交叉，直接跳过 Compaction。
