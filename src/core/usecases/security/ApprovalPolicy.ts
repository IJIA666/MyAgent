/**
 * @fileoverview 中央审批策略服务。
 * 职责：接收工具层上报的 SafetyOperation，交叉校验资源真实性，
 * 根据操作类型、WorkMode 和资源类型动态生成受信的 ApprovalRequest，
 * 并将用户 choiceId 映射为具体的授权效果（PendingGrant / PersistentRuleEffect / deny）。
 */

import type { SafetyResource } from './SafetyResource.js';
import type { SafetyOperation, ApprovalChoiceId, ApprovalChoice, ApprovalRequest, PendingGrant, PersistentRuleEffect } from '../plugins/plugin-types.js';
import type { ResourceExtractor } from '../../../ports/driven/tools/ToolAccessMetadataPort.js';

/** 资源分类规则键 */
type RuleKey = 'path+read' | 'path+write' | 'directory-scope' | 'command-prefix' | 'hardline' | 'sensitive-file' | 'untrusted';

/** choice 生成规则矩阵：资源类型 → 可用 choice 列表 */
const CHOICE_RULES: Record<RuleKey, ApprovalChoiceId[]> = {
  'path+read':      ['call', 'session', 'deny'],
  'path+write':     ['call', 'session', 'deny'],
  'directory-scope': ['call', 'session', 'deny'],
  'command-prefix': ['call', 'persistent', 'deny'],
  'hardline':       ['deny'],
  'sensitive-file': ['call', 'deny'],
  'untrusted':      ['call', 'deny'],
};

/** 硬红线命令前缀列表 */
const HARDLINE_PREFIXES: string[] = [
  'rm -rf /',
  'rm -rf /*',
  'mkfs',
  'dd if=',
  '> /dev/sd',
  ':(){ :|:& };:',
];

/** 敏感文件路径模式列表（仅匹配 basename） */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env$/,
  /^\.env\./,
  /^\.ssh\//,
  /^id_rsa$/,
  /^id_ed25519$/,
  /^\.gitconfig$/,
  /^\.aws\//,
  /^\.kube\//,
  /^\.docker\//,
  /^credentials$/,
  /^secrets\//,
];

/** choice 展示标签映射 */
const CHOICE_LABELS: Record<ApprovalChoiceId, { label: string; description: string }> = {
  call:       { label: '单次放行',      description: '仅本次操作放行，下次仍会询问' },
  session:    { label: '会话始终放行',  description: '本次会话内所有相同操作自动放行' },
  persistent: { label: '永久放行',      description: '将该命令前缀加入永久白名单' },
  deny:       { label: '拒绝',          description: '拒绝本次操作' },
};

/**
 * 中央审批策略服务。
 * 不持有状态，可安全地作为单例在组合根中装配并注入 HumanApprovalPlugin。
 */
export class ApprovalPolicy {
  /** 资源提取器注册表：工具名 → 提取器函数 */
  private resourceExtractors = new Map<string, ResourceExtractor>();

  /**
   * 注册一个资源提取器。
   * 每个内置工具在注册时应同时调用此方法登记其提取器。
   *
   * @param toolName - 工具名称
   * @param extractor - 从工具参数中提取 SafetyResource[] 的函数
   */
  public registerExtractor(toolName: string, extractor: ResourceExtractor): void {
    this.resourceExtractors.set(toolName, extractor);
  }

