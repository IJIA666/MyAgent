## 1. 去中心化配额接口与复合消息体扩展 (Entities & Types Refactoring)

- [x] 1.1 修改 `src/ports/driven/tools/ToolRegistryPort.ts` 中的 `ToolMetadata` 结构，新增可选的去中心化配额声明字段 `maxLines?: number` 与 `maxBytes?: number`。
- [x] 1.2 在 `src/core/domain/context.ts` 中定义继承自底层契约的派生类型 `StoredChatMessage extends ChatMessage`，新增可选的内部属性 `originalPath?: string` 和 `isTruncated?: boolean`。
- [x] 1.3 重构 `SessionContext.ts` 中的 `messageHistory` 类型为 `StoredChatMessage[]`，确保其在落盘时随 JSON 序列化物理保真输出。

<!-- checkpoint: npx tsc --noEmit -->

## 2. ToolDispatcher 同步拦截与外带写盘折叠 (Pruning & Out-of-band Storage)

- [x] 2.1 重构 `src/core/usecases/engine/ToolDispatcher.ts`。实现动态获取工具配额（缺省时使用系统默认配额：`maxLines = 2000`，`maxBytes = 50KB`）。
- [x] 2.2 实现 `boundedPreview` 对折截断算法：优先按行行数对半拼接首尾，若整体依然超出 `maxBytes` 限制，则降级为对前半截和后半截分别执行字节数对折截断。
- [x] 2.3 在 `ToolDispatcher` 中当检测到超标大输出时，同步将原始文本存入 `.myagent/tool-outputs/` 外带文件，并在返回给引擎的历史中存储复合消息体（预览 text + 原始 originalPath 引用）。
- [x] 2.4 重构 `ContextAdapter.assemble()` 的实现类。在消息组装投递给底层大模型驱动层前，采用解构赋值：`const { originalPath, isTruncated, ...cleanMsg } = msg;` 剥离内部属性，确保完整透传包含 `tool_calls`、`tool_call_id`、`name`、`reasoning_content` 等在内的全部底层 `ChatMessage` 属性载荷。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 首尾双保中段有损压缩开发与验收 (Middle Compaction & Verification)

- [x] 3.1 升级 `src/core/usecases/brain/CompactionService.ts` 中的会话提炼逻辑。根据消息历史中 **`role === "user"`（用户交互消息）的数量** 进行安全区间界定：
  - 强行保护 System 提示、第一轮交互。
  - 从后往前寻找第 4 个 `role === "user"` 消息的起点索引，将其作为尾部保护区的起点。
  - 对中段 messages 对话块触发 LLM 总结，并在原位置用一条 `user` 摘要消息（Summary Notice）将其合并替代。
- [x] 3.2 在 `CompactionService` 中加入中段索引安全卡关，若首尾保护区发生重叠交叉（总交互轮次过短），直接跳过压缩。
- [x] 3.3 编写去中心化工具裁剪与首尾双保中段压缩的单元测试（在同构后的 `test/` 目录下建立对应镜像文件），并执行全量单测验收。

<!-- checkpoint: npm test -->
