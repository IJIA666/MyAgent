/**
 * @file 端口层共享的智能体事件类型定义。
 * AgentEvent 作为纯联合类型从 core/usecases/engine/agent-loop.ts 提升至端口层。
 */

import type { PendingInteraction } from './pending-interaction.js';
import type { ApprovalChoice } from './approval-types.js';

/**
 * 智能体产生的事件类型，外部消费者（如 UI 终端）据此渲染流式反馈过程。
 * 所有变体均为纯数据结构，不引用 core 内部类型。
 */
export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_call_start'; functionName: string; functionArgs: Record<string, unknown> }
  | {
      type: 'tool_call_result';
      functionName: string;
      result: string;
      /** 工具调用是否成功；UI 不得从本地化错误文本猜测执行结果。 */
      status: 'success' | 'error';
    }
  | { type: 'interaction_request'; interaction: PendingInteraction }
  | { type: 'error'; message: string; cause?: unknown }
  | {
      type: 'suspend';
      id: string;
      toolCall: { name: string; arguments: Record<string, unknown> };
      allowedPrefix: string | null;
      message?: string;
      choices?: ApprovalChoice[];
    }
  | { type: 'complete' };