  /**
   * 校验工具层报告的 SafetyOperation 并生成受信的审批请求。
   *
   * 流程：
   * 1. 若存在注册的资源提取器，重新计算资源并与 operation.resources 交叉校验
   * 2. 根据资源类型和 WorkMode 生成 choice 列表
   * 3. 第三方工具（无可信提取器）仅允许 call 或 deny
   *
   * @param params - 解析参数
   * @returns 受信的审批请求
   */
  public resolve(params: {
    toolName: string;
    toolArgs: Record<string, unknown>;
    operation: SafetyOperation;
    workMode: string;
  }): ApprovalRequest {
    const { toolName, toolArgs, operation } = params;

    // 1. 资源交叉校验（仅内置工具）
    const extractor = this.resourceExtractors.get(toolName);

    if (!extractor) {
      // 第三方工具无可信提取器 → fail closed，仅 call/deny
      return this.buildLimitedRequest(toolName, operation.summary, 'untrusted');
    }

    // 内置工具有提取器 → 重新计算并交叉校验
    const validatedResources = extractor(toolArgs);
    const reportedResources = operation.resources;
    const hasReportedResources = reportedResources.length > 0;

    if (hasReportedResources && !this.areResourcesMatching(validatedResources, reportedResources)) {
      // 提取器结果与工具报告不匹配 → 拒绝
      return this.buildDenyRequest(toolName, `工具 "${toolName}" 报告的资源与参数提取结果不匹配，操作已被拒绝。`);
    }

    const effectiveResources = hasReportedResources ? reportedResources : validatedResources;
    const normalizedOperation: SafetyOperation = {
      ...operation,
      resources: effectiveResources
    };

    // 2. 硬红线检查（基于完整命令，而非仅前缀）
    if (this.isHardlineCommand(effectiveResources, toolName, toolArgs)) {
      return this.buildDenyRequest(toolName, `操作 "${toolName}" 触发了安全红线规则，已被系统拒绝。`);
    }

    // 2.1 命令工具未提取出可持久化前缀时，仅允许 call / deny
    if (normalizedOperation.operationCategory === 'command-execute' && effectiveResources.length === 0) {
      return this.buildLimitedRequest(toolName, normalizedOperation.summary, 'untrusted', normalizedOperation);
    }

    // 2.2 其它类型若仍无受信资源，则拒绝
    if (effectiveResources.length === 0) {
      return this.buildDenyRequest(toolName, `工具 "${toolName}" 未提供可校验的受信资源，操作已被拒绝。`);
    }

    // 3. 敏感文件检查
    if (this.isSensitiveFile(effectiveResources)) {
      return this.buildLimitedRequest(toolName, normalizedOperation.summary, 'sensitive-file', normalizedOperation);
    }

    // 4. 根据资源类型聚合 choice 规则
    const ruleKeys = this.classifyResources(effectiveResources);
    const mergedChoices = this.mergeChoiceRules(ruleKeys);
    const hasDirectoryScope = effectiveResources.some(r => r.kind === 'directory-scope');
    const choices: ApprovalChoice[] = mergedChoices.map((choiceId) => {
      // 目录范围资源的 session 选项描述应明确告知子树授权范围
      if (choiceId === 'session' && hasDirectoryScope) {
        return {
          choiceId,
          label: '会话始终放行',
          description: '本次会话内允许读取该目录及其所有子目录，不再逐一确认',
        };
      }
      return {
        choiceId,
        label: CHOICE_LABELS[choiceId].label,
        description: CHOICE_LABELS[choiceId].description,
      };
    });

    return {
      id: `approval_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
      message: normalizedOperation.summary,
      choices,
      operation: normalizedOperation
    };
  }

  /**
   * 将用户选择的 choiceId 映射为具体的授权效果。
   * 注意：persistent 仅对 command-prefix 资源生效；对其他资源类型降级为 deny。
   *
   * @param choiceId - 用户选择的审批项标识
   * @param operation - 标准化操作描述
   * @param toolName - 工具名称
   * @returns 授权效果对象，包含 type 及对应的 payload
   */
  public static mapChoiceToEffect(
    choiceId: ApprovalChoiceId,
    operation: SafetyOperation,
    toolName: string
  ): { type: 'call' | 'session' | 'persistent' | 'deny'; payload?: PendingGrant | PersistentRuleEffect } {
    switch (choiceId) {
      case 'call':
        return {
          type: 'call',
          payload: { type: 'call', toolCallId: '', toolName, resources: operation.resources } as PendingGrant,
        };
      case 'session': {
        // 保留 path 和 directory-scope 资源，command-prefix 不进入会话授权
        const retained = operation.resources.filter(
          (r): r is SafetyResource & ({ kind: 'path' } | { kind: 'directory-scope' }) =>
            r.kind === 'path' || r.kind === 'directory-scope'
        );
        return {
          type: 'session',
          payload: { type: 'session', toolCallId: '', resources: retained } as PendingGrant,
        };
      }
      case 'persistent': {
        const prefixResource = operation.resources.find(
          (r): r is SafetyResource & { kind: 'command-prefix' } => r.kind === 'command-prefix'
        );
        if (!prefixResource) {
          // persistent 对非命令资源降级为 deny
          return { type: 'deny' };
        }
        return {
          type: 'persistent',
          payload: { type: 'persistent', prefix: prefixResource.prefix } as PersistentRuleEffect,
        };
      }
      case 'deny':
        return { type: 'deny' };
    }
  }

  // ──── 私有辅助方法 ────

  /** 构建仅含 deny 的审批请求 */
  private buildDenyRequest(toolName: string, message: string): ApprovalRequest {
    return {
      id: `approval_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
      message,
      choices: [
        {
          choiceId: 'deny',
          label: CHOICE_LABELS.deny.label,
          description: CHOICE_LABELS.deny.description,
        },
      ],
    };
  }

