/**
 * 按 PowerShell statement 树自底向上聚合命令与表达式行为。
 * 聚合结果区分确定行为和条件行为，并显式保留状态变化与不确定性。
 */

import type {
  AtomicResourceOperand,
  CommandSegmentAnalysis,
  ExecutionEffectSummary,
  ExecutionStateTransition,
  PowerShellExpressionEffect,
  PowerShellExpressionTermination,
  PowerShellProgramSyntax,
  PowerShellSecurityFlags,
  PowerShellStatementSyntax,
} from './types.js';

const HIGHER_ORDER_COMMANDS = new Set([
  'foreach-object', 'format-list', 'format-table', 'group-object', 'select-object',
  'sort-object', 'where-object',
]);

const ANALYZABLE_ELEMENT_TYPES = new Set([
  'ArrayLiteralAst', 'HashtableAst', 'ParenExpressionAst', 'ScriptBlockExpressionAst', 'SubExpressionAst',
]);

const CONDITIONAL_CHILD_STATEMENTS = new Set([
  'DoUntilStatementAst', 'DoWhileStatementAst', 'ForEachStatementAst', 'ForStatementAst',
  'FunctionDefinitionAst', 'IfStatementAst', 'SwitchStatementAst', 'TrapStatementAst',
  'TryStatementAst', 'WhileStatementAst',
]);

const TERMINATION_RANK: Readonly<Record<PowerShellExpressionTermination, number>> = {
  bounded: 0,
  unknown: 1,
  'potentially-unbounded': 2,
};

/** 返回去重且保持发现顺序的数组。 */
function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

