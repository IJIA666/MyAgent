import type { NativeTool } from '../../tool-types.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import type { ToolAuthorizationAdapter, ToolAuthorizationBuildContext } from '../../../../ports/driven/tools/ToolAuthorizationAdapter.js';
import type { PermissionSessionState } from '../../../../core/domain/permissions/permission-session-state.js';
import type {
  ApprovalAction,
  PermissionRequest,
  SkillPermissionAnalysis,
} from '../../../../core/domain/permissions/permission-types.js';
import type { SkillLibrary } from '../../../../core/usecases/brain/skill-library.js';
import {
  SkillPendingStageError,
  type SkillPendingStore,
  type SkillWriteApprovalController,
} from '../../../../core/usecases/brain/skill-pending-store.js';
import {
  SKILL_ERR_READ_BEFORE_WRITE_REQUIRED,
  type SkillManageAction,
  type SkillManageRequest,
} from '../../../../core/usecases/brain/skill-types.js';
import { SkillManageAuthorizationAdapter } from '../../permissions/skill-tool-authorization.js';

/**
 * skill_manage 原生工具。
 * 提供六种独立动作维护 Skill 包，每次调用独立提交。
 */
export class SkillManageTool implements NativeTool {
  readonly securityCategory = 'write';

  readonly name = 'skill_manage';

