import { exec } from 'child_process';
import { promisify } from 'util';
import type { QualityCheckPort } from '../../ports/driven/QualityCheckPort.js';

/**
 * 基于本地子进程 Shell 的代码规范及 TypeScript 类型校验适配器。
 */
export class ShellQualityCheckAdapter implements QualityCheckPort {
  /**
   * 执行后置质量自测校验，运行 npm run lint 和 npx tsc --noEmit。
   *
   * @returns 异步返回包含校验是否成功和报错信息的对象
   */
  public async runPostRunCheck(): Promise<{ success: boolean; output: string }> {
    const execPromise = promisify(exec);
    let output = '';
    try {
      // 1. 运行 ESLint 静态代码规范检查
      const { stdout: lintStdout, stderr: lintStderr } = await execPromise('npm run lint', { cwd: process.cwd() });
      output += lintStdout + lintStderr;
    } catch (lintError: unknown) {
      const err = lintError as { stdout?: string; stderr?: string; message?: string };
      output += (err.stdout || '') + (err.stderr || '') + (err.message || '');
      return { success: false, output: `ESLint 检查失败:\n${output}` };
    }

    try {
      // 2. 运行 TypeScript 编译类型检查
      const { stdout: tscStdout, stderr: tscStderr } = await execPromise('npx tsc --noEmit', { cwd: process.cwd() });
      output += tscStdout + tscStderr;
    } catch (tscError: unknown) {
      const err = tscError as { stdout?: string; stderr?: string; message?: string };
      const errorOutput = (err.stdout || '') + (err.stderr || '') + (err.message || '');
      return { success: false, output: `TypeScript 类型检查失败:\n${errorOutput}` };
    }

    return { success: true, output };
  }
}
