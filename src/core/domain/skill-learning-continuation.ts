/**
 * @file Skill 学习在人机中断边界上的可持久化延续状态。
 * 该状态只保存等待前已经产生的学习证据，不代表任务已经成功，也不会直接触发后台 Review。
 */

import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';

/** Skill Review 使用的单条结构化工具证据。 */
export interface SkillReviewToolEvidence {
  /** 工具调用标识。 */
  readonly toolCallId: string;
  /** 工具名称。 */
  readonly toolName: string;
  /** 工具结果状态。 */
  readonly status: 'success' | 'error';
  /** 有界结果摘要。 */
  readonly resultSummary: string;
}

/**
 * 等待用户交互时保存的 Skill 学习延续状态。
 * 后续 run 只有正常完成后，才会把这些证据计入 Review 阈值。
 */
export interface SkillLearningContinuation {
  /** 延续状态结构版本。 */
  readonly version: 3;
  /** 等待前已经复制的有界会话轨迹。 */
  readonly trajectory: readonly ChatMessage[];
  /** 等待前真实成功加载的 Skill 名称。 */
  readonly loadedSkills: readonly string[];
  /** 等待前收集的结构化工具证据。 */
  readonly toolEvidence: readonly SkillReviewToolEvidence[];
  /** 等待前已经进入模型流的逻辑请求次数。 */
  readonly modelLoopCount: number;
  /** 等待前包含非空 tool_calls 的模型响应数量。 */
  readonly toolIterationCount: number;
  /** 等待前模型请求的工具调用总数。 */
  readonly requestedToolCallCount: number;
  /** 已经跨越的人机中断段数量。 */
  readonly segmentCount: number;
  /**
   * 等待段结束时的会话历史长度。
   * 恢复 run 时该值作为逻辑学习资格/恢复边界（learningTrajectoryStartIndex）：
   * 恢复 run 的学习起点必须与它一致；后台复盘快照统一从恢复后的主会话
   * 当前历史一次性构造，不再从该索引截取轨迹与本状态 trajectory 拼接。
   */
  readonly resumeHistoryIndex: number;
  /**
   * 等待前是否已通过前台 skill_manage 真实 success/staged 沉淀。
   * 恢复 run 继续沿用该标志，等待前后的工具型响应均不得推进本任务的后台学习累计。
   */
  readonly foregroundSkillMutationHandled: boolean;
}

/**
 * 深复制并冻结 Skill 学习延续状态，避免插件与会话快照共享可变引用。
 *
 * @param continuation - 待保存的延续状态
 * @returns 与调用方引用隔离的只读状态
 */
export function cloneSkillLearningContinuation(
  continuation: Readonly<SkillLearningContinuation>,
): Readonly<SkillLearningContinuation> {
  return Object.freeze({
    version: 3,
    trajectory: Object.freeze(structuredClone([...continuation.trajectory])),
    loadedSkills: Object.freeze([...continuation.loadedSkills]),
    toolEvidence: Object.freeze(
      continuation.toolEvidence.map(evidence => Object.freeze({ ...evidence })),
    ),
    modelLoopCount: continuation.modelLoopCount,
    toolIterationCount: continuation.toolIterationCount,
    requestedToolCallCount: continuation.requestedToolCallCount,
    segmentCount: continuation.segmentCount,
    resumeHistoryIndex: continuation.resumeHistoryIndex,
    foregroundSkillMutationHandled: continuation.foregroundSkillMutationHandled,
  });
}

/**
 * 校验会话快照中的未知值并恢复 Skill 学习延续状态。
 * 非法数据按 fail-closed 返回 null，不影响主会话消息恢复。
 * 旧版（version 1/2）快照无法还原模型循环数，按零循环迁移并保留其余证据。
 *
 * @param value - 会话快照中的原始字段
 * @returns 合法的只读延续状态；字段缺失或损坏时返回 null
 */
export function normalizeSkillLearningContinuation(
  value: unknown,
): Readonly<SkillLearningContinuation> | null {
  if (!isRecord(value)
    || (value.version !== 1 && value.version !== 2 && value.version !== 3)
    || !Array.isArray(value.trajectory)
    || !value.trajectory.every(isChatMessage)
    || !Array.isArray(value.loadedSkills)
    || !value.loadedSkills.every(isNonEmptyString)
    || !Array.isArray(value.toolEvidence)
    || !value.toolEvidence.every(isToolEvidence)
    || (value.version === 3 && !isNonNegativeInteger(value.modelLoopCount))
    || !isNonNegativeInteger(value.toolIterationCount)
    || !isNonNegativeInteger(value.requestedToolCallCount)
    || !Number.isInteger(value.segmentCount)
    || (value.segmentCount as number) < 1
    || !isNonNegativeInteger(value.resumeHistoryIndex)
  ) {
    return null;
  }

  // version 1 旧快照缺少前台沉淀标志：按 false 迁移。
  const foregroundHandled = value.version === 2 || value.version === 3
    ? value.foregroundSkillMutationHandled === true
    : false;

  return cloneSkillLearningContinuation({
    version: 3,
    trajectory: value.trajectory as ChatMessage[],
    loadedSkills: value.loadedSkills as string[],
    toolEvidence: value.toolEvidence as SkillReviewToolEvidence[],
    // 旧版只记录工具响应次数，不能把它误当成模型循环次数。
    modelLoopCount: value.version === 3 ? value.modelLoopCount as number : 0,
    toolIterationCount: value.toolIterationCount as number,
    requestedToolCallCount: value.requestedToolCallCount as number,
    segmentCount: value.segmentCount as number,
    resumeHistoryIndex: value.resumeHistoryIndex as number,
    foregroundSkillMutationHandled: foregroundHandled,
  });
}

/** 判断未知值是否为最小合法 ChatMessage。 */
function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value)
    && typeof value.role === 'string'
    && (typeof value.content === 'string' || value.content === null);
}

/** 判断未知值是否为结构化工具证据。 */
function isToolEvidence(value: unknown): value is SkillReviewToolEvidence {
  return isRecord(value)
    && isNonEmptyString(value.toolCallId)
    && isNonEmptyString(value.toolName)
    && (value.status === 'success' || value.status === 'error')
    && typeof value.resultSummary === 'string';
}

/** 判断未知值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 判断未知值是否为非负整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
