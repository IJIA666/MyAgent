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

/**
 * 证据完整性分类。
 */
export type EvidenceCompleteness = 'complete' | 'partial' | 'lower-bound';

/**
 * 单条对象级证据记录。
 * 绑定目标、指标、度量值、单位、来源和覆盖范围，不得外推到未覆盖的目标。
 */
export interface DiagnosticEvidenceRecord {
  /** 证据指向的目标路径或标识 */
  target: string;
  /** 指标名称（如 sizeBytes、lineCount、freeSpace） */
  metric: string;
  /** 度量数值 */
  value: number;
  /** 度量单位（如 bytes、count、ms） */
  unit: string;
  /** 证据来源工具名称 */
  source: string;
  /** 来源工具的调用关联 ID */
  correlationId?: string;
  /** 覆盖完整性 */
  completeness: EvidenceCompleteness;
  /** 覆盖范围描述 */
  coverage: string;
  /** 可选的错误摘要 */
  error?: string;
}

/** 证据记录集合的最大数量，超出时淘汰低优先级记录。 */
export const MAX_EVIDENCE_RECORDS = 50;

/** 诊断护栏在单轮交互中的状态快照。 */
export interface DiagnosticTurnState {
  active: boolean;
  /** 兼容保留的回合级证据等级（由 evidenceRecords 纯函数派生） */
  evidenceLevel: DiagnosticEvidenceLevel;
  systemQueryAttempts: number;
  lastSystemQueryFailed: boolean;
  listFilesUsed: number;
  stagnantListFilesCount: number;
  lastDirectoryStatsTruncated: boolean;
  highRiskTargets: string[];
  scannedTargets: string[];
  /** 对象级证据记录集合（有界，优先保留完整测量、最新错误和高风险目标） */
  evidenceRecords: DiagnosticEvidenceRecord[];
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
    lastDirectoryStatsTruncated: false,
    highRiskTargets: collectHighRiskTargets(seedText),
    scannedTargets: [],
    evidenceRecords: []
  };
}

/**
 * 从 evidenceRecords 派生回合级 evidenceLevel。
 * 优先取最高完整性记录的等级，error 优先。
 */
export function deriveEvidenceLevelFromRecords(records: DiagnosticEvidenceRecord[]): DiagnosticEvidenceLevel {
  if (records.length === 0) return 'presence';
  const hasError = records.some(r => r.error);
  if (hasError) return 'error';
  const hasMeasured = records.some(r => r.completeness === 'complete');
  if (hasMeasured) return 'measured';
  const hasPartial = records.some(r => r.completeness === 'partial' || r.completeness === 'lower-bound');
  if (hasPartial) return 'measured';
  return 'enumeration';
}

/**
 * 添加证据记录到有界集合。
 * 优先保留 complete measured、最新错误和高风险目标。
 * 超出上限时光淘汰 'presence' 级记录。
 */
export function addEvidenceRecord(
  records: DiagnosticEvidenceRecord[],
  record: DiagnosticEvidenceRecord
): DiagnosticEvidenceRecord[] {
  const updated = [...records, record];
  if (updated.length <= MAX_EVIDENCE_RECORDS) return updated;

  // 淘汰策略：先淘汰 completeness 非 complete 且无 error 的记录
  const highPriority = updated.filter(r => r.completeness === 'complete' || r.error);
  const lowPriority = updated.filter(r => r.completeness !== 'complete' && !r.error);
  lowPriority.sort((a, b) => {
    const aScore = a.completeness === 'partial' ? 1 : 0;
    const bScore = b.completeness === 'partial' ? 1 : 0;
    return aScore - bScore;
  });
  const keep = MAX_EVIDENCE_RECORDS - highPriority.length;
  return [...highPriority, ...lowPriority.slice(0, Math.max(0, keep))];
}

