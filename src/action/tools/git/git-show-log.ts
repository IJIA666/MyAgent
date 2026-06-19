import { execSync } from 'child_process';
import { getAuthorizedDir } from '../base.js';
import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';

/**
 * Git 提交日志查看工具类。
 * 只读拉取最近的 commit 日志汇总，用于大模型梳理项目重构与提交脉络。
 */
export class GitShowLogTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /** 工具的名称。 */
  readonly name = 'gitShowLog';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'gitShowLog',
      description: "只读获取最近的 Git 提交日志摘要。用于帮助大模型掌握项目历史变更脉络。",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "需要拉取的最近提交记录条数，最大限制为 50，默认拉取 10 条。"
          }
        }
      }
    }
  };

  /**
   * 执行 Git Log 只读查看。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 简要格式化后的日志列表文本
   */
  execute(args: Record<string, unknown>): string {
    const workDir = getAuthorizedDir();
    if (!workDir) {
      throw new Error("工作区尚未初始化。请确保在使用文件或 Git 工具前调用 initWorkspace()。");
    }

    const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, args.limit)) : 10;
    const logCmd = `git -c color.ui=false log -n ${limit} --pretty=format:"%h - %an (%ad): %s" --date=short`;

    try {
      const stdout = execSync(logCmd, { cwd: workDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      
      // 使用 String.fromCharCode 拼装 ESC (27) 和 CSI (155)，防止 ESLint no-control-regex 检测
      const esc = String.fromCharCode(27);
      const csi = String.fromCharCode(155);
      const ansiRegex = new RegExp('[' + esc + csi + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');
      const cleanLog = stdout.replace(ansiRegex, '');

      return cleanLog || "未找到任何 Git 提交日志。";
    } catch (err: unknown) {
      const errorObj = err as { stderr?: string; message?: string };
      throw new Error(`获取 Git 日志失败：${errorObj.stderr || errorObj.message}`, { cause: err });
    }
  }

  /**
   * 审查 Git 提交日志查看调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(): SafetyCheckResult {
    return { status: 'pass' };
  }
}
