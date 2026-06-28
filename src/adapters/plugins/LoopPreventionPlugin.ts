import type { HookContext, Plugin } from '../../core/usecases/plugins/plugin-types.js';
import { HookEventName } from '../../core/usecases/plugins/plugin-types.js';

/**
 * 推理死循环防护插件。
 * 挂载于 SessionStart 与 BeforeTool，记录工具调用指纹及频次，
 * 一旦检测到对同一个工具且包含完全相同参数的调用达到 3 次，立即抛出熔断信号（abort）以阻止死循环。
 */
export class LoopPreventionPlugin implements Plugin {
  public readonly name = 'LoopPreventionPlugin';
  public readonly weight = 5; // 执行顺序应该极其靠前，以便在工具真正分发执行前进行熔断判定

  private toolCallCounter = new Map<string, number>();

  public readonly hooks = {
    [HookEventName.SessionStart]: async (context: HookContext, next: () => Promise<void>) => {
      this.toolCallCounter.clear();
      await next();
    },
    [HookEventName.BeforeTool]: async (context: HookContext, next: () => Promise<void>) => {
      const toolCall = context.toolCall;
      if (toolCall) {
        const functionName = toolCall.name;
        const functionArgs = toolCall.arguments;
        const argsFingerprint = `${functionName}:${JSON.stringify(functionArgs)}`;

        const callCount = this.toolCallCounter.get(argsFingerprint) || 0;
        if (callCount >= 3) {
          context.control = {
            action: 'abort',
            reason: `安全熔断：检测到针对 ${functionName} 的相同参数调用已达 ${callCount} 次，疑似陷入死循环，强行终止推理进程。`
          };
          return; // 短路退出，不继续执行 next
        }

        this.toolCallCounter.set(argsFingerprint, callCount + 1);
      }
      await next();
    }
  };
}
