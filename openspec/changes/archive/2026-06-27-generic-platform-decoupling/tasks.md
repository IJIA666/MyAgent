## 1. 核心人设提示词 OS 解耦与装配

- [x] 1.1 修改 `src/core/usecases/prompts.ts` 的 `BASE_SYSTEM_PROMPT` 常量，将 Windows 命令特异性规则替换为占位符 `5. 【终端命令安全性约束】\n{{OS_SECURITY_INSTRUCTIONS}}`。
- [x] 1.2 在 `src/core/usecases/prompts.ts` 中新增并**显式导出**常量映射 `OS_INSTRUCTIONS_MAP`，分别定义 win32、darwin 和 linux 三套平台的安全性红线 and 命令规范说明。
- [x] 1.3 在 `src/core/usecases/prompts.ts` 模块加载初始化段落中，自适应提取 `process.platform`，执行 replace 操作将占位符一次性固化装配，赋值给只读常量 `RESOLVED_BASE_PROMPT`。
- [x] 1.4 在 `src/core/usecases/prompts.ts` 的 `buildSystemPrompt` 拼装导出函数中，使用 `RESOLVED_BASE_PROMPT` 固化常量直接拼入 stable 缓存部分，剔除运行时 replace 开销。
- [x] 1.5 修改单元测试文件 `test/session/prompt.test.ts`，直接导入导出的 `OS_INSTRUCTIONS_MAP` 并在单测中对其每个平台分支（win32, darwin, linux）包含的安全描述行进行独立断言校验，消除 mock 环境变量的复杂性。

<!-- checkpoint: npm test -- src/core/usecases/prompts.test.ts -->

## 2. 长期记忆拆批逻辑完全下沉至适配器

- [x] 2.1 核查并修改领域服务文件 `src/core/usecases/MemoryService.ts`：核实是否残存 `BATCH_SIZE = 10` 的硬编码分批逻辑，确认后彻底将其从领域服务中移除，精简为直接将全量 texts 提交给 `this.embeddingPort.embed(texts)`。
- [x] 2.2 修改适配器文件 `src/adapters/llm/OpenAiEmbeddingAdapter.ts`，在 `generateEmbeddings(texts)` 内部自理 10 条上限分批逻辑（必须使用切片并发 + 并发度调度限流，严禁使用低效的 `for await` 串行，亦防止无脑 Promise.all 触发服务端的 Rate Limit 拦截），平铺聚合结果返回。
- [x] 2.3 验证并确保 MemoryService 关联单测行为正常，且全部 202 个单元测试绿灯通过。

<!-- checkpoint: npm test -->
