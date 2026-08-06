/**
 * @file 子代理任务状态协议。
 * 只保存任务生命周期和低敏诊断索引，不保存 prompt、原始 assistant 输出或完整 transcript。
 */

import type { SubagentContextPolicy } from '../../../ports/driving/SubagentExecutionPort.js';

/** 任务可观察生命周期状态。 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'interrupted';

/** 任务的前台/后台阻塞属性。 */
export type TaskMode = 'foreground' | 'background';

/** 任务终态集合。 */
export type TerminalTaskStatus = Exclude<TaskStatus, 'pending' | 'running' | 'waiting_approval'>;

/** 任务运行用量的低敏摘要。 */
export interface TaskUsage {
  /** 最后一次请求输入 Token 加所有请求输出 Token。 */
  readonly totalTokens?: number;
  /** 实际执行的工具调用数量。 */
  readonly toolUses: number;
  /** 任务从开始到终态的耗时毫秒。 */
  readonly durationMs: number;
}

/** 版本化任务索引记录，不含 prompt 和原始输出。 */
export interface TaskStateRecord {
  /** 索引格式版本。 */
  readonly version: 1;
  /** 任务 ID 与 Agent ID 始终相同。 */
  readonly agentId: string;
  /** 父会话 ID，仅用于会话隔离校验。 */
  readonly parentSessionId: string;
  /** 用户可读的 3-5 词任务摘要。 */
  readonly description: string;
  /** 子代理类型。 */
  readonly agentType: string;
  /** 上下文装载策略。 */
  readonly contextPolicy: SubagentContextPolicy;
  /** 前台/后台提交模式。 */
  readonly mode: TaskMode;
  /** 当前任务状态。 */
  readonly status: TaskStatus;
  /** 创建时间。 */
  readonly createdAt: string;
  /** 最近更新时间。 */
  readonly updatedAt: string;
  /** 开始执行时间。 */
  readonly startedAt?: string;
  /** 终态时间。 */
  readonly endedAt?: string;
  /** 低敏错误摘要。 */
  readonly errorSummary?: string;
  /** 运行用量。 */
  readonly usage?: TaskUsage;
  /** 完成通知是否已经成功入父会话。只能从 false/空值写成 true。 */
  readonly notified?: boolean;
}

/** 任务索引文件结构。 */
export interface TaskStateFile {
  /** 索引格式版本。 */
  readonly version: 1;
  /** 当前父会话索引记录。 */
  readonly tasks: readonly TaskStateRecord[];
}

/** 合法状态迁移表。 */
const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  pending: ['running', 'killed', 'interrupted'],
  running: ['waiting_approval', 'completed', 'failed', 'killed', 'interrupted'],
  waiting_approval: ['running', 'completed', 'failed', 'killed', 'interrupted'],
  completed: [],
  failed: [],
  killed: [],
  interrupted: [],
});

/** 判断一个状态是否为任务终态。 */
export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return status === 'completed'
    || status === 'failed'
    || status === 'killed'
    || status === 'interrupted';
}

/** 判断两个任务状态之间是否允许 compare-and-transition。 */
export function isLegalTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** 判断字符串是否属于当前任务状态协议。 */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'pending'
    || value === 'running'
    || value === 'waiting_approval'
    || value === 'completed'
    || value === 'failed'
    || value === 'killed'
    || value === 'interrupted';
}

/** 判断任务 ID 是否可以安全用于内存索引和 transcript 路径。 */
export function isSafeTaskId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && /^[a-zA-Z0-9_-]+$/u.test(value);
}

/**
 * 判断任务描述是否满足模型可见摘要边界。
 * 英文按 3-5 词校验；中文任务通常无空格分隔，按 6 个以上字符兜底，
 * 避免 "分析当前代码" 这类合法短摘要被分词规则拒绝。
 */
export function isTaskDescription(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 160) {
    return false;
  }
  const words = trimmed.split(/\s+/u).filter(Boolean);
  return words.length >= 3 || trimmed.length >= 6;
}

/** 返回不含可变引用的任务记录副本。 */
export function cloneTaskState(record: TaskStateRecord): TaskStateRecord {
  return {
    ...record,
    ...(record.usage ? { usage: { ...record.usage } } : {}),
  };
}

/**
 * 去除 C0 控制字符与 DEL，保留可打印文本，用于低敏错误摘要。
 * 通知正文等需要保留段落结构的场景可传入 preserveWhitespace 保留制表、换行与回车。
 *
 * @param value - 待清理文本
 * @param preserveWhitespace - 是否保留 \t \n \r 三个空白控制符
 * @returns 清理后的文本
 */
export function stripControlCharacters(value: string, preserveWhitespace = false): string {
  return Array.from(value)
    .filter(char => {
      const code = char.codePointAt(0) ?? 0;
      if (preserveWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) {
        return true;
      }
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
}
