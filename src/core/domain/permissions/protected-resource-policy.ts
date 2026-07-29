/**
 * @file 受保护资源策略。
 * 按 managed host、trusted user host、project/local、session、tool candidate 组合 stricter-wins，
 * 低层 allow 不得覆盖高层 ask/deny。
 */

/** 策略层级（值越小优先级越高）。 */
export type PolicyLayer =
  | 'managed'
  | 'trusted-user'
  | 'project'
  | 'session'
  | 'tool';

/** 受保护资源的策略决策。 */
export type ProtectedPolicyDecision = 'deny' | 'ask' | 'allow' | 'none';

/** 受保护资源的检查结果。 */
export interface ProtectedResourceResult {
  readonly decision: ProtectedPolicyDecision;
  readonly layer: PolicyLayer;
  readonly matchedPattern?: string;
  readonly reason: string;
}

/** 一条受保护资源的策略规则。 */
interface ProtectedResourceRule {
  /** 匹配路径的前缀/glob。 */
  readonly pattern: string;
  /** 策略层。 */
  readonly layer: PolicyLayer;
  /** 默认决策。 */
  readonly decision: 'deny' | 'ask';
  /** 规则说明。 */
  readonly reason: string;
}

// ── managed 层规则（不可被任何低层覆盖）──

const MANAGED_RULES: readonly ProtectedResourceRule[] = [
  { pattern: '.git/', layer: 'managed', decision: 'deny', reason: 'Git 对象和引用不可被工具直接修改' },
  { pattern: '.git', layer: 'managed', decision: 'deny', reason: 'Git 元数据不可被工具直接修改' },
  { pattern: '.myagent/settings.json', layer: 'managed', decision: 'deny', reason: 'MyAgent 用户设置不可由工具修改' },
  { pattern: '.myagent/settings.local.json', layer: 'managed', decision: 'deny', reason: 'MyAgent 项目设置不可由工具修改' },
  { pattern: '.myagent/rules/', layer: 'managed', decision: 'deny', reason: '权限规则文件不可由工具直接修改' },
  { pattern: '.myagent/hooks/', layer: 'managed', decision: 'deny', reason: 'MyAgent hooks 不可由工具直接修改' },
  { pattern: '.env', layer: 'managed', decision: 'deny', reason: '环境变量文件包含敏感凭据' },
  { pattern: '.env*', layer: 'managed', decision: 'deny', reason: '环境变量文件包含敏感凭据' },
  { pattern: '.npmrc', layer: 'managed', decision: 'deny', reason: '包管理器配置可能包含访问令牌' },
  { pattern: '.pypirc', layer: 'managed', decision: 'deny', reason: '包管理器配置可能包含访问令牌' },
  { pattern: 'credentials.json', layer: 'managed', decision: 'deny', reason: '凭据文件不可由普通工具直接访问' },
];

// ── trusted-user 层规则（可由 managed 覆盖，但覆盖 project/session）──

const TRUSTED_USER_RULES: readonly ProtectedResourceRule[] = [
  { pattern: '.husky/', layer: 'trusted-user', decision: 'ask', reason: 'Git hooks 可执行文件需谨慎修改' },
  { pattern: '.vscode/', layer: 'trusted-user', decision: 'ask', reason: 'IDE 配置变更需确认' },
  { pattern: '.idea/', layer: 'trusted-user', decision: 'ask', reason: 'IDE 配置变更需确认' },
];
/** 当前项目由宿主维护的候选 provenance 暂存根。 */
let protectedMemoryCandidateRoot: string | null = null;

/**
 * 注入当前项目的内部候选暂存根。
 * 该根由宿主 MemoryCandidateStore 写入，普通工具即使位于默认 memory 根也不得访问。
 *
 * @param candidateRoot - 已物理规范化的候选根；null 表示未启用 memory
 */
export function setProtectedMemoryCandidateRoot(candidateRoot: string | null): void {
  protectedMemoryCandidateRoot = candidateRoot
    ? normalizePath(candidateRoot).replace(/\/+$/, '')
    : null;
}

/** 路径分隔符归一化。 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** 使用路径分段匹配受保护名称，避免普通文件名子串误命中。 */
function matchesProtectedPattern(path: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.endsWith('*')) {
    const prefix = normalizedPattern.slice(0, -1);
    const filename = path.split('/').at(-1) ?? '';
    return filename.startsWith(prefix);
  }
  if (normalizedPattern.endsWith('/')) {
    return path.includes(`/${normalizedPattern}`)
      || path.startsWith(normalizedPattern);
  }
  return path === normalizedPattern
    || path.endsWith(`/${normalizedPattern}`)
    || path.includes(`/${normalizedPattern}/`);
}

/**
 * 检查路径是否命中受保护资源策略。
 * 按 managed → trusted-user → project → session → tool 顺序 stricter-wins。
 *
 * @param targetPath - 待检查的绝对路径
 * @param operation - 操作类型（read/write）
 * @returns 命中策略的结果；未命中时返回 { decision: 'none' }
 */
export function checkProtectedResource(
  targetPath: string,
  operation: 'read' | 'write',
): ProtectedResourceResult {
  const normalized = normalizePath(targetPath);
  if (
    protectedMemoryCandidateRoot
    && (
      normalized === protectedMemoryCandidateRoot
      || normalized.startsWith(`${protectedMemoryCandidateRoot}/`)
    )
  ) {
    return {
      decision: 'deny',
      layer: 'managed',
      matchedPattern: 'memory-candidate-staging-root',
      reason: '记忆候选 provenance 暂存区只能由宿主管理',
    };
  }
  // 示例模板不包含真实凭据，继续按普通文件规则处理。
  if ((normalized.split('/').at(-1) ?? '') === '.env.example') {
    return { decision: 'none', layer: 'managed', reason: '环境变量示例文件不属于凭据文件' };
  }

  // managed 层：最高优先级
  for (const rule of MANAGED_RULES) {
    if (matchesProtectedPattern(normalized, rule.pattern)) {
      // managed deny 即使 read 也拒绝（读敏感文件也受限）
      return {
        decision: operation === 'write' ? 'deny' : rule.decision,
        layer: 'managed',
        matchedPattern: rule.pattern,
        reason: rule.reason,
      };
    }
  }

  // trusted-user 层
  for (const rule of TRUSTED_USER_RULES) {
    if (matchesProtectedPattern(normalized, rule.pattern)) {
      // 用户层对读操作宽松
      if (operation === 'read') {
        return { decision: 'allow', layer: 'trusted-user', matchedPattern: rule.pattern, reason: '读取 IDE 配置' };
      }
      return {
        decision: rule.decision,
        layer: 'trusted-user',
        matchedPattern: rule.pattern,
        reason: rule.reason,
      };
    }
  }

  return { decision: 'none', layer: 'managed', reason: '未命中受保护资源策略' };
}
