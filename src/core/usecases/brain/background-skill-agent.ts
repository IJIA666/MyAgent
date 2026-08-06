import { normalize } from 'node:path';
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
import { isToolOutcomeWithinQuota } from '../engine/ToolDispatcher.js';
import { logger } from '../../../utils/logger.js';
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
  type SkillManageAction,
} from './skill-types.js';
import {
  SkillReviewReadLedger,
  skillReadLedgerRegistry,
} from './skill-review-read-ledger.js';
import { ScopedToolRegistry } from '../subagent/ScopedToolRegistry.js';

/** Skill Review Agent 的固定工具上限：目录 → 读取 → 写入。 */
const BACKGROUND_SKILL_TOOL_NAMES = new Set(['skills_list', 'load_skill', 'skill_manage']);

/** 会修改既有 Skill 的动作；create 由运行时在成功后加入本任务范围。 */
const EXISTING_SKILL_MUTATION_ACTIONS: ReadonlySet<SkillManageAction> = new Set([
  'patch',
  'edit',
  'delete',
  'write_file',
  'remove_file',
]);

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
  /** 可选注入的读取账本；缺省时按当前 caller 创建并注册。 */
  readonly readLedger?: SkillReviewReadLedger;
  /** Curator 本轮允许修改的既有 Skill 名称；Review 不设置此范围。 */
  readonly allowedExistingSkillNames?: readonly string[];
}

/**
 * Skill Review Agent 的受限 ToolRegistry 视图。
 * 工具面固定为父工具集合与 skills_list/load_skill/skill_manage 的交集，
 * 所有调用继续经过共享 ToolGateway，但使用独立权限快照和 background/subagent caller。
 */
