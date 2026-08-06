/**
 * @file 后台子代理结果通知。
 * 只把已扫描交付文本和低敏错误摘要封装成父会话可消费的 task-notification 消息。
 */

import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { EventNotificationPort } from '../../../ports/driven/session/EventNotificationPort.js';
import type { SubagentRuntimeTaskResult } from './SubagentRuntime.js';
import { isTerminalTaskStatus, stripControlCharacters, type TaskStateRecord } from './task-state.js';

/** 任务通知的固定 payload 结构。 */
export interface TaskNotificationPayload {
  /** 固定消息类型。 */
  readonly type: 'task-notification';
  /** 任务 ID。 */
  readonly agentId: string;
  /** 用户可读摘要。 */
  readonly description: string;
  /** 任务终态。 */
  readonly status: 'completed' | 'failed' | 'killed' | 'interrupted';
  /** 低敏摘要。 */
  readonly summary: string;
  /** 已扫描交付文本；失败任务不携带。 */
  readonly result?: string;
  /** 低敏运行用量。 */
  readonly usage?: SubagentRuntimeTaskResult['usage'];
}

/**
 * 将任务终态转换为父会话的固定通知消息。
 *
 * @param record - 任务安全索引记录
 * @param result - 子运行器结果，其中 output 已经过扫描
 * @returns 可追加到父会话历史的 user 消息
 */
export function buildTaskNotification(
  record: TaskStateRecord,
  result: SubagentRuntimeTaskResult,
): ChatMessage {
  const status = record.status;
  if (!isTerminalTaskStatus(status)) {
    throw new Error('只有任务终态才能生成 task-notification');
  }
  const payload: TaskNotificationPayload = {
    type: 'task-notification',
    agentId: safeText(record.agentId, 128),
    description: safeText(record.description, 160),
    status,
    summary: status === 'completed'
      ? '子代理任务已完成'
      : safeText(record.errorSummary ?? result.errorMessage ?? '子代理任务未完成', 500),
    ...(status === 'completed' && typeof result.output === 'string'
      ? { result: safeText(result.output, 4000) }
      : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
  return {
    role: 'user',
    content: `<task-notification>\n${safeJson(payload)}\n</task-notification>`,
  };
}

/** 将已构造的安全通知追加到父会话并发出异步唤醒事件。 */
export function enqueueAgentNotification(
  parentSession: EventNotificationPort,
  record: TaskStateRecord,
  result: SubagentRuntimeTaskResult,
): void {
  parentSession.addNotification(buildTaskNotification(record, result));
  parentSession.emit('async_event', {
    type: 'task-notification',
    agentId: record.agentId,
  });
}

/** 限制文本长度并去除控制字符；保留换行以维持扫描结果的多行结构。 */
function safeText(value: string, maxLength: number): string {
  return stripControlCharacters(value, true).slice(0, maxLength);
}

/** 对理论上已受类型约束的 payload 再做不可失败序列化。 */
function safeJson(value: TaskNotificationPayload): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      type: 'task-notification',
      agentId: safeText(value.agentId, 128),
      description: safeText(value.description, 160),
      status: value.status,
      summary: '子代理通知序列化失败',
    });
  }
}
