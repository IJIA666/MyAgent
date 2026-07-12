import { execSync } from 'child_process';
import { getAuthorizedDir } from '../base.js';
import type { NativeTool } from '../../tool-types.js';
import type { SafetyCheckResult } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SafetyOperation } from '../../../../ports/shared/tool-policy.js';

/**
 * Git 状态查看工具类。
 * 原生抓取工作区内的 Git 状态变化，将未跟踪、已修改等文件相对路径以结构化 JSON 数据返回。
 */
export class GitShowStatusTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /** 工具的名称。 */
  readonly name = 'gitShowStatus';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'gitShowStatus',
      description: "只读获取当前工作区内的 Git 状态。返回结构化的已修改、未跟踪、已删除等文件的相对路径列表 JSON。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  };

  /**
   * 执行 Git 状态只读查看。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 结构化状态 JSON 字符串
   */
  execute(): string {
    const workDir = getAuthorizedDir();
    if (!workDir) {
      throw new Error("工作区尚未初始化。请确保在使用文件或 Git 工具前调用 initWorkspace()。");
    }

    try {
      const stdout = execSync('git status --porcelain', { cwd: workDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const lines = stdout.split(/\r?\n/);
      
      const result = {
        modified: [] as string[],
        untracked: [] as string[],
        deleted: [] as string[],
        added: [] as string[],
        renamed: [] as string[]
      };

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const status = line.slice(0, 2);
        const filePath = line.slice(3).trim();

        if (status.includes('?')) {
          result.untracked.push(filePath);
        } else if (status.includes('M')) {
          result.modified.push(filePath);
        } else if (status.includes('A')) {
          result.added.push(filePath);
        } else if (status.includes('D')) {
          result.deleted.push(filePath);
        } else if (status.includes('R')) {
          result.renamed.push(filePath);
        } else {
          result.modified.push(filePath);
        }
      }

      return JSON.stringify(result, null, 2);
    } catch (err: unknown) {
      const errorObj = err as { stderr?: string; message?: string };
      throw new Error(`获取 Git 状态失败：${errorObj.stderr || errorObj.message}`, { cause: err });
    }
  }

  /**
   * 审查 Git 状态查看调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(): SafetyCheckResult {
    return { status: 'pass', operation: { planSideEffect: 'read', riskReason: '', operationCategory: 'command-execute' as const, summary: '查看 Git 工作区状态', resources: [] } as SafetyOperation };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * Git 状态查看是安全的只读操作。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'allow', decisionReason: 'Git 只读操作' };
  }
}
