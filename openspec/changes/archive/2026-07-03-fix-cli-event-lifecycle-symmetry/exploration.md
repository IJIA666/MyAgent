# 探索主题: CLI 事件渲染与状态管理 Bug 分析

## 1. 问题定义

在 Plan 模式下手动测试时，发现三个关联的 Bug：
1. **显示错乱**：工具调用被插件拦截后，错误反馈 `[反馈] 工具 "writeFile" 执行完毕...` 被渲染在用户 prompt 行的同一行，产生 `用户 > [反馈]...` 的视觉错乱
2. **状态泄漏**：error 事件过早结束渲染周期并恢复监听器，导致后续事件（`tool_call_result`、第二轮 ReAct 循环的 content）在错误的状态上下文中渲染
3. **异常自动回复**：工具拦截后 agent 自动发起新一轮请求，且在此期间 WorkMode 切换被 `isProcessing` 锁阻塞

三个 Bug 的根因指向同一个代码缺陷：**`handleAgentEvent` 中 `error` 事件不当终止渲染周期**。更深层说，`session.ts` 中的事件生命周期契约是**非对称**的——正常路径有 `complete` 收尾，错误路径只有 `error` 没有 `complete`，强制 CLI 层把 error 当作状态终结点。

## 2. 关键发现与调研结果

### 2.1 非对称契约：session.ts 的历史债务

`runInternalGeneration()` 中的事件生命周期处理（`session.ts:385-428`）：

```typescript
let hasError = false;
try {
    for await (const event of this.agentLoop.chat(...)) {
        this.emit('agent_event', event);
    }
} catch (error) {
    hasError = true;
    this.emit('agent_event', { type: 'error', ... });   // ← 只有 error，没有 complete
} finally {
    this.isGenerating = false;
    // 第 403-404 行注释：「若推理期间抛出 error 异常，将直接由 'error' 广播事件接管
    //   且直接由终端捕获并恢复 stdin，故无需（也不应该）在此处重复发送 'complete'。」
    if (!hasError && !willWakeup) {
        this.emit('agent_event', { type: 'complete' }); // ← hasError 时跳过
    }
    // 第 412 行：nextTick 没有 !hasError 守卫 ⚠️
    process.nextTick(() => {
        if (!this.isGenerating && this.hasPendingAsyncNotification) {
            // auto-wakeup 在 hasError=true 时也会触发
```

这份代码主动把状态清理责任推给 error 事件。它假设 error **总是**代表灾难性崩溃（API 断连、网络超时）——此时不需要后续事件，CLI 直接恢复监听即可。但这一假设在"流内 error"（如工具被插件 abort，后续还有 `tool_call_result` 和下一轮 ReAct）的场景下完全不成立。

### 2.2 流内 error 的时序破坏

agent-loop 在 `BeforeTool` 钩子返回 `abort` 时，连续 push 两个事件：

```typescript
// agent-loop.ts:529-530
taskEvents.push({ type: 'error', message: `[插件拦截] 工具调用被拦截阻断：${...}` });
taskEvents.push({ type: 'tool_call_result', functionName, result: toolResult });
```

`handleAgentEvent` 对 error 的处理：

```typescript
// facade.ts:283-287
case 'error':
    console.log(theme.error(`\n[异常] ${event.message}\n`));
    this.isRendering = false;     // ← ⚠️ 过早终止渲染
    this.listener.resume();       // ← ⚠️ 过早恢复监听
    break;
```

`resume()` 内部（`input-listener.ts:198-201`）：

```typescript
setImmediate(() => {
    this.isPaused = false;        // ← 异步释放，后续 tick 执行
});
```

### 2.3 状态泄漏时序表

| 时刻 | 操作 | `isPaused` | `isRendering` |
|:---|:---|:---|:---|
| T1 | `error` → `resume()`，`setImmediate(isPaused=false)` 入队 | `true` | `false` |
| T2 | `tool_call_result` → `pause()` | `true` | `true` |
| T3 | `setImmediate` 回调执行 → `isPaused = false` | **`false`** | **`true`** |

T3 之后监听器在渲染期间被意外激活。后续的 ReAct 循环第二轮（模型看到 error 后生成回复）在异常的监听器状态下渲染，触发 WorkMode 切换时的 `isProcessing` 锁竞争和意外 auto-wakeup。

### 2.4 readline prompt 换行问题

