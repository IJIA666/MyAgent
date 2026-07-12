/**
 * 通用无状态人机协同审批插件。
 *
 * 核心职责：
 * 1. 通过显式 `ToolPolicyPort` 获取安全评估结果，不再从工具目录探测 `checkSafety`。
 * 2. 根据 pass / deny / suspend 三分流处理调用。
 * 3. suspend 路径复用现有 `buildSafetyOperation()`、`ApprovalPolicy.resolve()`
 *    和 `mapChoiceToEffect()`，不新增策略缓存。
 */

import type { Plugin, HookContext } from './plugin-types.js';
import type { SafetyOperation, SafetyCheckResult } from '../../../ports/shared/tool-policy.js';
import type { ToolPolicyCall, ToolPolicyPort } from '../../../ports/shared/tool-policy.js';
import type { SafetyResource } from '../../../ports/shared/safety-resource.js';
import type { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import { HookEventName } from './plugin-types.js';
import type { PendingGrant } from './plugin-types.js';
import type { ApprovalChoice } from './plugin-types.js';

/**
 * @deprecated 将 ToolPermissionService + PermissionPromptAdapter 替代。
 * ApprovalPolicy 已弃用，保留此映射函数仅为过渡期兼容。
 */
function mapChoiceToEffectCompat(
  choiceId: string,
  _resources: import('../../../ports/shared/safety-resource.js').SafetyResource[] | undefined,
  _toolName: string
): { type: 'call' | 'session' | 'persistent' | 'deny'; payload?: PendingGrant | { prefix: string } } {
  switch (choiceId) {
    case 'approve': return { type: 'call' };
    case 'session': return { type: 'session' };
    case 'persistent': return { type: 'persistent', payload: { prefix: _toolName } };
    default: return { type: 'deny' };
  }
}

/** ApprovalPolicy.resolve 返回的审批请求格式 */
interface ApprovalResolveResult {
  choices: ApprovalChoice[];
  message: string;
  operation: SafetyOperation;
}

/** ApprovalPolicy.resolve 函数的类型签名 */
type ApprovalResolver = (params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  operation: SafetyOperation;
  workMode: string;
}) => ApprovalResolveResult;

export class HumanApprovalPlugin implements Plugin {
  /** 插件在系统内的唯一标识名 */
  public readonly name = 'HumanApprovalPlugin';
  /** 执行优先级权重（保持原有早执行次序，在 BeforeTool 管线中优先拦截） */
  public readonly weight = 10;
  /** 中央审批策略服务实例（可选，已弃用） */
  private approvalPolicy?: Record<string, unknown>;
  /** 工具策略评估端口（替代原先的运行时方法探测） */
  private toolPolicyPort: ToolPolicyPort;
  /** 插件注册的生命周期钩子中间件集合 */
  public readonly hooks = {
    [HookEventName.BeforeTool]: this.beforeToolMiddleware.bind(this)
  };

  /**
   * @param toolPolicyPort - 工具策略评估端口（策略来源唯一入口）
   * @param approvalPolicy - 中央审批策略服务实例（可选，已弃用）
   */
  constructor(toolPolicyPort: ToolPolicyPort, approvalPolicy?: Record<string, unknown>) {
    this.toolPolicyPort = toolPolicyPort;
    this.approvalPolicy = approvalPolicy;
  }

