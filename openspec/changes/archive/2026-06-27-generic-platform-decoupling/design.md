## 背景

当前代码库中存在三处平台及提供商特化的紧耦合：
1. `prompts.ts` 的 `BASE_SYSTEM_PROMPT` 静态人设硬编码了 Windows 命令规则，与 volatile 层动态输出的宿主 OS 信息（macOS/Linux 等）在运行期产生认知冲突。
2. 领域层 `MemoryService.ts` 强行掺入了 DashScope 单次批上限 10 的嵌入限制（`BATCH_SIZE = 10`），拖慢了其它并发性能优良的提供商（如 OpenAI）的索引速度。
3. 执行底座 `terminal-engine.ts` 掺杂了 Windows 的微观修补逻辑。

## 目标与非目标

**目标:**
- **OS 指令彻底解耦**：将 `prompts.ts` 的 Windows 命令人设解耦，通过占位符在模块加载阶段一次性按运行环境自适应注入，消除跨平台下的模型认知分裂，维护 static segment 的绝对缓存命中。
- **并发能力最大释放**：将 embedding 批量处理限制（Batch Size）下沉至具体的适配器（DashScope 适配器自理，OpenAI 保持并发直达），净化领域层。
- **底座零环境特异性**：将终端引擎特异性补丁移出核心调度底座。
- **质量保障**：保证重构后全部 202 个单测（包括 prompts 和 MemoryService 测试）全部绿灯通过。

**非目标:**
- 本次重构不包含对核心主引擎大循环（`AgentLoop`）的控制流进行任何逻辑改动。
- 不会对既有提示词关于任务执行的全局开发准则进行任何语义变更。

## 架构决策

1. **模块加载时占位符一次性替换 (Resolved Prompt at Import)**
   - **决策**：在 `prompts.ts` 中**显式导出**针对 win32、darwin 和 linux 三套平台的特定命令红线安全限制映射 `OS_INSTRUCTIONS_MAP`。在 `prompts.ts` 被 Node 加载导入时，基于 `process.platform` 一次性完成 `replace` 操作，固化为只读常量 `RESOLVED_BASE_PROMPT`。
   - **理由**：相较于在函数被高频调用时动态计算，在模块加载期进行一次性装配性能最优，且彻底对齐了 static 层作为“全局不变量”的缓存对齐精神。同时，显式导出 `OS_INSTRUCTIONS_MAP` 让单测可以直接以白盒方式校验各个平台分支的契约正确性，无需强行在单进程内 mock 不可变的 `process.platform`。
2. **拆批职责依赖反转 (Decouple batching to Adapter)**
   - **决策**：领域层 `MemoryService.ts` 直接一次性交付全部文本数组给 `EmbeddingPort`，彻底剥离 `BATCH_SIZE = 10` 及 `for` 切分。具体的物理限制交由具体的 `DashScopeEmbeddingAdapter.ts` 在内部实现并发拆分。
   - **理由**：依赖反转的六边形架构要求领域层必须对于特定的提供商限制保持“零感知”。阿里的局限应当在阿里适配器内部自我消化。

## 风险与权衡

- **[风险点]：单测中断言失效**
  - **缓解策略**：由于 prompts 静态特征发生了常量级别的修改，`prompts.test.ts` 中直接校验系统提示词的断言会失效。我们将不再依赖运行时 `process.platform` 环境，而是**直接导入 `OS_INSTRUCTIONS_MAP` 导出对象**，为 `win32`、`darwin`、`linux` 每个 Key 下的内容分别断言，从而实现 100% 完整的静态人设分支测试覆盖率。
- **[风险点]：DashScope 拆批重构后请求频率超限 (Rate Limit) 或低效串行**
  - **缓解策略**：下沉到 `DashScopeEmbeddingAdapter.ts` 内部后，采用**“切片并发发送 + 并发度限流限制”**（使用异步控制将每批大小限制在 10 个以内，并行 Promise 数量进行保护并发调度，杜绝使用低效串行 `for await`，亦防止无脑 `Promise.all` 导致的 Rate Limit 封禁），并在单元测试中为其补充并发执行及结果无缝平铺聚合的正确性自测。
