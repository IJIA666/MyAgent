/**
 * 基于本地子进程 Shell 的代码规范及 TypeScript 类型校验适配器。
 * 将 ESLint 与 TypeScript 拆分为两个可计时步骤，支持 AbortSignal 取消和输出截断脱敏。
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { QualityCheckPort, QualityCheckContext, QualityCheckResult, QualityCheckStep } from '../../ports/driven/security/QualityCheckPort.js';

/**
 * Shell 命令执行函数签名，测试时可注入 mock 替换真实 exec。
 */
export type ShellExecutor = (command: string, options?: { cwd?: string; timeout?: number; signal?: AbortSignal }) =>
  Promise<{ stdout: string; stderr: string }>;

/** 将 exec 的 string | Buffer 返回值标准化为字符串。 */
function normalizeExecOutput(val: string | Buffer): string {
  return typeof val === 'string' ? val : val.toString('utf-8');
}

/** 单步执行结果最大截断长度，防止完整 stdout/stderr 泄露。 */
const STEP_SUMMARY_MAX_LENGTH = 2000;

/** 截断过长文本并脱敏。 */
function truncateAndSanitize(text: string, maxLen: number = STEP_SUMMARY_MAX_LENGTH): string {
  // 脱敏绝对路径和敏感信息
  const sanitized = text
    .replace(/([A-Z]:\\(?:[^\\\s]+\\)*)/gi, match =>
      match.length > 20 ? `${match.slice(0, 10)}...` : match)
    .replace(/(\/[^\s]+\/){2,}/g, '.../');
  if (sanitized.length <= maxLen) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maxLen - 6))}\n...截断`;
}

/**
 * 单次 shell 命令步骤执行器。
 * 支持 AbortSignal 取消，超时时设置 cancelled 标志。
 */
async function runStep(
  name: string,
  command: string,
  cwd: string,
  executor: ShellExecutor,
  signal?: AbortSignal
): Promise<QualityCheckStep> {
  const startTime = Date.now();
  let cancelled = false;
  let stdout = '';
  let stderr = '';

  try {
    const result = await executor(command, { cwd, timeout: 60000, signal });
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      cancelled = true;
    } else {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
  }

  const durationMs = Date.now() - startTime;
  const raw = `${stdout}\n${stderr}`.trim();
  const summary = truncateAndSanitize(raw);

  return {
    name,
    success: !cancelled && (!stderr || stderr.length === 0),
    durationMs,
    exitCode: cancelled ? -1 : (stderr ? 1 : 0),
    cancelled,
    summary
  };
}

export class ShellQualityCheckAdapter implements QualityCheckPort {
  /** 可注入的 shell 命令执行器，默认使用 promisified exec，测试时可替换为 mock */
  private executor: ShellExecutor;

  /**
   * @param executor - 可选的 shell 命令执行器，默认使用 child_process.exec
   */
  constructor(executor?: ShellExecutor) {
    this.executor = executor ?? (async (cmd, opts) => {
      const execPromise = promisify(exec);
      const raw = await execPromise(cmd, opts);
      return {
        stdout: normalizeExecOutput(raw.stdout),
        stderr: normalizeExecOutput(raw.stderr)
      };
    });
  }
  /**
   * 执行后置质量自测校验。
   * 第一步运行 ESLint，若通过则继续 TypeScript 类型检查。
   * 任何一步失败或被取消即停止后续步骤。
   *
   * @param context - 质量校验上下文
   * @returns 结构化校验结果
   */
  public async runPostRunCheck(context: QualityCheckContext): Promise<QualityCheckResult> {
    const startTime = Date.now();
    const steps: QualityCheckStep[] = [];
    const cwd = process.cwd();

    // 步骤 1: ESLint
    const lintStep = await runStep('eslint', 'npm run lint', cwd, this.executor, context.signal);
    steps.push(lintStep);

    // ESLint 失败或被取消时不再执行 TypeScript
    if (!lintStep.success || lintStep.cancelled || context.signal?.aborted) {
      const overallSuccess = lintStep.cancelled || context.signal?.aborted ? false : false;
      return {
        success: overallSuccess && lintStep.success,
        steps,
        durationMs: Date.now() - startTime,
        summary: `ESLint ${lintStep.cancelled ? '已取消' : '失败'}`
      };
    }

    // 步骤 2: TypeScript 编译检查
    const tscStep = await runStep('tsc', 'npx tsc --noEmit', cwd, this.executor, context.signal);
    steps.push(tscStep);

    const durationMs = Date.now() - startTime;
    const allPassed = lintStep.success && tscStep.success;
    return {
      success: allPassed,
      steps,
      durationMs,
      summary: allPassed ? '全部通过' : `TypeScript ${tscStep.cancelled ? '已取消' : '失败'}`
    };
  }
}
