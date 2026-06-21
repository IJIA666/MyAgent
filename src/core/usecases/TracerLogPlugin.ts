import type { HookContext, Plugin } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import type { AgentTracer } from '../domain/tracer.js';

/**
 * 审计与足迹跟踪插件。
 * 挂载于所有的核心生命周期节点，捕获智能体运行过程中的所有生命周期阶段和执行参数，
 * 并在每一次 Hook 触发时，提取并写入由 Immer 沙箱产生的上下文属性修改（Patches）记录。
 */
export class TracerLogPlugin implements Plugin {
  public readonly name = 'TracerLogPlugin';
  public readonly weight = 100; // 审计插件一般较晚运行，以便观察其他插件的修改结果

  private tracerProvider: () => AgentTracer;

  /**
   * 构造函数。
   *
   * @param tracerProvider - 动态提供模型交互追踪仪的获取函数
   */
  constructor(tracerProvider: () => AgentTracer) {
    this.tracerProvider = tracerProvider;
  }

  public readonly hooks = {
    [HookEventName.SessionStart]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.tracerProvider().logPluginAudit({
        timestamp: new Date().toISOString(),
        type: 'lifecycle',
        eventName: HookEventName.SessionStart
      });
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.BeforeModel]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.tracerProvider().logPluginAudit({
        timestamp: new Date().toISOString(),
        type: 'lifecycle',
        eventName: HookEventName.BeforeModel,
        details: {
          model: context.llmRequest?.model,
          messagesCount: context.llmRequest?.messages?.length
        }
      });
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.AfterModel]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.tracerProvider().logPluginAudit({
        timestamp: new Date().toISOString(),
        type: 'lifecycle',
        eventName: HookEventName.AfterModel
      });
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.BeforeTool]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.tracerProvider().logPluginAudit({
        timestamp: new Date().toISOString(),
        type: 'lifecycle',
        eventName: HookEventName.BeforeTool,
        details: { toolCall: context.toolCall }
      });
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.AfterTool]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.tracerProvider().logPluginAudit({
        timestamp: new Date().toISOString(),
        type: 'lifecycle',
        eventName: HookEventName.AfterTool,
        details: { toolCall: context.toolCall }
      });
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.SessionEnd]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.tracerProvider().logPluginAudit({
        timestamp: new Date().toISOString(),
        type: 'lifecycle',
        eventName: HookEventName.SessionEnd
      });
      await next();
      this.auditCurrentPatches(context);
    }
  };

  /**
   * 收集并审计当前会话上下文中尚未记录的 Immer Patches 变更。
   *
   * @param context - 当前 Hook 执行上下文对象
   */
  private auditCurrentPatches(context: HookContext): void {
    const patches = context.sessionContext.getAndClearPluginPatches();
    if (patches && patches.length > 0) {
      for (const patchGroup of patches) {
        this.tracerProvider().logPluginAudit({
          timestamp: new Date().toISOString(),
          type: 'context_mutation',
          triggerEvent: patchGroup.eventName,
          patches: patchGroup.patches
        });
      }
    }
  }
}
