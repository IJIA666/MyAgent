import type {
  ToolAuthorizationAdapter,
  ToolAuthorizationBuildContext,
} from '../../../ports/driven/tools/ToolAuthorizationAdapter.js';
import type {
  PermissionRequest,
  ResourceEvidence,
  FileResourceEvidence,
  DirectoryScopeEvidence,
  ApprovalAction,
  SkillPermissionAnalysis,
  SkillMutationPrecondition,
} from '../../../core/domain/permissions/permission-types.js';
import type { PermissionSessionState } from '../../../core/domain/permissions/permission-session-state.js';
import type { SkillLibrary } from '../../../core/usecases/brain/skill-library.js';
import {
  SKILL_CURATOR_CALLER_ID_PREFIX,
  SKILL_PENDING_APPROVAL_CALLER_PREFIX,
  SKILL_REVIEW_CALLER_ID_PREFIX,
  type SkillManageAction,
  type SkillWriteOrigin,
} from '../../../core/usecases/brain/skill-types.js';
import { skillReadLedgerRegistry } from '../../../core/usecases/brain/skill-review-read-ledger.js';

/** 可用于 Plan 模式判断的操作分类。 */
type SkillOperationClass = 'read' | 'edit' | 'delete';

/**
 * skill_manage 工具的权限适配器。
 * 根据 action 和调用者身份派生 origin，生成资源证据。
 */
export class SkillManageAuthorizationAdapter implements ToolAuthorizationAdapter {
  readonly runtimeToolName = 'skill_manage';
  readonly permissionIdentity = 'SkillManage' as const;
  readonly adapterVersion = '1.0.0';

  private readonly skillLibrary: SkillLibrary;

  constructor(skillLibrary: SkillLibrary) {
    this.skillLibrary = skillLibrary;
  }

  /**
   * 将原始工具输入规范化为权限请求。
   *
   * @param input - 原始工具输入参数
   * @param context - 可选的构建上下文（含调用者信息）
   * @returns 标准化 PermissionRequest
   */
  buildPermissionRequest(
    input: Readonly<Record<string, unknown>>,
    context?: ToolAuthorizationBuildContext,
  ): PermissionRequest {
    const action = input.action as SkillManageAction | undefined;
    const name = input.name as string | undefined;

    const resources = this.buildResourceEvidence(action, name, input, context);
    const operationClass = this.classifyOperation(action);
    const analysis = this.buildAnalysis(action, name, input, context);

    const isEditOperation = operationClass === 'edit';
    const isDelete = operationClass === 'delete';

    return {
      runtimeToolName: 'skill_manage',
      permissionIdentity: 'SkillManage',
      normalizedArgs: Object.freeze({ ...input }),
      isEditOperation,
      resourceEvidences: Object.freeze(resources),
      approvalOptions: isDelete
        ? [
            { type: 'allowOnce' },
            { type: 'deny' },
          ]
        : [
            { type: 'allowOnce' },
            { type: 'deny' },
          ],
      ...(analysis ? { analysis } : {}),
      adapterVersion: this.adapterVersion,
    };
  }

  /**
   * 构建可用的审批动作。
   *
   * @param request - 已构建的 PermissionRequest
   * @param _state - 当前会话权限状态
   * @returns 当前可选的审批动作列表
   */
  buildApprovalOptions(
    request: PermissionRequest,
    _state: PermissionSessionState,
  ): readonly ApprovalAction[] {
    // delete 操作只返回 allowOnce 和 deny
    if (!request.isEditOperation) {
      return [
        { type: 'allowOnce' },
        { type: 'deny' },
      ];
    }
    // 编辑操作提供更多选项
    return [
      { type: 'allowOnce' },
      { type: 'deny' },
    ];
  }

  /**
   * 判断本次调用是否应归类为普通 Edit 操作。
   * create/patch/edit/write_file/remove_file 属于编辑，delete 不属于。
   *
   * @param request - 已构建的 PermissionRequest
   * @returns 编辑操作返回 true
   */
  isOrdinaryEdit(request: PermissionRequest): boolean {
    return request.isEditOperation;
  }

  /** 根据 action 分类操作类别。 */
  private classifyOperation(action?: SkillManageAction): SkillOperationClass {
    switch (action) {
      case 'create':
      case 'patch':
      case 'edit':
      case 'write_file':
      case 'remove_file':
        return 'edit';
      case 'delete':
        return 'delete';
      default:
        return 'edit';
    }
  }

  /** 从受信 caller 派生执行期 origin；无法证明身份时不生成分析。 */
  private buildAnalysis(
    action: SkillManageAction | undefined,
    name: string | undefined,
    input: Record<string, unknown>,
    context?: ToolAuthorizationBuildContext,
  ): SkillPermissionAnalysis | undefined {
    if (!action || !name || !context?.caller.hostVerified) {
      return undefined;
    }
    const origin = deriveSkillOrigin(context.caller);
    if (!origin) {
      return undefined;
    }
    const callerId = context.caller.caller.callerId;
    // 后台 caller 从本次任务的读取账本签发先读后写前置条件；
    // 凭证不足或账本不存在时返回 undefined，由执行期对后台调用 fail-closed。
    const mutationPrecondition = origin === 'foreground'
      ? undefined
      : this.buildMutationPrecondition(callerId, action, input);
    return Object.freeze({
      kind: 'skill-manage',
      action,
      name,
      origin,
      callerId,
      ...extractPendingReplayId(callerId),
      ...(mutationPrecondition ? { mutationPrecondition } : {}),
    });
  }

