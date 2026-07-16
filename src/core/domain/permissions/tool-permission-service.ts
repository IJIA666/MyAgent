/**
 * @file 统一工具权限服务。
 * 按 Claude Code 顺序执行权限决策流程：全局规则 → 工具 checkPermissions →
 * 工具级安全结果 → bypass → allow → passthrough → 模式后处理。
 * 只产生最终 allow / ask / deny 三种决策。
 */

import type {
  PermissionMode,
  PermissionDecision,
  PermissionDecisionSource,
  PermissionRule,
  PermissionRuleSource,
  ToolPermissionEvidence,
  ToolPermissionCheckResult,
  ToolPermissionResourceEvidence,
} from './permission-types.js';
import { PermissionRuleStore } from './rule-store.js';

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

// ── 模式语义辅助类型 ──

/** Auto 分类器接口，由 AutoPermissionClassifier 实现 */
export interface AutoClassifier {
  /**
   * 判断一次 ask 调用是否安全。
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @param evidence - 工具分析产生的结构化证据
   * @returns 允许或拒绝
   */
  classify(
    toolName: string,
    args: Record<string, unknown>,
    evidence?: ToolPermissionEvidence,
  ): Promise<{ allow: boolean; reason: string }>;
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
  /** 权限决策信息 */
  readonly decision: Pick<PermissionDecision, 'kind'> & { decisionReason?: string };
  /** 权限阶段生成的只读证据。 */
  readonly evidence?: ToolPermissionEvidence;
}

// ── ToolPermissionService ──

/**
 * 统一工具权限服务选项。
 */
export interface ToolPermissionServiceOptions {
  /** 规则存储实例 */
  ruleStore: PermissionRuleStore;
  /** 可选：Auto 分类器 */
  autoClassifier?: AutoClassifier;
  /** 是否运行在 headless 模式（无交互） */
  headless?: boolean;
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
  private readonly autoClassifier?: AutoClassifier;
  private readonly headless: boolean;
  /** 仅登记由本服务创建的上下文，阻止调用方伪造授权凭据。 */
  private readonly issuedContexts = new WeakSet<object>();
  /** 防止同一授权上下文被 tail call 重放。 */
  private readonly consumedContexts = new WeakSet<object>();

  constructor(options: ToolPermissionServiceOptions) {
    this.ruleStore = options.ruleStore;
    this.autoClassifier = options.autoClassifier;
    this.headless = options.headless ?? false;
  }

  /**
   * 执行一次工具调用的完整权限检查。
   *
   * @param toolName - 工具名称
   * @param args - 工具调用参数
   * @param mode - 当前权限模式
   * @param toolChecker - 可选的工具 checkPermissions 实现
   * @param context - 额外的执行上下文（cwd 等）
   * @returns 最终的权限决策
   */
  async checkPermissions(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionMode,
    toolChecker?: ToolPermissionChecker,
    context?: { cwd?: string },
  ): Promise<PermissionDecision> {
    // 工具检查只执行一次，优先取得结构化证据与不可绕过结果。
    let toolResult: ToolPermissionCheckResult = { kind: 'passthrough' };
    if (toolChecker) {
      toolResult = await toolChecker.checkPermissions(
        { args, cwd: context?.cwd },
        { mode, rules: this.ruleStore },
      );
    }

    // 工具 deny 只表示输入契约失败、完整性失败或工具硬红线，任何规则和模式都不能覆盖。
    if (toolResult.kind === 'deny') {
      return {
        kind: 'deny',
        decisionReason: toolResult.decisionReason,
        evidence: toolResult.evidence,
        decisionSource: 'invariant',
        matchedEvidenceIds: collectEvidenceIds(toolResult.evidence),
        overridable: false,
      };
    }

    // 防御性检查：即使工具误把硬红线包装为 passthrough，也不能进入普通规则层。
    if (toolResult.evidence?.sideEffect === 'hardline') {
      return {
        kind: 'deny',
        decisionReason: toolResult.evidence.riskReason || '命令未通过不可绕过安全检查',
        evidence: toolResult.evidence,
        decisionSource: 'invariant',
        matchedEvidenceIds: collectEvidenceIds(toolResult.evidence),
        overridable: false,
      };
    }

    // 显式用户规则高于普通工具建议；deny 和 ask 仍高于 allow。
    const ruleDecision = this.evaluateExplicitRules(toolName, args, toolResult.evidence);
    const baselineDecision = ruleDecision ?? this.createBuiltInBaseline(toolName, toolResult);
    return this.applyPermissionMode(baselineDecision, mode, toolName, args);
  }

