/**
 * @file 统一工具权限服务。
 * 按 Claude Code 顺序执行权限决策流程：全局规则 → 工具 checkPermissions →
 * 工具级安全结果 → bypass → allow → passthrough → 模式后处理。
 * 只产生最终 allow / ask / deny 三种决策。
 */

import type {
  PermissionMode,
  PermissionDecision,
  ToolPermissionEvidence,
  ToolPermissionCheckResult,
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
   * @returns 允许或拒绝
   */
  classify(toolName: string, args: Record<string, unknown>): Promise<{ allow: boolean; reason: string }>;
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
 * 1. 全局 deny / ask 规则匹配
 * 2. 工具 checkPermissions(input, context)
 * 3. 工具级 deny / 内容级 ask / 安全检查结果
 * 4. bypassPermissions 判断
 * 5. allow 规则匹配
 * 6. passthrough 转 ask
 * 7. dontAsk / auto classifier / headless fallback
 * 8. 产生最终 PermissionDecision
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
    // 步骤 1：收集规则结果，但不因 ask/deny 提前跳过工具 hardline 检查。
    const ruleDecision = this.evaluateGlobalRules(toolName, args)
      ?? this.evaluateAllowRules(toolName, args);

    // 步骤 2：每次权限评估恰好执行一次工具检查。
    let toolResult: ToolPermissionCheckResult = { kind: 'passthrough' };
    if (toolChecker) {
      toolResult = await toolChecker.checkPermissions(
        { args, cwd: context?.cwd },
        { mode, rules: this.ruleStore },
      );
    }

    // 步骤 3：按 deny > ask > allow > passthrough 聚合规则和工具结果。
    let decision: PermissionDecision;
    if (toolResult.kind === 'deny') {
      decision = {
        kind: 'deny',
        decisionReason: toolResult.decisionReason,
        evidence: toolResult.evidence,
      };
    } else if (ruleDecision?.kind === 'deny') {
      decision = {
        ...ruleDecision,
        evidence: toolResult.evidence,
      };
    } else if (toolResult.kind === 'ask') {
      decision = {
        kind: 'ask',
        message: toolResult.message ?? `工具 "${toolName}" 需要权限确认`,
        decisionReason: toolResult.decisionReason ?? '工具检查要求权限确认',
        evidence: toolResult.evidence,
      };
    } else if (ruleDecision?.kind === 'ask') {
      decision = {
        ...ruleDecision,
        evidence: toolResult.evidence,
      };
    } else if (toolResult.kind === 'allow') {
      decision = {
        kind: 'allow',
        decisionReason: toolResult.decisionReason || '工具安全检查通过',
        updatedInput: toolResult.updatedInput,
        evidence: toolResult.evidence,
      };
    } else if (ruleDecision?.kind === 'allow') {
      decision = {
        ...ruleDecision,
        evidence: toolResult.evidence,
      };
    } else {
      decision = {
        kind: 'ask',
        message: `工具 "${toolName}" 需要权限确认`,
        decisionReason: '未配置 allow 规则，且工具检查结果为 passthrough',
        evidence: toolResult.evidence,
      };
    }

    // 步骤 4：只有聚合后的 ask 进入模式后处理，deny 永不降级。
    return this.handleModePostProcessing(decision, mode, toolName, args);
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

  // ── 全局规则评估 ──

  /**
   * 评估全局 deny / ask 规则。
   * 按 deny → ask → allow 顺序，返回最高优先级匹配决策。
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @returns 匹配的 deny/ask 决策，无匹配则返回 undefined
   */
  private evaluateGlobalRules(
    toolName: string,
    args: Record<string, unknown>,
  ): PermissionDecision | undefined {
    const content = extractContentFromArgs(toolName, args);

    // 获取匹配的所有规则
    const matchedRules = this.ruleStore.getMatchingRules(toolName, content);

    // deny → ask 顺序
    for (const behavior of ['deny', 'ask'] as const) {
      const rule = matchedRules.find((r) => r.ruleBehavior === behavior);
      if (rule) {
        if (behavior === 'deny') {
          return { kind: 'deny', decisionReason: `规则 (${rule.source}): ${rule.ruleValue.toolName} 被拒绝` };
        }
        return {
          kind: 'ask',
          message: `规则 (${rule.source}): ${rule.ruleValue.toolName} 需要确认`,
          decisionReason: `显式 ask 规则 (${rule.source}): ${rule.ruleValue.toolName} 需要权限确认`,
        };
      }
    }

    return undefined;
  }

  /**
   * 评估 allow 规则匹配。
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @returns 匹配的 allow 决策或无
   */
  private evaluateAllowRules(toolName: string, args: Record<string, unknown>): PermissionDecision | undefined {
    const content = extractContentFromArgs(toolName, args);
    const matchedRules = this.ruleStore.getMatchingRules(toolName, content);
    const allowRule = matchedRules.find((r) => r.ruleBehavior === 'allow');
    if (allowRule) {
      return { kind: 'allow', decisionReason: `规则 (${allowRule.source}): ${allowRule.ruleValue.toolName} 已允许` };
    }
    return undefined;
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
  private async handleModePostProcessing(
    decision: PermissionDecision,
    mode: PermissionMode,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    // deny 决策直接返回，不受模式影响
    if (decision.kind === 'deny') {
      return decision;
    }

    // allow 决策直接返回
    if (decision.kind === 'allow') {
      return decision;
    }

    // ask 决策受模式影响
    if (decision.kind === 'ask') {
      return this.processAskDecision(decision, mode, toolName, args);
    }

    return decision;
  }

  /**
   * 处理 ask 决策的模式后处理。
   *
   * @param decision - ask 决策
   * @param mode - 当前模式
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @returns 可能被模式修改后的最终决策
   */
  private async processAskDecision(
    decision: PermissionDecision & { kind: 'ask' },
    mode: PermissionMode,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    switch (mode) {
      case 'acceptEdits': {
        // acceptEdits 只对文件编辑/文件系统操作自动 allow
        if (isEditOperation(toolName, args)) {
          return {
            kind: 'allow',
            decisionReason: 'acceptEdits: 编辑操作自动允许',
            evidence: decision.evidence,
          };
        }
        return decision;
      }

      case 'plan': {
        // plan 模式只允许只读操作
        if (this.isPlanSafeCall(toolName, args, decision.evidence)) {
          return decision; // 保留 ask，让审批流程决定
        }
        return {
          kind: 'deny',
          decisionReason: `plan 模式不允许 "${toolName}" 操作`,
          evidence: decision.evidence,
        };
      }

      case 'dontAsk': {
        // dontAsk 将 ask 转为 deny
        return {
          kind: 'deny',
          decisionReason: `dontAsk 模式: "${toolName}" 需要权限但未预先允许`,
          evidence: decision.evidence,
        };
      }

      case 'bypassPermissions': {
        // bypass 将 ask 转为 allow，除非是不可绕过的操作
        if (decision.decisionReason?.includes('显式 ask')) {
          return decision; // 显式 ask 规则仍然触发审批
        }
        return {
          kind: 'allow',
          decisionReason: `bypassPermissions 模式: "${toolName}" 已绕过询问`,
          evidence: decision.evidence,
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
        };
      }
      // 有交互环境：保留 ask 让用户判断
      return decision;
    }

    try {
      const result = await this.autoClassifier.classify(toolName, args);
      if (result.allow) {
        return {
          kind: 'allow',
          decisionReason: `auto 分类器: ${result.reason}`,
          evidence: decision.evidence,
        };
      }
      return {
        kind: 'deny',
        decisionReason: `auto 分类器: ${result.reason}`,
        evidence: decision.evidence,
      };
    } catch {
      // 分类器异常
      if (this.headless) {
        return {
          kind: 'deny',
          decisionReason: `auto 模式: 分类器异常且为 headless 模式，拒绝 "${toolName}"`,
          evidence: decision.evidence,
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
    _args: Record<string, unknown>,
    evidence?: ToolPermissionEvidence,
  ): boolean {
    const planSafeTools = new Set([
      'Read',
      'ReadManyFiles',
      'Glob',
      'Grep',
      'Dir',
      'Bash',
      'PowerShell',
      'WebFetch',
      'WebSearch',
    ]);

    if (!planSafeTools.has(toolName)) {
      return false;
    }

    // Bash/PowerShell 需要额外检查是否为只读命令
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      return evidence?.sideEffect === 'read' || evidence?.sideEffect === 'sensitive-read';
    }

    return true;
  }
}

// ── 辅助函数 ──

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
