/**
 * @file 智能体 Hook 管道运行调度器。
 * 核心职责：
 * 1. 构建基于异步洋葱中间件（ Onion Middleware ）的链式调用机制。
 * 2. 利用 Immer 的 produceWithPatches 对上下文（ messages 与 llmRequest ）进行 Draft 状态沙箱包装。
 * 3. 拦截 SessionContext 的改写操作使其在沙箱中安全运行，并在执行链无阻断通过后统一提交。
 * 4. 落地串行短路（ Fail-Fast ）拦截决策，并输出 Patch 变更日志以供 Trace 审计。
 */

import { enablePatches, createDraft, finishDraft, setAutoFreeze } from 'immer';
import type { Patch } from 'immer';
import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { HookContext, HookEventName, HookMiddleware, LlmRequest } from './plugin-types.js';
import type { SessionContext } from '../../domain/context.js';
import { logger, compressPatch } from '../../../utils/logger.js';

// 全局禁用 Immer 的自动冻结机制，以适配 SessionContext 底层的面向对象可变状态（Mutable State）架构设计，防止外部操作被冻结的会话消息历史或工具属性时崩溃
setAutoFreeze(false);

// 显式启用 Immer 的变更补丁功能，以支持局部变更溯源
enablePatches();



/**
 * 包装在 Immer 隔离沙箱中的纯状态数据结构。
 */
interface BaseState {
  history: ChatMessage[];
  llmRequest?: LlmRequest;
  llmResponse?: unknown;
  toolCall?: {
    name: string;
    arguments: Record<string, unknown>;
  };
  toolResult?: {
    content: string;
    isError?: boolean;
  };
  tailToolCallRequest?: {
    name: string;
    args: Record<string, unknown>;
  };
}

/**
 * 串行执行指定的 Hook 生命周期中间件管道。
 *
 * @param eventName - 当前触发的生命周期节点名
 * @param sessionContext - 智能体会话的 SessionContext 实例
 * @param middlewares - 已按权重排序 of 中间件回调链
 * @param extraParams - 触发此 Hook 节点所附带的可选参数（ 如 llmRequest, toolCall 等 ）
 * @returns 执行完成并合并了沙箱修改后的最终 HookContext 对象
 */
export async function runHookPipeline(
  eventName: HookEventName,
  sessionContext: SessionContext,
  middlewares: HookMiddleware[],
  extraParams?: Partial<Pick<HookContext, 'llmRequest' | 'llmResponse' | 'toolCall' | 'toolResult' | 'emitEvent' | 'toolRegistry'>>
): Promise<HookContext> {
  // 1. 装配外层基础 Context，初始化控制信号为 continue
  const context: HookContext = {
    sessionContext,
    eventName,
    ...extraParams,
    control: { action: 'continue' }
  };

  // 如果没有挂载任何中间件，直接顺延通过
  if (middlewares.length === 0) {
    return context;
  }

  // 2. 识别并提取核心需要隔离防冲突的纯 JS 状态数据
  const baseState: BaseState = {
    history: sessionContext.getHistory(),
    llmRequest: context.llmRequest ? structuredClone(context.llmRequest) : undefined,
    llmResponse: context.llmResponse ? structuredClone(context.llmResponse) : undefined,
    toolCall: context.toolCall ? structuredClone(context.toolCall) : undefined,
    toolResult: context.toolResult ? structuredClone(context.toolResult) : undefined,
    tailToolCallRequest: undefined
  };

  // 3. 启用忙锁并创建沙箱隔离 Draft
  sessionContext.isProcessing = true;
  const draft = createDraft(baseState);

  // 代理原有的 SessionContext，重定向其对 messageHistory 的所有改写和读取至 Immer 的 Draft 状态上
  const sandboxedSessionContext = new Proxy(sessionContext, {
    get(target, prop, receiver) {
      if (prop === 'getHistory') {
        return () => draft.history;
      }
      if (prop === 'addMessage') {
        return (msg: ChatMessage) => {
          draft.history.push(msg);
        };
      }
      if (prop === 'popMessage') {
        return () => draft.history.pop();
      }
      if (prop === 'truncateHistory') {
        return (keepLastN: number) => {
          if (draft.history.length <= keepLastN + 1) return;
          const systemMsg = draft.history[0];
          const keptMsgs = draft.history.slice(draft.history.length - keepLastN);
          draft.history = [systemMsg, ...keptMsgs];
        };
      }
      // 其它普通属性和未拦截方法反射并绑定执行
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  const sandboxContext: HookContext = {
    sessionContext: sandboxedSessionContext,
    eventName: context.eventName,
    llmRequest: draft.llmRequest,
    llmResponse: draft.llmResponse,
    toolCall: draft.toolCall,
    toolResult: draft.toolResult,
    toolRegistry: context.toolRegistry,
    control: context.control, // 共享同一个控制信号引用
    emitEvent: context.emitEvent
  };

  // 洋葱模型串行递归分发
  const dispatch = async (i: number): Promise<void> => {
    // 遇中断即短路（ Fail-Fast ）：当前任一插件触发了非 continue 指令时，立即截断
    if (sandboxContext.control.action !== 'continue') {
      return;
    }

    // 递归终止条件
    if (i >= middlewares.length) {
      return;
    }

    const middleware = middlewares[i];
    // 递归执行下一个中间件，利用 await 保证严格的串行时序
    await middleware(sandboxContext, () => dispatch(i + 1));
  };

  let finalState: BaseState;
  const patches: Patch[] = [];

  try {
    // 异步执行洋葱链，由 Try-Catch-Finally 提供稳固的异常熔断和忙锁释放防护
    await dispatch(0);
    // 将中间件中填写的尾随工具请求与控制指令提取到最终合并状态中
    draft.tailToolCallRequest = sandboxContext.tailToolCallRequest;
    // 冻结 Draft 状态并捕获 patches 补丁
    finalState = finishDraft(draft, (p) => {
      patches.push(...p);
    }) as BaseState;
  } catch (error) {
    // 发生异常时，直接丢弃该 Draft，坚决不提交，防止脏写
    logger.error(`[Plugin Error] Hook ${eventName} failed:`, error);
    throw error;
  } finally {
    // 强制还原并释放并发忙状态锁，杜绝死锁风险
    sessionContext.isProcessing = false;
  }

  // 4. 一次性安全提交 Immer 生成的不可变状态至外层 SessionContext 属性
  // 只有当控制指令没有触发 abort（ 强行终止 ）时，修改才会被确认落盘，防止脏写
  if (finalState.history !== baseState.history && context.control.action !== 'abort') {
    sessionContext.updateHistory(finalState.history);
  }

  // 同步写回外部 HookContext 属性以供 AgentLoop 最终消费
  context.llmRequest = finalState.llmRequest;
  context.llmResponse = finalState.llmResponse;
  context.toolCall = finalState.toolCall;
  context.toolResult = finalState.toolResult;
  context.tailToolCallRequest = finalState.tailToolCallRequest;

  // 5. 可观测性追踪：如果产生上下文改动，输出差异 Patch 审计日志
  if (patches.length > 0) {
    // 对 patches 执行 Map 压缩摘要，避免大文本（ 如 system prompt ）撑爆日志
    const simplifiedPatches = patches.map(compressPatch);

    // 将变更捕获作为 Trace 日志写入，提高黑盒插件环境下的高度可调试性
    logger.debug(`[Plugin Trace] Hook ${eventName} context modified: ${JSON.stringify(simplifiedPatches, null, 2)}`);
    sessionContext.addPluginPatches(eventName, patches);
  }

  return context;
}
