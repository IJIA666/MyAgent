import { logger } from '../../../utils/logger.js';
import type { ApprovalChoice } from '../plugins/plugin-types.js';

export interface ApprovalDecision {
  /** 决策动作：call (单次放行), session (本次会话始终放行), persistent (持久化白名单), deny (拒绝执行) */
  action: 'call' | 'session' | 'persistent' | 'deny';
}

/**
 * 人机协同审批协调服务。
 * 核心职责：
 * 1. 负责在内存中管理所有挂起待审批的 Promise 凭证 (Deferred Promises)；
 * 2. 调度执行超时自动拒绝机制，防止因表现层断开连接而导致工作流长期挂死；
 * 3. 集中控制批量拒绝 (rejectAll)，支持在会话销毁或异常断开时释放全部挂起任务。
 */
export class ApprovalService {
  /** 挂起的审批项映射表，Key 为审批 ID */
  private pendingApprovals = new Map<
    string,
    {
      sessionId?: string;
      resolve: (value: ApprovalDecision) => void;
      reject: (reason: Error) => void;
      timeoutId: NodeJS.Timeout;
    }
  >();

  /** 是否启用自动放行 (Bypass) 模式，常用于非 TTY 的 CI 自动化测试流水线 */
  private isBypassMode = false;

  /** 同步/异步审批提问事件处理器回调函数，用于绕开 Generator 原地阻塞时的事件延迟 */
  private onNeedApprovalHandler?: (
    id: string,
    toolCall: { name: string; arguments: Record<string, unknown> },
    allowedPrefix?: string,
    message?: string,
    choices?: ApprovalChoice[]
  ) => void | Promise<void>;

  /**
   * 注册审批提问事件处理器。
   * 用于终端 UI 层直接绑定其交互问答渲染接口，实现非阻塞同步通知。
   *
   * @param handler - 审批事件回调函数
   */
  public registerApprovalHandler(handler: typeof this.onNeedApprovalHandler): void {
    this.onNeedApprovalHandler = handler;
  }

  /**
   * 构造函数，初始化服务状态并判定 TTY 环境。
   *
   * @param isBypassMode - 是否开启 Bypass 自动放行模式，默认根据 process.stdin.isTTY 自动判定
   */
  constructor(isBypassMode?: boolean) {
    this.isBypassMode = isBypassMode ?? !process.stdin.isTTY;
  }

  /**
   * 动态设定是否开启 Bypass 模式。
   *
   * @param enabled - 是否启用 Bypass 模式
   */
  public setBypassMode(enabled: boolean): void {
    this.isBypassMode = enabled;
  }

  /**
   * 原地异步挂起并等待外部决策返回。
   * 支持同步触发已注册的审批通知回调。
   *
   * @param id - 每次审批任务的唯一标识 ID
   * @param toolCall - 触发审批的工具调用详情，包含名称和参数
   * @param allowedPrefix - 可选的自动放行命令前缀匹配
   * @param message - 可选的卡关提示信息，用于告知用户越界或风险类型
   * @param timeoutMs - 审批超时限制毫秒数，默认 5 分钟 (300,000ms)
   * @returns 外部人机交互最终做出的审批决策
   */
  public async wait(
    id: string,
    toolCall: { name: string; arguments: Record<string, unknown> },
    allowedPrefix?: string,
    message?: string,
    timeoutMs = 300000,
    sessionId?: string,
    choices?: ApprovalChoice[]
  ): Promise<ApprovalDecision> {
    // 若处于 Bypass 模式，立即以 call 单次放行回复，保障 CI/测试顺畅
    if (this.isBypassMode) {
      return { action: 'call' };
    }

    // 同步触发已注册的审批问答界面，传入完整的审批元数据
    if (this.onNeedApprovalHandler) {
      try {
        const res = this.onNeedApprovalHandler(id, toolCall, allowedPrefix, message, choices);
        if (res instanceof Promise) {
          res.catch((err) => logger.error('Approval handler async error:', err)); // 替换为统一日志单例输出
        }
      } catch (err) {
        logger.error('Approval handler sync error:', err); // 替换为统一日志单例输出
      }
    }

    return new Promise<ApprovalDecision>((resolve, reject) => {
      // 开启超时定时器，超时默认返回 deny 拒绝决策，保障系统不挂死
      const timeoutId = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve({ action: 'deny' });
      }, timeoutMs);

      // 将控制权 resolve/reject 以及定时器指针存入内存映射表中，并强绑定 sessionId
      this.pendingApprovals.set(id, { resolve, reject, timeoutId, sessionId });
    });
  }

  /**
   * 唤醒并解决特定的审批任务。
   *
   * @param id - 需要唤醒的审批任务 ID
   * @param decision - 人机交互做出的具体审批决策
   * @returns 唤醒是否成功，若返回 false 说明 ID 不存在或已超时失效
   */
  public resolve(id: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return false;
    }
    // 清除超时定时器并从列表中移除
    clearTimeout(pending.timeoutId);
    this.pendingApprovals.delete(id);

    // 执行 resolve 唤醒挂起的 Promise
    pending.resolve(decision);
    return true;
  }

  /**
   * 强制异常终止特定的审批任务。
   *
   * @param id - 需要终止的审批任务 ID
   * @param error - 触发异常终止的错误原因
   * @returns 异常拒绝是否成功
   */
  public reject(id: string, error: Error): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeoutId);
    this.pendingApprovals.delete(id);

    pending.reject(error);
    return true;
  }

  /**
   * 批量异常终止特定会话对应的所有挂起审批任务（级联安全熔断）。
   *
   * @param sessionId - 会话唯一标识 ID
   * @param error - 异常终止的错误原因
   */
  public rejectBySessionId(sessionId: string, error: Error): void {
    for (const [id, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeoutId);
        pending.reject(error);
        this.pendingApprovals.delete(id);
      }
    }
  }

  /**
   * 释放并清空当前所有挂起等待中的审批任务，触发异常拒绝。
   * 常用于网络意外断开或会话销毁时的紧急垃圾回收。
   *
   * @param reason - 全局释放的原因说明
   */
  public rejectAll(reason = 'Session is closing'): void {
    const error = new Error(`Approval cancelled: ${reason}`);
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingApprovals.clear();
  }
}
