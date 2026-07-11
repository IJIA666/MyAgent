/**
 * @fileoverview 诊断类任务的轻量护栏状态与判定工具。
 * 负责识别诊断意图、跟踪本轮扫描/系统查询状态，并提供工具调用前后的收敛决策。
 */

import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';

// ── 最终回答质量门禁 ──

/**
 * 诊断质量门禁检查结果。
 */
export interface DiagnosticQualityGateResult {
  /** 是否通过门禁（无违规主张） */
  passed: boolean;
  /** 修正后的回答文本（通过时与原文相同） */
  sanitizedText: string;
  /** 违规主张列表 */
  violations: string[];
}

/**
 * 场景感知的质量门禁关键词模式。
 * 仅在回答中包含以下关键词时才触发对应类型的证据校验。
 */
const QUALITY_TRIGGER_PATTERNS: Array<{ trigger: RegExp; label: string }> = [
  { trigger: /(?:释放|清理|删除|节省|占用)[^。\n]*?\d+\s*(?:GB|MB|KB|bytes?)/i, label: 'quantified-release' },
  { trigger: /\b(总量|总空间|合计|容量)\s*:?\s*\d+/i, label: 'total-capacity' },
  { trigger: /建议\s*(优先|可以|需要|应当)\s*(删除|迁移|清理|优化|修改|备份)/i, label: 'cleanup-recommendation' },
  { trigger: /主要(原因|问题|占用|瓶颈)(是|为)/i, label: 'root-cause' },
  { trigger: /风险.*(高|低|中|不可控|可控|安全)/i, label: 'risk-assessment' },
  { trigger: /(完成度|进度)\s*[：:]\s*\d+%/i, label: 'completion-estimate' },
];

/** 存储容量单位到字节的换算倍率。 */
const STORAGE_UNIT_MULTIPLIERS: Record<string, number> = {
  byte: 1,
  bytes: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

/** 从主张文本中提取全部存储容量数值并统一换算为字节。 */
function extractStorageClaims(text: string): number[] {
  return Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*(bytes?|KB|MB|GB|TB)/gi), match => {
    const multiplier = STORAGE_UNIT_MULTIPLIERS[match[2].toLowerCase()] ?? 1;
    return Number(match[1]) * multiplier;
  });
}

/** 构建可直接引用的测量值，并补充同一目标总量与剩余量的确定性差值。 */
function buildMeasuredStorageValues(evidenceRecords: DiagnosticEvidenceRecord[]): number[] {
  const completeRecords = evidenceRecords.filter(record =>
    record.completeness === 'complete' &&
    !record.error &&
    STORAGE_UNIT_MULTIPLIERS[record.unit.toLowerCase()] !== undefined
  );
  const values = completeRecords.map(record =>
    record.value * STORAGE_UNIT_MULTIPLIERS[record.unit.toLowerCase()]
  );
  for (let leftIndex = 0; leftIndex < completeRecords.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < completeRecords.length; rightIndex++) {
      if (completeRecords[leftIndex].target === completeRecords[rightIndex].target) {
        values.push(Math.abs(values[leftIndex] - values[rightIndex]));
      }
    }
  }
  return values;
}

/** 判断量化主张是否与某个完整测量值在显示舍入误差内一致。 */
function isSupportedStorageClaim(claim: number, measuredValues: number[]): boolean {
  return measuredValues.some(value => Math.abs(value - claim) <= Math.max(1024 ** 2, value * 0.02));
}

/**
 * 确定性"主张—证据"质量门禁。
 * 对诊断类最终回答中的量化主张、完成度估算、清理建议和风险结论做证据匹配校验。
 * 无匹配证据的主张被降级或删除，不调用模型自评。
 *
 * @param response - 模型生成的最终回答文本
 * @param evidenceRecords - 当前对象级证据记录列表
 * @returns 质量门禁检查结果
 */
