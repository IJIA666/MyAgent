/**
 * PowerShell 原生 AST 解析适配器。
 * 通过受限子进程调用 System.Management.Automation.Language.Parser，并提供超时、输出上限和 LRU 缓存。
 */

import { spawn } from 'child_process';
import { resolveShellLauncher } from '../terminal-plan.js';
import { getRuntimeEnv } from '../../../../../config/env.js';
import {
  createCredentialEnvironment,
  createCredentialProfile,
} from '../../../../../core/domain/security/credential-profile.js';
import type {
  CommandRedirectionAnalysis,
  CommandRiskSignal,
  CommandConnector,
  PowerShellCommandElementChild,
  PowerShellCommandElementSyntax,
  PowerShellCommandSyntax,
  PowerShellProgramSyntax,
  PowerShellSemanticNodeSyntax,
  PowerShellSecurityFlags,
  PowerShellStatementSecurityPatterns,
  PowerShellStatementSyntax,
  PowerShellVariableSyntax,
  ShellCommandSyntaxNode,
  ShellStructureParseResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_CACHE_SIZE = 100;
const POWERSHELL_AST_SCRIPT = `
function Test-SafeArgumentAst($element) {
  if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
      $element -is [System.Management.Automation.Language.ConstantExpressionAst]) {
    return $true
  }
  if ($element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
    return @($element.NestedExpressions).Count -eq 0
  }
  if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
    if ($null -eq $element.Argument) { return $true }
    return Test-SafeArgumentAst $element.Argument
  }
  if ($element -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    foreach ($item in $element.Elements) {
      if (-not (Test-SafeArgumentAst $item)) { return $false }
    }
    return $true
  }
  return $false
}

function Convert-CommandElement($element) {
  $children = @()
  if ($element -is [System.Management.Automation.Language.CommandParameterAst] -and $null -ne $element.Argument) {
    $children = @(@{
      astType = $element.Argument.GetType().Name
      text = $element.Argument.Extent.Text
    })
  } elseif ($element -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $children = @($element.Elements | ForEach-Object {
      @{
        astType = $_.GetType().Name
        text = $_.Extent.Text
      }
    })
  } elseif ($element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
    $children = @($element.NestedExpressions | ForEach-Object {
      @{
        astType = $_.GetType().Name
        text = $_.Extent.Text
      }
    })
  }
  @{
    astType = $element.GetType().Name
    text = $element.Extent.Text
    value = if ($element.PSObject.Properties['Value']) { [string]$element.Value } else { $null }
    children = $children
  }
}

function Convert-Redirection($redirection) {
  @{
    text = $redirection.Extent.Text
    isMerging = $redirection -is [System.Management.Automation.Language.MergingRedirectionAst]
  }
}

function Convert-Command($command, $statement) {
  $pipeline = $command.Parent
  while ($null -ne $pipeline -and -not ($pipeline -is [System.Management.Automation.Language.PipelineAst])) {
    $pipeline = $pipeline.Parent
  }
  $pipelineIndex = 0
  if ($null -ne $pipeline) {
    for ($index = 0; $index -lt $pipeline.PipelineElements.Count; $index += 1) {
      if ($pipeline.PipelineElements[$index] -eq $command) {
        $pipelineIndex = $index
        break
      }
    }
  }
  $owner = $command.Parent
  while ($null -ne $owner -and (
    -not ($owner -is [System.Management.Automation.Language.StatementAst]) -or
    $owner -is [System.Management.Automation.Language.CommandBaseAst]
  )) {
    $owner = $owner.Parent
  }
  $firstElement = @($command.CommandElements)[0]
  $nameType = 'unknown'
  if ($firstElement -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
    $nameType = if ($firstElement.StringConstantType -eq [System.Management.Automation.Language.StringConstantType]::BareWord) { 'bareword' } else { 'string' }
  } elseif ($null -ne $firstElement) {
    $nameType = 'expression'
  }
  @{
    name = $command.GetCommandName()
    nameType = $nameType
    text = $command.Extent.Text
    start = $command.Extent.StartOffset
    end = $command.Extent.EndOffset
    pipelineIndex = $pipelineIndex
    nested = $null -eq $owner -or -not [object]::ReferenceEquals($owner, $statement)
    elements = @($command.CommandElements | ForEach-Object { Convert-CommandElement $_ })
    redirections = @($command.Redirections | ForEach-Object { Convert-Redirection $_ })
  }
}

$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
$statementNodes = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.StatementAst] -and
  -not ($node -is [System.Management.Automation.Language.CommandBaseAst])
}, $true))
$statements = @($statementNodes | ForEach-Object {
  $statement = $_
  $statementIndex = [array]::IndexOf($statementNodes, $statement)
  $parentStatement = $statement.Parent
  while ($null -ne $parentStatement -and (
    -not ($parentStatement -is [System.Management.Automation.Language.StatementAst]) -or
    $parentStatement -is [System.Management.Automation.Language.CommandBaseAst]
  )) {
    $parentStatement = $parentStatement.Parent
  }
  $directCommands = @()
  $nestedCommands = @()
  foreach ($command in @($statement.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))) {
    $converted = Convert-Command $command $statement
    if ($converted.nested) {
      $nestedCommands += $converted
    } else {
      $directCommands += $converted
    }
  }
  $pipelineElementTypes = @()
  if ($statement -is [System.Management.Automation.Language.PipelineAst]) {
    $pipelineElementTypes = @($statement.PipelineElements | ForEach-Object { $_.GetType().Name })
  }
  @{
    index = $statementIndex
    statementType = $statement.GetType().Name
    text = $statement.Extent.Text
    start = $statement.Extent.StartOffset
    end = $statement.Extent.EndOffset
    parentIndex = if ($null -ne $parentStatement) { [array]::IndexOf($statementNodes, $parentStatement) } else { $null }
    pipelineElementTypes = $pipelineElementTypes
    commands = $directCommands
    nestedCommands = $nestedCommands
    redirections = @($statement.FindAll({ param($node) $node -is [System.Management.Automation.Language.RedirectionAst] }, $true) | ForEach-Object { Convert-Redirection $_ })
    securityPatterns = @{
      hasScriptBlocks = @($statement.FindAll({ param($node) $node -is [System.Management.Automation.Language.ScriptBlockExpressionAst] }, $true)).Count -gt 0
      hasSubExpressions = @($statement.FindAll({ param($node) $node -is [System.Management.Automation.Language.SubExpressionAst] -or $node -is [System.Management.Automation.Language.ParenExpressionAst] }, $true)).Count -gt 0
      hasMemberInvocations = @($statement.FindAll({ param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)).Count -gt 0
      hasAssignments = $statement -is [System.Management.Automation.Language.AssignmentStatementAst] -or @($statement.FindAll({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)).Count -gt 0
    }
  }
})
$allCommands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
$security = @{
  hasScriptBlocks = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.ScriptBlockExpressionAst] }, $true)).Count -gt 0
  hasSubExpressions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.SubExpressionAst] -or $node -is [System.Management.Automation.Language.ParenExpressionAst] }, $true)).Count -gt 0
  hasCommandSubExpressions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.SubExpressionAst] }, $true)).Count -gt 0
  hasMemberInvocations = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)).Count -gt 0
  hasAssignments = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)).Count -gt 0
  hasSplatting = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.Splatted }, $true)).Count -gt 0
  hasDynamicCommands = @($allCommands | Where-Object { $null -eq $_.GetCommandName() }).Count -gt 0
  hasDynamicArguments = @($allCommands | Where-Object {
    $command = $_
    for ($index = 1; $index -lt $command.CommandElements.Count; $index += 1) {
      if (-not (Test-SafeArgumentAst $command.CommandElements[$index])) { return $true }
    }
    return $false
  }).Count -gt 0
  hasStopParsing = @($tokens | Where-Object { $_.Text -eq '--%' }).Count -gt 0
  hasControlFlow = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -or
    $node -is [System.Management.Automation.Language.LoopStatementAst] -or
    $node -is [System.Management.Automation.Language.SwitchStatementAst] -or
    $node -is [System.Management.Automation.Language.TryStatementAst] -or
    $node -is [System.Management.Automation.Language.TrapStatementAst] -or
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
  }, $true)).Count -gt 0
  hasExpressionPipelines = @($ast.FindAll({ param($node)
    if (-not ($node -is [System.Management.Automation.Language.PipelineAst])) { return $false }
    foreach ($element in $node.PipelineElements) {
      if (-not ($element -is [System.Management.Automation.Language.CommandAst])) { return $true }
    }
    return $false
  }, $true)).Count -gt 0
}
$variables = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) | ForEach-Object {
  @{
    path = $_.VariablePath.UserPath
    splatted = $_.Splatted
    start = $_.Extent.StartOffset
    end = $_.Extent.EndOffset
  }
})
$semanticAstNodes = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.AssignmentStatementAst] -or
  $node -is [System.Management.Automation.Language.VariableExpressionAst] -or
  $node -is [System.Management.Automation.Language.MemberExpressionAst] -or
  $node -is [System.Management.Automation.Language.BinaryExpressionAst] -or
  $node -is [System.Management.Automation.Language.UnaryExpressionAst] -or
  $node -is [System.Management.Automation.Language.TypeExpressionAst] -or
  $node -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or
  $node -is [System.Management.Automation.Language.IfStatementAst] -or
  $node -is [System.Management.Automation.Language.ForStatementAst] -or
  $node -is [System.Management.Automation.Language.ForEachStatementAst] -or
  $node -is [System.Management.Automation.Language.WhileStatementAst] -or
  $node -is [System.Management.Automation.Language.DoWhileStatementAst] -or
  $node -is [System.Management.Automation.Language.DoUntilStatementAst] -or
  $node -is [System.Management.Automation.Language.HashtableAst]
}, $true))
$semanticNodes = @($semanticAstNodes | ForEach-Object {
  $node = $_
  $parent = $node.Parent
  while ($null -ne $parent -and [array]::IndexOf($semanticAstNodes, $parent) -lt 0) {
    $parent = $parent.Parent
  }
  $statement = $node
  while ($null -ne $statement -and (
    -not ($statement -is [System.Management.Automation.Language.StatementAst]) -or
    $statement -is [System.Management.Automation.Language.CommandBaseAst]
  )) {
    $statement = $statement.Parent
  }
  $assignment = $node
  while ($null -ne $assignment -and -not ($assignment -is [System.Management.Automation.Language.AssignmentStatementAst])) {
    $assignment = $assignment.Parent
  }
  $isAssignmentTarget = $false
  if ($node -is [System.Management.Automation.Language.VariableExpressionAst] -and $null -ne $assignment) {
    $isAssignmentTarget = $node.Extent.StartOffset -ge $assignment.Left.Extent.StartOffset -and
      $node.Extent.EndOffset -le $assignment.Left.Extent.EndOffset
  }
  $receiverText = $null
  $receiverType = $null
  $memberName = $null
  $staticMember = $false
  if ($node -is [System.Management.Automation.Language.MemberExpressionAst]) {
    $receiverText = $node.Expression.Extent.Text
    if ($node.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) {
      $receiverType = $node.Expression.TypeName.FullName
    }
    $memberName = if ($node.Member.PSObject.Properties['Value']) { [string]$node.Member.Value } else { $node.Member.Extent.Text }
    $staticMember = $node.Static
  }
  @{
    index = [array]::IndexOf($semanticAstNodes, $node)
    astType = $node.GetType().Name
    text = $node.Extent.Text
    start = $node.Extent.StartOffset
    end = $node.Extent.EndOffset
    parentIndex = if ($null -ne $parent) { [array]::IndexOf($semanticAstNodes, $parent) } else { $null }
    statementIndex = if ($null -ne $statement) { [array]::IndexOf($statementNodes, $statement) } else { $null }
    operator = if ($node.PSObject.Properties['Operator']) { $node.Operator.ToString() } else { $null }
    variablePath = if ($node -is [System.Management.Automation.Language.VariableExpressionAst]) { $node.VariablePath.UserPath } else { $null }
    assignmentTarget = $isAssignmentTarget
    targetText = if ($node -is [System.Management.Automation.Language.AssignmentStatementAst]) { $node.Left.Extent.Text } else { $null }
    targetVariablePath = if ($node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [System.Management.Automation.Language.VariableExpressionAst]) { $node.Left.VariablePath.UserPath } else { $null }
    receiverText = $receiverText
    receiverType = $receiverType
    memberName = $memberName
    staticMember = $staticMember
  }
})
$typeLiterals = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.TypeExpressionAst] -or
  $node -is [System.Management.Automation.Language.TypeConstraintAst]
}, $true) | ForEach-Object { $_.TypeName.FullName } | Select-Object -Unique)
$usingStatements = @()
if ($ast.PSObject.Properties['UsingStatements']) { $usingStatements = @($ast.UsingStatements) }
$scriptRequirements = $null
if ($ast.PSObject.Properties['ScriptRequirements']) { $scriptRequirements = $ast.ScriptRequirements }
@{
  errors = @($errors | ForEach-Object { $_.Message })
  statements = $statements
  variables = $variables
  semanticNodes = $semanticNodes
  typeLiterals = $typeLiterals
  tokens = @($tokens | ForEach-Object {
    @{
      kind = $_.Kind.ToString()
      start = $_.Extent.StartOffset
      end = $_.Extent.EndOffset
    }
  })
  hasUsingStatements = $usingStatements.Count -gt 0
  hasScriptRequirements = $null -ne $scriptRequirements
  security = $security
} | ConvertTo-Json -Depth 12 -Compress
`;

/** PowerShell 解析 runner 的资源限制。 */
export interface PowerShellParserLimits {
  /** 单次解析最大耗时。 */
  readonly timeoutMs: number;
  /** 标准输出允许的最大字节数。 */
  readonly maxOutputBytes: number;
}

/** 可注入的 PowerShell 解析进程 runner。 */
export type PowerShellParserRunner = (
  command: string,
  limits: Readonly<PowerShellParserLimits>,
) => Promise<string>;

/** PowerShell AST 解析器构造参数。 */
export interface PowerShellAstParserOptions {
  /** 单次解析超时，默认 1500 毫秒。 */
  readonly timeoutMs?: number;
  /** 标准输出上限，默认 256 KiB。 */
  readonly maxOutputBytes?: number;
  /** LRU 缓存容量，默认 100。 */
  readonly cacheSize?: number;
  /** 测试或替代运行环境使用的解析 runner。 */
  readonly runner?: PowerShellParserRunner;
}

interface RawPowerShellCommandElementChild {
  readonly astType?: unknown;
  readonly text?: unknown;
}

interface RawPowerShellCommandElement {
  readonly astType?: unknown;
  readonly text?: unknown;
  readonly value?: unknown;
  readonly children?: unknown;
}

interface RawPowerShellRedirection {
  readonly text?: unknown;
  readonly isMerging?: unknown;
}

interface RawPowerShellCommand {
  readonly name?: unknown;
  readonly nameType?: unknown;
  readonly text?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly pipelineIndex?: unknown;
  readonly nested?: unknown;
  readonly elements?: unknown;
  readonly redirections?: unknown;
}

interface RawPowerShellStatement {
  readonly index?: unknown;
  readonly statementType?: unknown;
  readonly text?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly parentIndex?: unknown;
  readonly pipelineElementTypes?: unknown;
  readonly commands?: unknown;
  readonly nestedCommands?: unknown;
  readonly redirections?: unknown;
  readonly securityPatterns?: unknown;
}

interface RawPowerShellVariable {
  readonly path?: unknown;
  readonly splatted?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
}

interface RawPowerShellSemanticNode {
  readonly index?: unknown;
  readonly astType?: unknown;
  readonly text?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly parentIndex?: unknown;
  readonly statementIndex?: unknown;
  readonly operator?: unknown;
  readonly variablePath?: unknown;
  readonly assignmentTarget?: unknown;
  readonly targetText?: unknown;
  readonly targetVariablePath?: unknown;
  readonly receiverText?: unknown;
  readonly receiverType?: unknown;
  readonly memberName?: unknown;
  readonly staticMember?: unknown;
}

interface RawPowerShellToken {
  readonly kind?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
}

/** 旧 runner 测试数据使用的扁平节点，仅保留兼容归一化。 */
interface LegacyRawPowerShellNode {
  readonly text?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly parentStart?: unknown;
  readonly statementStart?: unknown;
  readonly statementType?: unknown;
  readonly pipelineIndex?: unknown;
  readonly nested?: unknown;
  readonly elementTypes?: unknown;
  readonly redirections?: unknown;
}

interface RawPowerShellParseResult {
  readonly errors?: unknown;
  readonly statements?: unknown;
  readonly variables?: unknown;
  readonly semanticNodes?: unknown;
  readonly typeLiterals?: unknown;
  readonly tokens?: unknown;
  readonly hasUsingStatements?: unknown;
  readonly hasScriptRequirements?: unknown;
  /** @deprecated 仅用于兼容旧测试 runner。 */
  readonly nodes?: unknown;
  readonly security?: unknown;
}

/** 带稳定风险代码的 PowerShell 解析器内部错误。 */
class PowerShellParserError extends Error {
  /** 稳定风险代码。 */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PowerShellParserError';
    this.code = code;
  }
}

