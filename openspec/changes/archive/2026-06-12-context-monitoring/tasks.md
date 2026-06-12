## 1. 依赖配置与基础设施准备

- [x] 1.1 在 `package.json` 的 `dependencies` 中添加 `js-tiktoken` (例如 `^1.0.12` 或最新版本)。
- [x] 1.2 运行本地依赖更新与下载安装，使分词库在当前开发环境就绪。

- [x] 1.3 验证 TypeScript 环境在此新增依赖下的编译状态，确保无类型错误。

<!-- checkpoint: npm run build -->

## 2. Token 分块计算与哈希监控逻辑实现

- [x] 2.1 修改 `src/brain/context.ts`：引入 `js-tiktoken`，实现**锚点基准 + 增量估算算法**。利用上一次 API 响应真实 Usage 作基底锚点，仅对最新产生的增量消息（如新 user/tool 消息或临时新规则）进行分词估算。
- [x] 2.2 修改 `src/brain/driver.ts`：在底层大模型流式传输响应（`streamChat()`）的过程中，收集 API 返回的实际 `usage` 数据，并在抛出 `complete` 或 `tool_calls` 完成事件时一并传回。
- [x] 2.3 修改 `src/brain/session.ts`：实现**前置哈希记录与后置击穿校验的两阶段监控**。请求前记录 System Prompt 与 Tools 描述哈希指纹以判断变化项；请求后比对 `cacheReadTokens`，若判定发生缓存击穿，结合前置变化项（或时间间隔）精准输出导致缓存失效的诱因。
- [x] 2.4 修改 `src/brain/tracer.ts`：在结构化交互流水 `InteractionRecord` 中新增 Token 详细估算、真实使用数、缓存命中 Token 数等持久化字段。

<!-- checkpoint: npm run build -->

## 3. 终端可视化呈现与单元测试验证

- [x] 3.1 修改 `src/interface/cli.ts`：在 `runStreamLoop` 大模型事件消费完毕后，获取本轮校准后的 Token 详情和缓存状态，在控制台界面以格式化和色阶高亮面板的形式回显统计结果（如 System/Rules/History 占比、当前总窗口占用率、缓存命中率）。
- [x] 3.2 针对 `SessionContext` 编写单元测试，覆盖 Token 预测逻辑以及 System Prompt 前缀哈希检测功能。
- [x] 3.3 运行 Vitest 测试用例，确保新添加的 Token 监控测试及已有的单元测试用例全部通过。

<!-- checkpoint: npm run test -->

## 4. Lint 缺陷修复与代码规范调优

- [x] 4.1 修复 `src/brain/context.ts` 中使用的 `any` 类型，声明并使用结构化的 `ApiUsage` 接口。
- [x] 4.2 修复 `src/brain/driver.ts` 中使用的 `any` 类型，替换为统一的 `ApiUsage` 接口。
- [x] 4.3 修复 `src/brain/session.ts` 中的 `any` 类型（包括 `lastEstimatedUsage` 的 `ContextTokenUsage` 类型声明以及 `usage` 相关的 `ApiUsage` 类型声明）。
- [x] 4.4 修复 `src/brain/session.ts` 中 `checkCacheAndCalibrate` 中的 `no-useless-assignment` 警告，移除 `reason` 的无用初始赋值。

<!-- checkpoint: npm run lint -->


