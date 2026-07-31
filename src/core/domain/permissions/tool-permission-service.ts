import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import type {
  PermissionMode,
  PermissionDecision,
  PermissionDecisionSource,
  PermissionRule,
  PermissionRuleSource,
  ToolPermissionEvidence,
  ToolPermissionCheckResult,
  ResourceEvidence,
  PermissionRequest,
  PermissionIdentity,
} from './permission-types.js';
import type { PermissionSessionState } from './permission-session-state.js';
import { PermissionRuleStore } from './rule-store.js';
import { checkProtectedResource } from './protected-resource-policy.js';
import {
  UNTRUSTED_CALLER,
  type TrustedCallContext,
} from './trusted-call-context.js';
import { ExecutionPlan } from './execution-plan.js';
import {
  ExecutionGrantService,
  type ExecutionGrant,
} from './execution-grant-service.js';

// ── 工具 checkPermissions 端口 ──

/**
 * 工具 `checkPermissions` 的输入上下文。
 */
export interface ToolExecutionContext {
  /** 当前的工具调用参数 */
  args: Record<string, unknown>;
  /** 当前工作目录 */
  cwd?: string;
}

/**
 * 工具 `checkPermissions` 端口契约。
 * 每个工具必须实现此接口，返回工具层级的安全检查结果。
 * 工具不得返回最终决策，最终决策由 ToolPermissionService 产生。
 */
export interface ToolPermissionChecker {
  /**
   * 执行工具内部的安全检查。
   *
   * @param input - 工具调用输入
   * @param context - 执行上下文
   * @returns 工具内部检查结果（allow/ask/deny/passthrough）
   */
  checkPermissions(
    input: ToolExecutionContext,
    context: { mode: PermissionMode; rules: PermissionRuleStore },
  ): Promise<ToolPermissionCheckResult> | ToolPermissionCheckResult;
}

/**
 * 正式权限请求的宿主上下文。
 * 工具候选只提供工具语义，caller 身份与会话状态必须由宿主注入。
 */
export interface PermissionRequestContext {
  /** 工具自身已经完成的一次安全分析结果。 */
  readonly toolResult?: ToolPermissionCheckResult;
  /** 经宿主验证的调用者；缺失时按未验证远程调用处理。 */
  readonly caller?: TrustedCallContext;
}

/** 规则匹配候选的类型。 */
type RuleCandidateKind = 'full' | 'subcommand' | 'resource' | 'operation';

/** 一条可供显式权限规则匹配的结构化候选。 */
interface RuleMatchCandidate {
  /** 候选内容。 */
  readonly content?: string;
  /** 候选来自完整调用、子命令、资源还是操作类别。 */
  readonly kind: RuleCandidateKind;
  /** 对应的稳定证据标识。 */
  readonly evidenceId: string;
}

/** 一次规则与结构化候选的命中结果。 */
interface MatchedPermissionRule {
  /** 命中的权限规则。 */
  readonly rule: PermissionRule;
  /** 命中的候选。 */
  readonly candidate: RuleMatchCandidate;
}

/** 不可伪造的内部执行上下文，证明调用已通过权限检查 */
export interface AuthorizedExecutionContext {
  /** 执行上下文的唯一标记，用于防伪造 */
  readonly nonce: string;
  /** 工具名称 */
  readonly toolName: string;
  /** 工具调用参数 */
  readonly args: Record<string, unknown>;
  /** 与授权决定绑定的不可变执行计划。 */
  readonly plan: ExecutionPlan;
  /** 当前权限服务为该计划签发的一次性 grant。 */
  readonly grant: ExecutionGrant;
  /** 权限决策信息 */
  readonly decision: Pick<PermissionDecision, 'kind'> & { decisionReason?: string };
  /** 权限阶段生成的只读证据。 */
  readonly evidence?: ToolPermissionEvidence;
  /** 权限阶段生成并绑定到获批输入的工具专用分析结果。 */
  readonly analysis?: unknown;
}

// ── ToolPermissionService ──

/**
 * 统一工具权限服务选项。
 */
export interface ToolPermissionServiceOptions {
  /** 规则存储实例 */
  ruleStore: PermissionRuleStore;
  /** 可选的一次性 grant 服务，主要用于组合根与测试注入。 */
  grantService?: ExecutionGrantService;
}

/**
 * 统一工具权限服务。
 *
 * 执行顺序（固定）：
 * 1. 工具分析并产生 evidence；不可绕过检查可直接 deny
 * 2. 显式规则按 deny → ask → allow 匹配完整调用、子命令与资源
 * 3. 无显式规则时，根据 evidence 产生内置基线
 * 4. PermissionMode 基于稳定来源和 evidence 做最终转换
 */
export class ToolPermissionService {
  private readonly ruleStore: PermissionRuleStore;
  /** 当前权限服务唯一的一次性执行 grant 签发器。 */
  private readonly grantService: ExecutionGrantService;
  /** 仅登记由本服务创建的上下文，阻止调用方伪造授权凭据。 */
  private readonly issuedContexts = new WeakSet<object>();
  /** 防止同一授权上下文被 tail call 重放。 */
  private readonly consumedContexts = new WeakSet<object>();

  constructor(options: ToolPermissionServiceOptions) {
    this.ruleStore = options.ruleStore;
    this.grantService = options.grantService ?? new ExecutionGrantService();
  }

