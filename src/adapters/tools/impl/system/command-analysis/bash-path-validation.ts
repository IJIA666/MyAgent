/**
 * 提供 Bash 文件路径、重定向、工作目录和 Git 控制路径检查。
 * 检查采用 deny 优先的两遍扫描，项目外路径本身不构成拒绝理由。
 */

import path from 'node:path';
import type { PermissionRule } from '../../../../../core/domain/permissions/permission-types.js';
import type { PermissionRuleStore } from '../../../../../core/domain/permissions/rule-store.js';
import { resolveBashCommandView } from './bash-read-only.js';
import type { AtomicResourceOperand, CommandSegmentAnalysis, ShellCommandAnalysis } from './types.js';

/** Bash 路径校验结果。 */
export interface BashPathValidationResult {
  /** 路径层建议的行为。 */
  readonly behavior: 'ask' | 'deny';
  /** 稳定原因代码。 */
  readonly code: string;
  /** 面向用户的主要说明。 */
  readonly message: string;
  /** 命中的显式路径规则。 */
  readonly matchedRule?: PermissionRule;
}

/** 一次可用于路径规则匹配的资源访问。 */
interface BashPathOperand {
  /** 访问方向。 */
  readonly access: AtomicResourceOperand['access'];
  /** 原始路径表达式。 */
  readonly rawPath: string;
  /** 静态解析后的路径。 */
  readonly resolvedPath?: string;
  /** 路径是否依赖运行时求值。 */
  readonly dynamic: boolean;
}

/** 添加去重后的路径结果。 */
function addResult(results: BashPathValidationResult[], result: BashPathValidationResult): void {
  if (!results.some(existing => existing.code === result.code && existing.message === result.message)) {
    results.push(result);
  }
}