  /** 构建受限 choice 的审批请求（用于敏感文件、untrusted 等场景） */
  private buildLimitedRequest(
    toolName: string,
    summary: string,
    ruleKey: RuleKey,
    operation?: SafetyOperation
  ): ApprovalRequest {
    const choiceIds = CHOICE_RULES[ruleKey];
    return {
      id: `approval_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
      message: summary,
      choices: choiceIds.map((choiceId) => ({
        choiceId,
        label: CHOICE_LABELS[choiceId].label,
        description: CHOICE_LABELS[choiceId].description,
      })),
      operation
    };
  }

  /** 交叉校验提取器结果与工具层报告的资源是否一致 */
  private areResourcesMatching(
    extected: SafetyResource[],
    reported: SafetyResource[]
  ): boolean {
    if (extected.length !== reported.length) return false;

    // 将两个集合序列化为可比较的形式
    const serialize = (r: SafetyResource): string => {
      if (r.kind === 'path') return `path:${r.access}:${r.normalizedPath}`;
      if (r.kind === 'directory-scope') return `directory-scope:read:${r.normalizedPath}`;
      return `command-prefix:${r.prefix}`;
    };

    const extectedSet = new Set(extected.map(serialize));
    const reportedSet = new Set(reported.map(serialize));

    // 检查完整包含关系：提取器结果是可信基准，reported 必须完全匹配
    if (extectedSet.size !== reportedSet.size) return false;
    for (const s of extectedSet) {
      if (!reportedSet.has(s)) return false;
    }
    return true;
  }

  /** 检查是否命中硬红线命令（基于已决议 shell 语义 + 命令字符串） */
  private isHardlineCommand(resources: SafetyResource[], toolName: string, toolArgs: Record<string, unknown>): boolean {
    if (toolName !== 'execute_command') {
      return false;
    }
    const command = (toolArgs.command as string) || '';
    if (!command) return false;

    // 已决议的 shell family 信息由 checkSafety 阶段传入 toolArgs.shellKind，
    // 消除了旧版 bash/powershell 工具名不一致的隐患

    for (const prefix of HARDLINE_PREFIXES) {
      if (command.startsWith(prefix) || command.includes(prefix)) {
        return true;
      }
    }
    return false;
  }

  /** 检查是否涉及敏感文件 */
  private isSensitiveFile(resources: SafetyResource[]): boolean {
    for (const r of resources) {
      if (r.kind === 'path') {
        const basename = r.normalizedPath.split(/[/\\]/).pop() || '';
        for (const pattern of SENSITIVE_FILE_PATTERNS) {
          if (pattern.test(basename) || pattern.test(r.normalizedPath)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** 将安全资源分类为规则键列表 */
  private classifyResources(resources: SafetyResource[]): RuleKey[] {
    const keys = new Set<RuleKey>();
    for (const r of resources) {
      if (r.kind === 'path') {
        keys.add(r.access === 'read' ? 'path+read' : 'path+write');
      } else if (r.kind === 'directory-scope') {
        keys.add('directory-scope');
      } else if (r.kind === 'command-prefix') {
        keys.add('command-prefix');
      }
    }
    return Array.from(keys);
  }

  /** 合并多个规则键的 choice 列表（取交集，保证 deny 始终存在） */
  private mergeChoiceRules(ruleKeys: RuleKey[]): ApprovalChoiceId[] {
    if (ruleKeys.length === 0) return ['deny'];

    // 收集各规则的 choice 集
    const sets = ruleKeys.map((key) => new Set(CHOICE_RULES[key]));

    // 取交集
    const merged = new Set<ApprovalChoiceId>(sets[0]);
    for (let i = 1; i < sets.length; i++) {
      for (const choice of merged) {
        if (!sets[i].has(choice)) {
          merged.delete(choice);
        }
      }
    }

    // 保证 deny 始终存在
    merged.add('deny');

    // 按固定序排列：call → session → persistent → deny
    const order: ApprovalChoiceId[] = ['call', 'session', 'persistent', 'deny'];
    return order.filter((c) => merged.has(c));
  }
}
