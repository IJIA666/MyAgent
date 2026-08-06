/**
 * 诊断数据写盘前治理模块。
 * 该模块只处理数据副本，不依赖 logger、文件系统或运行时配置副作用，
 * 用于在 logger、trace 和 audit 各自的最终序列化边界统一执行敏感值清理。
 */

import { createHash } from 'crypto';
import type { DiagnosticArtifact, DiagnosticPolicy } from '../config/types.js';

/** sanitizer 的默认长度上限，避免异常载荷占满 JSONL 文件。 */
const DEFAULT_MAX_STRING_LENGTH = 4000;
/** sanitizer 的默认数组摘要上限。 */
const DEFAULT_MAX_ARRAY_ITEMS = 50;
/** 用户自定义模式的最大数量。 */
const MAX_CUSTOM_PATTERN_COUNT = 20;
/** 单条用户自定义模式的最大长度。 */
const MAX_CUSTOM_PATTERN_LENGTH = 256;

/** 仅在 operational/audit 中压缩正文的字段。 */
const OPAQUE_FIELDS = new Set([
  'arguments',
  'content',
  'context',
  'messages',
  'patches',
  'prompt',
  'reasoning',
  'result',
  'toolcalls',
  'toolresult'
]);

/** 无论处于何种策略都必须遮蔽的字段。 */
const ALWAYS_REDACTED_FIELDS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authorizationtoken',
  'authtoken',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'env',
  'headers',
  'password',
  'privatekey',
  'refreshtoken',
  'sessiontoken',
  'secret',
  'secretkey',
  'token'
]);

/** sanitizer 可调参数。 */
export interface DiagnosticSanitizerOptions {
  /** 用户追加的脱敏模式。 */
  customPatterns?: readonly string[];
  /** 普通字符串的最大保留长度。 */
  maxStringLength?: number;
  /** 数组的最大保留元素数。 */
  maxArrayItems?: number;
}

/** 已编译的 sanitizer 内部状态。 */
interface SanitizerContext {
  policy: DiagnosticPolicy;
  customPatterns: RegExp[];
  maxStringLength: number;
  maxArrayItems: number;
  seen: WeakSet<object>;
}

/** 根据制品类型解析实际写盘策略。 */
export function resolveDiagnosticPolicy(artifact: DiagnosticArtifact, replayEnabled: boolean): DiagnosticPolicy {
  if (artifact === 'audit') {
    return 'audit';
  }
  if (artifact === 'trace') {
    return replayEnabled ? 'replay' : 'operational';
  }
  return 'operational';
}

/**
 * 校验用户提供的脱敏模式。
 * 错误信息只描述配置结构，不回显模式正文，避免把用户配置中的秘密写入日志。
 *
 * @param patterns - 待校验的模式列表
 * @throws 当模式数量、长度或正则语法不符合边界时抛出配置错误
 */
export function validateDiagnosticPatterns(patterns: readonly string[]): void {
  if (patterns.length > MAX_CUSTOM_PATTERN_COUNT) {
    throw new Error('诊断脱敏 pattern 数量超过安全上限');
  }

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.trim() === '' || pattern.length > MAX_CUSTOM_PATTERN_LENGTH) {
      throw new Error('诊断脱敏 pattern 格式不受支持');
    }
    try {
      new RegExp(pattern, 'gi');
    } catch {
      throw new Error('诊断脱敏 pattern 不是合法正则表达式');
    }
  }
}

/**
 * 递归生成安全数据副本。
 *
 * @param value - 待治理的数据
 * @param policy - 当前制品的诊断策略
 * @param options - 脱敏模式和长度边界
 * @returns 不修改原始输入且可 JSON 序列化的安全副本
 */
export function sanitizeDiagnosticData(
  value: unknown,
  policy: DiagnosticPolicy,
  options: DiagnosticSanitizerOptions = {}
): unknown {
  if (!isDiagnosticPolicy(policy)) {
    throw new Error('不支持的诊断数据策略');
  }

  const patterns = options.customPatterns ?? [];
  const customPatterns: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      customPatterns.push(new RegExp(pattern, 'gi'));
    } catch {
      // 运行时容错：配置加载边界会提前拒绝非法 pattern，直接调用时跳过异常规则。
    }
  }

  const context: SanitizerContext = {
    policy,
    customPatterns,
    maxStringLength: normalizePositiveLimit(options.maxStringLength, DEFAULT_MAX_STRING_LENGTH),
    maxArrayItems: normalizePositiveLimit(options.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS),
    seen: new WeakSet<object>()
  };
  return sanitizeValue(value, undefined, context);
}