/** 判断重定向目标是否为 PowerShell 的空设备变量。 */
function isNullRedirectionTarget(target: string | undefined): boolean {
  const normalized = target?.replace(/\s+/gu, '').toLowerCase();
  return normalized === '$null' || normalized === '${null}';
}

/** 将 PowerShell 重定向投影为保守证据。 */
function parseRedirection(raw: string | RawPowerShellRedirection): CommandRedirectionAnalysis {
  const text = typeof raw === 'string' ? raw : typeof raw.text === 'string' ? raw.text : '';
  const isMerging = typeof raw === 'object' && raw.isMerging === true;
  const match = text.trim().match(/^(\d*[*]?)(>>|>|<)\s*(.*)$/);
  const operator = match?.[2] ?? text.trim();
  const target = match?.[3]?.trim() || undefined;
  if (isMerging || isNullRedirectionTarget(target)) {
    return {
      operator,
      target,
      sideEffect: 'read',
      permission: 'allow',
      reason: isMerging
        ? `检测到流合并重定向 ${text.trim()}`
        : `检测到丢弃输出的空设备重定向 ${text.trim()}`,
    };
  }
  const isInput = operator === '<';
  return {
    operator,
    target,
    sideEffect: isInput ? 'sensitive-read' : 'write',
    permission: 'ask',
    reason: target ? `检测到重定向 ${operator} ${target}` : `重定向 ${operator} 缺少静态目标`,
  };
}