/** 按资源字段去重，避免命名参数与兼容位置参数重复报告。 */
function uniqueResources(values: readonly AtomicResourceOperand[]): readonly AtomicResourceOperand[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${value.kind}:${value.access}:${value.parameterName ?? ''}:${value.rawValue}:${value.dynamic}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 取多个摘要中最保守的终止性。 */
function aggregateTermination(
  values: readonly PowerShellExpressionTermination[],
): PowerShellExpressionTermination {
  return values.reduce<PowerShellExpressionTermination>((highest, current) => (
    TERMINATION_RANK[current] > TERMINATION_RANK[highest] ? current : highest
  ), 'bounded');
}

/** 判断原子命令的动态参数是否已由可分析的子 AST 覆盖。 */
function isAnalyzableContainer(segment: CommandSegmentAnalysis, hasChildStatements: boolean): boolean {
  if (!hasChildStatements) {
    return false;
  }
  const elementTypes = segment.elementTypes ?? [];
  const hasStructuredArgument = elementTypes.some(type => ANALYZABLE_ELEMENT_TYPES.has(type));
  return hasStructuredArgument && (
    HIGHER_ORDER_COMMANDS.has(segment.executable) || elementTypes.some(type => (
      type === 'ParenExpressionAst' || type === 'SubExpressionAst'
    ))
  );
}

/** 将单个命令证据转换为聚合 effect。 */
function effectsFromSegment(
  segment: CommandSegmentAnalysis,
  hasChildStatements: boolean,
): readonly PowerShellExpressionEffect[] {
  let effects = [...segment.evidence.possibleEffects] as PowerShellExpressionEffect[];
  if (isAnalyzableContainer(segment, hasChildStatements)) {
    // 容器的动态参数已由 child statement 分析，容器自身只负责内存转换。
    effects = effects.filter(effect => effect !== 'unknown');
    effects.push('pureTransform');
  }
  for (const redirection of segment.redirections ?? []) {
    if (redirection.sideEffect === 'write') {
      effects.push('filesystemWrite');
    } else if (redirection.sideEffect === 'sensitive-read') {
      effects.push('filesystemRead', 'sensitiveDisclosure');
    }
  }
  if (segment.sideEffect === 'sensitive-read') {
    effects.push('sensitiveDisclosure');
  }
  return unique(effects);
}

/** 判断一个直接 child 是否只在条件或高阶容器执行时发生。 */
function isConditionalChild(
  parent: PowerShellStatementSyntax,
  parentSegments: readonly CommandSegmentAnalysis[],
  childSegments: readonly CommandSegmentAnalysis[],
): boolean {
  if (CONDITIONAL_CHILD_STATEMENTS.has(parent.statementType)) {
    return true;
  }
  if (parent.statementType === 'PipelineChainAst') {
    // Pipeline chain 的首项必定执行，后续项由 && 或 || 的前项结果控制。
    return childSegments.some(segment => segment.connectorBefore === '&&' || segment.connectorBefore === '||');
  }
  return parentSegments.some(segment => isAnalyzableContainer(segment, true));
}

interface StatementAggregationContext {
  readonly program: Readonly<PowerShellProgramSyntax>;
  readonly segmentsByStatement: ReadonlyMap<number, readonly CommandSegmentAnalysis[]>;
  readonly childrenByStatement: ReadonlyMap<number, readonly PowerShellStatementSyntax[]>;
}

/** 递归聚合单个 statement 及其直接 child。 */
function aggregateStatement(
  statement: PowerShellStatementSyntax,
  context: Readonly<StatementAggregationContext>,
): ExecutionEffectSummary {
  const segments = context.segmentsByStatement.get(statement.index) ?? [];
  const childStatements = context.childrenByStatement.get(statement.index) ?? [];
  const childSummaries = childStatements.map(child => aggregateStatement(child, context));
  const expression = context.program.expressionEffects?.find(effect => effect.statementIndex === statement.index);
  const hasChildren = childStatements.length > 0;
  const ownEffects = unique([
    ...segments.flatMap(segment => effectsFromSegment(segment, hasChildren)),
    ...(expression?.effects ?? []),
  ]);
  const definiteEffects = unique([
    ...ownEffects,
    ...childSummaries.flatMap((childSummary, index) => {
      const childStatement = childStatements[index];
      if (childStatement === undefined || isConditionalChild(
        statement,
        segments,
        context.segmentsByStatement.get(childStatement.index) ?? [],
      )) {
        return [];
      }
      return childSummary.definiteEffects;
    }),
  ]);
  const possibleEffects = unique([
    ...ownEffects,
    ...childSummaries.flatMap(child => child.possibleEffects),
  ]);
  const uncertaintyReasons = [
    ...segments.flatMap(segment => (
      effectsFromSegment(segment, hasChildren).includes('unknown') ? [segment.evidence.evidenceReason] : []
    )),
    ...(expression?.confidence === 'unknown' ? [expression.reason] : []),
    ...childSummaries.flatMap(child => child.uncertaintyReasons),
  ];
  const stateTransitions: ExecutionStateTransition[] = [];
  if (segments.some(segment => segment.executable === 'set-location')) {
    stateTransitions.push({ statementIndex: statement.index, kind: 'cwd', reason: 'Set-Location 改变后续相对路径基准' });
  }
  if (expression?.effects.includes('sessionMutation')) {
    const environment = expression.writesVariables.some(variable => variable.toLowerCase().startsWith('env:'));
    stateTransitions.push({
      statementIndex: statement.index,
      kind: environment ? 'environment' : 'session',
      reason: expression.reason,
    });
  }
  const commandNames = segments.map(segment => segment.executable).filter(Boolean);
  const dataFlows = commandNames.length > 1
    ? [`pipeline/statement 数据流：${commandNames.join(' -> ')}`]
    : [];
  return {
    nodeId: `statement:${statement.index}`,
    definiteEffects,
    possibleEffects,
    resourceAccesses: uniqueResources([
      ...segments.flatMap(segment => segment.evidence.resourceOperands),
      ...childSummaries.flatMap(child => child.resourceAccesses),
    ]),
    stateTransitions: [...stateTransitions, ...childSummaries.flatMap(child => child.stateTransitions)],
    dataFlows: [...dataFlows, ...childSummaries.flatMap(child => child.dataFlows)],
    asyncExecutions: [
      ...segments.filter(segment => segment.background).map(segment => `后台执行：${segment.command}`),
      ...childSummaries.flatMap(child => child.asyncExecutions),
    ],
    termination: aggregateTermination([
      expression?.termination ?? 'bounded',
      ...childSummaries.map(child => child.termination),
    ]),
    uncertaintyReasons: unique(uncertaintyReasons),
    childSummaries,
  };
}

/** 生成未由表达式/命令证据覆盖的全局 PowerShell 风险。 */
function unresolvedGlobalRisks(
  program: Readonly<PowerShellProgramSyntax>,
  flags: Readonly<PowerShellSecurityFlags>,
): readonly string[] {
  const reasons: string[] = [];
  if (flags.hasSplatting) reasons.push('splatting 参数无法静态展开');
  if (flags.hasDynamicCommands) reasons.push('动态命令名无法静态解析');
  if (flags.hasStopParsing) reasons.push('停止解析标记后的参数无法验证');
  if (program.hasUsingStatements) reasons.push('using statement 可能加载外部模块或程序集');
  if (program.hasScriptRequirements) reasons.push('脚本 requirement 会改变执行前提');
  return reasons;
}

/**
 * 聚合完整 PowerShell 程序的执行行为。
 *
 * @param program - 已附加表达式摘要的 PowerShell AST 投影
 * @param segments - 扁平命令视图；仅按 statementIndex 归属一次
 * @param flags - 解析器产生的全局动态风险标志
 * @returns 程序根执行摘要
 */
export function aggregatePowerShellEffects(
  program: Readonly<PowerShellProgramSyntax>,
  segments: readonly CommandSegmentAnalysis[],
  flags: Readonly<PowerShellSecurityFlags>,
): ExecutionEffectSummary {
  const segmentsByStatement = new Map<number, CommandSegmentAnalysis[]>();
  for (const segment of segments) {
    if (segment.statementIndex === undefined) continue;
    const existing = segmentsByStatement.get(segment.statementIndex) ?? [];
    existing.push(segment);
    segmentsByStatement.set(segment.statementIndex, existing);
  }
  const childrenByStatement = new Map<number, PowerShellStatementSyntax[]>();
  for (const statement of program.statements) {
    if (statement.parentStatementIndex === undefined) continue;
    const existing = childrenByStatement.get(statement.parentStatementIndex) ?? [];
    existing.push(statement);
    childrenByStatement.set(statement.parentStatementIndex, existing);
  }
  const context: StatementAggregationContext = { program, segmentsByStatement, childrenByStatement };
  const rootSummaries = program.statements
    .filter(statement => statement.parentStatementIndex === undefined)
    .map(statement => aggregateStatement(statement, context));
  const globalRisks = unresolvedGlobalRisks(program, flags);
  return {
    nodeId: 'root',
    definiteEffects: unique(rootSummaries.flatMap(summary => summary.definiteEffects)),
    possibleEffects: unique(rootSummaries.flatMap(summary => summary.possibleEffects)),
    resourceAccesses: uniqueResources(rootSummaries.flatMap(summary => summary.resourceAccesses)),
    stateTransitions: rootSummaries.flatMap(summary => summary.stateTransitions),
    dataFlows: rootSummaries.flatMap(summary => summary.dataFlows),
    asyncExecutions: rootSummaries.flatMap(summary => summary.asyncExecutions),
    termination: aggregateTermination(rootSummaries.map(summary => summary.termination)),
    uncertaintyReasons: unique([
      ...globalRisks,
      ...rootSummaries.flatMap(summary => summary.uncertaintyReasons),
    ]),
    childSummaries: rootSummaries,
  };
}
