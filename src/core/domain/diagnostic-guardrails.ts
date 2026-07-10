/**
 * @fileoverview 诊断类任务的轻量护栏状态与判定工具。
 * 负责识别诊断意图、跟踪本轮扫描/系统查询状态，并提供工具调用前后的收敛决策。
 */

import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';

/** 诊断任务允许扩展的最大目录枚举次数。 */
export const DIAGNOSTIC_LISTFILES_BUDGET = 4;
/** 连续命中低价值枚举的最大容忍次数。 */
export const DIAGNOSTIC_STAGNANT_SCAN_LIMIT = 2;

/** 诊断结论允许使用的证据等级。 */
export type DiagnosticEvidenceLevel = 'presence' | 'enumeration' | 'measured' | 'error';

/** 诊断护栏在单轮交互中的状态快照。 */
export interface DiagnosticTurnState {
  active: boolean;
  evidenceLevel: DiagnosticEvidenceLevel;
  systemQueryAttempts: number;
  lastSystemQueryFailed: boolean;
  listFilesUsed: number;
  stagnantListFilesCount: number;
  highRiskTargets: string[];
  scannedTargets: string[];
}

/** 工具预执行护栏的判定结果。 */
export interface DiagnosticToolReservation {
  state: DiagnosticTurnState;
  blockedReason?: string;
}

const DIAGNOSTIC_INTENT_PATTERN = /诊断|排查|排障|磁盘|磁碟|空间|占用|清理|缓存|临时文件|日志|扫描|大目录|disk|storage|cleanup|cache|space|diagnos|troubleshoot|scan/i;

const HIGH_RISK_TARGET_DEFINITIONS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Package Cache', pattern: /package\s*cache/i },
  { label: '安装缓存', pattern: /installer\s*cache|安装缓存/i },
  { label: '修复介质', pattern: /repair\s*media|修复介质/i },
  { label: '共享组件缓存', pattern: /shared\s*component|共享组件缓存/i },
  { label: 'WinSxS', pattern: /\bwinsxs\b/i }
];

/**
 * 创建新的诊断状态快照。
 *
 * @param seedText - 可选的首轮用户消息文本
 * @returns 已初始化的诊断状态
 */
export function createDiagnosticTurnState(seedText?: string): DiagnosticTurnState {
  return {
    active: hasDiagnosticIntent(seedText),
    evidenceLevel: 'presence',
    systemQueryAttempts: 0,
    lastSystemQueryFailed: false,
    listFilesUsed: 0,
    stagnantListFilesCount: 0,
    highRiskTargets: collectHighRiskTargets(seedText),
    scannedTargets: []
  };
}

/**
 * 根据最新消息快照补齐诊断状态，但不重置已累积的运行时计数。
 *
 * @param state - 当前诊断状态
 * @param messages - 准备发送给模型的消息快照
 * @returns 已同步用户意图的诊断状态
 */
export function syncDiagnosticTurnStateWithMessages(
  state: DiagnosticTurnState,
  messages: ChatMessage[]
): DiagnosticTurnState {
  const latestUserContent = getLatestUserMessageContent(messages);
  if (!latestUserContent) {
    return state;
  }

  return mergeDiagnosticText(state, latestUserContent);
}

/**
 * 在工具执行前预留诊断预算，并在必要时直接阻断高风险或低价值调用。
 *
 * @param state - 当前诊断状态
 * @param toolName - 即将执行的工具名称
 * @param args - 已解析的工具参数
 * @returns 预留后的状态与可选阻断原因
 */
