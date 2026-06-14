# 提案: 肢解上帝类 SessionManager (refactor-brain-session)

## 1. 背景与痛点 (Motivation)
在现有的架构中，`src/brain/session.ts` 扮演着“大内总管”的角色。随着功能的不断迭代，该文件已膨胀至 700 多行。它不仅包含了与大模型交互的最核心的 ReAct 推理生成循环（`run` 方法），还糅合了状态落盘（`saveState`）、庞杂的截断压缩机制（`compact` / `triggerAsyncCompaction`）、工具文本的后处理削峰（`handleLargeToolOutput`）以及系统全局规则的加载。这种万物互联的**强耦合**导致：
1. 测试极其困难，Mock 依赖关系成了一团乱麻。
2. 难以引入例如多路并发、流式 UI 事件下发等新特性。
3. 严重违背单一职责原则（SRP）。

## 2. 核心目标 (Goals)
- **纯化心脏**：让 `SessionManager` 退化为一个纯粹的“生命周期调度器”和“ReAct 循环执行引擎”。
- **领域解耦**：将非核心的附加逻辑下沉为独立的四大专门领域服务（Domain Services）。
- **接口标准化**：确保重构后的对外部暴露行为完全向后兼容，所有的单元测试依旧必须跑通。

## 3. 非目标 (Non-Goals)
- 本阶段不改变现有的 ReAct 逻辑或引入新的大模型调度框架。
- 不修改 `ContextAdapter` 或更底层的数据结构定义。