export function applyDiagnosticQualityGate(
  response: string,
  evidenceRecords: DiagnosticEvidenceRecord[]
): DiagnosticQualityGateResult {
  const violations: string[] = [];
  let sanitized = response;

  // 遍历触发模式，检查对应主张是否有证据支持
  const hasMeasured = evidenceRecords.some(r => r.completeness === 'complete' && !r.error);
  const hasAnyMetric = evidenceRecords.some(r => r.metric !== 'error' && r.metric !== 'entries');
  const measuredStorageValues = buildMeasuredStorageValues(evidenceRecords);
  for (const { trigger, label } of QUALITY_TRIGGER_PATTERNS) {
    if (!trigger.test(sanitized)) continue;

    switch (label) {
      case 'quantified-release': {
        // 量化释放主张必须能匹配具体完整测量值，不能用任意 measured 记录笼统放行。
        const claims = extractStorageClaims(sanitized.match(trigger)?.[0] ?? '');
        if (claims.length === 0 || claims.some(claim => !isSupportedStorageClaim(claim, measuredStorageValues))) {
          violations.push('量化释放估算无证据支持');
          sanitized = sanitized.replace(
            trigger,
            '（待验证：当前证据不足，无法提供准确量化估算）'
          );
        }
        break;
      }
      case 'total-capacity': {
        if (!hasMeasured) {
          violations.push('总容量声明无完整测量证据');
          sanitized = sanitized.replace(trigger, '（待测量）');
        }
        break;
      }
      case 'cleanup-recommendation': {
        if (!hasAnyMetric) {
          violations.push('清理建议无任何测量证据');
          sanitized = sanitized.replace(
            trigger,
            '（待验证——当前仅有文件列表，无实际大小数据）'
          );
        }
        break;
      }
      case 'root-cause': {
        if (!hasMeasured) {
          violations.push('主要原因判定无完整测量证据');
          sanitized = sanitized.replace(
            /主要(原因|问题|占用|瓶颈)(是|为).*?[。\n]/g,
            '（证据不足以判定主要原因）'
          );
        }
        break;
      }
      case 'risk-assessment': {
        if (!hasMeasured) {
          violations.push('风险评估无测量证据');
          sanitized = sanitized.replace(
            trigger,
            '（风险等级待验证——当前证据不足以判定风险）'
          );
        }
        break;
      }
      case 'completion-estimate': {
        if (!hasMeasured) {
          violations.push('完成度估算无测量证据');
          sanitized = sanitized.replace(
            trigger,
            '（完成度待评估——当前证据不足以计算进度百分比）'
          );
        }
        break;
      }
    }
  }

  return {
    passed: violations.length === 0,
    sanitizedText: sanitized,
    violations,
  };
}

// ── 证据解释器注册系统 ──

/**
 * 证据解释器函数类型。
 * 将工具调用参数和结果转换为对象级证据记录列表。
 *
 * @param args - 工具调用参数
 * @param result - 工具执行结果文本
 * @param error - 可选的执行错误
 * @param correlationId - 可选的调用关联 ID
 * @returns 证据记录列表（空数组表示无法解析）
 */
export type EvidenceInterpreter = (
  args: Record<string, unknown>,
  result?: string,
  error?: string,
  correlationId?: string
) => DiagnosticEvidenceRecord[];

/** 全局证据解释器注册表：工具名 → 解释器函数 */
const evidenceInterpreters = new Map<string, EvidenceInterpreter>();

/**
 * 注册一个诊断工具的证据解释器。
 *
 * @param toolName - 工具名称
 * @param interpreter - 解释器函数
 */
export function registerEvidenceInterpreter(toolName: string, interpreter: EvidenceInterpreter): void {
  evidenceInterpreters.set(toolName, interpreter);
}

/**
 * 获取已注册的所有解释器名称（供测试与调试使用）。
 *
 * @returns 已注册的解释器工具名列表
 */
export function getRegisteredInterpreters(): string[] {
  return Array.from(evidenceInterpreters.keys());
}

/**
 * 解析工具执行结果，生成对象级证据记录。
 * 优先使用已注册的解释器；未注册时返回空数组。
 *
 * @param toolName - 工具名称
 * @param args - 工具调用参数
 * @param result - 工具执行结果文本
 * @param error - 可选的执行错误
 * @param correlationId - 可选的调用关联 ID
 * @returns 证据记录列表
 */
