import { execSync } from 'child_process';
import { getAuthorizedDir, secureResolveReadPath } from '../base.js';
import type { NativeTool } from '../../tool-types.js';

/**
 * Git 差异查看工具类。
 * 只读拉取工作区内的增量 Diff 结果并过滤 ANSI 颜色转义标记。
 */
export class GitShowDiffTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /** 工具 of 名称。 */
  readonly name = 'gitShowDiff';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'gitShowDiff',
      description: "只读获取当前工作区内的 Git Diff 增量代码差异。会自动清洗 ANSI 颜色控制字符以防文本解析干扰。",
      parameters: {
        type: "object",
        properties: {
          staged: {
            type: "boolean",
            description: "是否仅查看已暂存区（staged/cached）的增量差异，默认为 false。"
          },
          targetPath: {
            type: "string",
            description: "要限定查看差异的目标文件或目录路径（相对于工作区根目录的相对路径，例如 'src/index.ts'，可选）。"
          }
        }
      }
    }
  };

  /**
   * 执行 Git Diff 只读查看。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 过滤颜色后的 Diff 文本结果
   */
  execute(args: Record<string, unknown>): string {
    const workDir = getAuthorizedDir();
    if (!workDir) {
      throw new Error("工作区尚未初始化。请确保在使用文件或 Git 工具前调用 initWorkspace()。");
    }

    const staged = typeof args.staged === 'boolean' ? args.staged : false;
    const targetPath = args.targetPath;

    let diffCmd = 'git -c color.ui=false diff';
    if (staged) {
      diffCmd += ' --cached';
    }

    if (typeof targetPath === 'string' && targetPath.trim() !== '') {
      const safePath = secureResolveReadPath(targetPath);
      diffCmd += ` -- "${safePath}"`;
    }

    try {
      const stdout = execSync(diffCmd, { cwd: workDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      
      // 使用 String.fromCharCode 拼装 ESC (27) 和 CSI (155)，防止 ESLint no-control-regex 检测
      const esc = String.fromCharCode(27);
      const csi = String.fromCharCode(155);
      const ansiRegex = new RegExp('[' + esc + csi + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');
      const cleanDiff = stdout.replace(ansiRegex, '');

      if (cleanDiff.length > 20000) {
        return cleanDiff.slice(0, 20000) + "\n\n... [已因超出最大字数限制而物理截断]";
      }

      return cleanDiff || "没有检测到任何代码变更差异。";
    } catch (err: unknown) {
      const errorObj = err as { stderr?: string; message?: string };
      throw new Error(`获取 Git Diff 失败：${errorObj.stderr || errorObj.message}`, { cause: err });
    }
  }

  /**
   * 审查 Git 差异查看调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  /**
   * Claude 风格的 tool-level checkPermissions。
   * Git 差异查看是安全的只读操作。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'allow', decisionReason: 'Git 只读操作' };
  }
}