  /**
   * 执行一次工具调用的完整权限检查。
   *
   * @param toolName - 工具名称
   * @param args - 工具调用参数
   * @param mode - 当前权限模式
   * @param toolChecker - 可选的工具 checkPermissions 实现
   * @param context - 额外的执行上下文与当前会话规则视图
   * @returns 最终的权限决策
   */
  async checkPermissions(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionMode,
    toolChecker?: ToolPermissionChecker,
    context?: { cwd?: string; ruleStore?: PermissionRuleStore },
  ): Promise<PermissionDecision> {
    // 每次调用固定使用所属会话的规则视图；无会话时才使用构造期受限仓库。
    const ruleStore = context?.ruleStore ?? this.ruleStore;
    // 工具检查只执行一次，优先取得结构化证据与不可绕过结果。
    let toolResult: ToolPermissionCheckResult = { kind: 'passthrough' };
    if (toolChecker) {
      toolResult = await toolChecker.checkPermissions(
        { args, cwd: context?.cwd },
        { mode, rules: ruleStore },
      );
    }
    const shellCandidate = isShellPermissionCandidate(toolName, toolResult);

    // 工具 deny 只表示输入契约失败、完整性失败或工具硬红线，任何规则和模式都不能覆盖。
    if (toolResult.kind === 'deny') {
      const matchedRule = toolResult.matchedRule;
      return {
        kind: 'deny',
        decisionReason: toolResult.decisionReason,
        evidence: toolResult.evidence,
        decisionCode: toolResult.decisionCode,
        ruleSuggestions: toolResult.ruleSuggestions,
        analysis: toolResult.analysis,
        decisionSource: matchedRule ? getRuleDecisionSource(matchedRule.source) : 'invariant',
        matchedRule,
        matchedEvidenceIds: collectEvidenceIds(toolResult.evidence),
        overridable: false,
      };
    }

    // 非 Shell 工具仍保留通用 hardline 兜底；Shell 必须以专属候选结果为唯一决定源。
    if (!shellCandidate && toolResult.evidence?.sideEffect === 'hardline') {
      return {
        kind: 'deny',
        decisionReason: toolResult.evidence.riskReason || '命令未通过不可绕过安全检查',
        evidence: toolResult.evidence,
        decisionCode: toolResult.decisionCode,
        ruleSuggestions: toolResult.ruleSuggestions,
        analysis: toolResult.analysis,
        decisionSource: 'invariant',
        matchedEvidenceIds: collectEvidenceIds(toolResult.evidence),
        overridable: false,
      };
    }

    // 显式用户规则高于普通工具建议；deny 和 ask 仍高于 allow。
    const ruleDecision = shellCandidate
      ? this.evaluateBareToolRule(toolName, ruleStore, toolResult.evidence)
      : this.evaluateExplicitRules(toolName, args, ruleStore, toolResult.evidence);
    const baselineDecision = ruleDecision ?? this.createBuiltInBaseline(toolName, toolResult);
    const candidateDecision = attachToolMetadata(baselineDecision, toolResult);
    return this.applyPermissionMode(candidateDecision, mode, toolName, args);
  }

  /**
   * 基于工具适配器产生的 PermissionRequest 执行权限检查。
   * 使用适配器提供的稳定权限身份取代字符串猜测。
   *
   * @param request - 工具适配器产生的标准化权限请求
   * @param state - 当前会话权限状态
   * @returns 最终权限决策
   */
  async checkRequest(
    request: PermissionRequest,
    state: PermissionSessionState,
    context: PermissionRequestContext = {},
  ): Promise<PermissionDecision> {
    const mode = state.getMode();
    const ruleStore = state.getRuleStore();
    const { runtimeToolName, normalizedArgs, permissionIdentity, isEditOperation: isEdit } = request;
    const caller = context.caller ?? UNTRUSTED_CALLER;
    const isAuthorizedEditScope = isEdit && isRequestWithinEditScope(request, state);
    const toolResult = bindRequestAnalysis(context.toolResult, request.analysis);

    // managed/trusted-user 资源上限必须先于 caller、普通规则、模式和 memory 特例。
    const protectedDecision = evaluateProtectedRequest(request);
    if (protectedDecision) {
      return protectedDecision;
    }

    // 未经宿主验证或来自 remote 渠道的 caller 不得借用本地会话 id、规则或审批。
    if (!caller.hostVerified || caller.caller.channelTrust === 'remote') {
      return {
        kind: 'ask',
        message: `未验证调用者请求执行 "${runtimeToolName}"`,
        decisionReason: '调用者身份未通过本地宿主验证',
        evidence: createRequestEvidence(request),
        decisionSource: 'invariant',
        matchedEvidenceIds: request.resourceEvidences.map(createResourceEvidenceId),
        overridable: false,
      };
    }

    // 工具硬拒绝代表输入或分析不完整，任何规则与模式都不能覆盖。
    if (toolResult?.kind === 'deny') {
      const deniedToolResult = attachRequestResources(toolResult, request);
      return {
        kind: 'deny',
        decisionReason: deniedToolResult.decisionReason,
        evidence: deniedToolResult.evidence,
        decisionCode: deniedToolResult.decisionCode,
        analysis: deniedToolResult.analysis,
        decisionSource: 'invariant',
        matchedEvidenceIds: request.resourceEvidences.map(createResourceEvidenceId),
        overridable: false,
      };
    }

    // 显式规则优先
    const requestEvidence = createRequestEvidence(request);
    const ruleDecision = this.evaluateExplicitRules(
      runtimeToolName,
      normalizedArgs as Record<string, unknown>,
      ruleStore,
      requestEvidence,
    );
    if (ruleDecision) {
      return this.applyRequestMode(
        ruleDecision,
        mode,
        runtimeToolName,
        isAuthorizedEditScope,
        permissionIdentity,
        toolResult,
      );
    }

    // 默认 memory 等工具专属内置候选在显式规则之后生效。
    if (
      toolResult
      && toolResult.kind !== 'passthrough'
    ) {
      const requestToolResult = attachRequestResources(toolResult, request);
      const toolDecision = attachToolMetadata(
        this.createBuiltInBaseline(runtimeToolName, requestToolResult),
        requestToolResult,
      );
      return this.applyRequestMode(
        toolDecision,
        mode,
        runtimeToolName,
        isAuthorizedEditScope,
        permissionIdentity,
        toolResult,
      );
    }

    // 没有命中规则时，根据权限身份产生基线
    const baselineDecision = withBoundAnalysis(
      this.createPermissionBaseline(permissionIdentity, runtimeToolName, request),
      request.analysis,
    );
    return this.applyRequestMode(
      baselineDecision,
      mode,
      runtimeToolName,
      isAuthorizedEditScope,
      permissionIdentity,
      toolResult,
    );
  }