  /**
   * 生成不可伪造的已授权执行上下文。
   * 在权限决策为 allow 后调用，为 ToolExecutor 提供授权证明。
   *
   * @param toolName - 工具名称
   * @param args - 工具调用参数
   * @param decision - 权限决策
   * @returns 不可伪造的执行上下文
   */
  createAuthorizedContext(
    toolName: string,
    args: Record<string, unknown>,
    decision: PermissionDecision,
  ): AuthorizedExecutionContext | null {
    if (decision.kind !== 'allow') {
      return null;
    }
    const context: AuthorizedExecutionContext = {
      nonce: generateNonce(),
      toolName,
      args,
      decision: { kind: 'allow', decisionReason: decision.decisionReason },
      evidence: decision.evidence,
    };
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

  /**
   * 对完整调用、子命令、资源和操作类别评估显式规则。
   * deny/ask 命中任何候选即可生效；allow 必须覆盖完整调用或所有子命令，避免复合命令被部分放行。
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @param evidence - 工具分析证据
   * @returns 匹配的最终规则决策，无匹配则返回 undefined
   */
  private evaluateExplicitRules(
    toolName: string,
    args: Record<string, unknown>,
    evidence?: ToolPermissionEvidence,
  ): PermissionDecision | undefined {
    const candidates = createRuleCandidates(toolName, args, evidence);
    const matches = this.collectRuleMatches(toolName, candidates);

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
    const coveringMatches = findCoveringAllowMatches(candidates, allowMatches);
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
  ): MatchedPermissionRule[] {
    const matches: MatchedPermissionRule[] = [];
    for (const candidate of candidates) {
      const matchedRules = this.ruleStore.getMatchingRules(toolName, candidate.content);
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

    if (evidence?.sideEffect === 'read') {
      return {
        kind: 'allow',
        decisionReason: evidence.riskReason || '已证明为普通只读操作',
        updatedInput: toolResult.kind === 'allow' ? toolResult.updatedInput : undefined,
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

    // 非 Shell 旧工具在完成证据迁移前，暂时兼容原有 allow/ask 建议。
    if (toolResult.kind === 'allow') {
      return {
        kind: 'allow',
        decisionReason: toolResult.decisionReason || '工具安全检查通过',
        updatedInput: toolResult.updatedInput,
        decisionSource: 'builtInBaseline',
        matchedEvidenceIds,
        overridable: true,
      };
    }
    if (toolResult.kind === 'ask') {
      return {
        kind: 'ask',
        message: toolResult.message ?? `工具 "${toolName}" 需要权限确认`,
        decisionReason: toolResult.decisionReason ?? '工具检查要求权限确认',
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
   * @param args - 工具参数
   * @returns 最终的权限决策
   */
  private async applyPermissionMode(
    decision: PermissionDecision,
    mode: PermissionMode,
    toolName: string,
    args: Record<string, unknown>,
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
        if (isEditOperation(toolName, args)) {
          return {
            kind: 'allow',
            decisionReason: 'acceptEdits: 编辑操作自动允许',
            evidence: decision.evidence,
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
          decisionSource: 'mode',
          matchedEvidenceIds: decision.matchedEvidenceIds,
          overridable: false,
        };
      }

      case 'auto': {
        // auto 模式使用分类器
        return this.handleAutoMode(decision, toolName, args);
      }

      default: {
        // default 模式：保留 ask
        return decision;
      }
    }
  }

  /**
   * 处理 auto 模式的 ask 后分类。
   *
   * @param decision - ask 决策
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @returns 分类器决定的 allow/deny 或原始 ask
   */
  private async handleAutoMode(
    decision: PermissionDecision & { kind: 'ask' },
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    if (!this.autoClassifier) {
      // 分类器不可用
      if (this.headless) {
        return {
          kind: 'deny',
          decisionReason: `auto 模式: 分类器不可用且为 headless 模式，拒绝 "${toolName}"`,
          evidence: decision.evidence,
          decisionSource: 'mode',
          matchedEvidenceIds: decision.matchedEvidenceIds,
          overridable: false,
        };
      }
      // 有交互环境：保留 ask 让用户判断
      return decision;
    }

    try {
      const result = await this.autoClassifier.classify(toolName, args, decision.evidence);
      if (result.allow) {
        return {
          kind: 'allow',
          decisionReason: `auto 分类器: ${result.reason}`,
          evidence: decision.evidence,
          decisionSource: 'classifier',
          matchedEvidenceIds: decision.matchedEvidenceIds,
          overridable: false,
        };
      }
      return {
        kind: 'deny',
        decisionReason: `auto 分类器: ${result.reason}`,
        evidence: decision.evidence,
        decisionSource: 'classifier',
        matchedEvidenceIds: decision.matchedEvidenceIds,
        overridable: false,
      };
    } catch {
      // 分类器异常
      if (this.headless) {
        return {
          kind: 'deny',
          decisionReason: `auto 模式: 分类器异常且为 headless 模式，拒绝 "${toolName}"`,
          evidence: decision.evidence,
          decisionSource: 'mode',
          matchedEvidenceIds: decision.matchedEvidenceIds,
          overridable: false,
        };
      }
      return decision;
    }
  }

  /**
   * 判断 plan 模式下该工具调用是否安全（只读）。
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
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
    if (!isStructuredResourceEvidence(resource)) {
      return;
    }
    const evidenceId = resource.sourceNodeId || `resource:${index}`;
    candidates.push({ content: resource.rawExpression, kind: 'resource', evidenceId });
    if (resource.resolvedResource && resource.resolvedResource !== resource.rawExpression) {
      candidates.push({ content: resource.resolvedResource, kind: 'resource', evidenceId });
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

/** 找出足以覆盖完整调用的 allow 命中，拒绝只覆盖复合命令一部分的 allow。 */
function findCoveringAllowMatches(
  candidates: readonly RuleMatchCandidate[],
  allowMatches: readonly MatchedPermissionRule[],
): MatchedPermissionRule[] {
  const toolWideMatch = allowMatches.find((item) => item.rule.ruleValue.ruleContent === undefined);
  if (toolWideMatch) {
    return [toolWideMatch];
  }

  const wholeCallMatch = allowMatches.find((item) =>
    item.candidate.kind === 'full' || item.candidate.kind === 'operation');
  if (wholeCallMatch) {
    return [wholeCallMatch];
  }

  const subcommandCandidates = candidates.filter((candidate) => candidate.kind === 'subcommand');
  if (subcommandCandidates.length > 0) {
    const coveringSubcommands = subcommandCandidates.map((candidate) =>
      allowMatches.find((item) => item.candidate.evidenceId === candidate.evidenceId));
    if (coveringSubcommands.every((item): item is MatchedPermissionRule => item !== undefined)) {
      return coveringSubcommands;
    }
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
    evidenceIds.push(isStructuredResourceEvidence(resource) && resource.sourceNodeId
      ? resource.sourceNodeId
      : `resource:${index}`);
  });
  return [...new Set(evidenceIds)];
}

/** 判断兼容资源记录是否已经采用正式的结构化资源契约。 */
function isStructuredResourceEvidence(
  resource: ToolPermissionResourceEvidence | Readonly<Record<string, unknown>>,
): resource is ToolPermissionResourceEvidence {
  return typeof resource.rawExpression === 'string' &&
    typeof resource.sourceNodeId === 'string' &&
    typeof resource.operation === 'string';
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
    decisionSource: 'mode',
    matchedEvidenceIds: originalDecision.matchedEvidenceIds,
    overridable: false,
  };
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
 * 判断是否为编辑类操作（acceptEdits 模式使用）。
 *
 * @param toolName - 工具名称
 * @param args - 工具参数
 * @returns 是否为编辑操作
 */
function isEditOperation(toolName: string, _args: Record<string, unknown>): boolean {
  const editTools = new Set([
    'Write',
    'Edit',
    'Create',
    'ApplyPatch',
    'DeleteFile',
    'MoveFile',
    'CopyFile',
  ]);
  return editTools.has(toolName);
}

let nonceCounter = 0;

/**
 * 生成不可伪造的 nonce 字符串。
 *
 * @returns nonce 字符串
 */
function generateNonce(): string {
  nonceCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `auth_${ts}_${rand}_${nonceCounter}`;
}