  /**
   * BeforeTool 钩子中间件处理逻辑。
   *
   * 变更内容：安全评估入口从 `'checkSafety' in tool` 运行时探测
   * 迁移为显式 `ToolPolicyPort.evaluate()` 调用。
   * 保持现有 pass/deny/suspend 分流及后续授权效果映射不变。
   *
   * @param context - Hook 阶段的执行上下文
   * @param next - 洋葱管道的下一个中间件回调
   */
  private async beforeToolMiddleware(context: HookContext, next: () => void): Promise<void> {
    const toolCall = context.toolCall;
    if (!toolCall) {
      await next();
      return;
    }

    const sessionContext = context.sessionContext;
    const service = sessionContext.approvalService;

    // 构造标准化的工具策略调用描述
    const policyCall: ToolPolicyCall = {
      toolCallId: toolCall.id ?? '',
      toolName: toolCall.name,
      args: toolCall.arguments ?? {},
    };

    // 通过显式策略端口获取安全评估（替代旧 checkSafety 方法探测）
    const safetyResult: SafetyCheckResult = await this.toolPolicyPort.evaluate(
      policyCall,
      sessionContext,
    );

    // 【Plan 模式统一策略】基于 planSideEffect 决定 pass/suspend/deny
    // 仅当工具返回了可信副作用分类时生效；未设置 planSideEffect 的工具走原有流程。
    const workMode = sessionContext.getWorkMode();
    const planSideEffect = safetyResult.operation?.planSideEffect;
    if (workMode === 'Plan' && planSideEffect) {
      const isTrustedPlanRead = planSideEffect === 'read' && (
        safetyResult.status === 'pass' ||
        (safetyResult.status === 'suspend' && safetyResult.operation?.operationCategory === 'command-execute')
      );
      if (isTrustedPlanRead) {
        // 可证明安全的原子只读命令由 Plan 中央策略直接放行，不进入命令授权流程。
        // file-read 类的 suspend 仍表示工作区外访问，必须保留审批与 capability 注册。
        await next();
        return;
      }

      if (planSideEffect === 'sensitive-read' && safetyResult.status === 'suspend') {
        // 敏感只读操作进入受限审批：仅提供 call/deny 选项
        const approvalId = `approve_${Math.random().toString(36).substring(2, 9)}`;
        const operation: SafetyOperation = safetyResult.operation!;

        const approvalRequest = (this.approvalPolicy as { resolve: ApprovalResolver } | undefined)?.resolve({
          toolName: toolCall.name,
          toolArgs: toolCall.arguments,
          operation,
          workMode,
        });

        // 强制覆盖为仅 call/deny（无论 ApprovalPolicy 返回什么）
        if (!approvalRequest) {
          context.control.action = 'abort';
          context.control.reason = `[Plan 模式拒绝] 操作 "${toolCall.name}"：无法生成审批请求（approvalPolicy 未配置）。`;
          return;
        }
        const limitedChoices = approvalRequest.choices.filter((c: ApprovalChoice) => c.choiceId === 'call' || c.choiceId === 'deny');
        if (limitedChoices.length === 0) {
          // 没有可用选项时直接拒绝
          context.control.action = 'abort';
          context.control.reason = `[Plan 模式拒绝] 操作 "${toolCall.name}" 被识别为敏感读取，但无可用的审批选项。`;
          return;
        }

        context.emitEvent?.({
          type: 'suspend',
          id: approvalId,
          toolCall: { name: toolCall.name, arguments: toolCall.arguments },
          message: `[Plan 模式受限审批] 工具 "${toolCall.name}" 的副作用分类为 "sensitive-read"，仅允许单次放行或拒绝。`,
          choices: limitedChoices
        });

        if (!service) {
          context.control.action = 'abort';
          context.control.reason = 'Missing ApprovalService in SessionContext';
          return;
        }

        const decision = await service.wait(
          approvalId,
          { name: toolCall.name, arguments: toolCall.arguments },
          undefined,
          `[Plan 模式受限审批] ${operation.summary}`,
          300000,
          sessionContext.getSessionId(),
          limitedChoices
        );

        if (decision.action === 'deny') {
          const haltError = new Error('HaltedByReject: Operation rejected by user in Plan limited approval.');
          service.rejectBySessionId(sessionContext.getSessionId(), haltError);
          context.control.action = 'abort';
          context.control.reason = 'HaltedByReject: Operation rejected by user';
          throw haltError;
        }

        // call 类型：注册一次性调用授权
        const effect = mapChoiceToEffectCompat(decision.action as string, undefined, toolCall.name);
        if (effect.type === 'call') {
          context.pendingGrant = effect.payload as PendingGrant;
        }

        await next();
        return;
      }

      if (planSideEffect !== 'read') {
        // write / unknown / hardline → 在 Plan 模式下直接拒绝。
        context.control.action = 'abort';
        context.control.reason = `[Plan 模式拒绝] 操作 "${toolCall.name}" 的副作用分类为 "${planSideEffect}"，Plan 模式下只允许可证明安全的只读操作。请使用只读文件 API 工具（如 readFile、listFiles、grepSearch）代替。`;
        return;
      }
      // read + suspend/deny 保留工具安全评估的原始语义，继续交由下方通用三分流处理。
    }

    // 处理安全评估结论
    if (safetyResult.status === 'pass') {
      await next();
      return;
    }

    if (safetyResult.status === 'deny') {
      context.control.action = 'abort';
      context.control.reason = `工具 "${toolCall.name}" 执行安全核查被拒绝: ${safetyResult.message || '安全校验未通过。'}`;
      return;
    }

    // 处理挂起审批分支 (suspend)
    if (safetyResult.status === 'suspend') {
      const toolCallId = policyCall.toolCallId;
      const approvalId = `approve_${Math.random().toString(36).substring(2, 9)}`;

      // 从工具注册表获取元数据（仅用于 fallback 资源推断，非安全评估来源）
      const toolMeta = (context.toolRegistry as ToolRegistryPort | undefined)?.getTool(toolCall.name);

      // 组装 SafetyOperation（含旧格式降级兼容）
      const operation: SafetyOperation = this.buildSafetyOperation(safetyResult, toolMeta, toolCall.name);

      // 委托 ApprovalPolicy 生成受信的审批请求
      const approvalRequest = (this.approvalPolicy as { resolve: ApprovalResolver } | undefined)?.resolve({
        toolName: toolCall.name,
        toolArgs: toolCall.arguments,
        operation,
        workMode: sessionContext.getWorkMode(),
      });

      // 广播 suspend 事件给外部宿主，携带 ApprovalRequest.choices
      if (!approvalRequest) {
        context.control.action = 'abort';
        context.control.reason = `工具 "${toolCall.name}"：无法生成审批请求（approvalPolicy 未配置）。`;
        return;
      }

      // 广播 suspend 事件给外部宿主，携带 ApprovalRequest.choices
      context.emitEvent?.({
        type: 'suspend',
        id: approvalId,
        toolCall: {
          name: toolCall.name,
          arguments: toolCall.arguments
        },
        allowedPrefix: safetyResult.safePrefix ?? null,
        message: approvalRequest.message,
        choices: approvalRequest.choices
      });

      if (!service) {
        context.control.action = 'abort';
        context.control.reason = 'Missing ApprovalService in SessionContext';
        return;
      }

      // 原地挂起并等待外部决策，透传 choices 给 UI
      const decision = await service.wait(
        approvalId,
        { name: toolCall.name, arguments: toolCall.arguments },
        safetyResult.safePrefix,
        approvalRequest.message,
        300000,
        sessionContext.getSessionId(),
        approvalRequest.choices
      );

      // UI 回传的 choiceId 必须属于本次受信的 choices 集，否则按拒绝处理
      const allowedChoices = new Set(approvalRequest.choices.map((choice: { choiceId: string }) => choice.choiceId));
      if (!allowedChoices.has(decision.action)) {
        const haltError = new Error(`HaltedByReject: Untrusted approval choice "${decision.action}" is not allowed for this operation.`);
        service.rejectBySessionId(sessionContext.getSessionId(), haltError);
        context.control.action = 'abort';
        context.control.reason = `HaltedByReject: Untrusted approval choice "${decision.action}"`;
        throw haltError;
      }

      const trustedOperation = approvalRequest.operation ?? operation;

      // 委托兼容函数将 choiceId 映射为授权效果
      const effect = mapChoiceToEffectCompat(decision.action, trustedOperation.resources, toolCall.name);

      // 处理拒绝分支
      if (effect.type === 'deny') {
        const haltError = new Error('HaltedByReject: Operation rejected by user, and all subsequent pending actions have been cancelled.');
        service.rejectBySessionId(sessionContext.getSessionId(), haltError);
        context.control.action = 'abort';
        context.control.reason = 'HaltedByReject: Operation rejected by user';
        throw haltError;
      }

      // 根据效果类型构造 pendingGrant 或 persistentRuleEffect
      if (effect.type === 'persistent') {
        context.persistentRuleEffect = effect.payload as { type: 'persistent'; prefix: string };
      } else if (effect.type === 'call' || effect.type === 'session') {
        const grant = effect.payload as PendingGrant;
        const pendingGrant: PendingGrant = grant.type === 'call'
          ? { type: 'call', toolCallId: toolCallId!, toolName: grant.toolName, resources: grant.resources }
          : { type: 'session', toolCallId: toolCallId!, resources: grant.resources };
        context.pendingGrant = pendingGrant;
      }
    }

    // 执行链流转
    await next();
  }

