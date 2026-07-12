import { existsSync, readFileSync, writeFileSync } from 'fs';
import { applyPatch, createPatch } from 'diff';
import { resolve } from 'path';
import { secureResolveWritePath, getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import { ReadFileTool } from './file-system.js';
import type { NativeTool } from '../../tool-types.js';
import type { SafetyCheckResult } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SafetyOperation } from '../../../../ports/shared/tool-policy.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import { applyReplacePatch } from './apply-patch-helper.js';
import { getWorkMode, loadWorkMode } from '../system/terminal.js';

/**
 * 局部补丁修补与特征对齐替换工具类。
 * 支持严格 Unified Diff 补丁修补以及基于期望上下文签名特征滑动窗口对齐块替换的双轨控制。
 */
export class ApplyPatchTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'targetPath';

  /** 工具的名称。 */
  readonly name = 'applyPatch';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'applyPatch',
      description: "应用代码修补。支持标准的严格 Diff 模式，以及通过期望上下文特征签名滑动窗口替换的块模式，能够有效规避行号漂移。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "需要修改的目标文件相对路径（相对于工作区根目录，例如 'src/index.ts'）。"
          },
          patchMode: {
            type: "string",
            enum: ["strict", "replace"],
            description: "修补模式。'strict' 表示严格应用标准 Unified Diff 补丁；'replace' 表示通过上下文行签名块替换。"
          },
          patchContent: {
            type: "string",
            description: "在 'strict' 模式下，它是标准的 Unified Diff 补丁；在 'replace' 模式下，它是替换进去的新内容片段。"
          },
          startLine: {
            type: "number",
            description: "仅在 'replace' 模式下有效：期望匹配的代码块的大致起始行号（可选，从 1 开始）。"
          },
          endLine: {
            type: "number",
            description: "仅在 'replace' 模式下有效：期望匹配的代码块的大致结束行号（可选，从 1 开始）。"
          },
          expectedContent: {
            type: "string",
            description: "仅在 'replace' 模式下有效：期望原文里的 2-3 行特征上下文签名，用来通过滑动窗口精确定位。前导和尾随空格会被忽略。"
          }
        },
        required: ["targetPath", "patchMode", "patchContent"]
      }
    }
  };

  /**
   * 审查补丁修补调性的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    loadWorkMode();
    if (getWorkMode() === 'YOLO') {
      return { status: 'pass', operation: { planSideEffect: 'write', riskReason: '', operationCategory: 'file-edit' as const, summary: '应用补丁', resources: [] } as SafetyOperation };
    }
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { status: 'deny', message: 'targetPath 必须是字符串' };
    }
    let isOutOfSandbox = false;
    let resolvedPath = '';
    try {
      secureResolveWritePath(targetPath, sessionContext);
    } catch {
      isOutOfSandbox = true;
      const rootDir = getAuthorizedDir();
      resolvedPath = getPhysicalRealPath(resolve(rootDir!, targetPath));
    }
    return {
      status: 'suspend',
      message: `智能体试图执行修改或写入操作。工具: "${this.name}"，目标路径: "${targetPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined,
      resources: isOutOfSandbox ? [{ kind: 'path', access: 'write' as const, normalizedPath: resolvedPath }] : [],
      operation: { planSideEffect: 'write', riskReason: `补丁操作: ${targetPath}`, operationCategory: 'file-edit' as const, summary: `应用补丁 ${targetPath}`, resources: isOutOfSandbox ? [{ kind: 'path', access: 'write', normalizedPath: resolvedPath }] : [] }
    };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 补丁操作由 ToolPermissionService 统一决策。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { kind: 'deny', decisionReason: 'targetPath 必须是字符串' };
    }
    // 补丁是写操作，让 ToolPermissionService 通过规则和模式处理
    return { kind: 'passthrough' };
  }

  /**
   * 执行补丁或块替换修补操作。
   *
   * @param args - 工具调用参数字典
   * @param _context - 工具调用执行上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @returns 修补成功的提示信息
   */
  execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort): string {
    const targetPath = args.targetPath;
    const patchMode = args.patchMode;
    const patchContent = args.patchContent;

    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }
    if (patchMode !== 'strict' && patchMode !== 'replace') {
      throw new Error("patchMode 必须是 'strict' 或 'replace'");
    }
    if (typeof patchContent !== 'string') {
      throw new Error("patchContent 必须是字符串");
    }

    const safePath = _context ? secureResolveWritePath(targetPath, _context) : secureResolveWritePath(targetPath);

    if (!existsSync(safePath)) {
      throw new Error(`目标文件不存在，无法应用修补："${targetPath}"`);
    }

    // 安全前置拦截：在修改已有文件前，必须先调用 readFile 工具阅读该文件的最新内容。
    if (!ReadFileTool.readFileState.has(safePath)) {
      throw new Error("拒绝安全风险操作：在修改已有文件前，必须先调用 readFile 工具阅读该文件的最新内容。");
    }

    const fileContent = readFileSync(safePath, 'utf-8');

    if (patchMode === 'strict') {
      const result = applyPatch(fileContent, patchContent);
      if (result === false) {
        throw new Error("Patch apply failed: context mismatch");
      }
      writeFileSync(safePath, result, 'utf-8');
      const limitedPatch = limitPatchSize(patchContent);
      return `严格补丁应用成功："${targetPath}"。\n\n轻量级变更 Diff 摘要：\n\`\`\`diff\n${limitedPatch}\n\`\`\``;
    } else {
      // replace 块模式
      const expectedContent = args.expectedContent;
      if (typeof expectedContent !== 'string') {
        throw new Error("在 'replace' 模式下，expectedContent 必须是字符串。");
      }

      const { newContent, matchedLine, matchedLinesCount } = applyReplacePatch({
        fileContent,
        patchContent,
        expectedContent,
        startLine: typeof args.startLine === 'number' ? args.startLine : undefined,
        endLine: typeof args.endLine === 'number' ? args.endLine : undefined
      });

      writeFileSync(safePath, newContent, 'utf-8');
      const diffSummary = generateLightDiff(expectedContent, patchContent);
      return `通过特征签名对齐块替换成功："${targetPath}"，替换了从第 ${matchedLine} 行开始的 ${matchedLinesCount} 行内容。${diffSummary}`;
    }
  }
}