/** 判断原始路径是否指向 POSIX 根目录。 */
function isRootPath(rawPath: string): boolean {
  return ['/', '/*', '/**'].includes(rawPath.replace(/['"]/gu, '').trim());
}

/** 判断路径是否包含运行时表达式或 glob。 */
function isDynamicPath(rawPath: string): boolean {
  return /[$`{}]/u.test(rawPath);
}

/** 将静态路径解析到实际 cwd。 */
function resolveStaticPath(rawPath: string, cwd: string): string | undefined {
  if (isDynamicPath(rawPath) || rawPath.startsWith('-')) return undefined;
  const unquoted = rawPath.replace(/^['"]|['"]$/gu, '');
  return path.resolve(cwd, unquoted);
}

/** 从原子资源证据收集文件系统路径。 */
function collectPathOperands(
  analysis: Readonly<ShellCommandAnalysis>,
  cwd: string,
): readonly BashPathOperand[] {
  const evidenceOperands = analysis.subcommands.flatMap(segment => segment.evidence.resourceOperands
    .filter(operand => operand.kind === 'filesystem')
    .map(operand => ({
      access: operand.access,
      rawPath: operand.rawValue,
      resolvedPath: operand.dynamic ? undefined : resolveStaticPath(operand.rawValue, cwd),
      // 只读 glob 由 Shell 展开后仍保持只读；写操作的 glob 继续视为动态路径。
      dynamic: isDynamicPath(operand.rawValue) || (
        operand.dynamic && (operand.access !== 'read' || !/[*?[\]]/u.test(operand.rawValue))
      ),
    })));
  const inferredOperands = analysis.subcommands.flatMap(segment => inferCommandPathOperands(segment, cwd));
  const unique = new Map<string, BashPathOperand>();
  for (const operand of [...evidenceOperands, ...inferredOperands]) {
    unique.set(`${operand.access}:${operand.rawPath}`, operand);
  }
  return [...unique.values()];
}

/** 为旧原子目录尚未标注的常用 Bash 文件命令补充路径操作数。 */
function inferCommandPathOperands(
  segment: Readonly<CommandSegmentAnalysis>,
  cwd: string,
): readonly BashPathOperand[] {
  const view = resolveBashCommandView(segment);
  const readCommands = new Set(['cat', 'file', 'head', 'ls', 'readlink', 'realpath', 'stat', 'tail', 'wc']);
  const writeCommands = new Set(['mkdir', 'rm', 'rmdir', 'tee', 'touch']);
  const access: AtomicResourceOperand['access'] | undefined = readCommands.has(view.executable)
    ? 'read'
    : writeCommands.has(view.executable) ? 'write' : undefined;
  if (!access) return [];
  return view.arguments
    .filter(argument => !argument.startsWith('-'))
    .map(rawPath => ({
      access,
      rawPath,
      resolvedPath: resolveStaticPath(rawPath, cwd),
      dynamic: isDynamicPath(rawPath) || (access !== 'read' && /[*?[\]]/u.test(rawPath)),
    }));
}

/** 读取路径规则对应的工具名。 */
function getPathRuleTool(access: AtomicResourceOperand['access']): 'Read' | 'Edit' {
  return access === 'read' ? 'Read' : 'Edit';
}

/** 查找一个路径命中的最高优先级显式规则。 */
function findPathRule(
  operand: Readonly<BashPathOperand>,
  rules: PermissionRuleStore,
): PermissionRule | undefined {
  const toolName = getPathRuleTool(operand.access);
  const candidates = [operand.resolvedPath, operand.rawPath].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    const rule = rules.getMatchingRules(toolName, candidate)[0];
    if (rule) return rule;
  }
  return undefined;
}

/** 判断 rm 是否递归强制删除根目录。 */
function isRecursiveForcedRootRemoval(segment: Readonly<CommandSegmentAnalysis>): boolean {
  const view = resolveBashCommandView(segment);
  if (view.executable !== 'rm') return false;
  const flags = view.arguments.filter(argument => argument.startsWith('-')).join('');
  const recursive = flags.includes('r') || view.arguments.includes('--recursive');
  const forced = flags.includes('f') || view.arguments.includes('--force');
  return recursive && forced && view.arguments.some(isRootPath);
}

/** 判断路径是否为常见敏感读取或凭据位置。 */
function isSensitivePath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/gu, '/').toLowerCase();
  return /(^|\/)\.ssh(\/|$)|(^|\/)\.gnupg(\/|$)|(^|\/)etc\/(shadow|sudoers)(\/|$)|credentials|\.env($|\.)/u.test(normalized);
}

/** 检查重定向、cwd、链接和 Git 控制路径风险。 */
function validateSegmentPaths(
  segment: Readonly<CommandSegmentAnalysis>,
  results: BashPathValidationResult[],
): void {
  const view = resolveBashCommandView(segment);
  for (const redirection of segment.redirections ?? []) {
    if (!redirection.target || isDynamicPath(redirection.target)) {
      addResult(results, { behavior: 'ask', code: 'bash.dynamic-redirection', message: '重定向目标无法静态确定' });
    } else if (!redirection.operator.startsWith('<') || redirection.operator === '<<<') {
      addResult(results, { behavior: 'ask', code: 'bash.output-redirection', message: '命令会通过重定向写入文件' });
    }
  }
  if (view.executable === 'cd' && (view.arguments.length === 0 || view.arguments.some(isDynamicPath))) {
    addResult(results, { behavior: 'ask', code: 'bash.dynamic-cwd', message: '命令会将工作目录切换到运行时路径' });
  }
  if (view.executable === 'ln' && view.arguments.some(argument => ['-s', '--symbolic', '--relative'].includes(argument))) {
    addResult(results, { behavior: 'ask', code: 'bash.link-creation', message: '命令会创建符号链接' });
  }
  if (view.arguments.some(argument => /(^|[/\\])\.git([/\\]|$)|(^|[/\\])(hooks|HEAD|refs|objects)([/\\]|$)/u.test(argument))) {
    addResult(results, { behavior: 'ask', code: 'bash.git-internal-path', message: '命令会访问 Git 控制目录或内部对象' });
  }
  if (view.executable === 'git' && view.arguments.some(argument => argument === '--bare' || argument.startsWith('--git-dir') || argument.startsWith('--work-tree'))) {
    addResult(results, { behavior: 'ask', code: 'bash.git-path-control', message: 'Git 参数会改变仓库或工作树路径' });
  }
  if (view.executable === 'git' && view.arguments[0] === 'archive' && view.arguments.some(argument => argument.includes('.git'))) {
    addResult(results, { behavior: 'ask', code: 'bash.git-archive-control', message: 'Git archive 目标涉及仓库控制路径' });
  }
}

/**
 * 检查 Bash 路径、规则、重定向和危险删除。
 *
 * @param analysis - Bash 结构分析结果
 * @param cwd - 命令实际执行目录
 * @param rules - 当前权限规则存储
 * @returns deny 优先排列的全部路径结果
 */
export function validateBashPaths(
  analysis: Readonly<ShellCommandAnalysis>,
  cwd: string,
  rules: PermissionRuleStore,
): readonly BashPathValidationResult[] {
  const operands = collectPathOperands(analysis, cwd);
  const denyResults: BashPathValidationResult[] = [];
  const askResults: BashPathValidationResult[] = [];

  // 第一遍只处理不可绕过根目录删除和显式 deny。
  for (const segment of analysis.subcommands) {
    if (isRecursiveForcedRootRemoval(segment)) {
      addResult(denyResults, { behavior: 'deny', code: 'bash.root-removal', message: '禁止递归强制删除文件系统根目录' });
    }
  }
  for (const operand of operands) {
    const rule = findPathRule(operand, rules);
    if (rule?.ruleBehavior === 'deny') {
      addResult(denyResults, { behavior: 'deny', code: 'bash.path-rule-deny', message: '路径命中显式拒绝规则', matchedRule: rule });
    }
  }

  // 第二遍收集普通 ask，确保不会遮蔽前面的 deny。
  for (const operand of operands) {
    const rule = findPathRule(operand, rules);
    if (rule?.ruleBehavior === 'ask') {
      addResult(askResults, { behavior: 'ask', code: 'bash.path-rule-ask', message: '路径命中显式询问规则', matchedRule: rule });
    } else if (operand.dynamic) {
      addResult(askResults, { behavior: 'ask', code: 'bash.dynamic-path', message: '文件路径依赖运行时表达式或 glob' });
    } else if (isSensitivePath(operand.rawPath)) {
      addResult(askResults, { behavior: 'ask', code: 'bash.sensitive-path', message: '命令会访问敏感配置或凭据路径' });
    }
  }
  analysis.subcommands.forEach(segment => validateSegmentPaths(segment, askResults));
  return [...denyResults, ...askResults];
}
