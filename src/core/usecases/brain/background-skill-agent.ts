import type { SessionEventPort } from '../../../ports/driven/session/SessionEventPort.js';
import type { ApprovalPort } from '../../../ports/driven/session/ApprovalPort.js';
import type { EventNotificationPort } from '../../../ports/driven/session/EventNotificationPort.js';
import type { InteractionPort } from '../../../ports/driven/session/InteractionPort.js';
import type {
  ToolExecutionLifecycleHooks,
  ToolMetadata,
  ToolRegistryPort,
} from '../../../ports/driven/tools/ToolRegistryPort.js';
import type { ToolExecutionOutcome } from '../../../adapters/tools/tool-types.js';
import {
  PermissionSessionState,
  type PermissionSessionSnapshot,
} from '../../domain/permissions/permission-session-state.js';
import {
  createChildTrustedCallContext,
  type TrustedCallContext,
} from '../../domain/permissions/trusted-call-context.js';
import {
  SKILL_CURATOR_CALLER_ID_PREFIX,
  SKILL_REVIEW_CALLER_ID_PREFIX,
} from './skill-types.js';

/** Skill Review Agent 的固定工具上限。 */
const BACKGROUND_SKILL_TOOL_NAMES = new Set(['load_skill', 'skill_manage']);

/** 后台真实 Skill 变更或暂存结果。 */
export interface BackgroundSkillMutationResult {
  /** 结果状态。 */
  readonly status: 'success' | 'staged';
  /** Skill 管理动作。 */
  readonly action: string;
  /** Skill 名称。 */
  readonly name: string;
  /** writeApproval 暂存标识。 */
  readonly pendingId?: string;
  /** delete 归档时的 umbrella 吸收目标。 */
  readonly absorbedInto?: string;
}

/** BackgroundSkillAgent 构造选项。 */
export interface BackgroundSkillAgentOptions {
  /** 父会话最终权限状态。 */
  readonly parentPermissionState: PermissionSessionState;
  /** 父 caller；子 caller 从其受信身份派生。 */
  readonly parentCaller: TrustedCallContext;
  /** 父 Agent 当前实际可见工具名。 */
  readonly parentToolNames: readonly string[];
  /** 子 Agent caller id。 */
  readonly callerId: string;
  /** 关闭或取消后是否仍允许进入工具执行。 */
  readonly isActive?: () => boolean;
  /** 真实 success/staged skill_manage 结果观察器。 */
  readonly onSkillMutation?: (result: BackgroundSkillMutationResult) => void;
  /** 受信 caller 前缀；默认后台 Review。 */
  readonly callerIdPrefix?: typeof SKILL_REVIEW_CALLER_ID_PREFIX
    | typeof SKILL_CURATOR_CALLER_ID_PREFIX;
  /** skill_manage 获得执行许可后的首个写入前钩子。 */
  readonly beforeSkillMutation?: () => void;
}

/**
 * Skill Review Agent 的受限 ToolRegistry 视图。
 * 工具面固定为父工具集合与 load_skill/skill_manage 的交集，
 * 所有调用继续经过共享 ToolGateway，但使用独立权限快照和 background/subagent caller。
 */
export class BackgroundSkillAgent implements ToolRegistryPort {
  private readonly permissionState: PermissionSessionState;
  private readonly caller: TrustedCallContext;
  private readonly parentToolNames: ReadonlySet<string>;
  private readonly isActive: () => boolean;
  private readonly onSkillMutation?: (result: BackgroundSkillMutationResult) => void;
  private readonly beforeSkillMutation?: () => void;

  /**
   * @param parentRegistry - 已装配统一 ToolGateway 的父工具注册表
   * @param options - 权限快照、父工具面、caller 与结果观察器
   */
  constructor(
    private readonly parentRegistry: ToolRegistryPort,
    options: BackgroundSkillAgentOptions,
  ) {
    this.permissionState = PermissionSessionState.fromSnapshot(
      options.parentPermissionState.snapshot(),
    );
    const callerIdPrefix = options.callerIdPrefix ?? SKILL_REVIEW_CALLER_ID_PREFIX;
    this.caller = createChildTrustedCallContext(
      options.parentCaller,
      options.callerId.startsWith(callerIdPrefix)
        ? options.callerId
        : `${callerIdPrefix}:${options.callerId}`,
    );
    this.parentToolNames = new Set(options.parentToolNames);
    this.isActive = options.isActive ?? (() => true);
    this.onSkillMutation = options.onSkillMutation;
    this.beforeSkillMutation = options.beforeSkillMutation;
  }

  /**
   * 返回父工具面内允许暴露给 Review 模型的两个工具定义。
   *
   * @returns load_skill/skill_manage 与父工具面的交集
   */
  public async getTools(): Promise<unknown[]> {
    const tools = await this.parentRegistry.getTools();
    return tools.filter(tool => {
      const name = getToolDefinitionName(tool);
      return name !== undefined && this.isAllowedTool(name);
    });
  }