/** 将未知对象收窄为普通记录。 */
function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

/** 归一化 PowerShell 命令参数的一层子节点。 */
function normalizeElementChild(raw: unknown): PowerShellCommandElementChild | undefined {
  const child = toRecord(raw) as RawPowerShellCommandElementChild;
  if (typeof child.astType !== 'string' || typeof child.text !== 'string') {
    return undefined;
  }
  return { astType: child.astType, text: child.text };
}

/** 归一化 PowerShell CommandElementAst。 */
function normalizeCommandElement(raw: unknown): PowerShellCommandElementSyntax | undefined {
  const element = toRecord(raw) as RawPowerShellCommandElement;
  if (typeof element.astType !== 'string' || typeof element.text !== 'string') {
    return undefined;
  }
  return {
    astType: element.astType,
    text: element.text,
    value: typeof element.value === 'string' ? element.value : undefined,
    children: toArray(element.children)
      .map(normalizeElementChild)
      .filter((child): child is PowerShellCommandElementChild => child !== undefined),
  };
}

/** 归一化 statement 内的一次 PowerShell 命令调用。 */
function normalizePowerShellCommand(raw: unknown): PowerShellCommandSyntax | undefined {
  const command = toRecord(raw) as RawPowerShellCommand;
  if (typeof command.text !== 'string' || typeof command.start !== 'number' || typeof command.end !== 'number') {
    return undefined;
  }
  return {
    name: typeof command.name === 'string' && command.name.length > 0 ? command.name : undefined,
    nameType:
      command.nameType === 'bareword' ||
      command.nameType === 'string' ||
      command.nameType === 'expression'
        ? command.nameType
        : 'unknown',
    text: command.text,
    start: command.start,
    end: command.end,
    pipelineIndex: typeof command.pipelineIndex === 'number' ? command.pipelineIndex : 0,
    nested: command.nested === true,
    elements: toArray(command.elements)
      .map(normalizeCommandElement)
      .filter((element): element is PowerShellCommandElementSyntax => element !== undefined),
    redirections: toArray(command.redirections).map(rawRedirection => (
      parseRedirection(toRecord(rawRedirection) as RawPowerShellRedirection)
    )),
  };
}

