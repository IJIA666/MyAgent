# 架构重构里程碑 (Milestone: internal-refactor-v1)

由于本次重构涉及多个子系统的深度解耦，为保证项目稳定性，我们拆分为以下两个子战役（Sub-Changes）循序渐进地执行：

- [x] **Phase 1**: `/openspec-propose refactor-action-tools`
  拆分庞大的 `src/action/tools.ts`，将其按功能域分散至 `src/action/native-tools/` 目录下，解耦原生动作工具的堆砌。

- [x] **Phase 2**: `/openspec-propose refactor-brain-session`
  肢解上帝类 `src/brain/session.ts`，抽离出纯净的 ReAct 循环引擎，并将紧耦合的压缩逻辑、文件追踪和工具脱敏等下放到专门的领域服务（Domain Services）。
