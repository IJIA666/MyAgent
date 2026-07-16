/**
 * 对 PowerShell 语义 AST 投影执行有限、可证明的表达式 effect 分析。
 * 未登记的方法、setter 和控制结构保守输出 unknown，不尝试解释完整 PowerShell 语言。
 */

import type {
  PowerShellDataSensitivity,
  PowerShellExpressionConfidence,
  PowerShellExpressionEffect,
  PowerShellExpressionEffectSummary,
  PowerShellExpressionTermination,
  PowerShellProgramSyntax,
  PowerShellSemanticNodeSyntax,
  PowerShellStatementSyntax,
} from './types.js';

const LOOP_AST_TYPES = new Set([
  'DoUntilStatementAst',
  'DoWhileStatementAst',
  'ForEachStatementAst',
  'ForStatementAst',
  'WhileStatementAst',
]);

const FILE_WRITE_METHODS = new Set([
  'appendalllines', 'appendalltext', 'copy', 'create', 'delete', 'move', 'openwrite',
  'replace', 'setattributes', 'setcreationtime', 'setlastaccesstime', 'setlastwritetime',
  'writeallbytes', 'writealllines', 'writealltext',
]);

const FILE_READ_METHODS = new Set([
  'exists', 'getattributes', 'getcreationtime', 'getlastaccesstime', 'getlastwritetime',
  'openread', 'readallbytes', 'readalllines', 'readalltext', 'readlines',
]);

/** 返回去重且保持发现顺序的字符串数组。 */
function unique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

/** 判断变量是否只在当前 PowerShell 子进程的普通局部作用域中绑定。 */
function isLocalVariable(path: string): boolean {
  const lower = path.toLowerCase();
  return !lower.includes(':') || lower.startsWith('local:') || lower.startsWith('private:');
}

/** 判断静态 receiver 是否为 System.Math。 */
function isMathType(typeName: string | undefined): boolean {
  const lower = typeName?.toLowerCase();
  return lower === 'math' || lower === 'system.math';
}

/** 判断静态 receiver 是否为 System.IO.File。 */
function isFileType(typeName: string | undefined): boolean {
  const lower = typeName?.toLowerCase();
  return lower === 'io.file' || lower === 'system.io.file';
}

interface MutableSummary {
  readonly effects: PowerShellExpressionEffect[];
  readonly readsVariables: string[];
  readonly writesVariables: string[];
  readonly resourceExpressions: string[];
  sensitivity: PowerShellDataSensitivity;
  termination: PowerShellExpressionTermination;
  confidence: PowerShellExpressionConfidence;
  readonly reasons: string[];
}

/** 提升摘要可信度的不确定性等级。 */
function markConditional(summary: MutableSummary): void {
  if (summary.confidence === 'proven') {
    summary.confidence = 'conditional';
  }
}

/** 将摘要标记为包含无法证明的行为。 */
function markUnknown(summary: MutableSummary, reason: string): void {
  summary.effects.push('unknown');
  summary.confidence = 'unknown';
  summary.reasons.push(reason);
}

/** 分析单个赋值节点。 */
function analyzeAssignment(node: PowerShellSemanticNodeSyntax, summary: MutableSummary): void {
  const target = node.targetVariablePath;
  if (target === undefined) {
    summary.writesVariables.push(node.targetText ?? node.text);
    markUnknown(summary, '对象属性或动态左值赋值可能触发外部 setter');
    return;
  }
  summary.writesVariables.push(target);
  if (isLocalVariable(target)) {
    summary.effects.push('localMutation');
    summary.reasons.push(`记录局部变量绑定：${target}`);
    return;
  }
  const lower = target.toLowerCase();
  if (lower.startsWith('env:') || lower.startsWith('global:') || lower.startsWith('script:')) {
    summary.effects.push('sessionMutation');
    summary.reasons.push(`赋值会改变当前 PowerShell 会话：${target}`);
    return;
  }
  markUnknown(summary, `无法证明赋值目标没有外部副作用：${target}`);
}

