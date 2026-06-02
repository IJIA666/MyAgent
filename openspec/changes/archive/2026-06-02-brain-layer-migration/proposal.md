## 改造原因

作为大型重构项目 `modular-architecture` 的第二阶段（Phase 2），我们将专注于 Agent 的核心“思考层”。目前，涉及大语言模型交互、上下文管理与工具调度的核心逻辑全部集中在 `src/session.ts` 中。为了清晰地划定认知边界，为未来扩展复杂状态机引擎和长期记忆机制做铺垫，我们需要将其提取到独立的 `src/brain/` 模块中。

## 变更内容

- 建立 `src/brain/` 顶层目录。
- 迁移核心思考层代码：将 `src/session.ts` 移动至 `src/brain/session.ts`。
- 新增 `src/brain/index.ts` 门面文件，统一对外暴露 `brain` 层的接口能力（如 `SessionManager`）。
- 更新全量项目中对 `session.ts` 的依赖导入路径。

## 业务能力

### 新增业务能力
无。本次为纯技术重构，不涉及新增业务逻辑。

### 修改业务能力
无。大模型交互的核心流转机制不变。

## 影响范围

- 核心逻辑模块的物理目录结构变更（`src/session.ts` -> `src/brain/session.ts`）。
- 牵涉到入口层 `index.ts` 和命令层 `command.ts` 中针对思考层模块依赖导入路径的修正。