  /**
   * 根据 PermissionIdentity 创建内置基线决策。
   *
   * @param identity - 稳定权限身份
   * @param toolName - 运行时工具名
   * @param request - 适配器提供的权限请求
   * @returns 内置基线决策
   */
  private createPermissionBaseline(
    identity: PermissionIdentity,
    toolName: string,
    _request: PermissionRequest,
  ): PermissionDecision {
    const readIdentities: PermissionIdentity[] = ['FileRead'];
    if (readIdentities.includes(identity)) {
      return {
        kind: 'allow',
        decisionReason: `适配器标识 "${identity}" 为只读操作`,
        decisionSource: 'builtInBaseline',
        matchedEvidenceIds: [],
        overridable: true,
      };
    }

    return {
      kind: 'ask',
      message: `工具 "${toolName}" (${identity}) 需要权限确认`,
      decisionReason: `适配器标识 "${identity}" 未被规则覆盖`,
      decisionSource: 'builtInBaseline',
      matchedEvidenceIds: [],
      overridable: true,
    };
  }

  /**
   * 基于 mode 和适配器身份的最终模式转换。
   *
   * @param decision - 待处理的决策
   * @param mode - 当前模式
   * @param toolName - 运行时工具名
   * @param isEdit - 是否为普通编辑操作
   * @param identity - 稳定权限身份
   * @param toolResult - 工具对当前输入完成的安全分析结果
   * @returns 最终决策
   */
  private async applyRequestMode(
    decision: PermissionDecision,
    mode: PermissionMode,
    toolName: string,
    isEdit: boolean,
    identity: PermissionIdentity,
    toolResult: ToolPermissionCheckResult | undefined,
  ): Promise<PermissionDecision> {
    const currentDecision = withBoundAnalysis(decision, toolResult?.analysis);
    if (currentDecision.kind === 'deny' || !currentDecision.overridable) {
      return currentDecision;
    }

    switch (mode) {
      case 'acceptEdits': {
        if (isEdit) {
          return {
            kind: 'allow',
            decisionReason: `acceptEdits: "${toolName}" 为普通编辑操作 (${identity})`,
            evidence: currentDecision.evidence,
            analysis: currentDecision.analysis,
            decisionSource: 'mode',
            matchedEvidenceIds: currentDecision.matchedEvidenceIds,
            overridable: false,
          };
        }
        return currentDecision;
      }
      case 'plan': {
        const isVerifiedReadOnlyShell = (
          identity === 'ShellPowerShell'
          || identity === 'ShellBash'
        )
          && toolResult?.kind === 'allow'
          && toolResult.evidence?.sideEffect === 'read';
        if (identity !== 'FileRead' && !isVerifiedReadOnlyShell) {
          return {
            kind: 'deny',
            decisionReason: `plan 模式不允许 "${toolName}" (${identity})`,
            decisionSource: 'mode',
            matchedEvidenceIds: currentDecision.matchedEvidenceIds,
            overridable: false,
          };
        }
        return currentDecision;
      }
      case 'dontAsk': {
        if (currentDecision.kind === 'ask') {
          return {
            kind: 'deny',
            decisionReason: `dontAsk 模式: "${toolName}" 需要权限但不允许交互`,
            decisionSource: 'mode',
            matchedEvidenceIds: currentDecision.matchedEvidenceIds,
            overridable: false,
          };
        }
        return currentDecision;
      }
      case 'bypassPermissions': {
        if (currentDecision.kind === 'ask') {
          return {
            kind: 'allow',
            decisionReason: `bypassPermissions 模式: "${toolName}" 已绕过询问`,
            analysis: currentDecision.analysis,
            decisionSource: 'mode',
            matchedEvidenceIds: currentDecision.matchedEvidenceIds,
            overridable: false,
          };
        }
        return currentDecision;
      }
      default:
        return currentDecision;
    }
  }

  /**
   * 生成不可伪造的已授权执行上下文。
   * 在权限决策为 allow 后调用，为 ToolExecutor 提供授权证明。
   *
   * @param toolName - 工具名称
   * @param args - 工具调用参数
   * @param decision - 权限决策
   * @param plan - 已由网关基于当前状态创建的不可变执行计划
   * @returns 不可伪造的执行上下文
   */
  createAuthorizedContext(
    toolName: string,
    args: Record<string, unknown>,
    decision: PermissionDecision,
    plan: ExecutionPlan,
  ): AuthorizedExecutionContext | null {
    if (decision.kind !== 'allow') {
      return null;
    }
    if (plan.runtimeToolName !== toolName) {
      throw new Error('执行计划与工具名称不匹配');
    }
    const context: AuthorizedExecutionContext = Object.freeze({
      nonce: generateNonce(),
      toolName,
      args: plan.normalizedArgs as Record<string, unknown>,
      plan,
      grant: this.grantService.issueGrant(plan),
      decision: { kind: 'allow', decisionReason: decision.decisionReason },
      evidence: decision.evidence,
      analysis: decision.analysis,
    });
    this.issuedContexts.add(context);
    return context;
  }