/** 分析静态或实例成员调用。 */
function analyzeMemberInvocation(node: PowerShellSemanticNodeSyntax, summary: MutableSummary): void {
  const method = node.memberName?.toLowerCase();
  if (node.staticMember && isMathType(node.receiverType) && method !== undefined) {
    summary.effects.push('pureTransform');
    summary.reasons.push(`已登记纯数值方法：${node.receiverType}::${node.memberName}`);
    return;
  }
  if (node.staticMember && isFileType(node.receiverType) && method !== undefined) {
    summary.resourceExpressions.push(node.text);
    if (FILE_WRITE_METHODS.has(method)) {
      summary.effects.push('filesystemWrite');
      summary.reasons.push(`System.IO.File::${node.memberName} 会写入文件系统`);
      return;
    }
    if (FILE_READ_METHODS.has(method)) {
      summary.effects.push('filesystemRead');
      summary.reasons.push(`System.IO.File::${node.memberName} 会读取文件系统`);
      return;
    }
  }
  markUnknown(summary, `未登记成员调用：${node.receiverText ?? 'unknown'}.${node.memberName ?? 'unknown'}()`);
}

/** 将一个语义节点合入 statement 摘要。 */
function analyzeNode(node: PowerShellSemanticNodeSyntax, summary: MutableSummary): void {
  if (node.astType === 'AssignmentStatementAst') {
    analyzeAssignment(node, summary);
  }
  if (node.astType === 'VariableExpressionAst' && node.variablePath !== undefined && !node.assignmentTarget) {
    summary.readsVariables.push(node.variablePath);
    if (node.variablePath.toLowerCase().startsWith('env:')) {
      summary.sensitivity = 'sensitive';
      summary.reasons.push(`读取环境变量：${node.variablePath}`);
    } else if (summary.sensitivity === 'public') {
      summary.sensitivity = 'derived';
    }
  }
  if (node.astType === 'InvokeMemberExpressionAst') {
    analyzeMemberInvocation(node, summary);
  } else if (node.astType === 'MemberExpressionAst') {
    // PowerShell 对未知对象属性可能调用自定义 getter，因此只能条件证明。
    markConditional(summary);
    summary.reasons.push(`属性读取保留 receiver 证据：${node.receiverText ?? node.text}`);
  }
  if (LOOP_AST_TYPES.has(node.astType)) {
    summary.termination = 'potentially-unbounded';
    markUnknown(summary, `控制流 ${node.astType} 无法静态证明有界`);
  }
}

/** 为单个 statement 构建表达式摘要。 */
function summarizeStatement(
  statement: PowerShellStatementSyntax,
  nodes: readonly PowerShellSemanticNodeSyntax[],
): PowerShellExpressionEffectSummary {
  const mutable: MutableSummary = {
    effects: [],
    readsVariables: [],
    writesVariables: [],
    resourceExpressions: [],
    sensitivity: 'public',
    termination: 'bounded',
    confidence: 'proven',
    reasons: [],
  };
  for (const node of nodes) {
    analyzeNode(node, mutable);
  }
  return {
    statementIndex: statement.index,
    statementType: statement.statementType,
    effects: unique(mutable.effects),
    readsVariables: unique(mutable.readsVariables),
    writesVariables: unique(mutable.writesVariables),
    resourceExpressions: unique(mutable.resourceExpressions),
    dataSensitivity: mutable.sensitivity,
    termination: mutable.termination,
    confidence: mutable.confidence,
    reason: unique(mutable.reasons).join('；') || '表达式不产生额外外部 effect',
  };
}

/**
 * 为 PowerShell 程序附加逐 statement 的有限表达式语义摘要。
 *
 * @param program - 官方 PowerShell AST 的结构投影
 * @returns 保留原结构并附加表达式摘要的新程序对象
 */
export function analyzePowerShellExpressions(
  program: Readonly<PowerShellProgramSyntax>,
): PowerShellProgramSyntax {
  const expressionEffects = program.statements
    .map(statement => ({
      statement,
      nodes: program.semanticNodes.filter(node => node.statementIndex === statement.index),
    }))
    .filter(entry => entry.nodes.length > 0)
    .map(entry => summarizeStatement(entry.statement, entry.nodes));
  return { ...program, expressionEffects };
}
