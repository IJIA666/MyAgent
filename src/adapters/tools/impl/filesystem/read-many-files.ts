import { existsSync, statSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { secureResolveReadPath, getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';
import { extractFileOutline } from './read-many-files-helper.js';

/**
 * 批量文件读取工具类。
 * 支持传入多个相对路径并行读取文件，内置最大体积熔断及拒签自适应返回大纲/首尾片段的降级机制。
 */
export class ReadManyFilesTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'targetPaths';

  /** 工具的名称。 */
  readonly name = 'readManyFiles';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'readManyFiles',
      description: "批量读取授权工作区内的多个文件。支持前置体积熔断与拒签大纲概要自适应返回，保障大模型获取上下文的高效与安全。",
      parameters: {
        type: "object",
        properties: {
          targetPaths: {
            type: "string",
            description: "要读取的多个文件路径列表。使用英文逗号分隔（例如 'src/index.ts,src/utils.ts'）或 JSON 数组格式的字符串（例如 '[\"src/index.ts\",\"src/utils.ts\"]'）。"
          }
        },
        required: ["targetPaths"]
      }
    }
  };

  /**
   * 审查批量文件读取的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>): SafetyCheckResult {
    const targetPaths = args.targetPaths;
    if (typeof targetPaths !== 'string') {
      return { status: 'deny', message: 'targetPaths 必须是字符串' };
    }
    let paths: string[];
    const trimmed = targetPaths.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        paths = JSON.parse(trimmed);
      } catch {
        paths = trimmed.split(',').map(p => p.trim()).filter(Boolean);
      }
    } else {
      paths = trimmed.split(',').map(p => p.trim()).filter(Boolean);
    }

    const rootDir = getAuthorizedDir();
    for (const relPath of paths) {
      try {
        secureResolveReadPath(relPath);
      } catch {
        const rawPath = resolve(rootDir!, relPath);
        const resolvedPath = getPhysicalRealPath(rawPath);
        return {
          status: 'suspend',
          message: `智能体试图访问工作区外部的安全区，需要执行【只读】授权。目标路径: "${resolvedPath}"`,
          targetPath: resolvedPath
        };
      }
    }
    return { status: 'pass' };
  }

  /**
   * 执行批量文件读取操作。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 拼接后的文件内容，或在总体积超限时抛出熔断的结构化大纲详情
   */
  execute(args: Record<string, unknown>, sessionContext?: unknown): string {
    const targetPaths = args.targetPaths;
    if (typeof targetPaths !== 'string') {
      throw new Error("targetPaths 必须是字符串");
    }

    let paths: string[];
    const trimmed = targetPaths.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        paths = JSON.parse(trimmed);
      } catch {
        paths = trimmed.split(',').map(p => p.trim()).filter(Boolean);
      }
    } else {
      paths = trimmed.split(',').map(p => p.trim()).filter(Boolean);
    }

    if (paths.length === 0) {
      return "未提供任何有效的目标文件路径。";
    }

    const filesData: Array<{
      relativePath: string;
      safePath: string;
      content: string;
      size: number;
    }> = [];

    let totalChars = 0;

    // 首先校验并预读所有文件
    for (const relativePath of paths) {
      const safePath = secureResolveReadPath(relativePath);
      if (!existsSync(safePath)) {
        throw new Error(`未找到文件："${relativePath}"`);
      }
      const stats = statSync(safePath);
      if (stats.isDirectory()) {
        throw new Error(`路径 "${relativePath}" 是一个目录，无法直接进行文本读取。`);
      }

      const content = readFileSync(safePath, 'utf-8');
      totalChars += content.length;

      filesData.push({
        relativePath,
        safePath,
        content,
        size: content.length
      });
    }

    // 触发体积熔断机制
    const context = sessionContext as { appConfig?: { runtimeLimits?: { readManyFilesLimit?: number } } } | undefined;
    const limit = context?.appConfig?.runtimeLimits?.readManyFilesLimit ?? 50000;

    if (totalChars > limit) {
      const detailsList = filesData.map((fd) => {
        const lines = fd.content.split(/\r?\n/);
        const { outlineType, outline } = extractFileOutline(fd.relativePath, fd.content);

        return {
          relativePath: fd.relativePath,
          sizeBytes: fd.size,
          lineCount: lines.length,
          outlineType,
          outline
        };
      });

      const errResult = {
        error: "Size limit exceeded",
        message: `请求的文件总体积为 ${totalChars} 字符，超出了 ${limit.toLocaleString()} 字符的安全熔断限制。`,
        files: detailsList
      };

      throw new Error(`Size limit exceeded\n${JSON.stringify(errResult, null, 2)}`);
    }

    // 未超限，正常组装并返回
    let resultText = '';
    for (const fd of filesData) {
      resultText += `=== 文件: ${fd.relativePath} ===\n${fd.content}\n\n`;
    }
    return resultText;
  }
}