/**
 * 从 readFile 的结构化结果（includeMetadata=true）中解析证据记录。
 * sizeBytes 与 lineCount 产生 measured 记录；mtimeMs、kind 和存在性只能产生 presence 信息。
 *
 * @param targetPath - 读取的文件路径
 * @param result - readFile 返回的 JSON 字符串
 * @param correlationId - 可选的调用关联 ID
 * @returns 解析出的证据记录列表
 */
export function parseReadFileEvidence(
  targetPath: string,
  result?: string,
  correlationId?: string
): DiagnosticEvidenceRecord[] {
  if (!result) return [];
  let payload: { metadata?: { sizeBytes?: number; lineCount?: number; mtimeMs?: number; kind?: string } };
  try {
    payload = JSON.parse(result);
    if (!payload || !payload.metadata) return [];
  } catch {
    return [];
  }

  const records: DiagnosticEvidenceRecord[] = [];
  const meta = payload.metadata;

  if (typeof meta.sizeBytes === 'number') {
    records.push({
      target: targetPath,
      metric: 'sizeBytes',
      value: meta.sizeBytes,
      unit: 'bytes',
      source: 'readFile',
      correlationId,
      completeness: 'complete',
      coverage: `size of ${targetPath}`
    });
  }

  if (typeof meta.lineCount === 'number') {
    records.push({
      target: targetPath,
      metric: 'lineCount',
      value: meta.lineCount,
      unit: 'lines',
      source: 'readFile',
      correlationId,
      completeness: 'complete',
      coverage: `line count of ${targetPath}`
    });
  }

  // mtimeMs/kind 只能产生辅助信息
  if (typeof meta.mtimeMs === 'number') {
    records.push({
      target: targetPath,
      metric: 'mtimeMs',
      value: meta.mtimeMs,
      unit: 'ms',
      source: 'readFile',
      correlationId,
      completeness: 'partial',
      coverage: `modification time of ${targetPath}`
    });
  }

  return records;
}

/**
 * 从 listFiles 的结构化结果中解析证据记录。
 * 普通名称列表产生 enumeration；直接文件 size 绑定具体文件；
 * 目录完整总量产生 complete；observedSizeBytes 或截断结果产生 lower-bound/partial。
 *
 * @param targetPath - 列出的目标目录路径
 * @param result - listFiles 返回的 JSON 字符串
 * @param correlationId - 可选的调用关联 ID
 * @returns 解析出的证据记录列表
 */
export function parseListFilesEvidence(
  targetPath: string,
  result?: string,
  correlationId?: string
): DiagnosticEvidenceRecord[] {
  if (!result) return [];

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result);
  } catch {
    return [];
  }

  const records: DiagnosticEvidenceRecord[] = [];

  // 检查 directoryStats（旧同步统计）
  const stats = payload.directoryStats as Record<string, unknown> | undefined;
  if (stats && typeof stats.totalFiles === 'number') {
    const isTruncated = stats.isTruncated === true;
    records.push({
      target: targetPath,
      metric: 'totalFiles',
      value: stats.totalFiles as number,
      unit: 'files',
      source: 'listFiles',
      correlationId,
      completeness: isTruncated ? 'partial' : 'complete',
      coverage: `file count in ${targetPath}`
    });
  }

  if (stats && typeof stats.totalSizeBytes === 'number') {
    records.push({
      target: targetPath,
      metric: 'totalSizeBytes',
      value: stats.totalSizeBytes as number,
      unit: 'bytes',
      source: 'listFiles',
      correlationId,
      completeness: stats.isTruncated === true ? 'lower-bound' : 'complete',
      coverage: `total size of ${targetPath}`
    });
  }

  // 检查 targetMeasurement（新异步公平比较）
  const targetMeas = payload.targetMeasurement as Record<string, unknown> | undefined;
  if (targetMeas && typeof targetMeas.observedSizeBytes === 'number') {
    const isComplete = targetMeas.completeness === 'complete';
    records.push({
      target: targetPath,
      metric: 'observedSizeBytes',
      value: targetMeas.observedSizeBytes as number,
      unit: 'bytes',
      source: 'listFiles',
      correlationId,
      completeness: isComplete ? 'complete' : 'lower-bound',
      coverage: `observed size of ${targetPath}`
    });
  }

  // 检查 entries 中的单个文件 size
  const entries = payload.entries as Array<Record<string, unknown>> | undefined;
  if (entries) {
    for (const entry of entries) {
      if (typeof entry.sizeBytes === 'number' && entry.name) {
        records.push({
          target: `${targetPath}/${String(entry.name)}`,
          metric: 'sizeBytes',
          value: entry.sizeBytes as number,
          unit: 'bytes',
          source: 'listFiles',
          correlationId,
          completeness: 'complete',
          coverage: `size of ${String(entry.name)}`
        });
      }
    }
  }

  return records;
}

