import { existsSync, readFileSync, writeFileSync } from 'fs';
import { applyPatch } from 'diff';
import { secureResolveWritePath } from './base.js';
import { ReadFileTool } from './file-system.js';
import type { NativeTool } from '../virtual-mcp.js';
import { ToolConstants } from '../../common/constants.js';

/**
 * 局部补丁修补与特征对齐替换工具类。
 * 支持严格 Unified Diff 补丁修补以及基于期望上下文签名特征滑动窗口对齐块替换的双轨控制。
 */
export class ApplyPatchTool implements NativeTool {
  /** 工具的名称。 */
  readonly name = ToolConstants.APPLY_PATCH;

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: ToolConstants.APPLY_PATCH,
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
   * 执行补丁或块替换修补操作。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 修补成功的提示信息
   */
  execute(args: Record<string, unknown>): string {
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

    const safePath = secureResolveWritePath(targetPath);

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
      return `严格补丁应用成功："${targetPath}"。`;
    } else {
      // replace 块模式
      const expectedContent = args.expectedContent;
      if (typeof expectedContent !== 'string' || !expectedContent.trim()) {
        throw new Error("在 'replace' 模式下，必须提供有意义的 expectedContent 期望原文行特征签名。");
      }

      const fileLines = fileContent.split(/\r?\n/);
      const totalLines = fileLines.length;

      const start = typeof args.startLine === 'number' ? Math.max(1, args.startLine) : 1;
      const end = typeof args.endLine === 'number' ? Math.min(totalLines, args.endLine) : totalLines;

      // 在行号 [start, end] 的邻域（上下 50 行）进行特征查找以抵抗漂移
      const searchStart = Math.max(1, start - 50);
      const searchEnd = Math.min(totalLines, end + 50);

      const expectedLines = expectedContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (expectedLines.length === 0) {
        throw new Error("expectedContent 不能全为空格或空行。");
      }

      const matchIndices: number[] = [];
      const N = expectedLines.length;

      // 在搜索行号范围内滑动匹配特征行签名（忽略前导和尾随空格）
      for (let i = searchStart - 1; i <= searchEnd - N; i++) {
        let isMatch = true;
        for (let j = 0; j < N; j++) {
          if (fileLines[i + j].trim() !== expectedLines[j]) {
            isMatch = false;
            break;
          }
        }
        if (isMatch) {
          matchIndices.push(i);
        }
      }

      if (matchIndices.length === 0) {
        throw new Error(`在搜寻行号范围 [${searchStart}, ${searchEnd}] 内，未匹配到 expectedContent 的特征签名行。请提供更多正确的原文特征或拓宽 startLine/endLine 检索边界。`);
      }

      if (matchIndices.length > 1) {
        throw new Error(`在搜寻行号范围 [${searchStart}, ${searchEnd}] 内，匹配到了多于 1 处 (${matchIndices.length} 处) 的 expectedContent 特征，位置无法唯一对齐。请提供更长的唯一上下文签名，或者收紧 startLine/endLine 检索边界。`);
      }

      const targetIndex = matchIndices[0];
      const newContentLines = [
        ...fileLines.slice(0, targetIndex),
        patchContent,
        ...fileLines.slice(targetIndex + N)
      ];

      writeFileSync(safePath, newContentLines.join('\n'), 'utf-8');
      return `通过特征签名对齐块替换成功："${targetPath}"，替换了从第 ${targetIndex + 1} 行开始的 ${N} 行内容。`;
    }
  }
}