export function reserveDiagnosticToolCall(
  state: DiagnosticTurnState,
  toolName: string,
  args: Record<string, unknown>
): DiagnosticToolReservation {
  if (!state.active) {
    return { state };
  }

  const nextState = cloneDiagnosticTurnState(state);
  mergeHighRiskTargets(nextState, collectHighRiskTargets(extractTextFragments(args).join('\n')));

  if (toolName === 'execute_command') {
    const command = getCommandText(args);
    if (nextState.lastSystemQueryFailed && isComplexSystemQuery(command)) {
      return {
        state: nextState,
        blockedReason: '上一条系统查询已失败或被拦截，后续必须降级到内置只读工具、总结未知项或请求用户缩小范围，禁止继续升级为复杂 shell 命令。'
      };
    }
    nextState.systemQueryAttempts += 1;
    return { state: nextState };
  }

  if (toolName === 'listFiles') {
    if (nextState.listFilesUsed >= DIAGNOSTIC_LISTFILES_BUDGET) {
      return {
        state: nextState,
        blockedReason: `诊断扫描已达到本轮枚举预算（${DIAGNOSTIC_LISTFILES_BUDGET} 次），必须停止继续扩散并转入总结或请求更窄范围。`
      };
    }

    const targetPath = getListFilesTarget(args);
    if (targetPath && nextState.scannedTargets.includes(targetPath)) {
      nextState.stagnantListFilesCount += 1;
    } else if (targetPath) {
      nextState.scannedTargets.push(targetPath);
      nextState.stagnantListFilesCount = 0;
    }

    if (nextState.stagnantListFilesCount >= DIAGNOSTIC_STAGNANT_SCAN_LIMIT) {
      return {
        state: nextState,
        blockedReason: '连续目录枚举未提升证据等级，必须停止重复扫描并汇总当前候选，而不是继续低价值扩散。'
      };
    }

    nextState.listFilesUsed += 1;
  }

  return { state: nextState };
}

/**
 * 在工具执行后回写证据等级与失败状态。
 *
 * @param state - 当前诊断状态
 * @param toolName - 已执行的工具名称
 * @param args - 工具参数
 * @param outcome - 工具执行结论
 * @returns 回写后的诊断状态
 */
export function recordDiagnosticToolOutcome(
  state: DiagnosticTurnState,
  toolName: string,
  args: Record<string, unknown>,
  outcome: { error?: string; result?: string }
): DiagnosticTurnState {
  if (!state.active) {
    return state;
  }

  const nextState = cloneDiagnosticTurnState(state);
  mergeHighRiskTargets(nextState, collectHighRiskTargets(`${extractTextFragments(args).join('\n')}\n${outcome.result ?? ''}\n${outcome.error ?? ''}`));

  if (toolName === 'execute_command') {
    if (outcome.error) {
      nextState.lastSystemQueryFailed = true;
      nextState.evidenceLevel = 'error';
      return nextState;
    }

    nextState.lastSystemQueryFailed = false;
    nextState.evidenceLevel = detectMeasuredEvidence(toolName, args, outcome.result)
      ? 'measured'
      : elevateEvidenceLevel(nextState.evidenceLevel, 'presence');
    return nextState;
  }

  if (toolName === 'listFiles') {
    nextState.evidenceLevel = outcome.error
      ? 'error'
      : elevateEvidenceLevel(nextState.evidenceLevel, 'enumeration');
    return nextState;
  }

  if (outcome.error) {
    nextState.evidenceLevel = 'error';
    return nextState;
  }

  nextState.evidenceLevel = elevateEvidenceLevel(nextState.evidenceLevel, 'presence');
  return nextState;
}

/**
 * 判断当前工具输出是否已经包含可量化测量证据。
 *
 * @param toolName - 工具名称
 * @param args - 工具参数
 * @param result - 工具结果文本
 * @returns 是否可视为 measured 级证据
 */
export function detectMeasuredEvidence(
  toolName: string,
  args: Record<string, unknown>,
  result?: string
): boolean {
  if (!result) {
    return false;
  }

  if (toolName !== 'execute_command') {
    return false;
  }

  const commandText = getCommandText(args);
  const hasMeasurementIntent = /size|freespace|capacity|measure|du|diskfree|logicaldisk|volume|storage|bytes/i.test(commandText);
  const hasMeasuredPayload = /freespace|size|capacity|total|bytes|\b\d+\s*(kb|mb|gb|tb)\b|\b\d{5,}\b/i.test(result);
  return hasMeasurementIntent && hasMeasuredPayload;
}