/** 从 statement 局部安全对象读取稳定布尔值。 */
function normalizeStatementSecurity(raw: unknown): PowerShellStatementSecurityPatterns {
  const security = toRecord(raw);
  return {
    hasScriptBlocks: security.hasScriptBlocks === true,
    hasSubExpressions: security.hasSubExpressions === true,
    hasMemberInvocations: security.hasMemberInvocations === true,
    hasAssignments: security.hasAssignments === true,
  };
}

/** 归一化 PowerShell statement，父子关系在第二阶段补齐。 */
function normalizeStatement(
  raw: unknown,
  fallbackIndex: number,
): PowerShellStatementSyntax | undefined {
  const statement = toRecord(raw) as RawPowerShellStatement;
  if (
    typeof statement.statementType !== 'string' ||
    typeof statement.text !== 'string' ||
    typeof statement.start !== 'number' ||
    typeof statement.end !== 'number'
  ) {
    return undefined;
  }
  const index = typeof statement.index === 'number' ? statement.index : fallbackIndex;
  return {
    index,
    statementType: statement.statementType,
    text: statement.text,
    start: statement.start,
    end: statement.end,
    parentStatementIndex: typeof statement.parentIndex === 'number' && statement.parentIndex >= 0
      ? statement.parentIndex
      : undefined,
    pipelineElementTypes: toArray(statement.pipelineElementTypes)
      .filter((item): item is string => typeof item === 'string'),
    commands: toArray(statement.commands)
      .map(normalizePowerShellCommand)
      .filter((command): command is PowerShellCommandSyntax => command !== undefined),
    nestedCommands: toArray(statement.nestedCommands)
      .map(normalizePowerShellCommand)
      .filter((command): command is PowerShellCommandSyntax => command !== undefined),
    redirections: toArray(statement.redirections).map(rawRedirection => (
      parseRedirection(toRecord(rawRedirection) as RawPowerShellRedirection)
    )),
    securityPatterns: normalizeStatementSecurity(statement.securityPatterns),
  };
}