  /**
   * 从 SafetyCheckResult 组装 SafetyOperation。
   * 若 checkSafety 已返回 operation 字段则直接使用，
   * 否则从旧格式字段（resources、targetPath、message 等）降级组装。
   *
   * @param safetyResult - 安全评估结果
   * @param toolMeta - 工具元数据（仅用于降级时推断 securityCategory）
   * @param toolName - 工具名称
   * @returns 标准化安全操作描述
   */
  private buildSafetyOperation(
    safetyResult: SafetyCheckResult,
    toolMeta: { securityCategory: 'read' | 'write'; name: string } | undefined,
    toolName: string
  ): SafetyOperation {
    // 优先使用工具已返回的标准化 operation
    if (safetyResult.operation) {
      return safetyResult.operation;
    }

    // 降级组装：从旧格式字段推断
    const resources: SafetyResource[] = safetyResult.resources && safetyResult.resources.length > 0
      ? safetyResult.resources
      : safetyResult.targetPath
        ? [{
            kind: 'path',
            access: (toolMeta && toolMeta.securityCategory === 'read') ? 'read' : 'write',
            normalizedPath: safetyResult.targetPath
          }]
        : [];

    // 推断 operationCategory
    let operationCategory: SafetyOperation['operationCategory'];
    if (toolName === 'execute_command') {
      operationCategory = 'command-execute';
    } else if (toolMeta && toolMeta.securityCategory === 'read') {
      operationCategory = 'file-read';
    } else {
      operationCategory = 'file-write';
    }

    return {
      resources,
      riskReason: safetyResult.message || `工具 "${toolName}" 请求授权`,
      operationCategory,
      summary: safetyResult.message || toolName,
    };
  }
}