export function resolveToolEvidence(
  toolName: string,
  args: Record<string, unknown>,
  result?: string,
  error?: string,
  correlationId?: string
): DiagnosticEvidenceRecord[] {
  const interpreter = evidenceInterpreters.get(toolName);
  if (interpreter) {
    return interpreter(args, result, error, correlationId);
  }
  return [];
}

/** 诊断任务允许扩展的最大目录枚举次数。 */
export const DIAGNOSTIC_LISTFILES_BUDGET = 4;
/** 连续命中低价值枚举的最大容忍次数。 */
export const DIAGNOSTIC_STAGNANT_SCAN_LIMIT = 2;

/** 诊断相关工具名称列表。非此列表内的工具不计入证据增益与收敛计数。 */
const DIAGNOSTIC_TOOL_NAMES = new Set([
  'readFile', 'readManyFiles', 'listFiles', 'execute_command',
  'grepSearch', 'globSearch', 'search',
]);

/** 诊断结论允许使用的证据等级。 */
export type DiagnosticEvidenceLevel = 'presence' | 'enumeration' | 'measured' | 'error';

/**
 * 证据完整性分类。
 * - `complete`: 完整测量，可用于精确结论
 * - `partial`: 部分测量，部分可量化但覆盖不完整
 * - `lower-bound`: 下界值，仅表示"至少观察到 N"，不可推断上限
 * - `listed`: 纯枚举/候选项列表，无量化测量
 */
export type EvidenceCompleteness = 'complete' | 'partial' | 'lower-bound' | 'listed';

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

/**
 * 单次诊断工具调用的度量元数据。
 * 用于计算证据增益和成本收敛。
 */
export interface ToolCallMetrics {
  /** 工具名称 */
  toolName: string;
  /** 目标路径或标识 */
  targetKey: string;
  /** 本次调用新增的 evidenceRecords 数量 */
  newRecordsCount: number;
  /** 本次调用的估算耗时（毫秒） */
  durationMs: number;
  /** 扫描条目数（适用于枚举类工具） */
  itemsScanned: number;
  /** 输出体积（字节） */
  outputSizeBytes: number;
  /** 失败分类（无失败时为 undefined） */
  failureType?: 'permission_denied' | 'execution_error' | 'validation_error' | 'timeout' | 'cancelled';
}

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
  /** 本轮累计的工具调用度量列表，用于证据增益与成本收敛判定 */
  callMetrics: ToolCallMetrics[];
  /** 连续无增益（无新增记录）的调用次数 */
  stagnantCallCount: number;
  /** 连续无新增目标的调用次数 */
  stagnantTargetCount: number;
}

/**
 * 获取当前调用中新增的 evidenceRecords 数量（与上次快照比较）。
 * 用于计算单次调用的证据增益。
 *
 * @param current - 当前回合的证据记录列表
 * @param previous - 上次调用后的证据记录列表
 * @returns 新增记录数
 */
export function computeEvidenceGain(
  current: DiagnosticEvidenceRecord[],
  previous: DiagnosticEvidenceRecord[]
): number {
  const prevSet = new Set(previous.map(r => `${r.target}|${r.metric}`));
  return current.filter(r => !prevSet.has(`${r.target}|${r.metric}`)).length;
}

/**
 * 获取新增的 unique 目标数。
 *
 * @param current - 当前已扫描的目标列表
 * @param previous - 上次扫描的目标列表
 * @returns 新增目标数
 */
export function computeTargetGain(current: string[], previous: string[]): number {
  const prevSet = new Set(previous);
  return current.filter(t => !prevSet.has(t)).length;
}

/**
 * 检查是否应基于证据增益和成本收敛阻断调用。
 *
 * @param state - 当前诊断状态
 * @param toolName - 即将调用的工具名称
 * @param targetKey - 本次调用的目标标识
 * @returns 阻断原因，无阻断时返回 undefined
 */
