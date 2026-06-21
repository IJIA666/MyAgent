# 探索主题: 单元测试并发竞态修复与主动唤醒机制下沉解耦

## 1. 问题定义
为了完成系统的六边形架构重构闭环，解决 Input Adapter（`CliFacade`）与核心层（Core / Use Cases）的硬编码状态耦合，我们需要消除两个关键架构痛点：
1. **测试并发写竞态（Race Condition）**：在并发测试（`vitest`）环境下，多个测试用例并发修改共享的全局开发物理规则文件（`D:\Projects\MyAgent\.agent\global_rules.md` 等），由于其并行写操作导致测试之间互相覆写而随机失败。同时，原测试中的 `beforeAll/afterAll` 备份恢复机制在并发模式下容易保存并恢复被对方写坏的脏数据，导致损坏状态固化。
2. **主动唤醒适配器紧耦合**：终端异步后台任务完成或卡死触发的“大模型唤醒、推理忙锁、缓冲队列与熔断控制器”等控制调度逻辑，目前全部耦合在终端交互门面 `CliFacade` 中，导致这些能力在 Web UI、IDE 插件等多端适配器中无法复用。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 测试套件中，`test/brain/contextLoader.test.ts` 和 `test/session/prompt.test.ts` 均硬编码读写了 `D:\Projects\MyAgent\.agent\global_rules.md` 与 `.agent/rules/guize.md`。
  - `CliFacade` 私有维护了大模型推理状态 `isGenerating`、自动唤醒计数 `autoWakeupCount` 和积压通知标记 `hasPendingAsyncNotification`，并在 `onAsyncEvent` 监听器里手动控制 `runStreamLoop` 级联调起。
  - 核心层的 `SessionContext` 已继承了 `EventEmitter` 并实现了 `SessionEventPort`，能够正确发射 `async_event`。但在 Core 层没有大循环生命周期的统一管理者，强依赖外部 Adapter 的被动轮询或外壳驱动。
- **核实与洞察**：
  - **OpenCode 深度源码剖析 (`packages/core/src/session/run-coordinator.ts` & `input.ts`)**：
    - **运行协调机制 (`SessionRunCoordinator`)**：使用 `Effect-TS` 建立了协调器 `Coordinator`。针对每个会话通过内存中的 `Entry` 结构体跟踪其并发状态，记录当前的执行需求 `current: Demand`（分为 `run` 显式执行与 `wake` 异步唤醒）和最多一个挂起的后继执行需求 `pending?: Demand`。
    - **请求合并与防栈溢出自调用 (`coalesce` & `yieldNow`)**：在排水（draining）执行期间到达的重复唤醒会被合并（`coalesce`），保留最新准入的序列号。在当前周期退出（`settle` 阶段）时，若存在 `pending` 需求，会自动级联拉起后继排水。它通过 `Effect.yieldNow` 在微任务层物理隔离级联调用，防止 JS 栈上同步递归导致爆栈。
    - **持久化准入与 TOCTOU 消除 (`SessionInput` & 数据库锁)**：它的输入分为 `"steer"`（主动干预）和 `"queue"`（排队）两种交付类型。所有外界输入（用户、系统通知、接口）均通过数据库事务进行准入（`admit`），生成带序列号的记录，而后由协调器根据状态安全地将其推广（`promote`）为模型可见的历史消息。依靠数据库事务锁天然消除了单线程 EventLoop 内并发检查的 TOCTOU 竞态。
  - **Claude Code 源码实现分析 (`LocalShellTask.tsx` & `messageQueueManager.ts` & `useQueueProcessor.ts`)**：
    - **队列缓冲**：建立了一个模块级且独立于 React 状态周期的统一优先级指令队列 `commandQueue`，所有用户输入与系统事件通知均流经该管道。后台任务或卡死看守（Stall Watchdog）触发时，向队列调用 `enqueuePendingNotification` 注入最低优先级（`later`）的 XML 格式系统消息。
  - **Hermes Agent 源码实现分析 (`process_registry.py`)**：
    - **统一事件总线**：在 `ProcessRegistry` 中，内置了一个标准线程安全队列 `completion_queue`，用来缓冲后台进程的退出事件与 watch_patterns 实时匹配命中的输出切片。
    - **事件循环 Drain**：在 CLI 的 REPL 大交互循环（`process_loop`）及 Gateway 流调度中，每个智能体交互回合（Agent Turn）结束的收尾阶段，均会执行排空（`drain`）该队列的动作。若检测到匹配，自动将事件信息重组并强制塞回输入源，自动拉起下一轮推理周期。

