## 1. 基础契约与插件注册中心实现

- [x] 1.1 新增插件 Hook 类型与控制流接口定义 ` src/brain/plugin-types.ts `，包含事件名 ` HookEventName `、控制流指令 ` HookControl ` 以及插件 ` Plugin ` 配置定义。
- [x] 1.2 实现插件注册管理器 ` src/brain/plugin-registry.ts `，提供针对各类 Hook 生命周期的插件注册、卸载与获取功能。
- [x] 1.3 实现整数权重排序，对已注册的插件基于 ` weight ` 属性（ 升序 ）在内核初始化时执行 Array 排序。

<!-- checkpoint: npm run build -->

## 2. 状态沙箱隔离与串行 Fail-Fast 实现

- [x] 2.1 实现基于 Immer 类似机制的上下文只读/Draft 状态包装，确保生命周期中上下文修改完全在沙箱内进行。
- [x] 2.2 编写异步管道调度中间件（ 洋葱模型 ），确保异步 Hook 在严格串行次序下安全修改 Draft 并统一提交 Immutable 更新。
- [x] 2.3 实现串行管道短路（ Fail-Fast ）逻辑，当任一插件返回非 ` continue ` 控制指令时，立即短路退出 Hook 链。
- [x] 2.4 实现 ` produceWithPatches ` 对 Draft 改写差异的捕获机制，自动输出改写 Patch 与 JSON Path 日志至 Trace。

<!-- checkpoint: npm run test -->

## 3. 核心大循环重构与 Hook 挂载

- [x] 3.1 剥离 ` [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts) ` 中的硬编码切面逻辑（ Token 水位、压缩策略、JIT 规则注入、文件 Tracer ）。
- [x] 3.2 在 ` chat ` 推理循环的 5 个核心节点（ 模型前后、工具前后、工具过滤前 ）插入 Hook 派发中心调用。
- [x] 3.3 根据插件返回的 ` HookControl ` 指令，重构大循环的 ` abort `（ 终止 ）与 ` restart `（ 触发压缩重启推理 ）的分支控制。

<!-- checkpoint: npm run build -->

## 4. 切面业务插件化改造与集成

- [x] 4.1 编写 ` TokenWatermarkPlugin `，将其挂载到 ` BeforeModel ` 与 ` PreCompact `，检测水位并在超限时触发 Compact 与重启指令。
- [x] 4.2 编写 ` JitRulesPlugin `，捕获文件读取后的 JIT 规则并 append 附加到最近一条 ` user ` 消息尾部，保护 Prompt Cache。
- [x] 4.3 编写 ` TracerLogPlugin `，捕获执行足迹与 Immer 提交产生的变更 Patches 记录，审计插件改写逻辑。
- [x] 4.4 编写 ` LoopPreventionPlugin `，负责记录推理轮数并抛出熔断信号。

<!-- checkpoint: npm run test -->

## 5. 代码规范审查缺陷修复

- [x] 5.1 移除 [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts) 与 [plugin-types.ts](file:///d:/Projects/MyAgent/src/brain/plugin-types.ts) 中未使用的冗余导入（如 `ChatCompletionTool`, `ChatCompletionCreateParams`, `computeStringHash`, `TokenEstimator`）。
- [x] 5.2 修复 [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts)、[context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts)、[plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugin-runner.ts)、[plugin-types.ts](file:///d:/Projects/MyAgent/src/brain/plugin-types.ts) 以及各插件/测试文件中 `any` 类型的滥用缺陷，使用强类型定义或合适泛型进行规避。

<!-- checkpoint: npm run lint -->