  /**
   * 消费一次性授权上下文。
   *
   * @param context - 待消费的内部执行上下文
   * @returns 上下文是否由本服务签发且尚未使用
   */
  consumeAuthorizedContext(context: AuthorizedExecutionContext): boolean {
    if (!this.issuedContexts.has(context) || this.consumedContexts.has(context)) {
      return false;
    }
    const verification = this.grantService.consumeGrant(context.grant, context.plan);
    if (!verification.valid) {
      return false;
    }
    this.consumedContexts.add(context);
    return true;
  }

  /**
   * 验证上下文是否由当前权限服务签发。
   *
   * @param context - 待验证的内部上下文
   * @returns 是否为当前服务签发的上下文
   */
  isIssuedContext(context: AuthorizedExecutionContext): boolean {
    return this.issuedContexts.has(context);
  }

  // ── 显式规则评估 ──

  /** 对 Shell 候选结果只应用裸工具规则，内容规则已由专用分析器处理。 */
  private evaluateBareToolRule(
    toolName: string,
    ruleStore: PermissionRuleStore,
    evidence?: ToolPermissionEvidence,
  ): PermissionDecision | undefined {
    const rule = ruleStore.getMatchingRules(toolName)
      .find(candidate => candidate.ruleValue.ruleContent === undefined);
    if (!rule) {
      return undefined;
    }
    const decisionSource = getRuleDecisionSource(rule.source);
    const matchedEvidenceIds = collectEvidenceIds(evidence);
    if (rule.ruleBehavior === 'deny') {
      return {
        kind: 'deny',
        decisionReason: `规则 (${rule.source}): ${toolName} 被拒绝`,
        evidence,
        decisionSource,
        matchedRule: rule,
        matchedEvidenceIds,
        overridable: false,
      };
    }
    if (rule.ruleBehavior === 'ask') {
      return {
        kind: 'ask',
        message: `规则 (${rule.source}): ${toolName} 需要确认`,
        decisionReason: `规则 (${rule.source}): ${toolName} 需要权限确认`,
        evidence,
        decisionSource,
        matchedRule: rule,
        matchedEvidenceIds,
        overridable: false,
      };
    }
    return {
      kind: 'allow',
      decisionReason: `规则 (${rule.source}): ${toolName} 已允许`,
      evidence,
      decisionSource,
      matchedRule: rule,
      matchedEvidenceIds,
      overridable: false,
    };
  }

  /**
   * 对完整调用、子命令、资源和操作类别评估显式规则。
   * deny/ask 命中任何候选即可生效；allow 必须覆盖完整调用或所有子命令，避免复合命令被部分放行。
   *
   * @param toolName - 工具名称
   * @param _args - 保留给未来需要参数级模式后处理的调用上下文
   * @param ruleStore - 当前会话规则视图
   * @param evidence - 工具分析证据
   * @returns 匹配的最终规则决策，无匹配则返回 undefined
   */
  private evaluateExplicitRules(
    toolName: string,
    args: Record<string, unknown>,
    ruleStore: PermissionRuleStore,
    evidence?: ToolPermissionEvidence,
  ): PermissionDecision | undefined {
    const candidates = createRuleCandidates(toolName, args, evidence);
    const matches = this.collectRuleMatches(toolName, candidates, ruleStore);

    // deny 和 ask 只要命中一个结构化候选就必须生效。
    for (const behavior of ['deny', 'ask'] as const) {
      const match = matches.find((item) => item.rule.ruleBehavior === behavior);
      if (match) {
        const decisionSource = getRuleDecisionSource(match.rule.source);
        if (behavior === 'deny') {
          return {
            kind: 'deny',
            decisionReason: `规则 (${match.rule.source}): ${match.rule.ruleValue.toolName} 被拒绝`,
            evidence,
            decisionSource,
            matchedRule: match.rule,
            matchedEvidenceIds: [match.candidate.evidenceId],
            overridable: false,
          };
        }
        return {
          kind: 'ask',
          message: `规则 (${match.rule.source}): ${match.rule.ruleValue.toolName} 需要确认`,
          decisionReason: `规则 (${match.rule.source}): ${match.rule.ruleValue.toolName} 需要权限确认`,
          evidence,
          decisionSource,
          matchedRule: match.rule,
          matchedEvidenceIds: [match.candidate.evidenceId],
          overridable: false,
        };
      }
    }

    const allowMatches = matches.filter((item) => item.rule.ruleBehavior === 'allow');
    const coveringMatches = findCoveringAllowMatches(candidates, allowMatches, evidence);
    if (coveringMatches.length > 0) {
      const primaryMatch = coveringMatches[0];
      return {
        kind: 'allow',
        decisionReason: `规则 (${primaryMatch.rule.source}): ${primaryMatch.rule.ruleValue.toolName} 已允许`,
        evidence,
        decisionSource: getRuleDecisionSource(primaryMatch.rule.source),
        matchedRule: primaryMatch.rule,
        matchedEvidenceIds: [...new Set(coveringMatches.map((item) => item.candidate.evidenceId))],
        overridable: false,
      };
    }

    return undefined;
  }

