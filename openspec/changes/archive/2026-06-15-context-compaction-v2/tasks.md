## 1. 核心架构与模型服务层改造 (Background Async & Prompt Safeguards)

- [x] 1.1 在 LLM Service 层新增非阻塞的异步摘要生成方法 `generate_summary_async`，挂载至后台任务执行
- [x] 1.2 封装防爆仓应急降级函数 `_build_static_fallback_summary`，提取最后工具调用及最后一次指令生成静态文本
- [x] 1.3 在 Prompt Builder 中固化两套防御型前缀：`Strict Identifier Preservation` 与 `Handoff Instructions`

<!-- checkpoint: npx vitest run test/brain -q -->

## 2. 上下文钩子与零延迟硬截断 (Hook & Zero-Latency Truncation)

- [x] 2.1 引入 `afterTurn` (交互后置) 钩子检测机制，当累积增量 Token 达到 5000 时触发后台提炼任务，结果覆盖写至本地 `session_summary.md`
- [x] 2.2 重构 History Manager 的旧版轮换逻辑，改为基于 Token 占用率（80% 阈值）的指针级数组截断
- [x] 2.3 在截断发生时，拦截 LLM 的全量检索请求，直接丢弃冗余消息，在 `System Prompt` 头部拼接 `session_summary.md` 内容

<!-- checkpoint: npx vitest run test/brain -q -->

## 3. 文件硬性无损重载护栏 (File Pinning)

- [x] 3.1 新增文件行为追踪器 (File Tracker)，拦截并维护最近编辑活跃的 Top 5 个文件路径
- [x] 3.2 实现带预算控制的文本组装函数：读取这 5 个文件，受限于 25,000 Token 总预算与单体 5,000 Token 上限，包裹为 `<transient_file>`
- [x] 3.3 在触发数组硬截断后的第一次提示词组装时，调用原生代码强制将重载文件拼接进大模型输入流

<!-- checkpoint: npx vitest run test/brain -q -->
