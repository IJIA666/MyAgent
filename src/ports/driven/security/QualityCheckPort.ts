/**
 * @file QualityCheckPort.ts
 * @description 定义后置质量校验驱动端口契约。
 */

/**
 * 单个质量检查步骤的结果记录。
 */
export interface QualityCheckStep {
  /** 步骤名称（如 eslint、tsc） */
  name: string;
  /** 该步骤是否成功 */
  success: boolean;
  /** 步骤执行耗时（毫秒） */
  durationMs: number;
  /** 子进程退出码 */
  exitCode: number;
  /** 是否被取消 */
  cancelled: boolean;
  /** 脱敏后的受限错误摘要（不含完整 stdout/stderr） */
  summary: string;
}

/**
 * 质量检查的完整结构化结果。
 */
export interface QualityCheckResult {
  /** 总体是否通过（所有步骤均成功） */
  success: boolean;
  /** 执行的步骤列表 */
  steps: QualityCheckStep[];
  /** 总耗时（毫秒） */
  durationMs: number;
  /** 脱敏后的总体摘要 */
  summary: string;
}

/**
 * 质量校验驱动端口的输入上下文。
 */
export interface QualityCheckContext {
  /** 当前会话 ID */
  sessionId: string;
  /** 触发质量检查的 effect 列表（只读摘要） */
  triggerEffects: Array<{ kind: string; reason: string }>;
  /** 去重后的变更资源路径列表 */
  changedResources: string[];
  /** 可选的取消信号 */
  signal?: AbortSignal;
}

export interface QualityCheckPort {
  /**
   * 执行后置质量自测校验，对项目运行代码规范与类型检查。
   *
   * @param context - 质量校验上下文（会话 ID、触发 effects、变更资源、取消信号）
   * @returns 结构化校验结果，包含分步骤耗时、成功/取消状态和脱敏摘要
   */
  runPostRunCheck(context: QualityCheckContext): Promise<QualityCheckResult>;
}