  /** 收集所有规则候选的命中结果。 */
  private collectRuleMatches(
    toolName: string,
    candidates: readonly RuleMatchCandidate[],
    ruleStore: PermissionRuleStore,
  ): MatchedPermissionRule[] {
    const matches: MatchedPermissionRule[] = [];
    for (const candidate of candidates) {
      const matchedRules = ruleStore.getMatchingRules(toolName, candidate.content);
      for (const rule of matchedRules) {
        matches.push({ rule, candidate });
      }
    }
    return matches;
  }

  /** 根据工具建议和结构化证据生成无显式规则时的基线决定。 */
  private createBuiltInBaseline(
    toolName: string,
    toolResult: Exclude<ToolPermissionCheckResult, { kind: 'deny' }>,
  ): PermissionDecision {
    const evidence = toolResult.evidence;
    const matchedEvidenceIds = collectEvidenceIds(evidence);

    // 工具已经给出完整候选结果时直接使用，evidence 只供日志和执行 effect。
    if (toolResult.kind === 'allow') {
      return {
        kind: 'allow',
        decisionReason: toolResult.decisionReason || '工具权限检查通过',
        updatedInput: toolResult.updatedInput,
        evidence,
        decisionSource: toolResult.matchedRule
          ? getRuleDecisionSource(toolResult.matchedRule.source)
          : 'builtInBaseline',
        matchedRule: toolResult.matchedRule,
        matchedEvidenceIds,
        overridable: toolResult.matchedRule === undefined,
      };
    }
    if (toolResult.kind === 'ask') {
      return {
        kind: 'ask',
        message: toolResult.message ?? `工具 "${toolName}" 需要权限确认`,
        decisionReason: toolResult.decisionReason ?? '工具检查要求权限确认',
        evidence,
        decisionSource: toolResult.matchedRule
          ? getRuleDecisionSource(toolResult.matchedRule.source)
          : 'builtInBaseline',
        matchedRule: toolResult.matchedRule,
        matchedEvidenceIds,
        overridable: toolResult.matchedRule === undefined,
      };
    }

    // passthrough 工具在完成专用候选迁移前继续使用通用证据基线。
    if (evidence?.sideEffect === 'read') {
      return {
        kind: 'allow',
        decisionReason: evidence.riskReason || '已证明为普通只读操作',
        updatedInput: undefined,
        evidence,
        decisionSource: 'builtInBaseline',
        matchedEvidenceIds,
        overridable: true,
      };
    }

    if (evidence) {
      const message = evidence.sideEffect === 'sensitive-read'
        ? '该操作可能读取敏感信息'
        : evidence.sideEffect === 'write'
          ? `工具 "${toolName}" 将产生写入或状态改变`
          : `无法确定工具 "${toolName}" 的完整副作用`;
      return {
        kind: 'ask',
        message,
        decisionReason: evidence.riskReason || '结构化证据不足以自动放行',
        evidence,
        decisionSource: 'builtInBaseline',
        matchedEvidenceIds,
        overridable: true,
      };
    }

    if (isKnownReadOnlyTool(toolName)) {
      return {
        kind: 'allow',
        decisionReason: `内置只读工具 "${toolName}"`,
        decisionSource: 'builtInBaseline',
        matchedEvidenceIds,
        overridable: true,
      };
    }

    return {
      kind: 'ask',
      message: `工具 "${toolName}" 需要权限确认`,
      decisionReason: '没有显式规则，也没有足够证据自动放行',
      decisionSource: 'builtInBaseline',
      matchedEvidenceIds,
      overridable: true,
    };
  }

  // ── 模式后处理 ──

  /**
   * 执行模式相关的后处理逻辑。
   * 根据当前模式对 ask/deny 结果做最终转换。
   *
   * @param decision - 待处理的决策
   * @param mode - 当前权限模式
   * @param toolName - 工具名称
   * @param _args - 保留给未来参数级模式后处理的调用上下文
   * @returns 最终的权限决策
   */
  private async applyPermissionMode(
    decision: PermissionDecision,
    mode: PermissionMode,
    toolName: string,
    _args: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    // deny 永不降级；显式 allow 也不再被普通模式改写。
    if (decision.kind === 'deny') {
      return decision;
    }
    if (decision.kind === 'allow' && decision.matchedRule) {
      return decision;
    }

    // 显式 ask 必须保留，只有 dontAsk 或更严格的 Plan 禁写规则可以把它收紧为 deny。
    if (decision.kind === 'ask' && decision.matchedRule) {
      if (mode === 'dontAsk') {
        return createModeDeny(
          `dontAsk 模式: "${toolName}" 需要权限但不允许交互询问`,
          decision,
        );
      }
      if (mode === 'plan' && !this.isPlanSafeCall(toolName, decision.evidence) &&
          decision.evidence?.sideEffect !== 'sensitive-read') {
        return createModeDeny(`plan 模式不允许 "${toolName}" 的写入或未知操作`, decision);
      }
      return decision;
    }

    // Plan 会检查基线 allow 是否真的由只读证据支持，其它模式保留基线 allow。
    if (decision.kind === 'allow') {
      if (mode === 'plan' && !this.isPlanSafeCall(toolName, decision.evidence)) {
        return createModeDeny(`plan 模式不允许 "${toolName}" 操作`, decision);
      }
      return decision;
    }

    switch (mode) {
      case 'acceptEdits': {
        // acceptEdits 只放行专用编辑工具，不扩张到任意终端写入。
        if (isEditOperation(decision.evidence, toolName)) {
          return {
            kind: 'allow',
            decisionReason: 'acceptEdits: 编辑操作自动允许',
            evidence: decision.evidence,
            decisionCode: decision.decisionCode,
            ruleSuggestions: decision.ruleSuggestions,
            analysis: decision.analysis,
            decisionSource: 'mode',
            matchedEvidenceIds: decision.matchedEvidenceIds,
            overridable: false,
          };
        }
        return decision;
      }

      case 'plan': {
        // 普通读取直接 allow；敏感读取保留 ask；写入和未知操作 deny。
        if (this.isPlanSafeCall(toolName, decision.evidence)) {
          return {
            kind: 'allow',
            decisionReason: `plan 模式: 已证明 "${toolName}" 为只读操作`,
            evidence: decision.evidence,
            decisionCode: decision.decisionCode,
            ruleSuggestions: decision.ruleSuggestions,
            analysis: decision.analysis,
            decisionSource: 'mode',
            matchedEvidenceIds: decision.matchedEvidenceIds,
            overridable: false,
          };
        }
        if (decision.evidence?.sideEffect === 'sensitive-read') {
          return decision;
        }
        return createModeDeny(`plan 模式不允许 "${toolName}" 的写入或未知操作`, decision);
      }

      case 'dontAsk': {
        return createModeDeny(`dontAsk 模式: "${toolName}" 需要权限但未预先允许`, decision);
      }

      case 'bypassPermissions': {
        return {
          kind: 'allow',
          decisionReason: `bypassPermissions 模式: "${toolName}" 已绕过询问`,
          evidence: decision.evidence,
          decisionCode: decision.decisionCode,
          ruleSuggestions: decision.ruleSuggestions,
          analysis: decision.analysis,
          decisionSource: 'mode',
          matchedEvidenceIds: decision.matchedEvidenceIds,
          overridable: false,
        };
      }

      default: {
        // default 模式：保留 ask
        return decision;
      }
    }
  }