/**
 * 限制补丁显示尺寸，防止 Tool Result 发生大文本 Token 溢出。
 */
function limitPatchSize(patch: string): string {
  const lines = patch.split(/\r?\n/);
  const MAX_LINES = 25;
  if (lines.length > MAX_LINES) {
    const half = Math.floor(MAX_LINES / 2);
    return [
      ...lines.slice(0, half),
      `... [共被截断了 ${lines.length - half * 2} 行原始补丁以防膨胀] ...`,
      ...lines.slice(-half)
    ].join('\n');
  }
  return patch;
}

/**
 * 产生内存中轻量级 Diff 的辅助函数。
 */
function generateLightDiff(oldStr: string, newStr: string): string {
  const patch = createPatch('patch.txt', oldStr, newStr, '', '', { context: 3 });
  const lines = patch.split(/\r?\n/);
  // 过滤掉不必要的 Index: 和 =================================================================== 头部
  const cleanLines = lines.filter(line => !line.startsWith('Index:') && !line.startsWith('==='));
  
  const MAX_LINES = 25;
  const half = Math.floor(MAX_LINES / 2);
  const finalPatch = cleanLines.length > MAX_LINES
    ? [
        ...cleanLines.slice(0, half),
        `... [共被截断了 ${cleanLines.length - MAX_LINES} 行 diff 以防爆仓] ...`,
        ...cleanLines.slice(-half)
      ].join('\n')
    : cleanLines.join('\n');
  return `\n\n轻量级变更 Diff 摘要：\n\`\`\`diff\n${finalPatch}\n\`\`\``;
}
