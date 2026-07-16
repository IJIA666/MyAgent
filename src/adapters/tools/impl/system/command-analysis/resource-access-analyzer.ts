/**
 * 将原子资源 operand 与 PowerShell 表达式证据解析为通用资源访问事实。
 * 本模块维护有效 cwd，但不根据资源范围作最终权限决策。
 */

import { homedir } from 'os';
import { isAbsolute, parse, relative, resolve, win32 } from 'path';
import type {
  AtomicResourceOperand,
  CommandSegmentAnalysis,
  ResourceAccessCertainty,
  ResourceAccessEvidence,
  ResourceAccessKind,
  ResourceAccessOperation,
  ResourceAccessScope,
  ShellCommandAnalysis,
  ShellResourceAnalysisContext,
} from './types.js';

const SENSITIVE_PATH_PATTERNS = [
  /(?:^|[/\\])\.env(?:\.|$)/i,
  /(?:^|[/\\])\.ssh(?:[/\\]|$)/i,
  /(?:^|[/\\])id_(?:rsa|ed25519)$/i,
  /(?:^|[/\\])\.gitconfig$/i,
  /(?:^|[/\\])\.(?:aws|kube|docker)(?:[/\\]|$)/i,
  /(?:^|[/\\])credentials$/i,
  /(?:^|[/\\])secrets(?:[/\\]|$)/i,
] as const;

const DIRECTORY_RESOURCE_COMMANDS = new Set([
  'cd', 'dir', 'find', 'get-childitem', 'git', 'ls', 'mkdir', 'pwd', 'set-location',
]);

const IMPLICIT_CWD_COMMANDS = new Set(['dir', 'find', 'get-childitem', 'git', 'ls']);
const CREATE_COMMANDS = new Set(['mkdir', 'new-item', 'touch']);
const DELETE_COMMANDS = new Set(['del', 'erase', 'rd', 'remove-item', 'rm', 'rmdir']);

interface LiteralBinding {
  readonly statementIndex: number;
  readonly value: string;
}

interface ResolvedExpression {
  readonly value?: string;
  readonly certainty: ResourceAccessCertainty;
  readonly reason: string;
}

interface PhysicalResolution {
  readonly value?: string;
  readonly failed: boolean;
}

/** 判断路径文本是否命中已有敏感资源事实规则。 */
export function isSensitiveFilesystemPath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(path));
}