export class BackgroundSkillAgent implements ToolRegistryPort {
  private readonly permissionState: PermissionSessionState;
  private readonly caller: TrustedCallContext;
  private readonly parentToolNames: ReadonlySet<string>;
  private readonly isActive: () => boolean;
  private readonly onSkillMutation?: (result: BackgroundSkillMutationResult) => void;
  private readonly beforeSkillMutation?: () => void;
  private readonly readLedger: SkillReviewReadLedger;
  private readonly allowedExistingSkillNames?: Set<string>;
  /** 公共作用域注册表，统一承载 caller、子权限和 approvalAllowed=false。 */
  private readonly scopedRegistry: ScopedToolRegistry;

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
    // Curator 必须显式携带候选范围；缺失时使用空集合 fail-closed。
    this.allowedExistingSkillNames = callerIdPrefix === SKILL_CURATOR_CALLER_ID_PREFIX
      ? new Set(options.allowedExistingSkillNames ?? [])
      : undefined;
    // 一次隔离任务一个账本：绑定宿主验证的后台 caller，注册到内存注册表供授权适配器签发前置条件。
    this.readLedger = options.readLedger
      ?? new SkillReviewReadLedger(this.caller.caller.callerId);
    skillReadLedgerRegistry.register(this.readLedger);
    this.scopedRegistry = new ScopedToolRegistry({
      parent: parentRegistry,
      permissionState: this.permissionState,
      caller: this.caller,
      auditSource: 'background_skill_review',
      toolVisibility: name => this.isAllowedTool(name),
    });
  }

  /**
   * 返回父工具面内允许暴露给 Review 模型的三个工具定义。
   *
   * @returns skills_list/load_skill/skill_manage 与父工具面的交集
   */
  public async getTools(): Promise<unknown[]> {
    return this.scopedRegistry.getTools();
  }

  /**
   * 获取允许工具的元数据。
   *
   * @param name - 工具名
   * @returns 允许且父工具存在时的元数据
   */
  public getTool(name: string): ToolMetadata | undefined {
    return this.scopedRegistry.getTool(name);
  }

  /**
   * 使用受限安全上下文执行工具。
   *
   * @param functionName - 只能是 skills_list/load_skill/skill_manage
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
    if (functionName === 'skill_manage') {
      this.assertSkillMutationInScope(functionArgs);
    }

    const outcome = await this.scopedRegistry.callTool(
      functionName,
      structuredClone(functionArgs),
      _sessionContext,
      _interactionPort,
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
      },
    );
    if (functionName === 'skill_manage') {
      const mutation = parseSkillMutation(outcome.value, functionArgs);
      if (mutation) {
        // Curator 成功创建的 umbrella 可在同一任务后续调用中继续维护；暂存尚未落盘，不扩展范围。
        if (
          this.allowedExistingSkillNames
          && !outcome.cause
          && mutation.status === 'success'
          && mutation.action === 'create'
          && functionArgs.action === 'create'
          && mutation.name === functionArgs.name
        ) {
          this.allowedExistingSkillNames.add(mutation.name);
        }
        this.onSkillMutation?.(mutation);
      }
    } else if (functionName === 'load_skill' && !outcome.cause) {
      // 只在真实成功后记账：失败结果、取消或其他 Skill 不得产生读取凭证。
      // skills_list 只证明模型看过目录，不得满足先读后写要求，因此不进入记账分支。
      this.recordSkillLoad(functionArgs, outcome.value);
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
   * 共享父 ToolRegistry 的生命周期由 SessionManager 管理，此处不得关闭它；
   * 同时注销本次任务的读取账本，关闭后凭证不可复用。
   */
  public async close(): Promise<void> {
    await this.scopedRegistry.close();
    skillReadLedgerRegistry.unregister(this.caller.caller.callerId);
  }

  /** 判断工具是否同时属于固定上限和父工具面。 */
  private isAllowedTool(name: string): boolean {
    return BACKGROUND_SKILL_TOOL_NAMES.has(name) && this.parentToolNames.has(name);
  }

  /**
   * 强制 Curator 只能修改本轮候选或本轮已成功创建的 Skill。
   * Review 不设置候选集合，继续由既有 ownership 与读取凭证约束。
   *
   * @param input - skill_manage 原始参数
   */
  private assertSkillMutationInScope(input: Readonly<Record<string, unknown>>): void {
    if (!this.allowedExistingSkillNames) {
      return;
    }
    const action = input.action;
    const name = input.name;
    if (
      typeof action !== 'string'
      || typeof name !== 'string'
      || action === 'create'
      || !EXISTING_SKILL_MUTATION_ACTIONS.has(action as SkillManageAction)
    ) {
      return;
    }
    if (!this.allowedExistingSkillNames.has(name)) {
      throw new Error(`Curator 本轮候选范围不允许修改 Skill: ${name}`);
    }
  }

  /**
   * 记录一次真实成功的 load_skill 读取凭证。
   * 摘要只来自本次工具返回包络中的结构化 `content` 字段，不允许再次读取磁盘
   * 替换模型实际看到的版本；若统一输出层将折叠模型可见文本，则 fail-closed 不记录。
   *
   * @param functionArgs - load_skill 调用参数（name / 可选 file_path）
   * @param outcomeValue - 工具网关返回的真实结果包络
   */
  private recordSkillLoad(
    functionArgs: Readonly<Record<string, unknown>>,
    outcomeValue: unknown,
  ): void {
    const name = typeof functionArgs.name === 'string' ? functionArgs.name : undefined;
    if (!name) {
      return;
    }
    const filePath = typeof functionArgs.file_path === 'string'
      ? functionArgs.file_path
      : undefined;

    // 模型可见正文 = 工具返回包络的第一段 text（load_skill 的结构化 JSON 字符串）。
    const modelVisibleText = unwrapTextContent(outcomeValue);
    if (typeof modelVisibleText !== 'string') {
      logger.warn('[BackgroundSkillAgent] load_skill_credential_not_recorded', {
        component: 'background_skill_agent',
        event: 'load_skill_credential_not_recorded',
        reason: 'invalid_envelope',
        skill: name,
        filePath: filePath ?? null,
      });
      return;
    }
    if (!isToolOutcomeWithinQuota(this.getTool('load_skill'), outcomeValue)) {
      logger.warn('[BackgroundSkillAgent] load_skill_credential_not_recorded', {
        component: 'background_skill_agent',
        event: 'load_skill_credential_not_recorded',
        reason: 'model_visible_output_would_be_truncated',
        skill: name,
        filePath: filePath ?? null,
      });
      return;
    }

    // 解析结构化包络并校验 name/file 与调用参数一致，防止模型基于错配目标提交。
    let payload: unknown;
    try {
      payload = JSON.parse(modelVisibleText);
    } catch {
      logger.warn('[BackgroundSkillAgent] load_skill_credential_not_recorded', {
        component: 'background_skill_agent',
        event: 'load_skill_credential_not_recorded',
        reason: 'invalid_json_payload',
        skill: name,
        filePath: filePath ?? null,
      });
      return;
    }
    const record = this.verifySkillReadPayload(payload, name, filePath);
    if (!record) {
      logger.warn('[BackgroundSkillAgent] load_skill_credential_not_recorded', {
        component: 'background_skill_agent',
        event: 'load_skill_credential_not_recorded',
        reason: 'payload_field_mismatch',
        skill: name,
        filePath: filePath ?? null,
      });
      return;
    }
    // 只记录模型实际看到的 content 原文；解析失败、字段错配均不签发读取凭证。
    this.readLedger.recordLoad(record.name, record.filePath, record.content);
  }

  /**
   * 校验结构化 load_skill 包络与调用参数一致。
   * `file` 必须等于「SKILL.md 或规范化后的支持文件相对路径」，`content` 必须是字符串；
   * 任一不匹配返回 null，调用方 fail-closed。
   *
   * @param payload - 解析后的结果对象
   * @param name - 调用参数中的 Skill 名称
   * @param filePath - 调用参数中的可选支持文件路径
   * @returns 校验通过时返回记账所需的窄化字段；否则返回 null
   */
  private verifySkillReadPayload(
    payload: unknown,
    name: string,
    filePath: string | undefined,
  ): { name: string; filePath: string | undefined; content: string } | null {
    if (!isRecord(payload) || payload.name !== name) {
      return null;
    }
    // 未传 file_path 时工具返回 SKILL.md；传入时返回规范化相对路径。
    const expectedFile = filePath
      ? normalize(filePath).replace(/\\/g, '/')
      : 'SKILL.md';
    if (payload.file !== expectedFile) {
      return null;
    }
    const content = payload.content;
    if (typeof content !== 'string') {
      return null;
    }
    return { name, filePath, content };
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

/** 解包 CallToolResult 第一段 text 文本；无法解包时返回 undefined。 */
function unwrapTextContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    const first = value.content[0];
    if (isRecord(first) && typeof first.text === 'string') {
      return first.text;
    }
  }
  return undefined;
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