/** 归一化 PowerShell 变量引用。 */
function normalizeVariable(raw: unknown): PowerShellVariableSyntax | undefined {
  const variable = toRecord(raw) as RawPowerShellVariable;
  if (
    typeof variable.path !== 'string' ||
    typeof variable.start !== 'number' ||
    typeof variable.end !== 'number'
  ) {
    return undefined;
  }
  return {
    path: variable.path,
    splatted: variable.splatted === true,
    start: variable.start,
    end: variable.end,
  };
}

/** 归一化会影响表达式判断的 PowerShell AST 节点。 */
function normalizeSemanticNode(raw: unknown): PowerShellSemanticNodeSyntax | undefined {
  const node = toRecord(raw) as RawPowerShellSemanticNode;
  if (
    typeof node.index !== 'number' ||
    typeof node.astType !== 'string' ||
    typeof node.text !== 'string' ||
    typeof node.start !== 'number' ||
    typeof node.end !== 'number'
  ) {
    return undefined;
  }
  return {
    index: node.index,
    astType: node.astType,
    text: node.text,
    start: node.start,
    end: node.end,
    parentIndex: typeof node.parentIndex === 'number' && node.parentIndex >= 0 ? node.parentIndex : undefined,
    statementIndex: typeof node.statementIndex === 'number' && node.statementIndex >= 0 ? node.statementIndex : undefined,
    operator: typeof node.operator === 'string' ? node.operator : undefined,
    variablePath: typeof node.variablePath === 'string' ? node.variablePath : undefined,
    assignmentTarget: node.assignmentTarget === true,
    targetText: typeof node.targetText === 'string' ? node.targetText : undefined,
    targetVariablePath: typeof node.targetVariablePath === 'string' ? node.targetVariablePath : undefined,
    receiverText: typeof node.receiverText === 'string' ? node.receiverText : undefined,
    receiverType: typeof node.receiverType === 'string' ? node.receiverType : undefined,
    memberName: typeof node.memberName === 'string' ? node.memberName : undefined,
    staticMember: node.staticMember === true,
  };
}

