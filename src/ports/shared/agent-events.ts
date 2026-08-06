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
  | { type: 'complete' }
  | {
      /**
       * 后台 Skill 复盘的结果展示事件。
       * 仅供宿主非阻塞渲染状态行，绝不作为消息写入模型历史或触发自动唤醒；
       * 仅由真实成功的 skill_manage 工具结果派生，模型自述不会产生该事件。
       */
      type: 'skill_review_update';
      /** 真实 Skill 写入结果状态（成功或暂存）。 */
      status: 'success' | 'staged';
      /** Skill 管理动作（create/patch/edit/delete/write_file/remove_file）。 */
      action: string;
      /** 被变更的 Skill 名称。 */
      skill: string;
      /** writeApproval 暂存标识；仅 staged 结果携带。 */
      pendingId?: string;
    }
  | {
      /** 子代理任务生命周期状态行；不携带任务正文或原始输出。 */
      type: 'task_update';
      /** 任务 ID，同时也是 Agent ID。 */
      agentId: string;
      /** 用户可读任务摘要。 */
      description: string;
      /** 子代理类型。 */
      subagentType: string;
      /** 上下文装载策略。 */
      contextPolicy: 'fresh' | 'history-replay' | 'exact-fork';
      /** 当前任务生命周期状态。 */
      status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'killed' | 'interrupted';
      /** 状态发生时间。 */
      time: string;
    };