  /**
   * 获取允许工具的元数据。
   *
   * @param name - 工具名
   * @returns 允许且父工具存在时的元数据
   */
  public getTool(name: string): ToolMetadata | undefined {
    return this.isAllowedTool(name)
      ? this.parentRegistry.getTool(name)
      : undefined;
  }

  /**
   * 使用受限安全上下文执行工具。
   *
   * @param functionName - 只能是 load_skill 或 skill_manage
   * @param functionArgs - JSON 风格工具参数
   * @param _sessionContext - 被忽略，禁止把临时上下文作为审批入口传给父注册表
   * @param _interactionPort - 被忽略，后台任务不允许交互
   * @param signal - 后台任务取消信号
   * @param toolCallId - 工具调用标识
   * @param timeoutMs - 获批后执行超时
   * @param _lifecycleHooks - 被忽略，调用者不能扩大固定安全上下文
   * @returns 共享 ToolGateway 的真实执行结果
   */
  public async callTool(
    functionName: string,
    functionArgs: Record<string, unknown>,
    _sessionContext?: SessionEventPort & ApprovalPort & EventNotificationPort,
    _interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string,
    timeoutMs?: number,
    _lifecycleHooks?: ToolExecutionLifecycleHooks,
  ): Promise<ToolExecutionOutcome<unknown>> {
    if (!this.isAllowedTool(functionName)) {
      throw new Error(`Skill Review Agent 不允许调用工具: ${functionName}`);
    }
    this.assertActive(signal);

    const outcome = await this.parentRegistry.callTool(
      functionName,
      structuredClone(functionArgs),
      undefined,
      undefined,
      signal,
      toolCallId,
      timeoutMs,
      {
        prepareExecution: async () => {
          this.assertActive(signal);
          if (functionName === 'skill_manage') {
            this.beforeSkillMutation?.();
          }
        },
        securityContext: {
          caller: this.caller,
          permissionState: this.permissionState,
          approvalAllowed: false,
          auditSource: 'background_skill_review',
        },
      },
    );
    if (functionName === 'skill_manage') {
      const mutation = parseSkillMutation(outcome.value, functionArgs);
      if (mutation) {
        this.onSkillMutation?.(mutation);
      }
    }
    return outcome;
  }

  /**
   * 返回与父会话不共享引用的权限快照。
   *
   * @returns 当前后台权限快照
   */
  public getPermissionSnapshot(): PermissionSessionSnapshot {
    return this.permissionState.snapshot();
  }

  /**
   * 返回 background/subagent caller。
   *
   * @returns 受信子 caller
   */
  public getCaller(): TrustedCallContext {
    return this.caller;
  }

  /**
   * 关闭受限视图。
   * 共享父 ToolRegistry 的生命周期由 SessionManager 管理，此处不得关闭它。
   */
  public async close(): Promise<void> {
    // 受限视图不拥有共享 ToolRegistry。
  }

  /** 判断工具是否同时属于固定上限和父工具面。 */
  private isAllowedTool(name: string): boolean {
    return BACKGROUND_SKILL_TOOL_NAMES.has(name) && this.parentToolNames.has(name);
  }

  /** 在进入共享 ToolGateway 前后置准备阶段检查关闭与取消。 */
  private assertActive(signal?: AbortSignal): void {
    if (!this.isActive() || signal?.aborted) {
      const error = new Error('Skill Review Agent 已关闭或取消');
      error.name = 'AbortError';
      throw error;
    }
  }
}

/** 从 OpenAI function definition 或扁平工具元数据中读取工具名。 */
function getToolDefinitionName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.name === 'string') {
    return value.name;
  }
  return isRecord(value.function) && typeof value.function.name === 'string'
    ? value.function.name
    : undefined;
}

/** 从 ToolGateway 的 MCP 兼容包络解析真实 Skill 管理结果。 */
function parseSkillMutation(
  value: unknown,
  functionArgs: Readonly<Record<string, unknown>>,
): BackgroundSkillMutationResult | undefined {
  const payload = unwrapJsonPayload(value);
  if (
    !isRecord(payload)
    || (payload.status !== 'success' && payload.status !== 'staged')
    || typeof payload.action !== 'string'
    || typeof payload.name !== 'string'
  ) {
    return undefined;
  }
  return Object.freeze({
    status: payload.status,
    action: payload.action,
    name: payload.name,
    ...(typeof payload.pendingId === 'string' ? { pendingId: payload.pendingId } : {}),
    ...(payload.action === 'delete' && typeof functionArgs.absorbedInto === 'string'
      ? { absorbedInto: functionArgs.absorbedInto }
      : {}),
  });
}

/** 解包 CallToolResult 第一段 text，并兼容测试中的直接 JSON 字符串。 */
function unwrapJsonPayload(value: unknown): unknown {
  let text: string | undefined;
  if (typeof value === 'string') {
    text = value;
  } else if (isRecord(value) && Array.isArray(value.content)) {
    const first = value.content[0];
    if (isRecord(first) && typeof first.text === 'string') {
      text = first.text;
    }
  }
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