/**
 * 从 execute_command 的原子系统查询结果中提取数量型证据。
 * 绑定命令资源、指标与调用关联；不得仅凭任意大数字正则把整个任务升级为 measured。
 *
 * @param command - 执行的命令文本
 * @param result - 命令输出文本
 * @param correlationId - 可选的调用关联 ID
 * @returns 解析出的证据记录列表
 */
export function parseCommandEvidence(
  command: string,
  result?: string,
  correlationId?: string
): DiagnosticEvidenceRecord[] {
  if (!result) return [];
  const records: DiagnosticEvidenceRecord[] = [];

  // 只处理纯查询命令，用安全前缀检验
  const isQuery = /^(dir|ls|wmic|systeminfo|Get-PSDrive|df|du|tasklist|ps|ipconfig|ifconfig)\b/i.test(command.trim());
  if (!isQuery) return [];

  // 尝试提取数字型指标
  const sizeMatch = result.match(/(\d+)\s*(bytes|KB|MB|GB)/i);
  if (sizeMatch) {
    const value = parseInt(sizeMatch[1], 10);
    const unit = sizeMatch[2].toLowerCase();
    records.push({
      target: `command:${command.split(' ')[0]}`,
      metric: 'size',
      value,
      unit,
      source: 'execute_command',
      correlationId,
      completeness: 'partial',
      coverage: `output size from ${command.split(' ')[0]}`
    });
  }

  return records;
}

/**
 * 更新诊断状态中的 evidenceRecords：添加新记录并派生回合级证据等级。
 * 同一目标的新完整证据可以替换旧 partial，保留来源可追溯性。
 * 失败时追加目标级 error 记录，保留其他对象的有效 measured。
 */
