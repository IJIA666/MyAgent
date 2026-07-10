import type { HookContext, Plugin } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import type { AgentTracer } from '../../domain/tracer.js';
import { digestDiagnosticValue } from '../../../utils/diagnostic-sanitizer.js';

/**
 * 审计与足迹跟踪插件。
 * 挂载于核心生命周期节点，记录事件顺序、策略结果、资源摘要和 Immer 变更摘要，
 * 不把工具参数、工具结果、prompt 或 patch 原始值作为 audit 制品写盘。
 */
export class TracerLogPlugin implements Plugin {
  public readonly name = 'TracerLogPlugin';
  public readonly weight = 0; // 审计插件先进入管线，才能包裹并记录前置 abort 的最终状态。

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
    [HookEventName.RunStart]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.logLifecycleAudit(context, HookEventName.RunStart);
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.BeforeModel]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.logLifecycleAudit(context, HookEventName.BeforeModel);
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.AfterModel]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.logLifecycleAudit(context, HookEventName.AfterModel);
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.BeforeTool]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      try {
        await next();
      } finally {
        this.auditCurrentPatches(context);
        this.logLifecycleAudit(context, HookEventName.BeforeTool);
      }
    },
    [HookEventName.AfterTool]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.logLifecycleAudit(context, HookEventName.AfterTool);
      await next();
      this.auditCurrentPatches(context);
    },
    [HookEventName.RunEnd]: async (context: HookContext, next: () => Promise<void>) => {
      this.auditCurrentPatches(context);
      this.logLifecycleAudit(context, HookEventName.RunEnd);
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
          sessionId: context.sessionContext.getSessionId(),
          triggerEvent: patchGroup.eventName,
          patches: patchGroup.patches.map((patch) => ({
            op: patch.op,
            path: {
              length: patch.path.length,
              digest: digestDiagnosticValue(patch.path)
            },
            value: this.summarizePatchValue(patch.value)
          }))
        });
      }
    }
  }

  /** 记录不含原始载荷的生命周期审计事件。 */
  private logLifecycleAudit(context: HookContext, eventName: HookEventName): void {
    const toolCall = context.toolCall;
    this.tracerProvider().logPluginAudit({
      timestamp: new Date().toISOString(),
      type: 'lifecycle',
      sessionId: context.sessionContext.getSessionId(),
      eventName,
      correlationId: toolCall?.id,
      toolName: toolCall?.name,
      policyResult: context.control.action,
      status: context.toolResult?.isError ? 'error' : 'ok',
      model: context.llmRequest?.model,
      messagesCount: context.llmRequest?.messages?.length,
      tool: toolCall ? {
        name: toolCall.name,
        argumentKeys: Object.keys(toolCall.arguments),
        argumentDigest: digestDiagnosticValue(toolCall.arguments),
        resources: this.summarizeResources(toolCall.arguments)
      } : undefined,
      toolResult: context.toolResult ? {
        isError: context.toolResult.isError === true,
        length: context.toolResult.content.length,
        digest: digestDiagnosticValue(context.toolResult.content)
      } : undefined
    });
  }

  /** 将工具参数中的潜在资源定位字段转换为不可逆摘要。 */
  private summarizeResources(argumentsValue: Record<string, unknown>): Array<Record<string, unknown>> {
    const resourceKeys = new Set(['path', 'filePath', 'targetPath', 'url', 'directory', 'workspace']);
    return Object.entries(argumentsValue)
      .filter(([key]) => resourceKeys.has(key))
      .map(([key, value]) => ({
        field: key,
        type: Array.isArray(value) ? 'array' : typeof value,
        digest: digestDiagnosticValue(value)
      }));
  }

  /** 将 patch value 转换为长度、类型和不可逆摘要。 */
  private summarizePatchValue(value: unknown): Record<string, unknown> {
    return {
      type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
      length: typeof value === 'string' || Array.isArray(value) ? value.length : undefined,
      digest: digestDiagnosticValue(value)
    };
  }
}
