/**
 * @file Skill 学习节奏的持久化领域状态。
 * 该状态跨普通成功回合累计“包含非空 tool_calls 的模型响应次数”，
 * 与等待交互使用的 SkillLearningContinuation 分开保存；
 * 命名与文档统一使用 toolResponseIteration，不再暗示所有模型循环计数。
 */

/** Skill 学习节奏状态的版本号；结构变更时应递增并迁移。 */
export const SKILL_LEARNING_CADENCE_VERSION = 1 as const;

/**
 * 版本化 Skill 学习节奏状态。
 * 只保存未达到阈值的累计值；达到阈值并接受调度后由调用方消费阈值。
 */
export interface SkillLearningCadenceState {
  /** 状态结构版本。 */
  readonly version: typeof SKILL_LEARNING_CADENCE_VERSION;
  /** 已累计的“包含非空 tool_calls 的模型响应次数”。 */
  readonly accumulatedToolResponseIterations: number;
}

/**
 * 深复制并冻结学习节奏状态，避免插件与会话快照共享可变引用。
 *
 * @param state - 待复制的状态
 * @returns 与调用方引用隔离的只读状态
 */
export function cloneSkillLearningCadence(
  state: Readonly<SkillLearningCadenceState>,
): Readonly<SkillLearningCadenceState> {
  return Object.freeze({
    version: SKILL_LEARNING_CADENCE_VERSION,
    accumulatedToolResponseIterations: state.accumulatedToolResponseIterations,
  });
}

/**
 * 校验会话快照中的未知值并恢复学习节奏状态。
 * 非法数据按 fail-closed 返回零累计状态，不影响消息历史、挂起交互或延续状态恢复。
 *
 * @param value - 会话快照中的原始字段
 * @returns 合法的只读状态；字段缺失、版本未知、类型错误或负数时返回零累计
 */
export function normalizeSkillLearningCadence(
  value: unknown,
): Readonly<SkillLearningCadenceState> {
  if (!isRecord(value)
    || value.version !== SKILL_LEARNING_CADENCE_VERSION
    || !Number.isInteger(value.accumulatedToolResponseIterations)
    || (value.accumulatedToolResponseIterations as number) < 0
  ) {
    return Object.freeze({
      version: SKILL_LEARNING_CADENCE_VERSION,
      accumulatedToolResponseIterations: 0,
    });
  }
  return cloneSkillLearningCadence({
    version: SKILL_LEARNING_CADENCE_VERSION,
    accumulatedToolResponseIterations: value.accumulatedToolResponseIterations as number,
  });
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
