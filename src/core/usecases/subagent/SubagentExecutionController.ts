import type {
  SubagentExecutionPort,
  SubagentExecutionRequest,
  SubagentExecutionResult,
} from '../../../ports/driving/SubagentExecutionPort.js';
import { SUBAGENT_ERROR_CODES } from '../../../ports/driving/SubagentExecutionPort.js';
import { SubagentRuntime } from './SubagentRuntime.js';

/** 可被宿主绑定的子代理执行器。 */
export interface SubagentExecutionHost extends SubagentExecutionPort {
  /** 会话关闭时取消在途子代理。 */
  cancelActive(reason?: string): void;
}

/**
 * 会话绑定的子代理执行控制器。
 * Agent 工具只持有该稳定端口，具体运行器由 SessionManager 在组合完成后绑定。
 */
export class SubagentExecutionController implements SubagentExecutionPort {
  /** 当前会话绑定信息。 */
  private binding: { sessionId: string; executor: SubagentExecutionHost } | null = null;
  /** 控制器是否已经关闭。 */
  private closed = false;

  /**
   * 绑定一个会话的执行器。
   *
   * @param sessionId - 当前会话 ID
   * @param executor - 具体运行器
   * @throws 未绑定、重复或跨会话替换时抛出错误
   */
  public bind(sessionId: string, executor: SubagentExecutionHost): void {
    if (this.closed) {
      throw new Error('子代理执行控制器已关闭');
    }
    if (this.binding) {
      if (this.binding.executor !== executor) {
        throw new Error('子代理执行控制器不得绑定到不同执行器');
      }
      throw new Error('子代理执行控制器已绑定');
    }
    this.binding = { sessionId, executor };
  }

  /**
   * 会话恢复后更新同一执行器的 session ID，不允许替换运行器。
   *
   * @param sessionId - 恢复后的当前会话 ID
   */
  public updateSessionId(sessionId: string): void {
    if (!this.binding || this.closed) {
      throw new Error('子代理执行控制器尚未绑定');
    }
    this.binding = { ...this.binding, sessionId };
  }

  /**
   * 执行一次受绑定会话约束的子代理请求。
   *
   * @param request - 主 Agent 捕获的请求
   * @returns 结构化子代理结果
   */
  public async execute(request: SubagentExecutionRequest): Promise<SubagentExecutionResult> {
    if (this.closed || !this.binding) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.notBound,
        message: '子代理执行控制器未绑定可用会话',
      };
    }
    if (request.parentSession.getSessionId() !== this.binding.sessionId) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.sessionMismatch,
        message: '子代理请求不属于当前绑定会话',
      };
    }
    return this.binding.executor.execute(request);
  }

  /** 会话关闭前取消当前所有子代理。 */
  public cancelActive(reason = 'Session is closing'): void {
    this.binding?.executor.cancelActive(reason);
  }

  /**
   * 解除宿主绑定并使后续 Agent 调用 fail-closed。
   *
   * @param sessionId - 需要解除的会话 ID
   */
  public unbind(sessionId: string): void {
    if (this.binding?.sessionId === sessionId) {
      this.binding = null;
    }
  }

  /** 关闭控制器并取消所有在途子代理。 */
  public close(): void {
    if (this.closed) {
      return;
    }
    this.cancelActive('Subagent execution controller closed');
    this.closed = true;
    this.binding = null;
  }
}

/** 类型守卫：确认执行器具备运行器关闭所需的 cancelActive 能力。 */
export function isSubagentExecutionHost(value: SubagentExecutionPort): value is SubagentExecutionHost {
  return value instanceof SubagentRuntime || typeof (value as Partial<SubagentExecutionHost>).cancelActive === 'function';
}