export function checkDiagnosticConvergence(
  state: DiagnosticTurnState,
  toolName: string,
  _targetKey?: string
): string | undefined {
  if (!state.active) {
    return undefined;
  }

  // 连续 3 次调用无新增证据 → 阻断
  if (state.stagnantCallCount >= 3) {
    return `诊断已连续 ${state.stagnantCallCount} 次调用无新增证据，必须停止当前方向的扩散，基于已有证据总结或请求用户缩小范围。`;
  }

  // 连续 2 次调用无新增目标 → 阻断（重复扫描）
  if (state.stagnantTargetCount >= 2) {
    return `诊断已连续 ${state.stagnantTargetCount} 次调用无新增目标，必须停止重复扫描并汇总当前候选。`;
  }

  // listFiles 特定：已达预算上限
  if (toolName === 'listFiles' && state.listFilesUsed >= DIAGNOSTIC_LISTFILES_BUDGET) {
    return `诊断扫描已达到本轮枚举预算（${DIAGNOSTIC_LISTFILES_BUDGET} 次），必须停止继续扩散并转入总结或请求更窄范围。`;
  }

  return undefined;
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
    evidenceRecords: [],
    callMetrics: [],
    stagnantCallCount: 0,
    stagnantTargetCount: 0,
  };
}

/**
 * 从 evidenceRecords 派生回合级 evidenceLevel。
 * 优先取最高完整性记录的等级，error 优先。
 */