  /**
   * 判断 plan 模式下该工具调用是否安全（只读）。
   *
   * @param toolName - 工具名称
   * @param evidence - 工具权限证据
   * @returns 是否被允许在 plan 模式下执行
   */
  private isPlanSafeCall(
    toolName: string,
    evidence?: ToolPermissionEvidence,
  ): boolean {
    if (evidence) {
      return evidence.sideEffect === 'read';
    }
    return isKnownReadOnlyTool(toolName);
  }
}

// ── 辅助函数 ──

/** 根据完整调用、子命令、资源和操作类别生成规则候选。 */
function createRuleCandidates(
  toolName: string,
  args: Record<string, unknown>,
  evidence?: ToolPermissionEvidence,
): RuleMatchCandidate[] {
  const candidates: RuleMatchCandidate[] = [{
    content: extractContentFromArgs(toolName, args),
    kind: 'full',
    evidenceId: 'call:full',
  }];

  evidence?.subcommands?.forEach((subcommand, index) => {
    candidates.push({
      content: subcommand.command,
      kind: 'subcommand',
      evidenceId: `subcommand:${index}`,
    });
  });

  evidence?.resources?.forEach((resource, index) => {
    const evidenceId = resource.sourceNodeId || `resource:${index}`;
    candidates.push({ content: resource.rawExpression, kind: 'resource', evidenceId });
    const canonicalExpression = getCanonicalResourceExpression(resource);
    if (canonicalExpression && canonicalExpression !== resource.rawExpression) {
      candidates.push({ content: canonicalExpression, kind: 'resource', evidenceId });
    }
  });

  if (evidence?.operationCategory) {
    candidates.push({
      content: evidence.operationCategory,
      kind: 'operation',
      evidenceId: `operation:${evidence.operationCategory}`,
    });
  }

  return candidates;
}

/** 返回正式资源证据中可安全参与精确规则匹配的规范表达式。 */
function getCanonicalResourceExpression(resource: ResourceEvidence): string | undefined {
  switch (resource.kind) {
    case 'file':
    case 'directory-scope':
      return resource.canonicalPath;
    case 'network':
      return resource.canonicalUrl;
    case 'external-side-effect':
      return resource.canonicalServiceName;
    case 'command':
      return resource.canonicalSummary;
    case 'mcp-call':
      return `${resource.serverName}/${resource.toolName}`;
    case 'unknown':
      return undefined;
  }
}

/** 找出足以覆盖完整调用的 allow 命中，拒绝只覆盖复合命令一部分的 allow。 */
function findCoveringAllowMatches(
  candidates: readonly RuleMatchCandidate[],
  allowMatches: readonly MatchedPermissionRule[],
  evidence?: ToolPermissionEvidence,
): MatchedPermissionRule[] {
  const toolWideMatch = allowMatches.find((item) => item.rule.ruleValue.ruleContent === undefined);
  if (toolWideMatch) {
    return [toolWideMatch];
  }

  const subcommandCandidates = candidates.filter((candidate) => candidate.kind === 'subcommand');
  if (subcommandCandidates.length > 0) {
    const coveringSubcommands: MatchedPermissionRule[] = [];
    for (const candidate of subcommandCandidates) {
      const explicitMatch = allowMatches.find((item) => item.candidate.evidenceId === candidate.evidenceId);
      if (explicitMatch) {
        coveringSubcommands.push(explicitMatch);
        continue;
      }
      const subcommandIndex = Number(candidate.evidenceId.slice('subcommand:'.length));
      const baselinePermission = evidence?.subcommands?.[subcommandIndex]?.permission;
      if (baselinePermission !== 'allow') {
        return [];
      }
    }
    if (coveringSubcommands.length > 0) {
      return coveringSubcommands;
    }
    return [];
  }

  // 只有没有结构化子命令的非 Shell 工具才允许用完整调用或操作类别覆盖。
  const wholeCallMatch = allowMatches.find((item) =>
    item.candidate.kind === 'full' || item.candidate.kind === 'operation');
  if (wholeCallMatch) {
    return [wholeCallMatch];
  }

  const resourceCandidates = candidates.filter((candidate) => candidate.kind === 'resource');
  if (subcommandCandidates.length === 0 && resourceCandidates.length > 0) {
    const coveringResources = resourceCandidates.map((candidate) =>
      allowMatches.find((item) => item.candidate.evidenceId === candidate.evidenceId));
    if (coveringResources.every((item): item is MatchedPermissionRule => item !== undefined)) {
      return coveringResources;
    }
  }

  return [];
}