## 3. 方案对比与推荐方向
对“主动唤醒机制下沉”进行两种设计方案的对比：

| 评估维度 | 方案 A (推荐)：下沉至 Core 层的自驱动推理引擎 | 方案 B：由外部各输入适配器自行维护唤醒逻辑 |
| :--- | :--- | :--- |
| **消息/状态存储** | 在 `SessionManager` / `AgentLoop` 中维护 `isGenerating` 状态与缓冲队列。 | 各个适配器（CliFacade, WebUI, ApiGateway）自行声明私有状态。 |
| **逻辑复用性** | 极佳 ✓（所有适配器自动免费获得“后台唤醒与防死循环熔断”的成熟能力） | 极差 ✗（每开发一个新 Adapter 都必须把状态锁与唤醒大循环重写一遍） |
| **竞态稳定性** | 强 ✓（核心统一调度，易于实现多端消息时序控制和锁保护） | 弱（极易因为不同端的触发策略引起并发脏写冲突） |
| **结论分析** | **方案 A 胜出**。完全符合六边形架构中“将业务策略保留在 Core，保持 Adapter 轻量且只做翻译”的原则。 | 否决，造成逻辑冗余和多适配器架构下的不稳定竞态风险。 |

### 3.1 规则加载器与物理路径解耦重构边界
为解决测试并发冲突且不采用临时绕开的敷衍方案，重构应确立如下物理隔离规范：
1. **函数接口改造**：重构 `src/core/usecases/contextLoader.ts` 中的 `loadGlobalRules` 和 `loadLocalRules`，支持可选的文件路径参数 `customPath?: string`（未传入时回退到默认的物理开发路径）。
2. **测试文件隔离**：重构 `test/brain/contextLoader.test.ts`。在 `beforeEach` 中使用系统的 `os.tmpdir()` 创建每个测试套件独占的、带有随机前缀的临时沙箱文件夹，测试规则文件分别写入此沙箱，并将临时物理路径显式传入被测函数。
3. **消除冗余物理写入**：对于 `test/session/prompt.test.ts`，由于其核心仅是校验 XML 规则装配行为，不再去篡改或覆写磁盘上的开发物理规则文件，而是通过直接往 `buildSystemPrompt(customGlobalRules, customLocalRules)` 的内存参数中灌入 Mock 数据进行验证，从根本上隔离磁盘 I/O 冲突并废除 `beforeAll/afterAll` 易污染的备份恢复模式。

### 3.2 下沉后的事件流接口形态与接管机制
在核心层 `SessionManager` 接管自驱动循环后，如何向外部适配器暴露统一的推理事件流？
- **设计决定**：让 `SessionManager` 自身继承 `EventEmitter`，并向外部适配器统一暴露 `'agent_event'` 事件。
- **职责边界划分（防止职责重叠与事件泄露）**：
  - **Driven 端口层事件**：`SessionContext` 原有的 `EventEmitter` 仍仅用于接收**底层适配器与工具的异步回调事件**（例如 `async_event`）。它工作于 Ports 和 Domain 内部，不对任何 Driving 适配器公开。
  - **Driving 应用层事件**：`SessionManager` 继承的 `EventEmitter` 仅对外广播**模型层推理的宏观渲染事件**（例如 `thinking`、`content`、`agent_event`）。所有的 Driving 适配器（如 `CliFacade`）只需监听该接口事件。这保证了底层事件只在内核中流转，上层渲染事件统一由应用层广播。

