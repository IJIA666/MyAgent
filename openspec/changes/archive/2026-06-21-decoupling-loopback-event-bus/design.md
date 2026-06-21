## 背景

在先前的六边形架构改造完成并物理隔离后，我们划分了核心域（Core）与适配器域（Adapters）。但在系统健康度和主动唤醒上，仍遗留了两个关键的架构痛点：
1. **测试并发写竞态**：[contextLoader.test.ts](file:///d:/Projects/MyAgent/test/brain/contextLoader.test.ts) 和 [prompt.test.ts](file:///d:/Projects/MyAgent/test/session/prompt.test.ts) 均硬编码读写全局物理规则路径（`.agent/global_rules.md` 等），在 Vitest 并发执行下会交叉篡改数据导致测试随机发生断言失败。且其 `beforeAll/afterAll` 备份恢复机制在并发模式下容易固化损坏状态。
2. **主动唤醒机制的适配器强耦合**：异步终端任务触发的主动唤醒闭环（包括推理忙锁 `isGenerating`、熔断计数器 `autoWakeupCount` 以及积压缓冲通知 `hasPendingAsyncNotification`）目前完全耦合在命令行适配器 [CliFacade](file:///d:/Projects/MyAgent/src/adapters/input/interface/facade.ts) 中，使得该唤醒能力无法在 Web UI、IDE 插件等多端适配器中复用。

## 目标与非目标

**目标:**
1. **消除测试物理写竞态**：将 `loadGlobalRules` 和 `loadLocalRules` 与固定的全局磁盘路径解耦，重构测试用例，使其使用系统 `os.tmpdir()` 创建独立唯一的隔离沙箱文件夹；同时对 `prompt.test.ts` 改用纯内存 Mock 组装断言，物理隔离磁盘 I/O 竞态。
2. **自动唤醒机制下沉解耦**：将推理忙锁、自动唤醒次数统计与通知积压缓冲下沉至核心层，使内核自驱掌握完整的会话生命周期。
3. **接口重构与事件总线分发**：
   - 暴露全新的统一人类输入接口 `handleUserInput(input, transientSkillContent?)` 代替原有的 `addUserMessage` + `chat` 暴露接口，实现外部输入与自驱动推理的收水。
   - [SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 继承 `EventEmitter` 作为 Driving 应用层事件分发中枢，对外分发统一的 `'agent_event'` 流，适配器只管订阅它并被动响应 UI 呈现。
4. **时序安全防护**：基于同步原子加锁和 `process.nextTick` 微任务防范自调用栈溢出，在当前单 Adapter 交互模式下保证时序安全性。

**非目标:**
1. 本次重构不考虑多适配器并行会话共享执行流下的应用层 Promise 串行排队队列，本阶段仅聚焦于当前单 Adapter 单会话调用链的安全隔离。
2. 不会引入 RxJS 或大型第三方流式队列框架，保持原生 EventEmitter 与 JS 纯微任务的极简高性能设计。

## 架构决策

### 3.1 规则加载器与物理路径解耦
- **函数接口改造**：重构 `src/core/usecases/contextLoader.ts` 中的 `loadGlobalRules` 和 `loadLocalRules`，支持接收可选的 `customPath?: string`。未传入时回退到默认的物理开发路径。
- **模块级打桩隔离 (零生产代码污染)**：保持 [prompts.ts](file:///d:/Projects/MyAgent/src/core/usecases/prompts.ts) 的 `buildSystemPrompt` 参数签名不变，确保零侵入。在 [prompt.test.ts](file:///d:/Projects/MyAgent/test/session/prompt.test.ts) 头部通过 `vi.mock` 对 `contextLoader.ts` 进行模块级打桩拦截，从而在测试中直接将 `loadGlobalRules`/`loadLocalRules` 的物理读盘屏蔽，使得 `buildSystemPrompt()` 与 `new SessionContext` 的构造函数天然转化为无 I/O 的纯净内存执行，物理竞态自动归零。
- **测试路径解耦**：重构 [contextLoader.test.ts](file:///d:/Projects/MyAgent/test/brain/contextLoader.test.ts)。在 `beforeEach` 中使用 `os.tmpdir()` 在系统临时目录下隔离出独立沙箱文件夹进行读写测试，显式传入自定义路径测试加载器自身的读取行为。

### 3.2 双 EventEmitter 的职责边界隔离与物理卡关
- **Driven 端口层事件 (底层)**：[SessionContext](file:///d:/Projects/MyAgent/src/core/domain/context.ts) 继承的 `EventEmitter` 仍仅负责内核与底层工具的通信（如监听异步终端进程抛出的 `async_event`），工作于 Ports/Domain 内部，不对任何外部适配器开放。
- **强制隔离约束**：为防止外部适配器绕过逻辑，在 [SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 中声明 `this.context` 访问级别为严格的 `private`，且**彻底废弃并删除** `SessionManager` 类中原有的 `onAsyncEvent` 公开接口。外部适配器将绝对无法监听底层的 `async_event`。
- **Driving 应用层事件 (上层)**：[SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 继承的 `EventEmitter` 负责向外广播模型推理的渲染级事件（如 `thinking`、`content`、`agent_event`），向所有 Driving 适配器透明，确保事件的单一职责隔离。

### 3.3 统一人类输入接口 handleUserInput
- 外部适配器（如 [CliFacade](file:///d:/Projects/MyAgent/src/adapters/input/interface/facade.ts)）不再采用 `addUserMessage()` 与 `chat()` 的分离调用路径。原有的 `addUserMessage` 将被收水作为内部子步骤。
- 提供统一的高内聚交互入口 `handleUserInput(input: string, transientSkillContent?: string): void`。
- **点火即忘（Fire-and-forget）异步事件设计**：该接口签名明确返回 `void`，推理过程完全是异步且点火即忘的。调用侧不应也不需要通过 Promise `catch` 捕获异常。所有的业务报错和模型运行异常统一转化为 `agent_event` 的 `error` 事件进行分发广播，由订阅的适配器捕获并渲染。
- **同步原子加锁**：为防范同一 Tick 内的 TOCTOU 抢占竞态漏洞，外部调用该入口时，同步执行锁判断与立即设锁：
  ```typescript
  if (this.isGenerating) {
    throw new Error("Session is currently busy generating a response.");
  }
  this.isGenerating = true; // 同步加锁防止 TOCTOU
  this.autoWakeupCount = 0;  // 重置自动唤醒计数器
  
  // 1. 内部同步将用户消息写入 history
  this.context.addMessage({ role: 'user', content: input });
  // 2. 调起推理循环并广播事件
  this.runInternalGeneration(transientSkillContent);
  ```

### 3.4 微任务级联调度防护
- 在 `AgentLoop.chat` 推理大循环执行完毕的 `finally` 阶段，[SessionManager](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 将 `isGenerating` 释为 `false`。
- 随后通过 `process.nextTick` 将唤醒动作延迟到下一 Tick，防止同步递归造成 JS 调用栈溢出（Stack Overflow）与微任务时序混乱：
  ```typescript
  this.isGenerating = false;
  process.nextTick(() => {
    if (!this.isGenerating && this.hasPendingAsyncNotification) {
      this.hasPendingAsyncNotification = false;
      
      // 熔断安全防御
      if (this.autoWakeupCount >= 3) {
        this.emit('agent_event', {
          type: 'error',
          message: '[系统提示] 检测到连续自动唤醒次数已达上限（3次），已暂停自动唤醒，等待人工介入。'
        });
        return;
      }
      
      this.autoWakeupCount++;
      this.isGenerating = true; // 同步重新锁定
      this.runInternalGeneration(); // 级联调起推理
    }
  });
  ```

## 风险与权衡

1. **自动唤醒的死循环熔断保护**：
   - **风险**：后台任务（如 npm run dev 编译错误）频繁触发 Watcher 命中，大模型被唤醒后修复失败导致无限循环消耗 Token。
   - **权衡**：在核心层限制“无人值守”连续自唤醒上限为 3 次。熔断后在核心层抛出错误并向外分发广播事件。熔断计数器仅在人类交互通过 `handleUserInput` 主动下发新指令时才同步重置为 0。
2. **微任务调度下的锁抢占缝隙**：
   - **风险**：在解锁（`isGenerating = false`）到 `process.nextTick` 唤醒的极小 Tick 空档内，外部适配器若发起新指令会抢占推理锁，导致自动唤醒被跳过。
   - **权衡**：在当前的单 Adapter 命令行架构下此空档无实质负面影响，能够满足单调用链上的时序安全。未来若有多个适配器并发接入，将在核心层提供基于 Promise 链 of the self-serial queue to eliminate the TOCTOU concurrency race.

## [调试修正] 阶段 2 与阶段 3 的代码质量和架构封装微调

在 2026-06-21 调试阶段，我们针对代码质量、命名歧义和测试封装进行了以下修正：
1. **移除冗余忙锁**：移除了 `SessionManager.runInternalGeneration` 顶部的冗余 `isGenerating = true;` 赋值，统一由其入口 `handleUserInput` 和自唤醒 Tick 回调在调用前显式加锁，保证锁逻辑单一职责。
2. **事件非对称契约文档补充**：在 `SessionManager.runInternalGeneration` 的 `finally` 阶段，对“若推理期间产生错误，将完全由 `error` 广播事件接管，不重复发射 `complete` 事件”这一非对称生命周期逻辑添加了详细 JSDoc 阐述。
3. **暴露辅助测试方法**：在 `SessionManager` 中为测试专用提供标注了 `@internal` 的 `__testEmitAsyncEvent(event: unknown): void` 辅助测试方法，隔离私有 `context` 成员，维持底座对事件的防绕过物理隔离。
4. **命名空间与语义划界**：将 `CliFacade` 中的 `isGenerating` 成员重命名为 `isRendering`，彻底划清“核心推理忙锁”与“适配器视图渲染锁”的命名与语义边界。
5. **测试对齐**：更新 `loopback.test.ts`，利用 `__testEmitAsyncEvent` 辅助方法替代对私有 `context` 的直接强转调用。