/** 移除一组完整包裹资源表达式的引号。 */
function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  return trimmed.length >= 2 && (first === '"' || first === "'") && trimmed.at(-1) === first
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** 判断静态资源是否包含 Shell 通配模式。 */
function hasWildcard(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[');
}

/** 判断规范路径是否位于工作区内。 */
function isWithinWorkspace(workspaceRoot: string, target: string): boolean {
  const windowsPaths = win32.isAbsolute(workspaceRoot) && win32.isAbsolute(target);
  const relation = windowsPaths ? win32.relative(workspaceRoot, target) : relative(workspaceRoot, target);
  const absoluteRelation = windowsPaths ? win32.isAbsolute(relation) : isAbsolute(relation);
  return relation === '' || (!relation.startsWith('..') && !absoluteRelation);
}

/** 判断路径是否属于明显的操作系统级位置。 */
function isSystemFilesystemPath(target: string): boolean {
  const normalized = target.replace(/\//g, '\\');
  const root = win32.isAbsolute(normalized) ? win32.parse(normalized).root : parse(normalized).root;
  if (normalized.toLowerCase() === root.toLowerCase()) {
    return true;
  }
  return /^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|$)/i.test(normalized)
    || normalized.startsWith('\\\\.\\');
}

/** 根据命令身份细化资源种类。 */
function inferFilesystemKind(segment: CommandSegmentAnalysis): ResourceAccessKind {
  return DIRECTORY_RESOURCE_COMMANDS.has(segment.executable) ? 'directory' : 'file';
}

/** 根据原子访问与命令身份细化 create/delete 操作。 */
function inferOperation(
  segment: CommandSegmentAnalysis,
  operand: AtomicResourceOperand,
): ResourceAccessOperation {
  if (operand.access === 'write' && DELETE_COMMANDS.has(segment.executable)) return 'delete';
  if (operand.access === 'write' && CREATE_COMMANDS.has(segment.executable)) return 'create';
  return operand.access;
}

/** 从简单的 PowerShell 字符串赋值中提取局部变量来源。 */
function collectLiteralBindings(analysis: Readonly<ShellCommandAnalysis>): ReadonlyMap<string, LiteralBinding[]> {
  const bindings = new Map<string, LiteralBinding[]>();
  for (const statement of analysis.powershellProgram?.statements ?? []) {
    const match = /^\s*\$(?:local:)?([a-z_][a-z0-9_]*)\s*=\s*(['"])(.*?)\2\s*$/is.exec(statement.text);
    if (!match?.[1] || match[3] === undefined) continue;
    const key = match[1].toLowerCase();
    const existing = bindings.get(key) ?? [];
    existing.push({ statementIndex: statement.index, value: match[3] });
    bindings.set(key, existing);
  }
  return bindings;
}

/** 将静态字符串、cwd 或可追踪局部变量解析为资源值。 */
function resolveExpression(
  operand: AtomicResourceOperand,
  statementIndex: number | undefined,
  effectiveCwd: string,
  bindings: ReadonlyMap<string, LiteralBinding[]>,
): ResolvedExpression {
  const raw = unquote(operand.rawValue);
  if (!operand.dynamic) {
    return {
      value: raw,
      certainty: hasWildcard(raw) ? 'pattern' : 'exact',
      reason: '资源参数是静态字符串',
    };
  }
  if (/^\$\{?pwd\}?$/i.test(raw)) {
    return { value: effectiveCwd, certainty: 'exact', reason: 'PowerShell $PWD 解析为当前有效 cwd' };
  }
  const variable = /^\$(?:local:)?([a-z_][a-z0-9_]*)$/i.exec(raw)?.[1]?.toLowerCase();
  if (variable !== undefined) {
    const candidates = bindings.get(variable) ?? [];
    const binding = [...candidates].reverse().find(item => (
      statementIndex === undefined || item.statementIndex < statementIndex
    ));
    if (binding !== undefined) {
      return {
        value: binding.value,
        certainty: 'symbolic',
        reason: `局部变量 $${variable} 来源于静态字符串赋值`,
      };
    }
    return { certainty: 'symbolic', reason: `变量 $${variable} 的运行时值未静态确定` };
  }
  if (/^\$[a-z_][\w:]*(?:\.[a-z_]\w*)*$/i.test(raw)) {
    return { certainty: 'symbolic', reason: '成员或作用域变量保留为符号资源' };
  }
  return { certainty: 'unknown', reason: '资源参数包含无法静态求值的表达式' };
}

/** 根据路径与操作计算事实范围。 */
function classifyFilesystemScope(
  raw: string,
  resolved: string | undefined,
  operation: ResourceAccessOperation,
  workspaceRoot: string,
): ResourceAccessScope {
  if (operation === 'read' && isSensitiveFilesystemPath(resolved ?? raw)) return 'sensitive';
  if (resolved === undefined) return 'unknown';
  if (isWithinWorkspace(workspaceRoot, resolved)) return 'workspace';
  return isSystemFilesystemPath(resolved) ? 'system' : 'external';
}

/** 解析文件系统路径；盘符相对路径保持 symbolic，避免套用错误 cwd。 */
function resolveFilesystemPath(value: string, effectiveCwd: string): string | undefined {
  if (/^[a-z]:[^\\/]/i.test(value)) return undefined;
  if (value === '~' || value.startsWith('~\\') || value.startsWith('~/')) {
    return resolve(homedir(), value.slice(1).replace(/^[\\/]/, ''));
  }
  if (win32.isAbsolute(value)) return win32.normalize(value);
  if (isAbsolute(value)) return resolve(value);
  return win32.isAbsolute(effectiveCwd)
    ? win32.resolve(effectiveCwd, value)
    : resolve(effectiveCwd, value);
}

/** 对非通配路径应用可选物理解析，失败时保留词法证据而不伪造失败。 */
function resolvePhysicalPath(
  lexicalPath: string | undefined,
  certainty: ResourceAccessCertainty,
  resolver: ShellResourceAnalysisContext['resolvePhysicalPath'],
): PhysicalResolution {
  if (lexicalPath === undefined || certainty === 'pattern' || resolver === undefined) {
    return { value: lexicalPath, failed: false };
  }
  try {
    return { value: resolver(lexicalPath), failed: false };
  } catch {
    return { value: lexicalPath, failed: true };
  }
}

/** 识别 PowerShell provider，并避免把注册表、环境变量等误当文件。 */
function resolvePowerShellProvider(
  rawExpression: string,
  providerValue: string,
  operation: ResourceAccessOperation,
  sourceNodeId: string,
): ResourceAccessEvidence | undefined {
  const provider = /^([a-z][a-z0-9]*):(.*)$/i.exec(providerValue);
  if (!provider?.[1] || provider[1].length === 1) return undefined;
  const name = provider[1].toLowerCase();
  const certainty: ResourceAccessCertainty = hasWildcard(providerValue) ? 'pattern' : 'exact';
  if (['hklm', 'hkcu', 'hkcr', 'hku', 'hkcc', 'registry'].includes(name)) {
    return {
      kind: 'registry', operation, rawExpression, resolvedResource: providerValue,
      baseContext: `${provider[1]}: provider`, scope: 'system', certainty, sourceNodeId,
      reason: 'PowerShell 注册表 provider 资源',
    };
  }
  if (name === 'env') {
    return {
      kind: 'environment', operation, rawExpression, resolvedResource: providerValue,
      baseContext: 'Env: provider', scope: 'system', certainty, sourceNodeId,
      reason: 'PowerShell 环境变量 provider 资源',
    };
  }
  return {
    kind: 'unknown', operation, rawExpression, resolvedResource: providerValue,
    baseContext: `${provider[1]}: provider`, scope: 'system', certainty, sourceNodeId,
    reason: `PowerShell ${provider[1]} provider 尚未细分资源种类`,
  };
}

/** 将一个原子 operand 解析为通用资源证据。 */
function resolveOperand(
  segment: CommandSegmentAnalysis,
  operand: AtomicResourceOperand,
  effectiveCwd: string,
  workspaceRoot: string,
  bindings: ReadonlyMap<string, LiteralBinding[]>,
  physicalResolver: ShellResourceAnalysisContext['resolvePhysicalPath'],
): ResourceAccessEvidence {
  const sourceNodeId = segment.nodePath
    ? `command:${segment.nodePath.join('.')}`
    : `statement:${segment.statementIndex ?? 'atomic'}`;
  const expression = resolveExpression(operand, segment.statementIndex, effectiveCwd, bindings);
  const operation = inferOperation(segment, operand);
  const raw = unquote(operand.rawValue);
  if (operand.kind === 'network') {
    return {
      kind: 'network', operation, rawExpression: raw, resolvedResource: expression.value,
      baseContext: 'network URI', scope: expression.value ? 'external' : 'unknown',
      certainty: expression.certainty, sourceNodeId, reason: expression.reason,
    };
  }
  if (operand.kind === 'process') {
    return {
      kind: 'process', operation, rawExpression: raw, resolvedResource: expression.value,
      baseContext: 'process namespace', scope: 'system', certainty: expression.certainty,
      sourceNodeId, reason: expression.reason,
    };
  }
  const provider = resolvePowerShellProvider(raw, expression.value ?? raw, operation, sourceNodeId);
  if (provider !== undefined) return provider;
  const lexicalPath = expression.value === undefined
    ? undefined
    : resolveFilesystemPath(expression.value, effectiveCwd);
  const certainty = expression.value !== undefined && lexicalPath === undefined
    ? 'symbolic'
    : expression.certainty;
  const physical = resolvePhysicalPath(lexicalPath, certainty, physicalResolver);
  return {
    kind: inferFilesystemKind(segment), operation, rawExpression: raw,
    resolvedResource: physical.value, baseContext: effectiveCwd,
    scope: physical.failed
      ? 'unknown'
      : classifyFilesystemScope(raw, physical.value, operation, workspaceRoot),
    certainty: physical.failed ? 'unknown' : certainty,
    sourceNodeId,
    reason: physical.failed
      ? `${expression.reason}；物理路径解析失败，保留词法路径`
      : physical.value === undefined ? expression.reason : `${expression.reason}；按有效 cwd 解析`,
  };
}

/** 为无显式路径参数但默认作用于 cwd 的命令补充资源 operand。 */
function withImplicitCwdOperand(segment: CommandSegmentAnalysis): readonly AtomicResourceOperand[] {
  const resources = segment.evidence.resourceOperands;
  if (resources.length > 0 || !IMPLICIT_CWD_COMMANDS.has(segment.executable)) return resources;
  return [{
    argumentIndex: -1,
    kind: 'filesystem',
    access: 'read',
    rawValue: '.',
    dynamic: false,
  }];
}

/** 将静态重定向目标补充为文件写资源。 */
function redirectionOperands(segment: CommandSegmentAnalysis): readonly AtomicResourceOperand[] {
  return (segment.redirections ?? []).flatMap(redirection => (
    redirection.target && redirection.sideEffect === 'write'
      ? [{
          argumentIndex: -1,
          kind: 'filesystem' as const,
          access: 'write' as const,
          rawValue: redirection.target,
          dynamic: /\$|`|\$\(/.test(redirection.target),
        }]
      : []
  ));
}

/** 从 PowerShell 表达式摘要补充环境变量和 System.IO.File 资源。 */
function expressionResources(
  analysis: Readonly<ShellCommandAnalysis>,
  context: Readonly<ShellResourceAnalysisContext>,
): readonly ResourceAccessEvidence[] {
  const resources: ResourceAccessEvidence[] = [];
  for (const expression of analysis.powershellProgram?.expressionEffects ?? []) {
    for (const variable of expression.writesVariables) {
      if (!variable.toLowerCase().startsWith('env:')) continue;
      resources.push({
        kind: 'environment', operation: 'mutate', rawExpression: variable,
        resolvedResource: variable, baseContext: 'PowerShell session', scope: 'system',
        certainty: 'exact', sourceNodeId: `statement:${expression.statementIndex}`,
        reason: 'PowerShell 赋值会修改环境变量',
      });
    }
    for (const resourceExpression of expression.resourceExpressions) {
      const argument = /::[a-z0-9_]+\(\s*(['"])(.*?)\1/is.exec(resourceExpression)?.[2];
      if (argument === undefined) continue;
      const operation: ResourceAccessOperation = expression.effects.includes('filesystemWrite') ? 'write' : 'read';
      const certainty: ResourceAccessCertainty = hasWildcard(argument) ? 'pattern' : 'exact';
      const lexicalPath = resolveFilesystemPath(argument, context.cwd);
      const physical = resolvePhysicalPath(lexicalPath, certainty, context.resolvePhysicalPath);
      resources.push({
        kind: 'file', operation, rawExpression: argument, resolvedResource: physical.value,
        baseContext: context.cwd,
        scope: physical.failed
          ? 'unknown'
          : classifyFilesystemScope(argument, physical.value, operation, context.workspaceRoot),
        certainty: physical.failed ? 'unknown' : certainty,
        sourceNodeId: `statement:${expression.statementIndex}`,
        reason: 'System.IO.File 静态方法参数',
      });
    }
  }
  return resources;
}

/** 按稳定字段去重资源证据。 */
function uniqueResources(resources: readonly ResourceAccessEvidence[]): readonly ResourceAccessEvidence[] {
  const seen = new Set<string>();
  return resources.filter(resource => {
    const key = [
      resource.kind, resource.operation, resource.rawExpression,
      resource.resolvedResource ?? '', resource.sourceNodeId,
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 按真实执行顺序解析 Shell 命令访问的资源。
 *
 * @param analysis - 已完成结构、原子行为和嵌套 effect 分析的命令证据
 * @param context - 与实际执行一致的 cwd 和工作区根目录
 * @returns 不包含权限结论的资源访问证据
 */
export function analyzeCommandResources(
  analysis: Readonly<ShellCommandAnalysis>,
  context: Readonly<ShellResourceAnalysisContext>,
): readonly ResourceAccessEvidence[] {
  const bindings = collectLiteralBindings(analysis);
  const resources: ResourceAccessEvidence[] = [];
  let effectiveCwd = context.cwd;
  for (const segment of analysis.subcommands) {
    const operands = [...withImplicitCwdOperand(segment), ...redirectionOperands(segment)];
    const resolved = operands.map(operand => resolveOperand(
      segment,
      operand,
      effectiveCwd,
      context.workspaceRoot,
      bindings,
      context.resolvePhysicalPath,
    ));
    resources.push(...resolved);
    const cwdTransition = (segment.executable === 'set-location' || segment.executable === 'cd')
      && segment.nested !== true
      && segment.connectorBefore !== '&&'
      && segment.connectorBefore !== '||'
      ? resolved.find(resource => resource.kind === 'directory' && resource.resolvedResource !== undefined)
      : undefined;
    if (
      cwdTransition?.resolvedResource !== undefined &&
      (cwdTransition.certainty === 'exact' || cwdTransition.certainty === 'symbolic')
    ) {
      effectiveCwd = cwdTransition.resolvedResource;
    }
  }
  resources.push(...expressionResources(analysis, context));
  return uniqueResources(resources);
}
