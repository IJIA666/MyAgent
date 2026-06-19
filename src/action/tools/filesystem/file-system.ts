/**
 * 本地文件系统操作工具类集。
 * 提供路径安全校验约束下的文本读取（支持行范围精读）、文件写入、特征匹配增量编辑以及目录清单列举功能。
 */

import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { secureResolveReadPath, secureResolveWritePath, getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';
import { getWorkMode, loadWorkMode } from '../system/terminal.js';

/**
 * 文件读取工具类。
 * 实现了 NativeTool 契约，支持可选的行范围分页读取，用以精确精读局部代码片段。
 */
export class ReadFileTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /**
   * 记录读取快照的内存字典，用于实现基于 mtime 的缓存拦截去重机制。
   */
  static readonly readFileState = new Map<string, { lineStart?: number; lineEnd?: number; mtimeMs: number }>();

  /**
   * 工具的名称。
   */
  readonly name = 'readFile';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'readFile',
      description: "读取授权工作区根目录下的文本文件的内容。支持可选的行范围分页读取，用以精确精读局部代码片段。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要读取的目标文件路径（相对于工作区根目录的相对路径，例如 'src/index.ts'）。"
          },
          lineStart: {
            type: "number",
            description: "要读取的起始行号（可选，从 1 开始计数，如 10）。"
          },
          lineEnd: {
            type: "number",
            description: "要读取的结束行号（可选，包含该行，从 1 开始，如 25）。"
          }
        },
        required: ["targetPath"]
      }
    }
  };

  /**
   * 审查文件读取调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>): SafetyCheckResult {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { status: 'deny', message: 'targetPath 必须是字符串' };
    }
    try {
      secureResolveReadPath(targetPath);
      return { status: 'pass' };
    } catch {
      const rootDir = getAuthorizedDir();
      const rawPath = resolve(rootDir!, targetPath);
      const resolvedPath = getPhysicalRealPath(rawPath);
      return {
        status: 'suspend',
        message: `智能体试图访问工作区外部的安全区，需要执行【只读】授权。目标路径: "${resolvedPath}"`,
        targetPath: resolvedPath
      };
    }
  }

  /**
   * 执行文件读取操作。
   *
   * @param args - 工具调用参数字典
   * @returns 读取的文件内容或缓存未修改提示
   */
  execute(args: Record<string, unknown>): string {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }

    const safePath = secureResolveReadPath(targetPath);

    if (!existsSync(safePath)) {
      throw new Error(`未找到文件："${targetPath}"`);
    }

    const fileStat = statSync(safePath);
    if (fileStat.isDirectory()) {
      throw new Error(`路径 "${targetPath}" 是一个目录，不能作为普通文本文件进行读取。`);
    }

    const lineStart = typeof args.lineStart === 'number' ? args.lineStart : undefined;
    const lineEnd = typeof args.lineEnd === 'number' ? args.lineEnd : undefined;

    const currentMtimeMs = fileStat.mtimeMs;
    const cachedState = ReadFileTool.readFileState.get(safePath);

    if (
      cachedState &&
      cachedState.lineStart === lineStart &&
      cachedState.lineEnd === lineEnd &&
      cachedState.mtimeMs === currentMtimeMs
    ) {
      return "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";
    }

    const content = readFileSync(safePath, 'utf-8');
    let resultText: string;

    if (lineStart === undefined && lineEnd === undefined) {
      resultText = content;
    } else {
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;

      const start = lineStart !== undefined ? Math.max(1, lineStart) : 1;
      const end = lineEnd !== undefined ? Math.min(totalLines, lineEnd) : totalLines;

      if (start > totalLines) {
        resultText = `[提示：起始行 ${start} 超过了文件的总行数 ${totalLines}]`;
      } else if (end < start) {
        throw new Error(`结束行 lineEnd (${end}) 必须大于或等于起始行 lineStart (${start})`);
      } else {
        const sliceStart = start - 1;
        const sliceEnd = end;
        const slicedLines = lines.slice(sliceStart, sliceEnd);
        const prefix = `[文件：${targetPath} 第 ${start} 至 ${end} 行，总共 ${totalLines} 行]\n`;
        resultText = prefix + slicedLines.join('\n');
      }
    }

    ReadFileTool.readFileState.set(safePath, { lineStart, lineEnd, mtimeMs: currentMtimeMs });
    return resultText;
  }
}