/** 将规则配置来源归并为稳定的最终决定来源。 */
function getRuleDecisionSource(source: PermissionRuleSource): PermissionDecisionSource {
  if (source === 'policySettings') {
    return 'policyRule';
  }
  if (source === 'projectSettings' || source === 'localSettings') {
    return 'projectRule';
  }
  return 'userRule';
}

/** 收集参与决定的结构化证据标识。 */
function collectEvidenceIds(evidence?: ToolPermissionEvidence): string[] {
  if (!evidence) {
    return [];
  }

  const evidenceIds = [`operation:${evidence.operationCategory}`];
  evidence.subcommands?.forEach((_subcommand, index) => evidenceIds.push(`subcommand:${index}`));
  evidence.resources?.forEach((resource, index) => {
    evidenceIds.push(resource.sourceNodeId || `resource:${index}`);
  });
  return [...new Set(evidenceIds)];
}

/** 创建由权限模式收紧后的拒绝决定。 */
function createModeDeny(
  reason: string,
  originalDecision: PermissionDecision,
): PermissionDecision {
  return {
    kind: 'deny',
    decisionReason: reason,
    evidence: originalDecision.evidence,
    decisionCode: originalDecision.decisionCode,
    ruleSuggestions: originalDecision.ruleSuggestions,
    analysis: originalDecision.analysis,
    decisionSource: 'mode',
    matchedEvidenceIds: originalDecision.matchedEvidenceIds,
    overridable: false,
  };
}

/** 将工具候选元数据附加到显式规则或内置基线产生的决定。 */
function attachToolMetadata(
  decision: PermissionDecision,
  toolResult: ToolPermissionCheckResult,
): PermissionDecision {
  return {
    ...decision,
    decisionCode: toolResult.decisionCode ?? decision.decisionCode,
    ruleSuggestions: toolResult.ruleSuggestions ?? decision.ruleSuggestions,
    analysis: toolResult.analysis ?? decision.analysis,
    matchedRule: toolResult.matchedRule ?? decision.matchedRule,
  };
}

/** 判断工具结果是否为 Bash/PowerShell 专用候选决定。 */
function isShellPermissionCandidate(
  toolName: string,
  toolResult: ToolPermissionCheckResult,
): boolean {
  return (toolName === 'Bash' || toolName === 'PowerShell') &&
    toolResult.analysis !== undefined &&
    toolResult.evidence?.shellKind !== undefined;
}

/** 判断没有结构化证据的旧工具是否明确为专用只读工具。 */
function isKnownReadOnlyTool(toolName: string): boolean {
  const readOnlyTools = new Set([
    'Read',
    'ReadManyFiles',
    'Glob',
    'Grep',
    'Dir',
    'WebFetch',
    'WebSearch',
    'GitStatus',
    'GitLog',
    'GitDiff',
  ]);
  return readOnlyTools.has(toolName);
}

/**
 * 从工具参数中提取内容 specifier。
 *
 * @param toolName - 工具名称
 * @param args - 工具参数
 * @returns 内容 specifier 或 undefined
 */
function extractContentFromArgs(toolName: string, args: Record<string, unknown>): string | undefined {
  // Bash/PowerShell: 从 command/script 参数提取
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return (args.command ?? args.script) as string | undefined;
  }

  // 文件工具：从 path/filePath/target 参数提取
  if (['Read', 'Write', 'Edit', 'Create', 'ReadManyFiles', 'Glob', 'Grep', 'Dir'].includes(toolName)) {
    return (args.path ?? args.filePath ?? args.target ?? args.pattern) as string | undefined;
  }

  // Agent: 从 agentType/name 参数提取
  if (toolName === 'Agent') {
    return (args.agentType ?? args.name) as string | undefined;
  }

  return undefined;
}

/**
 * 已知的普通编辑工具名集合（acceptEdits 模式放行依据）。
 * TODO: 迁移到 ToolAuthorizationAdapter.isOrdinaryEdit()。
 */
const ORDINARY_EDIT_TOOLS = new Set([
  'writeFile', 'editFile', 'applyPatch', 'createDirectory',
]);

/**
 * 判断是否为编辑类操作（acceptEdits 模式使用）。
 * 优先检查 evidence 中的 operationCategory，回退检查工具名。
 *
 * @param evidence - 工具适配器产生的结构化操作证据
 * @param toolName - 运行时工具名（可选，用于 evidence 缺失时回退）
 * @returns 是否为编辑操作
 */
function isEditOperation(evidence?: ToolPermissionEvidence, toolName?: string): boolean {
  if (evidence?.operationCategory === 'file-edit'
    || evidence?.operationCategory === 'file-write') {
    return true;
  }
  // 无 evidence 时按已知编辑工具名回退
  if (toolName && ORDINARY_EDIT_TOOLS.has(toolName)) {
    return true;
  }
  return false;
}