export function recordEvidence(
  state: DiagnosticTurnState,
  newRecords: DiagnosticEvidenceRecord[],
  hasError: boolean
): DiagnosticTurnState {
  const nextState = cloneDiagnosticTurnState(state);

  for (const record of newRecords) {
    // 同目标同指标的新完整证据替换旧 partial
    const existingIdx = nextState.evidenceRecords.findIndex(
      r => r.target === record.target && r.metric === record.metric && r.completeness !== 'complete'
    );
    if (existingIdx >= 0 && record.completeness === 'complete') {
      nextState.evidenceRecords[existingIdx] = record;
    } else {
      nextState.evidenceRecords = addEvidenceRecord(nextState.evidenceRecords, record);
    }
  }

  if (hasError && newRecords.length === 0) {
    // 纯失败无新记录时追加通用错误标识
    nextState.evidenceRecords = addEvidenceRecord(nextState.evidenceRecords, {
      target: 'unknown',
      metric: 'error',
      value: 0,
      unit: 'count',
      source: 'diagnostic',
      completeness: 'partial',
      coverage: '查询失败',
      error: '工具执行错误'
    });
  }

  // 从 evidenceRecords 派生回合级等级
  nextState.evidenceLevel = deriveEvidenceLevelFromRecords(nextState.evidenceRecords);
  return nextState;
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
    // 预算感知判定（5.8）：使用 listFilesUsed 作为扫描成本预算
    if (nextState.listFilesUsed >= DIAGNOSTIC_LISTFILES_BUDGET) {
      return {
        state: nextState,
        blockedReason: `诊断扫描已达到本轮枚举预算（${DIAGNOSTIC_LISTFILES_BUDGET} 次），必须停止继续扩散并转入总结或请求更窄范围。`
      };
    }

    // 5.9-5.10：允许对已扫描目标的子目录做更窄扫描，但不扩大 maxEntries 上限
    const newMaxEntries = typeof args.maxEntries === 'number' ? args.maxEntries : undefined;
    if (newMaxEntries !== undefined && newMaxEntries > DIAGNOSTIC_LISTFILES_BUDGET * 50) {
      return {
        state: nextState,
        blockedReason: '不能扩大扫描预算上限，请保持或减少 maxEntries。'
      };
    }

    const scanKey = getListFilesScanKey(args);
    if (scanKey && nextState.scannedTargets.includes(scanKey)) {
      nextState.stagnantListFilesCount += 1;
    } else if (scanKey) {
      nextState.scannedTargets.push(scanKey);
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
    if (outcome.error) {
      nextState.evidenceLevel = 'error';
      return nextState;
    }

    const hasMeasuredEvidence = detectMeasuredEvidence(toolName, args, outcome.result);
    nextState.evidenceLevel = elevateEvidenceLevel(
      nextState.evidenceLevel,
      hasMeasuredEvidence ? 'measured' : 'enumeration'
    );
    nextState.lastDirectoryStatsTruncated = detectDirectoryStatsTruncation(outcome.result);
    if (nextState.lastDirectoryStatsTruncated) {
      nextState.stagnantListFilesCount = DIAGNOSTIC_STAGNANT_SCAN_LIMIT;
    }
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
    if (toolName === 'listFiles') {
      return detectMeasuredListFilesEvidence(result);
    }
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

/** 为 listFiles 调用构造稳定扫描键，避免把显式目录统计与普通枚举混为一类。 */
function getListFilesScanKey(args: Record<string, unknown>): string {
  const targetPath = getListFilesTarget(args);
  if (!targetPath) {
    return '';
  }

  const includeMetadata = args.includeMetadata === true;
  const includeDirectoryStats = args.includeDirectoryStats === true;
  if (!includeMetadata && !includeDirectoryStats) {
    return targetPath;
  }

  const parts = [targetPath];
  if (includeMetadata) {
    parts.push('metadata');
  }
  if (includeDirectoryStats) {
    parts.push(`stats:${String(args.maxDepth ?? '')}:${String(args.maxEntries ?? '')}:${String(args.maxBytes ?? '')}`);
  }
  return parts.join('|');
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

/** 识别 listFiles 结构化返回中是否包含真实数量型证据。 */
function detectMeasuredListFilesEvidence(result: string): boolean {
  const payload = parseDiagnosticJson(result);
  if (!payload) {
    return false;
  }

  const directoryStats = payload.directoryStats;
  if (isObjectRecord(directoryStats)) {
    const hasDirectoryTotals =
      typeof directoryStats.totalFiles === 'number' ||
      typeof directoryStats.totalDirectories === 'number' ||
      typeof directoryStats.totalSizeBytes === 'number';
    if (hasDirectoryTotals) {
      return true;
    }
  }

  if (!Array.isArray(payload.entries)) {
    return false;
  }

  return payload.entries.some(entry => isObjectRecord(entry) && typeof entry.sizeBytes === 'number');
}

/** 判断显式目录统计是否已经触发截断，触发后后续必须收敛。 */
function detectDirectoryStatsTruncation(result?: string): boolean {
  const payload = parseDiagnosticJson(result);
  if (!payload || !isObjectRecord(payload.directoryStats)) {
    return false;
  }
  return payload.directoryStats.isTruncated === true;
}

/** 尝试把结构化工具结果解析为对象记录。 */
function parseDiagnosticJson(result?: string): Record<string, unknown> | undefined {
  if (!result) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(result);
    return isObjectRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 收窄 unknown 为普通对象记录。 */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
