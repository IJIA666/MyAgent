/**
 * @file 会话授权令牌与参数摘要工具。
 * 定义 Call Capability 状态机相关类型，并提供参数摘要与字符串摘要计算函数。
 */
import { createHash } from 'crypto';
import type { SafetyResource } from '../usecases/security/SafetyResource.js';

/**
 * 单次工具调用的授权令牌生命周期状态。
 */
export type CallCapabilityState = 'registered' | 'claimed' | 'removed';

/**
 * 单次工具调用的授权令牌（Call Capability）。
 * 绑定 toolCallId + 工具名 + 资源 + 参数摘要，遵循 registered→claimed→removed 三状态生命周期。
 */
export interface CallCapability {
  /** 工具调用唯一标识符 */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 本次调用所涉及的原子资源列表 */
  resources: SafetyResource[];
  /** 规范化参数摘要，用于 claim 时比对防篡改 */
  argumentsDigest: string;
  /** 令牌生命周期状态 */
  state: CallCapabilityState;
  /** 领取该令牌的调用标识（claim 时填入） */
  claimedBy?: string;
  /** 令牌创建时间戳 */
  createdAt: number;
}

/**
 * 计算字符串的 MD5 哈希。
 *
 * @param text - 待计算哈希的原始文本
 * @returns 32 位的十六进制 MD5 哈希字符串
 */
export function computeStringHash(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/**
 * 计算工具调用参数的规范化摘要，用于 capability 令牌的防篡改比对。
 * 按 key 排序后序列化为 JSON 字符串，再计算 MD5 哈希。
 *
 * @param args - 工具调用参数
 * @returns 规范化参数的 MD5 摘要
 */
export function computeArgumentsDigest(args: Record<string, unknown>): string {
  const normalized = JSON.stringify(
    Object.keys(args).sort().map(k => [k, args[k]])
  );
  return computeStringHash(normalized);
}