/**
 * 文件全量写入/创建工具类。
 * 仅用于创建新节点或必须进行全文件覆盖的场景。
 */
export class WriteFileTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /**
   * 工具的名称。
   */
  readonly name = 'writeFile';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'writeFile',
      description: "向授权工作区内的指定文件全量写入或覆盖文本内容。会自动创建缺失的父级目录。【警告：此操作会彻底覆盖原文件！仅在创建新文件或必须进行全文件重写时使用。对已有文件的局部修改请必须优先使用 editFile 工具】",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要写入的目标文件路径（相对于工作区根目录，例如 'docs/readme.md'）。"
          },
          content: {
            type: "string",
            description: "要写入到文件中的完整文本内容。"
          }
        },
        required: ["targetPath", "content"]
      }
    }
  };

  /**
   * 审查文件写入调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>): SafetyCheckResult {
    loadWorkMode();
    if (getWorkMode() === 'YOLO') {
      return { status: 'pass' };
    }
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { status: 'deny', message: 'targetPath 必须是字符串' };
    }
    let isOutOfSandbox = false;
    let resolvedPath = '';
    try {
      secureResolveWritePath(targetPath);
    } catch {
      isOutOfSandbox = true;
      const rootDir = getAuthorizedDir();
      resolvedPath = getPhysicalRealPath(resolve(rootDir!, targetPath));
    }
    return {
      status: 'suspend',
      message: `智能体试图执行修改或写入操作。工具: "${this.name}"，目标路径: "${targetPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined
    };
  }

  /**
   * 执行文件写入操作。
   *
   * @param args - 工具调用参数字典
   * @returns 写入成功提示信息
   */
  execute(args: Record<string, unknown>): string {
    const targetPath = args.targetPath;
    const content = args.content;
    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }
    if (typeof content !== 'string') {
      throw new Error("content 必须是字符串");
    }

    const safePath = secureResolveWritePath(targetPath);

    if (existsSync(safePath) && !ReadFileTool.readFileState.has(safePath)) {
      throw new Error("拒绝安全风险操作：您正在尝试全量覆盖一个已有文件。为了防止代码误毁，在覆盖前必须先调用 readFile 工具阅读该文件的最新内容。");
    }

    const parentDir = dirname(safePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    writeFileSync(safePath, content, 'utf-8');
    return `写入执行成功："${targetPath}"。`;
  }
}

/**
 * 基于纯文本特征匹配的局部文件增量修改工具类。
 * 用于在不覆盖整个文件的情况下修改指定的代码段，这是修改已有文件的首选和最佳途径。
 */