/**
 * 为 audit 摘要计算不可逆指纹。
 *
 * @param value - 待摘要的值
 * @returns 小写十六进制 SHA-256 摘要
 */
export function digestDiagnosticValue(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = '[unserializable]';
  }
  return createHash('sha256').update(serialized).digest('hex');
}

/** 判断是否为合法诊断策略。 */
function isDiagnosticPolicy(value: unknown): value is DiagnosticPolicy {
  return value === 'operational' || value === 'audit' || value === 'replay';
}

/** 处理对象、数组、Error 和基础类型，始终返回安全副本。 */
function sanitizeValue(value: unknown, fieldName: string | undefined, context: SanitizerContext): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    return sanitizeString(value, fieldName, context);
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return `[${typeof value}]`;
  }
  if (typeof value !== 'object') {
    return String(value);
  }

  if (context.seen.has(value)) {
    return '[Circular]';
  }
  context.seen.add(value);

  try {
    if (Array.isArray(value)) {
      if (value.length > context.maxArrayItems) {
        return `[Array: ${value.length} items]`;
      }
      return value.map((item) => sanitizeValue(item, undefined, context));
    }

    const result: Record<string, unknown> = {};
    const keys = value instanceof Error
      ? Object.getOwnPropertyNames(value)
      : Object.keys(value as Record<string, unknown>);
    for (const key of keys) {
      const normalizedKey = normalizeFieldName(key);
      if (ALWAYS_REDACTED_FIELDS.has(normalizedKey)) {
        result[key] = '[REDACTED]';
        continue;
      }
      if (context.policy !== 'replay' && OPAQUE_FIELDS.has(normalizedKey)) {
        result[key] = summarizeOpaqueValue((value as Record<string, unknown>)[key], context);
        continue;
      }
      try {
        result[key] = sanitizeValue((value as Record<string, unknown>)[key], normalizedKey, context);
      } catch {
        result[key] = '[Unserializable]';
      }
    }
    return result;
  } finally {
    context.seen.delete(value);
  }
}

/** 处理普通文本、内置凭据模式、用户模式和日志注入字符。 */
function sanitizeString(value: string, fieldName: string | undefined, context: SanitizerContext): string {
  if (ALWAYS_REDACTED_FIELDS.has(fieldName ?? '')) {
    return '[REDACTED]';
  }

  let sanitized = value;
  sanitized = sanitized.replace(/(\b(?:authorization|proxy-authorization)\b\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s,;]+/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+-]{8,}/gi, '$1 [REDACTED]');
  sanitized = sanitized.replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^&\s,;]+)/gi, (match) => {
    const separator = match.match(/[=:]/)?.[0] ?? '=';
    const prefix = match.slice(0, match.indexOf(separator) + 1);
    return `${prefix}[REDACTED]`;
  });
  sanitized = sanitized.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  sanitized = sanitized.replace(/\b(?:sk|pk|xoxb|xoxp)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  sanitized = sanitized.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}\b/g, '[REDACTED]');
  sanitized = sanitized.replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]');
  for (const pattern of context.customPatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  sanitized = sanitized.replace(/[\r\n\u2028\u2029]/g, '\\n');

  if (sanitized.length > context.maxStringLength) {
    return `[String: ${sanitized.length} chars, sha256: ${digestDiagnosticValue(sanitized)}]`;
  }
  return sanitized;
}

/** 为 operational/audit 的高风险正文生成只含长度和摘要的结构化替代值。 */
function summarizeOpaqueValue(value: unknown, context: SanitizerContext): unknown {
  if (Array.isArray(value) && value.length === 0) {
    return [];
  }
  const safe = sanitizeValue(value, undefined, { ...context, seen: new WeakSet<object>() });
  if (typeof safe === 'string') {
    return `[String: ${safe.length} chars, sha256: ${digestDiagnosticValue(safe)}]`;
  }
  if (Array.isArray(safe)) {
    return `[Array: ${safe.length} items, sha256: ${digestDiagnosticValue(safe)}]`;
  }
  return `[Object, sha256: ${digestDiagnosticValue(safe)}]`;
}

/** 统一规范化字段名，兼容大小写、短横线、下划线和空格变体。 */
function normalizeFieldName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/** 防止调用方传入非法长度导致 sanitizer 自身异常。 */
function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