  readonly definition = {
    type: "function" as const,
    function: {
      name: 'skill_manage',
      description: [
        '管理扩展技能（Skill）包。每次调用独立提交，不跨调用回滚。',
        '支持六种动作（action）：',
        '  - create: 创建新 Skill，提供 content（完整 SKILL.md，含 frontmatter），可选 category',
        '  - patch: 定点替换 Skill 内文本，oldString 默认要求文件中唯一匹配，replaceAll=true 时允许多处',
        '  - edit: 完整替换 SKILL.md',
        '  - delete: 删除 Skill。前台调用直接物理删除，',
        '  - write_file: 写入支持文件（references/templates/scripts/assets 下）',
        '  - remove_file: 删除支持文件',
        'SKILL.md 最大 100,000 字符，支持文件最大 1 MiB（UTF-8）。',
        '优先使用 patch 而不是 edit 来增量更新。',
      ].join('\n'),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "要执行的动作",
            enum: ['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file'],
          },
          name: {
            type: "string",
            description: "目标 Skill 名称（小写字母、数字、连字符，1-64 字符）",
          },
          content: {
            type: "string",
            description: "create/edit 时的完整 SKILL.md 内容（须含合法 frontmatter，max 100KB）",
          },
          category: {
            type: "string",
            description: "create 时可选的分类标签",
          },
          oldString: {
            type: "string",
            description: "patch 时的旧文本（默认要求文件中唯一匹配）",
          },
          newString: {
            type: "string",
            description: "patch/edit 时的替换文本",
          },
          replaceAll: {
            type: "boolean",
            description: "patch 时是否替换所有匹配（默认 false，false 时要求唯一匹配）",
          },
          filePath: {
            type: "string",
            description: "write_file/remove_file/patch 时的支持文件相对路径（references/templates/scripts/assets 下）",
          },
          fileContent: {
            type: "string",
            description: "write_file 时写入的支持文件内容（UTF-8，最大 1 MiB）",
          },
          absorbedInto: {
            type: "string",
            description: "delete 时后台归档的吸收目标 umbrella 名称（前台 delete 不需要）",
          },
        },
        required: ["action", "name"],
        additionalProperties: false,
      },
    },
  };

  private skillLibrary?: SkillLibrary;
  private readonly pendingStore?: SkillPendingStore;
  private readonly approvalController?: SkillWriteApprovalController;
  readonly authorizationAdapter: ToolAuthorizationAdapter;

  /**
   * @param skillLibrary - 可选的共享 SkillLibrary 实例（未注入时调用将返回错误）
   * @param pendingStore - 可选的 pending 仓储
   * @param approvalController - 当前进程共享的 writeApproval 开关
   */
  constructor(
    skillLibrary?: SkillLibrary,
    pendingStore?: SkillPendingStore,
    approvalController?: SkillWriteApprovalController,
  ) {
    this.skillLibrary = skillLibrary;
    this.pendingStore = pendingStore;
    this.approvalController = approvalController;
    // 无论 SkillLibrary 是否存在，都创建适配器以通过 ToolCatalog 的契约检查。
    // 未注入 SkillLibrary 时使用一个空操作适配器，执行时返回明确错误。
    this.authorizationAdapter = skillLibrary
      ? new SkillManageAuthorizationAdapter(skillLibrary)
      : createNullSkillManageAdapter();
  }

  /**
   * 执行一次 skill_manage 动作。
   *
   * @param args - 工具参数（action、name 等）
   * @param context - 工具执行上下文；包含宿主签发的权限分析
   * @param signal - 可选的上游取消信号
   * @returns JSON 字符串，包络 success/error/staged 状态
   */
  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext | SessionEventPort,
    signal?: AbortSignal,
  ): Promise<string> {
    const action = args.action;
    if (typeof action !== 'string' || !['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file'].includes(action)) {
      return JSON.stringify({
        status: 'error',
        action: String(action),
        name: typeof args.name === 'string' ? args.name : '',
        error: `无效 action: ${action}，必须为 create/patch/edit/delete/write_file/remove_file`,
      });
    }

    const name = args.name;
    if (typeof name !== 'string' || !name.trim()) {
      return JSON.stringify({
        status: 'error',
        action,
        name: '',
        error: 'name 必须是有效的非空字符串',
      });
    }

    const request = this.buildRequest(args, action as SkillManageAction, name.trim());

    const validationError = this.validateRequest(request);
    if (validationError) {
      return JSON.stringify({
        status: 'error',
        action: request.action,
        name: request.name,
        error: validationError,
      });
    }

    if (!this.skillLibrary) {
      return JSON.stringify({
        status: 'error',
        action: request.action,
        name: request.name,
        error: 'skill_manage 未注入 SkillLibrary，无法执行',
      });
    }

    const analysis = context && 'permissionAnalysis' in context
      ? context.permissionAnalysis
      : undefined;
    if (!isBoundSkillAnalysis(analysis, request)) {
      return JSON.stringify({
        status: 'error',
        action: request.action,
        name: request.name,
        error: 'skill_manage 缺少与本次输入绑定的受信权限分析，拒绝执行',
      });
    }

    // 后台调用（复盘/长期技能融合）必须携带读取账本签发的先读后写前置条件。
    // 前置条件只来自宿主内存账本，模型提交的 fingerprint/origin/bypass 字段不在
    // Function Calling schema 中，一律不得生效。
    if (analysis.origin === 'background_review' || analysis.origin === 'background_curator') {
      if (!isBoundMutationPrecondition(analysis, request)) {
        return JSON.stringify({
          status: 'error',
          action: request.action,
          name: request.name,
          errorCode: SKILL_ERR_READ_BEFORE_WRITE_REQUIRED,
          error: '后台修改前必须先通过 load_skill 读取准确目标，读取凭证不足',
        });
      }
    }

    if (analysis.pendingReplayId) {
      if (!this.pendingStore) {
        return JSON.stringify({
          status: 'error',
          action: request.action,
          name: request.name,
          error: 'pending 仓储未配置，无法批准重放',
        });
      }
      const replay = await this.pendingStore.validateReplay(
        analysis.pendingReplayId,
        request,
      );
      if (replay.status !== 'ready') {
        return JSON.stringify({
          status: 'error',
          action: request.action,
          name: request.name,
          error: replay.error,
        });
      }
      // validateReplay 提供即时反馈；SkillLibrary 会在同一写锁临界区内再次比较该 fingerprint，
      // 防止校验返回后、真正写入前目标被其他会话修改。
      const result = await this.skillLibrary.manage(
        request,
        replay.record.origin,
        undefined,
        {
          id: replay.record.id,
          baseFingerprint: replay.record.preview.baseFingerprint,
        },
        signal,
      );
      if (result.status === 'success') {
        this.pendingStore.discard(replay.record.id);
      }
      return JSON.stringify(result);
    }

    if (this.approvalController?.isEnabled()) {
      if (!this.pendingStore) {
        return JSON.stringify({
          status: 'error',
          action: request.action,
          name: request.name,
          error: 'writeApproval 已开启但 pending 仓储未配置',
        });
      }
      try {
        const pending = await this.pendingStore.stage(
          request,
          analysis.origin,
          analysis.mutationPrecondition,
          signal,
        );
        return JSON.stringify({
          status: 'staged',
          action: request.action,
          name: request.name,
          pendingId: pending.id,
          summary: pending.summary,
        });
      } catch (error) {
        return JSON.stringify({
          status: 'error',
          action: request.action,
          name: request.name,
          ...(error instanceof SkillPendingStageError && error.errorCode
            ? { errorCode: error.errorCode }
            : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result = await this.skillLibrary.manage(
      request,
      analysis.origin,
      analysis.mutationPrecondition,
      undefined,
      signal,
    );
    return JSON.stringify(result);
  }

  /**
   * 工具级权限检查。非 delete 返回 allow 候选，delete 始终返回 destructive ask 候选。
   *
   * @param args - 原始工具参数
   * @returns 权限候选
   */
  checkPermissions(
    args: Record<string, unknown>,
  ): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const action = args.action;
    const name = args.name;
    if (
      typeof action !== 'string'
      || !['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file'].includes(action)
      || typeof name !== 'string'
      || name.trim().length === 0
    ) {
      return {
        kind: 'deny',
        decisionCode: 'skill_manage_invalid_input',
        decisionReason: 'skill_manage action/name 输入非法',
      };
    }
    if (action === 'delete') {
      return {
        kind: 'ask',
        decisionCode: 'skill_manage_delete_requires_approval',
        message: `删除 Skill "${name.trim()}" 需要确认`,
        decisionReason: 'skill_manage delete 是破坏性操作',
      };
    }
    return { kind: 'allow', decisionReason: 'skill_manage 由权限管线进一步评估' };
  }

  /** 从模型参数构造不含 caller/origin 的领域请求。 */
  private buildRequest(
    args: Record<string, unknown>,
    action: SkillManageAction,
    name: string,
  ): SkillManageRequest {
    return {
      name,
      action,
      content: typeof args.content === 'string' ? args.content : undefined,
      category: typeof args.category === 'string' ? args.category : undefined,
      oldString: typeof args.oldString === 'string' ? args.oldString : undefined,
      newString: typeof args.newString === 'string' ? args.newString : undefined,
      replaceAll: typeof args.replaceAll === 'boolean' ? args.replaceAll : undefined,
      filePath: typeof args.filePath === 'string' ? args.filePath : undefined,
      fileContent: typeof args.fileContent === 'string' ? args.fileContent : undefined,
      absorbedInto: typeof args.absorbedInto === 'string' ? args.absorbedInto : undefined,
    };
  }

  /** 请求参数基础校验。 */
  private validateRequest(request: SkillManageRequest): string | null {
    const { action, name, content, filePath, oldString, newString, fileContent } = request;

    if (!name) return 'name 不能为空';
    if (name.length > 64) return 'name 长度不能超过 64 字符';

    switch (action) {
      case 'create':
        if (!content) return 'create 需要提供 content';
        break;
      case 'patch':
        if (!oldString) return 'patch 需要提供 oldString';
        if (newString === undefined) return 'patch 需要提供 newString';
        break;
      case 'edit':
        if (!content) return 'edit 需要提供 content';
        if (filePath !== undefined) return 'edit 只能完整替换 SKILL.md，不接受 filePath';
        break;
      case 'delete':
        // absorbedInto 可选（前台不需要）
        break;
      case 'write_file':
        if (!filePath) return 'write_file 需要提供 filePath';
        if (fileContent === undefined) return 'write_file 需要提供 fileContent';
        break;
      case 'remove_file':
        if (!filePath) return 'remove_file 需要提供 filePath';
        break;
      default:
        return `未知动作: ${action}`;
    }
    return null;
  }
}

/** 验证权限分析与本次模型输入逐字段绑定。 */
function isBoundSkillAnalysis(
  value: unknown,
  request: SkillManageRequest,
): value is SkillPermissionAnalysis {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const analysis = value as Partial<SkillPermissionAnalysis>;
  return (
    analysis.kind === 'skill-manage'
    && analysis.action === request.action
    && analysis.name === request.name
    && (
      analysis.origin === 'foreground'
      || analysis.origin === 'background_review'
      || analysis.origin === 'background_curator'
    )
    && typeof analysis.callerId === 'string'
    && analysis.callerId.length > 0
  );
}

/**
 * 验证后台调用携带的写入前置条件与本次分析、请求逐字段绑定。
 * 前置条件必须由宿主账本按当前 caller 签发，模型无法构造该对象。
 *
 * @param analysis - 已绑定的权限分析
 * @param request - 本次 Skill 管理请求
 * @returns 前置条件存在且绑定一致时返回 true
 */
function isBoundMutationPrecondition(
  analysis: SkillPermissionAnalysis,
  request: SkillManageRequest,
): boolean {
  const precondition = analysis.mutationPrecondition;
  if (!precondition) {
    return false;
  }
  return precondition.callerId === analysis.callerId
    && precondition.action === analysis.action
    && precondition.name === analysis.name
    && precondition.filePath === (request.filePath ?? null);
}

/**
 * 创建空操作权限适配器，用于 SkillLibrary 未注入时的注册占位。
 * 执行时所有请求返回 deny。
 */
function createNullSkillManageAdapter(): ToolAuthorizationAdapter {
  return {
    runtimeToolName: 'skill_manage',
    permissionIdentity: 'SkillManage',
    adapterVersion: '1.0.0-null',
    buildPermissionRequest(
      _input: Readonly<Record<string, unknown>>,
      _context?: ToolAuthorizationBuildContext,
    ): PermissionRequest {
      return {
        runtimeToolName: 'skill_manage',
        permissionIdentity: 'SkillManage',
        normalizedArgs: Object.freeze({}),
        isEditOperation: false,
        resourceEvidences: Object.freeze([]),
        approvalOptions: Object.freeze([]),
        adapterVersion: '1.0.0-null',
      };
    },
    buildApprovalOptions(
      _request: PermissionRequest,
      _state: PermissionSessionState,
    ): readonly ApprovalAction[] {
      return Object.freeze([]);
    },
    isOrdinaryEdit(_request: PermissionRequest): boolean {
      return false;
    },
  };
}