### 3.3 Node.js 单线程级联调度忙锁与自调用防护
由于 `SessionManager` 是一个单会话实体，在其内部执行自驱动调用时，极易由于微任务调度不合理导致同步递归以及未定义的并发脏写。为此设计以下锁机制和自调用防护路径：
1. **状态标识与锁保护（防止并发重入 TOCTOU 竞态）**：
   - 核心维护 `isGenerating: boolean`（推理忙锁，控制同时只能有一个 `AgentLoop` 运行）以及 `hasPendingNotification: boolean`（后台通知积压标记）。
   - 提供外部人类输入的统一入口 `session.handleUserInput(input: string, transientSkillContent?: string): void`。
   - **原子加锁机制**：为了防止在同一个 EventLoop Tick 内由于异步判定产生 TOCTOU 竞态，当外部调用 `handleUserInput` 时，我们执行**同步检查并立即同步锁定**：
     ```typescript
     if (this.isGenerating) {
       // 若当前忙碌，且不是后台通知，则直接拒绝多余的用户输入（或视需求排队）
       throw new Error("Session is currently busy generating a response.");
     }
     this.isGenerating = true; // 同步加锁，确保同一 Tick 随后的并行调用无法通过校验
     this.autoWakeupCount = 0;  // 人类交互介入，重置熔断计数器
     
     // 触发后台执行
     this.runInternalGeneration(transientSkillContent);
     ```
2. **微任务级联调度防护（防止同步递归栈溢出）**：
   - 当 `AgentLoop` 的推理过程执行完毕，在 `finally` 阶段，核心执行以下微任务释放逻辑：
     ```typescript
     this.isGenerating = false;
     // 延迟到下一 Tick，释放调用栈，并防范同步递归产生的微任务队列混乱
     process.nextTick(() => {
       if (!this.isGenerating && this.hasPendingNotification) {
         this.hasPendingNotification = false;
         
         // 熔断安全防御
         if (this.autoWakeupCount >= 3) {
           this.emit('agent_event', {
             type: 'error',
             message: '[系统提示] 检测到连续自动唤醒次数已达上限（3次），已暂停自动唤醒，等待人工介入。'
           });
           return;
         }
         
         this.autoWakeupCount++;
         this.isGenerating = true; // 同步加锁
         // 内部自驱动运行推理，事件同样通过 'agent_event' 发射
         this.runInternalGeneration();
       }
     });
     ```
   - 这样保证了自唤醒完全通过微任务队列进行物理隔离，在当前单 Adapter 交互模式下，能保障在该会话的单调用链上不会产生未定义的并发重入或同步死锁。

## 4. 约束、风险与未知项
- **熔断器重置与入口收水**：核心层的自动唤醒熔断器（`autoWakeupCount`）必须能感知到人类的主动输入。原有的 `addUserMessage` 将被收水作为内部子步骤，外部适配器统一且仅能通过 `handleUserInput` 作为人类交互入口，自动唤醒熔断计数器在此入口的最前端同步清零，确保逻辑的高内聚性。
- **并发锁与 TOCTOU 竞态防范**：若未来存在多端适配器并发调用，在核心层管理的 `isGenerating` 推理锁必须能够防止在同一个 EventLoop Tick 内多个 Driving 适配器并发调用 `handleUserInput` 产生的 check-then-act TOCTOU 重入漏洞，可以通过同步抢占加锁或在应用层引入串行 Promise 任务队列来确保原子隔离。

## 5. 否决方案
- **方案 B (适配器层各自为战模式)**：否决此方案，它会在添加 IDE 插件或 Web 适配器时产生大量的逻辑复制，且状态失控。
- **全局宿主级消息强拉起**：否决此方案，以防多会话（Session）之间的后台任务更新互相干扰，导致消息混淆。
