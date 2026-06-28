## 改造原因

长链路交互中，工具返回的中型大文本输出（3000-8000 字符，如海量编译错误、大文件 diff 变动）往往直接塞入对话历史，从而吞噬 Token 水位线并诱发模型注意力的 Lost-in-the-Middle 漂移。

为了降噪并维护 Token 经济性，我们必须(MUST)在首期引入工具差异化折叠和中段消息有损压缩机制，在不改写磁盘物理日志的前提下，保障模型输入侧的极致干净与流畅。

## 变更内容

1. **工具去中心化配额定义**：工具在注册元数据中直接声明各自配额限额（`maxLines` 与 `maxBytes`），由拦截层统一捕获裁剪。
2. **复合消息历史结构与外带持久化**：超限的大文本同步写盘到外带临时目录，在 `messageHistory` 内存与落盘的物理日志中保留带有物理文件路径引用的复合消息结构。
3. **首尾双保中段压缩（Middle Compaction）**：Token 超限时保护 System Prompt 和最前及最近的交互消息，仅针对中段进行 LLM 提炼替代。

## 业务能力

### 新增业务能力

- `short-term-memory-compaction-and-pruning`: 提供工具去中心化配额拦截、外带大输出持久化引用、双向行级/字节保底折叠截断以及首尾双保中段有损压缩的能力。

### 修改业务能力

无。

## 影响范围

* **受影响代码**：
  * `src/core/usecases/engine/ToolDispatcher.ts`：同步拦截中型输出。
  * `src/core/domain/context.ts`：定义复合引用消息体及投递侧的无损折叠过滤。
  * `src/core/usecases/brain/CompactionService.ts`：开发首尾双保中段压缩提炼算法。
