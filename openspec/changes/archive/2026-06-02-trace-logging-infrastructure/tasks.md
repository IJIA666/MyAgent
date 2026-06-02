## 1. 基础追踪器实现

- [ ] 1.1 创建 `src/brain/tracer.ts` 并在其中定义 `InteractionRecord` 数据结构
- [ ] 1.2 在 `AgentTracer` 类中实现基于文件流追加写的 `logInteraction()` 接口

<!-- checkpoint: npx tsc --noEmit -->

## 2. 调度层侵入与日志挂载

- [ ] 2.1 在 `src/brain/session.ts` 中实例化 `AgentTracer`
- [ ] 2.2 在 `chat()` 生成器的轮次闭环处，组装并触发 `tracer.logInteraction()` 落盘逻辑
- [ ] 2.3 修改 `src/index.ts` 注入开机信息，提示 Trace 已就绪

<!-- checkpoint: npx tsc --noEmit -->
