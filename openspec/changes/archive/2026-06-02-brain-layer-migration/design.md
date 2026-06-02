## 背景

在 Phase 1（`action-layer-migration`）中，我们已经成功剥离了底层的工具与协议执行逻辑。本阶段（Phase 2）的目标是剥离大语言模型的交互流转层。目前，这一层由单体的 `src/session.ts` 承担。

## 目标与非目标

**目标:**
- 将大模型会话状态管理及推理流转逻辑（`session.ts`）移至 `src/brain/`。
- 提供统一的 `src/brain/index.ts` 门面供外部进行黑盒调用。

**非目标:**
- 不改变当前 `session.ts` 内部与 OpenAI API 的交互逻辑或 Prompt。
- 不引入持久化记忆或复杂状态机引擎（这是未来的架构演进方向，本次仅做目录重构）。

## 架构决策

- **保持依赖的单向流转**: `src/brain/` 仅能单向依赖 `src/action/`，绝对禁止反向依赖或跨越层级依赖界面层。
- **门面模式（Facade）**: 通过 `src/brain/index.ts` 暴露 `SessionManager` 等必要接口。

## 风险与权衡

- **路径断裂风险**: ESM 导入对于扩展名敏感，移动文件后需要仔细修复相对路径并使用 `tsc` 进行校验。