/** 将 PowerShell token kind 映射为命令连接符。 */
function tokenKindToConnector(kind: string): CommandConnector | undefined {
  switch (kind) {
    case 'AndAnd': return '&&';
    case 'OrOr': return '||';
    case 'Semi': return ';';
    case 'NewLine': return 'newline';
    case 'Pipe': return '|';
    default: return undefined;
  }
}

/** 在相邻 AST 节点范围之间查找 PowerShell 解析器确认的连接 token。 */
function findConnector(
  rawTokens: readonly unknown[],
  previousEnd: number | undefined,
  currentStart: number,
): CommandConnector | undefined {
  if (previousEnd === undefined) {
    return undefined;
  }
  for (const rawToken of rawTokens) {
    const token = toRecord(rawToken) as RawPowerShellToken;
    if (
      typeof token.kind !== 'string' ||
      typeof token.start !== 'number' ||
      typeof token.end !== 'number' ||
      token.start < previousEnd ||
      token.end > currentStart
    ) {
      continue;
    }
    const connector = tokenKindToConnector(token.kind);
    if (connector !== undefined) {
      return connector;
    }
  }
  return undefined;
}

/** 运行受限 PowerShell 子进程并返回 JSON 文本。 */
function runNativePowerShellParser(
  command: string,
  limits: Readonly<PowerShellParserLimits>,
): Promise<string> {
  const launcher = resolveShellLauncher('powershell');
  if (!launcher) {
    return Promise.reject(new PowerShellParserError('parser.powershell-unavailable', '当前平台未找到 PowerShell 解析器'));
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(launcher.executable, [...launcher.argsPrefix, POWERSHELL_AST_SCRIPT], {
      env: {
        ...createCredentialEnvironment(
          createCredentialProfile('terminal'),
          getRuntimeEnv(),
        ),
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    /** 仅完成一次 Promise，并清理超时计时器。 */
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new PowerShellParserError('parser.powershell-timeout', 'PowerShell AST 解析超时')));
    }, limits.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) {
        child.kill();
        finish(() => reject(new PowerShellParserError('parser.powershell-output-limit', 'PowerShell AST 输出超过安全上限')));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((size, item) => size + item.length, 0) < limits.maxOutputBytes) {
        stderr.push(chunk);
      }
    });
    child.on('error', error => {
      finish(() => reject(new PowerShellParserError('parser.powershell-process', error.message)));
    });
    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          reject(new PowerShellParserError('parser.powershell-process', detail || `PowerShell 解析进程退出码 ${code}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString('utf8'));
      });
    });
    child.stdin.end(command, 'utf8');
  });
}

/** 将未知 JSON 字段归一化为数组。 */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}

/** 为可注入 runner 添加可清理的统一超时边界。 */
function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PowerShellParserError('parser.powershell-timeout', 'PowerShell AST 解析超时'));
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 带资源限制和 LRU 的 PowerShell AST 解析器。
 */
export class PowerShellAstParser {
  private readonly limits: Readonly<PowerShellParserLimits>;
  private readonly cacheSize: number;
  private readonly runner: PowerShellParserRunner;
  private readonly cache = new Map<string, Promise<ShellStructureParseResult>>();

  /**
   * 创建 PowerShell AST 解析器。
   *
   * @param options - 超时、输出、缓存与 runner 配置
   */
  constructor(options: PowerShellAstParserOptions = {}) {
    this.limits = Object.freeze({
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
    this.cacheSize = Math.max(1, options.cacheSize ?? DEFAULT_CACHE_SIZE);
    this.runner = options.runner ?? runNativePowerShellParser;
  }

  /**
   * 解析 PowerShell 命令，并复用相同文本的并发或历史结果。
   *
   * @param command - 原始 PowerShell 命令文本
   * @returns 结构化 AST 节点与解析风险
   */
  parse(command: string): Promise<ShellStructureParseResult> {
    const cached = this.cache.get(command);
    if (cached) {
      // Map 的删除再插入表示最近使用，形成稳定 LRU 顺序。
      this.cache.delete(command);
      this.cache.set(command, cached);
      return cached;
    }

    const pending = this.parseUncached(command);
    this.cache.set(command, pending);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
    return pending;
  }

  /** 执行一次未缓存解析并将异常转换为保守结果。 */
  private async parseUncached(command: string): Promise<ShellStructureParseResult> {
    try {
      const rawText = await this.runParserWithRetry(command);
      if (Buffer.byteLength(rawText, 'utf8') > this.limits.maxOutputBytes) {
        throw new PowerShellParserError('parser.powershell-output-limit', 'PowerShell AST 输出超过安全上限');
      }
      return this.normalize(rawText, command);
    } catch (error) {
      const code = error instanceof PowerShellParserError ? error.code : 'parser.powershell-failed';
      const reason = error instanceof Error ? error.message : 'PowerShell AST 解析失败';
      return { parseStatus: 'unsupported', nodes: [], riskSignals: [{ code, reason }] };
    }
  }

  /** 仅对明确的解析超时执行一次扩大预算的重试。 */
  private async runParserWithRetry(command: string): Promise<string> {
    try {
      return await runWithTimeout(this.runner(command, this.limits), this.limits.timeoutMs);
    } catch (error) {
      if (!(error instanceof PowerShellParserError) || error.code !== 'parser.powershell-timeout') {
        throw error;
      }
      const retryLimits: Readonly<PowerShellParserLimits> = {
        ...this.limits,
        timeoutMs: this.limits.timeoutMs * 2,
      };
      return await runWithTimeout(this.runner(command, retryLimits), retryLimits.timeoutMs);
    }
  }

  /** 将 PowerShell JSON 输出规范化为稳定领域契约。 */
  private normalize(rawText: string, command: string): ShellStructureParseResult {
    let parsed: RawPowerShellParseResult;
    try {
      parsed = JSON.parse(rawText) as RawPowerShellParseResult;
    } catch {
      throw new PowerShellParserError('parser.powershell-json', 'PowerShell AST 返回了无效 JSON');
    }

    const errors = toArray(parsed.errors).filter((item): item is string => typeof item === 'string');
    if (errors.length > 0) {
      return {
        parseStatus: 'invalid',
        nodes: [],
        riskSignals: errors.map((reason): CommandRiskSignal => ({ code: 'parser.powershell-invalid', reason })),
      };
    }

    const rawStatements = toArray(parsed.statements);
    const statements = rawStatements
      .map((rawStatement, index) => normalizeStatement(rawStatement, index))
      .filter((statement): statement is PowerShellStatementSyntax => statement !== undefined);
    const powershellProgram: PowerShellProgramSyntax = {
      source: command,
      statements,
      variables: toArray(parsed.variables)
        .map(normalizeVariable)
        .filter((variable): variable is PowerShellVariableSyntax => variable !== undefined),
      semanticNodes: toArray(parsed.semanticNodes)
        .map(normalizeSemanticNode)
        .filter((node): node is PowerShellSemanticNodeSyntax => node !== undefined),
      typeLiterals: toArray(parsed.typeLiterals)
        .filter((item): item is string => typeof item === 'string'),
      hasUsingStatements: parsed.hasUsingStatements === true,
      hasScriptRequirements: parsed.hasScriptRequirements === true,
    };
    const rawTokens = toArray(parsed.tokens);
    const statementPathByIndex = new Map<number, readonly number[]>();
    const childStatementCounts = new Map<number, number>();
    let rootStatementIndex = 0;
    for (const statement of statements) {
      const parentPath = statement.parentStatementIndex === undefined
        ? undefined
        : statementPathByIndex.get(statement.parentStatementIndex);
      const childIndex = statement.parentStatementIndex === undefined
        ? rootStatementIndex++
        : childStatementCounts.get(statement.parentStatementIndex) ?? 0;
      if (statement.parentStatementIndex !== undefined) {
        childStatementCounts.set(statement.parentStatementIndex, childIndex + 1);
      }
      statementPathByIndex.set(statement.index, parentPath ? [...parentPath, childIndex] : [childIndex]);
    }
    const directCommands = statements
      .flatMap(statement => statement.commands.map((powerShellCommand, commandIndex) => ({
        statement,
        powerShellCommand,
        commandIndex,
      })))
      .sort((left, right) => left.powerShellCommand.start - right.powerShellCommand.start);
    const statementByIndex = new Map(statements.map(statement => [statement.index, statement] as const));
    let previousEnd: number | undefined;
    const nodes: ShellCommandSyntaxNode[] = directCommands.map(({ statement, powerShellCommand, commandIndex }) => {
      const statementPath = statementPathByIndex.get(statement.index) ?? [statement.index];
      const parentStatement = statement.parentStatementIndex === undefined
        ? undefined
        : statementByIndex.get(statement.parentStatementIndex);
      const connectorBefore = powerShellCommand.pipelineIndex > 0
        ? '|'
        : findConnector(rawTokens, previousEnd, powerShellCommand.start);
      previousEnd = powerShellCommand.end;
      return {
        command: powerShellCommand.text,
        nodePath: [...statementPath, commandIndex],
        connectorBefore,
        pipelineIndex: powerShellCommand.pipelineIndex,
        statementIndex: statement.index,
        statementType: statement.statementType,
        nested: powerShellCommand.nested || (
          parentStatement !== undefined && parentStatement.statementType !== 'PipelineChainAst'
        ),
        elementTypes: powerShellCommand.elements.map(element => element.astType),
        powershellCommand: powerShellCommand,
        redirections: powerShellCommand.redirections,
      };
    });
    if (nodes.length === 0 && parsed.nodes !== undefined) {
      nodes.push(...this.normalizeLegacyNodes(parsed.nodes));
    }
    const rawSecurity = typeof parsed.security === 'object' && parsed.security !== null
      ? parsed.security as Record<string, unknown>
      : {};
    const powershellSecurity: PowerShellSecurityFlags = {
      hasScriptBlocks: rawSecurity.hasScriptBlocks === true,
      hasSubExpressions: rawSecurity.hasSubExpressions === true,
      hasCommandSubExpressions: rawSecurity.hasCommandSubExpressions === true,
      hasMemberInvocations: rawSecurity.hasMemberInvocations === true,
      hasAssignments: rawSecurity.hasAssignments === true,
      hasSplatting: rawSecurity.hasSplatting === true,
      hasDynamicCommands: rawSecurity.hasDynamicCommands === true,
      hasDynamicArguments: rawSecurity.hasDynamicArguments === true,
      hasStopParsing: rawSecurity.hasStopParsing === true,
      hasControlFlow: rawSecurity.hasControlFlow === true,
      hasExpressionPipelines: rawSecurity.hasExpressionPipelines === true,
    };
    return {
      parseStatus: 'parsed',
      nodes,
      riskSignals: [],
      powershellSecurity,
      powershellProgram,
    };
  }

  /** 兼容旧测试 runner 返回的扁平 PowerShell 节点。 */
  private normalizeLegacyNodes(rawValue: unknown): ShellCommandSyntaxNode[] {
    const rawNodes = toArray(rawValue)
      .filter((item): item is LegacyRawPowerShellNode => typeof item === 'object' && item !== null);
    const pathByStart = new Map<number, readonly number[]>();
    const childCounts = new Map<number, number>();
    let rootIndex = 0;
    const nodes: ShellCommandSyntaxNode[] = [];
    for (const rawNode of rawNodes) {
      if (typeof rawNode.text !== 'string' || typeof rawNode.start !== 'number') {
        continue;
      }
      const parentStart = typeof rawNode.parentStart === 'number' ? rawNode.parentStart : undefined;
      const parentPath = parentStart === undefined ? undefined : pathByStart.get(parentStart);
      const childIndex = parentStart === undefined ? rootIndex++ : childCounts.get(parentStart) ?? 0;
      if (parentStart !== undefined) {
        childCounts.set(parentStart, childIndex + 1);
      }
      const nodePath = parentPath ? [...parentPath, childIndex] : [childIndex];
      pathByStart.set(rawNode.start, nodePath);
      nodes.push({
        command: rawNode.text,
        nodePath,
        pipelineIndex: typeof rawNode.pipelineIndex === 'number' ? rawNode.pipelineIndex : undefined,
        statementIndex: typeof rawNode.statementStart === 'number' ? rawNode.statementStart : undefined,
        statementType: typeof rawNode.statementType === 'string' ? rawNode.statementType : undefined,
        nested: rawNode.nested === true || parentStart !== undefined,
        elementTypes: toArray(rawNode.elementTypes).filter((item): item is string => typeof item === 'string'),
        redirections: toArray(rawNode.redirections)
          .filter((item): item is string => typeof item === 'string')
          .map(parseRedirection),
      });
    }
    return nodes;
  }
}

/** 默认 PowerShell AST 解析器单例。 */
export const powershellAstParser = new PowerShellAstParser();