`readline.prompt()` 输出 `用户 [model | Plan] > ` 后光标不换行——readline 在等用户输入。当 `console.log` 紧接着从当前光标位置输出时，文本拼接到 prompt 行上，产生视觉错乱。

## 3. 方案对比与推荐方向

### 3.1 朴素方案 A 的致命缺陷

简单删除 `facade.ts` 中 error case 的 `isRendering = false` 和 `resume()` 两行，会导致另一种死锁：当发生**真实的灾难性崩溃**（API 网络断开、LLM 请求超时），`session.ts` 的 catch 块仅 emit `error` 而不 emit `complete`。ClI 层永远停留在 `isRendering = true`，InputListener 永远挂起——终端彻底死锁。

### 3.2 方案对比

| 评估维度 | A+ 对称式契约重塑 | B. error 后延迟恢复 | C. 拆分 error 类型 |
|:---|:---|:---|:---|
| 改造范围 | `session.ts` catch 块 + nextTick 守卫 + `facade.ts` error case，共三处小改动 | `facade.ts` 一处，但需调延迟参数 | agent-loop 事件定义 + 所有 emit 点 |
| 死锁风险 | ✅ 消除 — 无论正常/异常，complete 始终收尾 | ⚠️ 延迟值不准确可能残留 | ✅ |
| 与现有行为兼容 | ✅ — 契约语义更清晰 | 中 — 延迟值难以确定 | 低 |
| 原理正确性 | ✅ complete 是唯一生命周期终点 | ⚠️ 规避症状，未解决根因 | ✅ 但过度设计 |

### 3.3 推荐路径：方案 A+（对称式契约重塑）

核心思想：**无论正常结束还是灾难崩溃，`complete` 都是唯一的状态终结点。error 退化为纯信息事件——只告诉用户"刚才出错了"，不参与状态管理。**

需要修改三处：

**修改一：`session.ts` — catch 块补发 complete**

```typescript
// session.ts:392-398
} catch (error: unknown) {
    hasError = true;
    const message = error instanceof Error ? error.message : String(error);
    this.emit('agent_event', {
        type: 'error',
        message
    });
    // 强制补发 complete，确保无论正常结束还是崩溃，生命周期对称收尾
    this.emit('agent_event', { type: 'complete' });
}
```

**修改二：`session.ts` — nextTick 加 hasError 守卫**

```typescript
// session.ts:411-412
process.nextTick(() => {
    if (!hasError && !this.isGenerating && this.hasPendingAsyncNotification) {
```

`!hasError` 防止灾难崩溃后 auto-wakeup 误触发，因为 catch 块已经补发了 `complete`。

**修改三：`facade.ts` — error 纯化为旁注**

```typescript
// facade.ts:283-287
case 'error':
    console.log(theme.error(`\n[异常] ${event.message}\n`));
    // 移除 isRendering=false 和 listener.resume()
    break;
```

**不变部分**：`finally` 块第 406 行的 `if (!hasError && !willWakeup)` 无需修改——catch 已 emit complete，`!hasError` 自动阻止双重 emit。正常路径（`!hasError && !willWakeup`）照常 emit。

**效果验证**：

| 场景 | 事件序列 | CLI 最终状态 |
|:---|:---|:---|
| 正常完成 | `...` → `complete` | `isRendering=false`，listener 恢复 |
| 工具被 abort | `error` → `tool_call_result` → `content` → `complete` | 同上（error 不影响状态） |
| API 崩溃 | `error` → `complete` | 同上（catch 补发了 complete） |

## 4. 约束、风险与未知项

- `setImmediate` 异步释放 `isPaused` 的设计在其他场景下是否也有类似的状态不一致风险，值得在后续排查
- 补发 `complete` 之后，auto-wakeup 的 `process.nextTick` 回调是否可能在 `complete` 事件处理完毕后才执行——如果 `hasPendingAsyncNotification` 在 error 场景下为 true 且 nextTick 未加守卫，会在 complete 之后启动新推理。`!hasError` 守卫已覆盖此场景

## 5. 否决方案

- **朴素方案 A（仅删 facade.ts 两行）**：灾难性崩溃时 session.ts 不 emit complete，导致 `isRendering` 永远为 true，终端死锁
- **方案 B（延迟恢复）**：治标不治本。轮次间的后续事件数量不确定，延迟值不可靠
- **方案 C（拆分 error 类型）**：过度设计。对称契约下 `complete` 统一收尾，无需区分 error 子类型