  /** 从账本按当前动作签发前置条件；未读取准确目标时返回 undefined。 */
  private buildMutationPrecondition(
    callerId: string,
    action: SkillManageAction,
    input: Record<string, unknown>,
  ): SkillMutationPrecondition | undefined {
    const ledger = skillReadLedgerRegistry.get(callerId);
    if (!ledger) {
      return undefined;
    }
    const name = typeof input.name === 'string' ? input.name : '';
    const filePath = typeof input.filePath === 'string' ? input.filePath : undefined;
    const absorbedInto = typeof input.absorbedInto === 'string'
      ? input.absorbedInto
      : undefined;
    return ledger.buildPrecondition(callerId, action, name, filePath, absorbedInto)
      ?? undefined;
  }

  /** 构建资源证据。 */
  private buildResourceEvidence(
    action: SkillManageAction | undefined,
    name: string | undefined,
    input: Record<string, unknown>,
    context?: ToolAuthorizationBuildContext,
  ): ResourceEvidence[] {
    const evidences: ResourceEvidence[] = [];
    if (!name) return evidences;

    const filePath = input.filePath as string | undefined;
    const skillDir = this.skillLibrary.resolveTargetPath(name);

    if (action === 'write_file' || action === 'remove_file' || (action === 'patch' && filePath)) {
      const targetPath = filePath
        ? this.skillLibrary.resolveTargetPath(name, filePath)
        : skillDir;
      evidences.push({
        kind: 'file',
        operation: action === 'remove_file' ? 'delete' : 'write',
        rawExpression: targetPath,
        canonicalPath: targetPath,
        scope: 'external',
        sourceNodeId: 'skill_manage',
        protected: false,
        provenance: 'tool-analyzed',
        channelTrust: context?.caller.caller.channelTrust ?? 'remote',
      } satisfies FileResourceEvidence);
    } else {
      evidences.push({
        kind: 'directory-scope',
        operation: action === 'delete' ? 'delete' : 'write',
        rawExpression: skillDir,
        canonicalPath: skillDir,
        scope: 'external',
        sourceNodeId: 'skill_manage',
        protected: false,
        provenance: 'tool-analyzed',
        channelTrust: context?.caller.caller.channelTrust ?? 'remote',
      } satisfies DirectoryScopeEvidence);
    }
    return evidences;
  }
}

/** 从宿主专用 callerId 提取 pending UUID，普通 caller 不返回字段。 */
function extractPendingReplayId(callerId: string): { pendingReplayId?: string } {
  const prefix = `${SKILL_PENDING_APPROVAL_CALLER_PREFIX}:`;
  if (!callerId.startsWith(prefix)) {
    return {};
  }
  const pendingReplayId = callerId.slice(prefix.length);
  return /^[0-9a-f-]{36}$/i.test(pendingReplayId)
    ? { pendingReplayId }
    : {};
}

/** 根据宿主验证 caller 的稳定身份派生 Skill 写入 origin。 */
function deriveSkillOrigin(
  caller: ToolAuthorizationBuildContext['caller'],
): SkillWriteOrigin | undefined {
  if (caller.isLocalInteractive && caller.caller.channelTrust === 'interactive') {
    return 'foreground';
  }
  if (
    caller.caller.channelTrust !== 'background'
    || caller.caller.audience !== 'subagent'
  ) {
    return undefined;
  }
  if (caller.caller.callerId.startsWith(SKILL_REVIEW_CALLER_ID_PREFIX)) {
    return 'background_review';
  }
  if (caller.caller.callerId.startsWith(SKILL_CURATOR_CALLER_ID_PREFIX)) {
    return 'background_curator';
  }
  return undefined;
}

/**
 * load_skill 工具的权限适配器（只读）。
 */
export class LoadSkillAuthorizationAdapter implements ToolAuthorizationAdapter {
  readonly runtimeToolName = 'load_skill';
  readonly permissionIdentity = 'FileRead' as const;
  readonly adapterVersion = '1.0.0';

  /**
   * 构建权限请求（只读）。
   *
   * @param input - 原始工具输入参数
   * @param _context - 可选的构建上下文
   * @returns 只读权限请求
   */
  buildPermissionRequest(
    input: Readonly<Record<string, unknown>>,
    _context?: ToolAuthorizationBuildContext,
  ): PermissionRequest {
    return {
      runtimeToolName: 'load_skill',
      permissionIdentity: 'FileRead',
      normalizedArgs: Object.freeze({ ...input }),
      isEditOperation: false,
      resourceEvidences: Object.freeze([]),
      approvalOptions: [
        { type: 'allowOnce' },
        { type: 'deny' },
      ],
      adapterVersion: this.adapterVersion,
    };
  }

  /**
   * 构建审批动作。
   *
   * @param _request - 已构建的 PermissionRequest
   * @param _state - 当前会话权限状态
   * @returns 审批选项
   */
  buildApprovalOptions(
    _request: PermissionRequest,
    _state: PermissionSessionState,
  ): readonly ApprovalAction[] {
    return [
      { type: 'allowOnce' },
      { type: 'deny' },
    ];
  }

  /**
   * load_skill 不是编辑操作。
   *
   * @returns false
   */
  isOrdinaryEdit(_request: PermissionRequest): boolean {
    return false;
  }
}