export function deriveEvidenceLevelFromRecords(records: DiagnosticEvidenceRecord[]): DiagnosticEvidenceLevel {
  if (records.length === 0) return 'presence';

  // 至少有一条无 error 的完整测量 → measured
  const hasCleanComplete = records.some(r => r.completeness === 'complete' && !r.error);
  if (hasCleanComplete) return 'measured';

  // 有 error 记录，且无 clean complete → error
  const hasError = records.some(r => r.error);
  if (hasError) return 'error';

  // 无 error，有部分测量 → measured
  const hasPartialOrLower = records.some(r => r.completeness === 'partial' || r.completeness === 'lower-bound');
  if (hasPartialOrLower) return 'measured';

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
 * 批量添加证据记录到有界集合。
 * 内部逐条调用 addEvidenceRecord 以复用淘汰策略。
 * 同目标同指标的新完整证据替换旧 partial 记录。
 *
 * @param records - 现有证据记录列表
 * @param newRecords - 新增的证据记录列表
 * @returns 更新后的证据记录列表
 */
export function addEvidenceRecords(
  records: DiagnosticEvidenceRecord[],
  newRecords: DiagnosticEvidenceRecord[]
): DiagnosticEvidenceRecord[] {
  let result = records;
  for (const record of newRecords) {
    // 同目标同指标的新完整证据替换旧 partial
    const existingIdx = result.findIndex(
      r => r.target === record.target && r.metric === record.metric && r.completeness !== 'complete'
    );
    if (existingIdx >= 0 && record.completeness === 'complete') {
      result = [...result];
      result[existingIdx] = record;
    } else {
      result = addEvidenceRecord(result, record);
    }
  }
  return result;
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return [];
  }

  const records: DiagnosticEvidenceRecord[] = [];

  // 处理 JSON 数组结果（listFiles 返回简单文件名列表 → enumeration）
  if (Array.isArray(parsed)) {
    records.push({
      target: targetPath,
      metric: 'entries',
      value: parsed.length,
      unit: 'files',
      source: 'listFiles',
      correlationId,
      completeness: 'listed',
      coverage: `file list in ${targetPath}`
    });
    return records;
  }

  // 非对象记录无法解析
  if (typeof parsed !== 'object' || parsed === null) {
    return records;
  }

  const payload = parsed as Record<string, unknown>;

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
/**
 * 提取命令文本中的核心查询命令（去除 shell wrapper 前缀）。
 */
function extractQueryCore(text: string): string {
  const trimmed = text.trim();
  // 去除常见 shell wrapper: powershell -Command "...", cmd /c "...", bash -c "..."
  const shellMatch = trimmed.match(/^(?:powershell|pwsh|cmd|bash|sh)\s+(?:-[a-zA-Z]+\s+)*(?:-c|-Command|\/c)\s+["']?([^"']+)["']?$/i);
  if (shellMatch) {
    return shellMatch[1].trim();
  }
  return trimmed;
}

export function parseCommandEvidence(
  command: string,
  result?: string,
  correlationId?: string
): DiagnosticEvidenceRecord[] {
  if (!result) return [];
  const records: DiagnosticEvidenceRecord[] = [];

  // 提取核心命令（去除 shell wrapper）
  const coreCommand = extractQueryCore(command);
  const isQuery = /^(dir|ls|wmic|systeminfo|Get-PSDrive|df|du|tasklist|ps|ipconfig|ifconfig)\b/i.test(coreCommand);
  if (!isQuery) return [];

  const cmdPrefix = coreCommand.split(' ')[0];

  // 1. wmic 输出: FreeSpace=<number>, Size=<number>
  if (/^wmic\b/i.test(coreCommand)) {
    const freeMatch = result.match(/FreeSpace\s*=\s*(\d+)/i);
    const sizeMatch = result.match(/Size\s*=\s*(\d+)/i);
    if (freeMatch) {
      records.push({
        target: `command:${cmdPrefix}`, metric: 'freeSpace',
        value: parseInt(freeMatch[1], 10), unit: 'bytes',
        source: 'execute_command', correlationId,
        completeness: 'complete', coverage: `free space from ${cmdPrefix}`
      });
    }
    if (sizeMatch) {
      records.push({
        target: `command:${cmdPrefix}`, metric: 'totalSize',
        value: parseInt(sizeMatch[1], 10), unit: 'bytes',
        source: 'execute_command', correlationId,
        completeness: 'complete', coverage: `total size from ${cmdPrefix}`
      });
    }
    if (freeMatch || sizeMatch) return records; // wmic 匹配成功
  }

  // 2. 通用数字型指标提取（大小/容量）
  const genericSize = result.match(/(\d+)\s*(bytes|KB|MB|GB)/i);
  if (genericSize) {
    records.push({
      target: `command:${cmdPrefix}`, metric: 'size',
      value: parseInt(genericSize[1], 10), unit: genericSize[2].toLowerCase(),
      source: 'execute_command', correlationId,
      completeness: 'partial', coverage: `output size from ${cmdPrefix}`
    });
  }

  // 3. tasklist/ps 行计数
  if (/^(tasklist|ps)\b/i.test(coreCommand)) {
    const lines = result.split('\n').filter(l => l.trim().length > 0);
    const dataLines = lines.length > 3 ? lines.length - 2 : Math.max(0, lines.length - 1);
    if (dataLines > 0) {
      records.push({
        target: `command:${cmdPrefix}`, metric: 'processCount',
        value: dataLines, unit: 'processes',
        source: 'execute_command', correlationId,
        completeness: 'partial', coverage: `process count from ${cmdPrefix}`
      });
    }
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

  // 通用收敛检查：基于证据增益和成本的阻断
  const targetKey = getToolCallTargetKey(toolName, args);
  const convergenceReason = checkDiagnosticConvergence(nextState, toolName, targetKey);
  if (convergenceReason) {
    return { state: nextState, blockedReason: convergenceReason };
  }

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

  // 诊断上下文中不允许 browser_navigate 访问 file:// 资源（磁盘容量诊断场景下
  // 不具备测量语义，不得作为系统查询失败的降级替代）。
  // 合法的本地 HTML 内容检查由 Agent 在非 file:// 目标或非容量诊断路径中执行。
  if (toolName === 'browser_navigate') {
    const url = typeof args.url === 'string' ? args.url : '';
    if (/^file:\/\//i.test(url.trim())) {
      return {
        state: nextState,
        blockedReason: '诊断上下文中不允许浏览器导航到 file:// 资源：浏览器不具备磁盘容量测量能力，且此类导航结果不能形成 measured 级证据。请使用内置只读文件工具或请求用户缩小范围。'
      };
    }
    // 非 file:// 导航放行
    return { state: nextState };
  }

  if (toolName === 'listFiles') {
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
 * 在工具执行后回写对象级证据并更新诊断状态。
 * 优先使用已注册的证据解释器解析工具结果并写入对象级账本；
 * 未注册解释器的工具保守记录 presence 或 error。
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
  mergeHighRiskTargets(
    nextState,
    collectHighRiskTargets(
      `${extractTextFragments(args).join('\n')}\n${outcome.result ?? ''}\n${outcome.error ?? ''}`
    )
  );

  // 解析对象级证据记录
  const previousRecords = [...nextState.evidenceRecords];
  const newRecords = resolveToolEvidence(toolName, args, outcome.result, outcome.error);

  if (newRecords.length > 0) {
    // 有结构化证据：写入账本并从记录派生回合级等级
    const hasError = newRecords.some(r => r.error);
    nextState.evidenceRecords = addEvidenceRecords(nextState.evidenceRecords, newRecords);
    nextState.evidenceLevel = deriveEvidenceLevelFromRecords(nextState.evidenceRecords);
    if (hasError) {
      nextState.lastSystemQueryFailed = true;
    }
  } else if (outcome.error) {
    // 无结构化证据但有错误：保守记录 error，追加通用错误标识
    nextState.evidenceRecords = addEvidenceRecord(nextState.evidenceRecords, {
      target: toolName,
      metric: 'error',
      value: 0,
      unit: 'count',
      source: toolName,
      completeness: 'partial',
      coverage: '工具执行错误',
      error: outcome.error
    });
    nextState.evidenceLevel = 'error';
  } else {
    // 无结构化证据且无错误：保守记录 presence
    nextState.evidenceLevel = elevateEvidenceLevel(nextState.evidenceLevel, 'presence');
  }

  // 仅诊断工具参与证据增益和收敛计数
  const isDiagTool = DIAGNOSTIC_TOOL_NAMES.has(toolName);
  if (isDiagTool) {
    const evidenceGain = computeEvidenceGain(nextState.evidenceRecords, previousRecords);
    const previousTargets = [...nextState.scannedTargets];
    const currentTargetKey = getToolCallTargetKey(toolName, args);
    let targetGain = 0;
    if (currentTargetKey && !previousTargets.includes(currentTargetKey)) {
      targetGain = 1;
      nextState.scannedTargets.push(currentTargetKey);
    }

    // 更新停滞计数（仅诊断工具）
    if (evidenceGain === 0) {
      nextState.stagnantCallCount += 1;
    } else {
      nextState.stagnantCallCount = 0;
    }
    if (targetGain === 0) {
      nextState.stagnantTargetCount += 1;
    } else {
      nextState.stagnantTargetCount = 0;
    }

    // 记录调用度量（获取真实值，不伪造）
    const outputSizeBytes = outcome.result ? outcome.result.length : 0;
    let failureType: ToolCallMetrics['failureType'] = undefined;
    if (outcome.error) {
      failureType = 'execution_error';
    }
    // itemsScanned 和 durationMs 在无真实测量时保持 0，不在此时注入伪造值
    nextState.callMetrics.push({
      toolName,
      targetKey: getToolCallTargetKey(toolName, args),
      newRecordsCount: newRecords.length,
      durationMs: 0,
      itemsScanned: 0,
      outputSizeBytes,
      failureType,
    });
  }

  // 保留工具特定的副状态（系统查询失败标志、枚举截断标志）
  if (toolName === 'execute_command') {
    nextState.lastSystemQueryFailed = !!outcome.error;
  }
  if (toolName === 'listFiles') {
    nextState.lastDirectoryStatsTruncated = detectDirectoryStatsTruncation(outcome.result);
    if (nextState.lastDirectoryStatsTruncated) {
      nextState.stagnantListFilesCount = DIAGNOSTIC_STAGNANT_SCAN_LIMIT;
    }
  }

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
    scannedTargets: [...state.scannedTargets],
    evidenceRecords: [...state.evidenceRecords],
    callMetrics: [...state.callMetrics],
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

/**
 * 从工具调用参数中提取稳定目标键，用于增益追踪和收敛判定。
 */
function getToolCallTargetKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'listFiles') {
    return getListFilesScanKey(args);
  }
  if (toolName === 'execute_command') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    // 只取前两个词作为抽象键，避免参数细节导致重复计数偏差
    return `cmd:${cmd.split(/\s+/).slice(0, 2).join(' ')}`;
  }
  if (toolName === 'readFile' || toolName === 'readManyFiles') {
    const path = (args.targetPath ?? args.targetPaths) as string | undefined;
    return path ? `read:${path}` : toolName;
  }
  return toolName;
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
