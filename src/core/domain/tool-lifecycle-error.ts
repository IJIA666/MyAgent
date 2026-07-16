/** 工具调用失败所在的稳定生命周期阶段。 */
export type ToolLifecyclePhase = 'authorization' | 'queue' | 'preparation' | 'execution';

/** 工具调用生命周期失败的稳定代码。 */
export type ToolLifecycleFailureCode =
  | 'permission_denied_before_execution'
  | 'approval_denied_before_execution'
  | 'cancelled_while_awaiting_approval'
  | 'cancelled_while_queued'
  | 'cancelled_before_execution'
  | 'failed_during_preparation'
  | 'execution_timed_out'
  | 'execution_cancelled_after_start';

/**
 * 携带稳定阶段和执行事实的工具生命周期错误。
 *
 * 调用方必须读取 `code` 和 `executionStarted`，不得解析本错误的展示文案。
 */
export class ToolLifecycleError extends Error {
  /** 稳定失败代码。 */
  readonly code: ToolLifecycleFailureCode;
  /** 失败发生的生命周期阶段。 */
  readonly phase: ToolLifecyclePhase;
  /** 失败前是否已经真正进入工具执行。 */
  readonly executionStarted: boolean;

  /**
   * 创建工具生命周期错误。
   *
   * @param code - 稳定失败代码
   * @param message - 面向用户和日志的错误说明
   * @param phase - 失败所在阶段
   * @param executionStarted - 是否已经进入真实工具执行
   * @param cause - 可选的原始异常
   */
  constructor(
    code: ToolLifecycleFailureCode,
    message: string,
    phase: ToolLifecyclePhase,
    executionStarted: boolean,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ToolLifecycleError';
    this.code = code;
    this.phase = phase;
    this.executionStarted = executionStarted;
  }
}

/**
 * 判断异常是否为稳定的工具生命周期错误。
 *
 * @param error - 待判断异常
 * @returns 是否为工具生命周期错误
 */
export function isToolLifecycleError(error: unknown): error is ToolLifecycleError {
  return error instanceof ToolLifecycleError;
}