/**
 * 检查文本是否带有诊断/排障/磁盘分析意图。
 *
 * @param text - 待识别文本
 * @returns 是否命中诊断意图
 */
export function hasDiagnosticIntent(text?: string): boolean {
  return typeof text === 'string' && DIAGNOSTIC_INTENT_PATTERN.test(text);
}

/**
 * 从文本中收集高风险清理对象标签。
 *
 * @param text - 待分析文本
 * @returns 命中的高风险标签列表
 */
export function collectHighRiskTargets(text?: string): string[] {
  if (!text) {
    return [];
  }

  const hits = new Set<string>();
  for (const definition of HIGH_RISK_TARGET_DEFINITIONS) {
    if (definition.pattern.test(text)) {
      hits.add(definition.label);
    }
  }
  return Array.from(hits);
}

/**
 * 判断系统查询是否已经升级为复杂 shell 方案。
 *
 * @param commandText - 原始命令文本
 * @returns 是否属于复杂查询
 */
export function isComplexSystemQuery(commandText: string): boolean {
  return /&&|\|\||[|;><]|%[A-Za-z_]+%|\$\(|\r|\n/.test(commandText);
}

/** 复制诊断状态，避免在并行工具编排前就地污染原对象。 */
function cloneDiagnosticTurnState(state: DiagnosticTurnState): DiagnosticTurnState {
  return {
    ...state,
    highRiskTargets: [...state.highRiskTargets],
    scannedTargets: [...state.scannedTargets]
  };
}

/** 合并最新文本中的诊断意图与高风险目标。 */
function mergeDiagnosticText(state: DiagnosticTurnState, text: string): DiagnosticTurnState {
  const nextState = cloneDiagnosticTurnState(state);
  if (hasDiagnosticIntent(text)) {
    nextState.active = true;
  }
  mergeHighRiskTargets(nextState, collectHighRiskTargets(text));
  return nextState;
}

/** 合并高风险标签并去重。 */
function mergeHighRiskTargets(state: DiagnosticTurnState, labels: string[]): void {
  for (const label of labels) {
    if (!state.highRiskTargets.includes(label)) {
      state.highRiskTargets.push(label);
    }
  }
}

/** 提取最后一条用户消息文本。 */
function getLatestUserMessageContent(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}

/** 读取 execute_command 的原始命令文本。 */
function getCommandText(args: Record<string, unknown>): string {
  return typeof args.command === 'string' ? args.command : '';
}

/** 读取 listFiles 的目标目录。 */
function getListFilesTarget(args: Record<string, unknown>): string {
  const candidate = args.targetPath ?? args.path ?? args.directoryPath;
  return typeof candidate === 'string' ? candidate : '';
}

/** 按证据强度提升等级，避免 measured 被低等级回退。 */
function elevateEvidenceLevel(
  currentLevel: DiagnosticEvidenceLevel,
  nextLevel: DiagnosticEvidenceLevel
): DiagnosticEvidenceLevel {
  const order: DiagnosticEvidenceLevel[] = ['presence', 'enumeration', 'measured', 'error'];
  if (nextLevel === 'error') {
    return 'error';
  }
  if (currentLevel === 'error') {
    return 'error';
  }
  return order.indexOf(nextLevel) > order.indexOf(currentLevel) ? nextLevel : currentLevel;
}

/** 把对象中的可读文本碎片提取出来，供意图/风险规则复用。 */
function extractTextFragments(input: unknown): string[] {
  if (typeof input === 'string') {
    return [input];
  }
  if (Array.isArray(input)) {
    return input.flatMap(item => extractTextFragments(item));
  }
  if (input && typeof input === 'object') {
    return Object.values(input as Record<string, unknown>).flatMap(value => extractTextFragments(value));
  }
  return [];
}
