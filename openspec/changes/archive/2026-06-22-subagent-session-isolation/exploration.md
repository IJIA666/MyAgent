# 探索主题: 子智能体临时会话的文件隔离与落盘过滤设计

## 1. 问题定义
在系统触发长期记忆异步自省提炼时，会实例化一个用于临时推理的子智能体。因为该子智能体在内部 ReAct 循环中复用了 `ContextRepository.saveState()` 接口，导致它所产生的临时会话历史被物理写入到 `.myagent/sessions/` 目录下（如 `1782049203662.json`）。
这会造成严重的**数据污染**：用户输入 `/history` 查看正常历史会话时，这些无意义的临时自省 JSON 文件也会被列出，不仅污染列表，还会占用无用的磁盘空间。

## 2. 关键发现与调研结果
- **代码库现状**：
  - [session.ts](file:///d:/Projects/MyAgent/src/core/usecases/session.ts#L614-L617)：自省子智能体在初始化时，通过以下方式声明了用于状态持久化的服务：
    ```typescript
    const subContextRepo = new ContextRepository(subContext);
    ```
  - [agent-loop.ts](file:///d:/Projects/MyAgent/src/core/usecases/agent-loop.ts#L495)：ReAct 主循环引擎在迭代和抛出异常的 Hook 生命周期中，均会默认触发 `contextRepo.saveState()`，造成临时子智能体对磁盘执行写 I/O。
  - [history.ts](file:///d:/Projects/MyAgent/src/adapters/input/interface/commands/history.ts#L11-L15)：历史会话查看命令通过读取 `.myagent/sessions` 文件夹下的所有 `.json` 后缀文件并排序显示，故自省文件会被直接混入展示。

## 3. 方案对比与推荐方向
为阻断子智能体临时落盘，我们设计并对比以下两种技术方案：

| 评估维度 | 方案 A (瞬态会话标识隔离 - First-class Flag) | 方案 B (运行时 Mock 覆盖 - Runtime Override) | 选型分析 |
| :--- | :--- | :--- | :--- |
| **封装性与 TS 契约** | **强 ✓**：`isTransient` 作为持久化组件一等公民，行为显式且安全。 | **弱 ✗**：通过直接对实例属性/方法重新赋值进行 Hack，破坏了类方法的封装性。 | A 占优 |
| **对公共契约的侵入度** | **中 ✗**：需要修改 `ContextRepository` 的构造签名，加一个可选参数。 | **极低 ✓**：完全无需修改 `ContextRepository`，仅在 `session.ts` 内部覆盖。 | B 占优 |
| **多场景复用性** | **高 ✓**：若后续框架增加了其他子智能体（如代码诊断子智能体），能一键复用瞬态不落盘标识。 | **低 ✗**：每次实例化临时子会话时都需手动编写 override 函数。 | A 占优 |
| **工程整洁度** | **高 ✓**：符合面向对象的可扩展性原则，不留运行时脏逻辑。 | **中 ✗**：强行修改外部类的方法，若后续重构方法签名，IDE 可能无法静态查错。 | A 占优 |

**推荐路径**：
推荐使用 **方案 A (瞬态会话标识隔离)**。在 [ContextRepository.ts](file:///d:/Projects/MyAgent/src/core/usecases/ContextRepository.ts) 中增加一个可选参数 `isTransient = false`，当标记为 `true` 时，`saveState()` 变为静默返回（`no-op`）。这是一种显式、强类型且符合工程规范（OCP 原则）的最优设计。

## 4. 约束、风险与未知项
- **向后兼容性**：新增构造参数 `isTransient` 必须设计为**带默认值 `false` 的可选参数**，防止破坏主智能体及测试套件中已有 `new ContextRepository(context, workspacePath)` 的构建兼容。

## 5. 否决方案
- **子智能体会话文件名加前缀过滤 (e.g. `subagent_1782.json`)**：允许子智能体继续落盘，只在 `/history` 读取列表时通过前缀进行过滤。
  - *否决原因*：这治标不治本，不仅会继续在本地残留大量的临时磁盘垃圾，而且增加了解析匹配的额外逻辑，引入了不必要的耦合。