export class EditFileTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /**
   * 工具的名称。
   */
  readonly name = 'editFile';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'editFile',
      description: "基于纯文本特征精确匹配的局部文件增量修改工具。用于在不覆盖整个文件的情况下修改指定的代码段，这是修改已有文件的首选和最佳途径。为确保唯一性和准确命中，old_string 必须保持与原文件精确一致并包含足够的前后上下文。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要修改的目标文件路径（相对于工作区根目录，例如 'src/index.ts'）。"
          },
          old_string: {
            type: "string",
            description: "需要被替换的原文片段。必须与原文件中的内容在字符级别上（包括空格、缩进和换行符）完全精确一致。"
          },
          new_string: {
            type: "string",
            description: "用于替换 old_string 的全新内容文本。若希望删除 old_string，可传入空字符串。"
          },
          replace_all: {
            type: "boolean",
            description: "是否全局替换。如果设置为 true，则会替换文件中所有匹配到的 old_string；默认为 false，此时如果匹配到多处相同的 old_string 会为了安全而抛出错误拦截。"
          }
        },
        required: ["targetPath", "old_string", "new_string"]
      }
    }
  };

  /**
   * 审查文件局部增量修改调性的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>): SafetyCheckResult {
    loadWorkMode();
    if (getWorkMode() === 'YOLO') {
      return { status: 'pass' };
    }
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { status: 'deny', message: 'targetPath 必须是字符串' };
    }
    let isOutOfSandbox = false;
    let resolvedPath = '';
    try {
      secureResolveWritePath(targetPath);
    } catch {
      isOutOfSandbox = true;
      const rootDir = getAuthorizedDir();
      resolvedPath = getPhysicalRealPath(resolve(rootDir!, targetPath));
    }
    return {
      status: 'suspend',
      message: `智能体试图执行修改或写入操作。工具: "${this.name}"，目标路径: "${targetPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined
    };
  }

  /**
   * 执行局部文件编辑操作。
   *
   * @param args - 工具调用参数字典
   * @returns 局部修改成功提示信息
   */
  execute(args: Record<string, unknown>): string {
    const targetPath = args.targetPath;
    const oldString = args.old_string;
    const newString = args.new_string;
    const replaceAll = typeof args.replace_all === 'boolean' ? args.replace_all : false;

    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }
    if (typeof oldString !== 'string') {
      throw new Error("old_string 必须是字符串");
    }
    if (typeof newString !== 'string') {
      throw new Error("new_string 必须是字符串");
    }

    if (oldString === newString) {
      throw new Error("没有任何实质性修改：old_string 和 new_string 完全相同。");
    }
    if (!oldString) {
      throw new Error("old_string 不能为空。如果希望创建或全量覆盖文件，请使用 writeFile 工具。");
    }

    const safePath = secureResolveWritePath(targetPath);

    if (!existsSync(safePath)) {
      throw new Error(`未找到文件："${targetPath}"，编辑失败。`);
    }

    const fileStat = statSync(safePath);
    if (fileStat.isDirectory()) {
      throw new Error(`路径 "${targetPath}" 是一个目录，不能进行文本编辑。`);
    }

    if (!ReadFileTool.readFileState.has(safePath)) {
      throw new Error("拒绝安全风险操作：在修改已有文件前，必须先调用 readFile 工具阅读该文件的最新内容。");
    }

    const content = readFileSync(safePath, 'utf-8');

    let replacementsCount = 0;
    let offset = 0;
    while ((offset = content.indexOf(oldString, offset)) !== -1) {
      replacementsCount++;
      offset += oldString.length;
    }

    if (replacementsCount === 0) {
      throw new Error("未找到匹配的 old_string。请确认文件最新内容（是否已在别处被修改），以及空格、缩进或换行是否完全一致。");
    }

    if (replacementsCount > 1 && !replaceAll) {
      throw new Error(`在文件中找到了 ${replacementsCount} 处完全相同的 old_string 匹配。无法确认要替换的准确位置。请提供包含更多前后文的 old_string 以确保唯一性，或者如果确定要全部替换，请设置 replace_all 为 true。`);
    }

    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    writeFileSync(safePath, newContent, 'utf-8');

    return `文件局部修改成功："${targetPath}"。共替换了 ${replacementsCount} 处。`;
  }
}

/**
 * 目录查询检索工具类。
 * 提供获取授权沙箱内指定目录浅层列表清单的能力。
 */
export class ListFilesTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /**
   * 工具的名称。
   */
  readonly name = 'listFiles';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'listFiles',
      description: "列出工作区根目录下目标文件夹内的所有直接子文件和文件夹名称。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要列出的目标文件夹路径（相对于工作区根目录）。默认为 '.' 即工作区根文件夹。"
          }
        }
      }
    }
  };

  /**
   * 审查目录清单列举的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>): SafetyCheckResult {
    const targetPath = typeof args.targetPath === 'string' ? args.targetPath : '.';
    try {
      secureResolveReadPath(targetPath);
      return { status: 'pass' };
    } catch {
      const rootDir = getAuthorizedDir();
      const rawPath = resolve(rootDir!, targetPath);
      const resolvedPath = getPhysicalRealPath(rawPath);
      return {
        status: 'suspend',
        message: `智能体试图访问工作区外部的安全区，需要执行【只读】授权。目标路径: "${resolvedPath}"`,
        targetPath: resolvedPath
      };
    }
  }

  /**
   * 执行列出目录操作。
   *
   * @param args - 工具调用参数字典
   * @returns 目录子项 JSON 序列化字符串
   */
  execute(args: Record<string, unknown>): string {
    const targetPath = typeof args.targetPath === 'string' ? args.targetPath : '.';
    const safePath = secureResolveReadPath(targetPath);

    if (!existsSync(safePath)) {
      throw new Error(`未找到文件夹："${targetPath}"`);
    }

    if (!statSync(safePath).isDirectory()) {
      throw new Error(`路径 "${targetPath}" 是一个文件，不能作为文件夹列出。`);
    }

    const files = readdirSync(safePath);
    return JSON.stringify(files);
  }
}