/** 用正式 PermissionRequest 资源替换工具候选中的迁移期资源形状。 */
function attachRequestResources<T extends ToolPermissionCheckResult>(
  toolResult: T,
  request: PermissionRequest,
): T {
  const fallbackEvidence = createRequestEvidence(request);
  return {
    ...toolResult,
    evidence: {
      ...(toolResult.evidence ?? fallbackEvidence),
      resources: request.resourceEvidences,
    },
  } as T;
}

/** 将适配器生成的受信分析绑定到工具候选，供最终决策和执行期复用。 */
function bindRequestAnalysis(
  toolResult: ToolPermissionCheckResult | undefined,
  analysis: unknown,
): ToolPermissionCheckResult | undefined {
  if (analysis === undefined) {
    return toolResult;
  }
  if (!toolResult) {
    return {
      kind: 'passthrough',
      analysis,
    };
  }
  return {
    ...toolResult,
    analysis,
  };
}

/** 在不改变决定判别字段的前提下附加执行期分析。 */
function withBoundAnalysis(
  decision: PermissionDecision,
  analysis: unknown,
): PermissionDecision {
  if (analysis === undefined || decision.analysis === analysis) {
    return decision;
  }
  return {
    ...decision,
    analysis,
  };
}

/** 将正式请求中的资源转成现有执行 effect 可消费的证据。 */
function createRequestEvidence(request: PermissionRequest): ToolPermissionEvidence {
  const sideEffect = request.permissionIdentity === 'FileRead'
    ? 'read'
    : request.permissionIdentity === 'UnknownEffect'
      ? 'unknown'
      : 'write';
  return {
    operationCategory: request.permissionIdentity,
    sideEffect,
    riskReason: `工具适配器声明 ${request.permissionIdentity}`,
    resources: request.resourceEvidences,
  };
}

/** 判断普通编辑的全部文件资源是否位于工作区或显式 additionalDirectories 内。 */
function isRequestWithinEditScope(
  request: PermissionRequest,
  state: PermissionSessionState,
): boolean {
  if (request.resourceEvidences.length === 0) {
    return false;
  }
  const additionalDirectories = state.getAdditionalDirectories();
  return request.resourceEvidences.every(resource => {
    if (resource.kind !== 'file' && resource.kind !== 'directory-scope') {
      return false;
    }
    if (resource.scope === 'workspace') {
      return true;
    }
    return additionalDirectories.some(directory =>
      isPhysicalSubPath(directory, resource.canonicalPath));
  });
}

/** 使用路径分段而非字符串前缀判断物理子树关系。 */
function isPhysicalSubPath(parent: string, candidate: string): boolean {
  const parentKey = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const candidateKey = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const relation = relative(parentKey, candidateKey);
  return relation === ''
    || (!relation.startsWith('..') && !isAbsolute(relation));
}

/** 为正式资源证据生成稳定、去敏的匹配标识。 */
function createResourceEvidenceId(resource: ResourceEvidence): string {
  return `${resource.kind}:${resource.sourceNodeId}:${resource.operation}`;
}

/**
 * 计算受保护资源的不可绕过上限。
 * 文件、网络和外部账号副作用必须在普通规则与模式之前完成判断。
 */
function evaluateProtectedRequest(request: PermissionRequest): PermissionDecision | undefined {
  const evidence = createRequestEvidence(request);
  const matchedEvidenceIds = request.resourceEvidences.map(createResourceEvidenceId);

  for (const resource of request.resourceEvidences) {
    if (resource.kind === 'file' || resource.kind === 'directory-scope') {
      const operation = resource.operation === 'read' ? 'read' : 'write';
      const result = checkProtectedResource(resource.canonicalPath, operation);
      if (result.decision === 'deny') {
        return {
          kind: 'deny',
          decisionReason: result.reason,
          evidence,
          decisionSource: 'invariant',
          matchedEvidenceIds,
          overridable: false,
        };
      }
      if (result.decision === 'ask') {
        return {
          kind: 'ask',
          message: '目标属于受保护资源，需要单次明确确认',
          decisionReason: result.reason,
          evidence,
          decisionSource: 'invariant',
          matchedEvidenceIds,
          overridable: false,
        };
      }
    }

    if (
      resource.kind === 'network'
      && (resource.scope === 'cloud-metadata' || resource.scope === 'link-local')
    ) {
      return {
        kind: 'deny',
        decisionReason: `禁止访问受保护网络范围: ${resource.scope}`,
        evidence,
        decisionSource: 'invariant',
        matchedEvidenceIds,
        overridable: false,
      };
    }

    if (
      resource.kind === 'network'
      && (resource.scope === 'loopback' || resource.scope === 'private')
    ) {
      return {
        kind: 'ask',
        message: '访问本地或私有网络需要明确确认',
        decisionReason: `网络目标属于受保护范围: ${resource.scope}`,
        evidence,
        decisionSource: 'invariant',
        matchedEvidenceIds,
        overridable: false,
      };
    }

    if (resource.kind === 'external-side-effect') {
      return {
        kind: 'ask',
        message: '外部账号副作用需要单次明确确认',
        decisionReason: `外部操作不可由文件编辑模式放行: ${resource.operation}`,
        evidence,
        decisionSource: 'invariant',
        matchedEvidenceIds,
        overridable: false,
      };
    }
  }
  return undefined;
}

/**
 * 生成用于审计关联的安全随机 nonce。
 *
 * @returns nonce 字符串
 */
function generateNonce(): string {
  return `auth_${randomUUID()}`;
}
