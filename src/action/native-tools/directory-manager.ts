import { mkdirSync, existsSync, statSync, rmSync, readdirSync, copyFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { secureResolveWritePath, secureResolveReadPath } from './base.js';
import type { NativeTool } from '../virtual-mcp.js';
import { ToolConstants } from '../../common/constants.js';

/**
 * 递归复制文件或目录的辅助函数。
 * 
 * @param src - 源物理绝对路径
 * @param dest - 目标物理绝对路径
 */
function copyRecursiveSync(src: string, dest: string): void {
  const stats = statSync(src);
  if (stats.isDirectory()) {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }
    const children = readdirSync(src);
    for (const child of children) {
      copyRecursiveSync(join(src, child), join(dest, child));
    }
  } else {
    const parentDir = dirname(dest);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    copyFileSync(src, dest);
  }
}

/**
 * 目录创建工具类。
 * 底层调用 fs.mkdirSync 原生递归创建多级文件夹，以支持跨平台一致性。
 */
export class CreateDirectoryTool implements NativeTool {
  /** 工具的名称。 */
  readonly name = ToolConstants.CREATE_DIRECTORY;

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: ToolConstants.CREATE_DIRECTORY,
      description: "递归创建多级目录。可磨平不同操作系统的命令行选项差异并自动校验工作区安全边界。",
      parameters: {
        type: "object",
        properties: {
          directoryPath: {
            type: "string",
            description: "需要创建的目标目录路径（相对于工作区根目录的相对路径，例如 'src/components/common'）。"
          }
        },
        required: ["directoryPath"]
      }
    }
  };

  /**
   * 执行递归创建目录。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 成功创建提示信息
   */
  execute(args: Record<string, unknown>): string {
    const directoryPath = args.directoryPath;
    if (typeof directoryPath !== 'string') {
      throw new Error("directoryPath 必须是字符串");
    }

    const safePath = secureResolveWritePath(directoryPath);

    if (existsSync(safePath)) {
      const stats = statSync(safePath);
      if (!stats.isDirectory()) {
        throw new Error(`路径 "${directoryPath}" 已存在，但它是一个文件而不是目录，无法创建。`);
      }
      return `目录已存在，无需重复创建："${directoryPath}"。`;
    }

    mkdirSync(safePath, { recursive: true });
    return `目录递归创建成功："${directoryPath}"。`;
  }
}

/**
 * 安全路径删除工具类。
 * 用于安全删除指定的文件或目录，支持在底层接入 ApprovalService 确权拦截机制。
 */
export class DeletePathTool implements NativeTool {
  /** 工具的名称。 */
  readonly name = ToolConstants.DELETE_PATH;

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: ToolConstants.DELETE_PATH,
      description: "删除工作区内指定的文件或目录（高危操作，会触发控制台审批卡关确权拦截）。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要删除的文件或目录的相对路径（相对于工作区根目录，例如 'src/utils/temp.ts'）。"
          }
        },
        required: ["targetPath"]
      }
    }
  };

  /**
   * 异步执行删除路径。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文，用于获取 ApprovalService 确权
   * @returns 成功删除的提示信息
   */
  async execute(args: Record<string, unknown>, sessionContext?: unknown): Promise<string> {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }

    const safePath = secureResolveWritePath(targetPath);

    if (!existsSync(safePath)) {
      return `目标路径不存在，无需删除："${targetPath}"。`;
    }

    const approvalService = (sessionContext as {
      approvalService?: {
        wait(
          id: string,
          toolCall: { name: string; arguments: Record<string, unknown> },
          allowedPrefix?: string,
          message?: string
        ): Promise<{ action: 'once' | 'always' | 'deny' }>;
      };
    })?.approvalService;
    if (approvalService) {
      const approvalId = `approve_delete_${Math.random().toString(36).substring(2, 9)}`;
      const decision = await approvalService.wait(
        approvalId,
        { name: this.name, arguments: args },
        undefined,
        `智能体试图安全删除以下路径: "${targetPath}"`
      );

      if (decision.action === 'deny') {
        throw new Error(`用户拒绝了删除路径的操作: ${targetPath}`);
      }
    }

    rmSync(safePath, { recursive: true, force: true });
    return `路径删除成功："${targetPath}"。`;
  }
}

/**
 * 移动路径工具类。
 * 原生实现文件或目录的移动转移，磨平跨卷/设备移动的平台限制，自动创建目标父目录。
 */
export class MovePathTool implements NativeTool {
  /** 工具的名称。 */
  readonly name = ToolConstants.MOVE_PATH;

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: ToolConstants.MOVE_PATH,
      description: "移动（重命名）文件或目录，支持跨卷移动并自动创建缺失的目标父级目录。",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "源文件或目录的相对路径（例如 'src/temp.ts'）。"
          },
          destinationPath: {
            type: "string",
            description: "目标文件或目录的相对路径（例如 'src/utils/temp.ts'）。"
          }
        },
        required: ["sourcePath", "destinationPath"]
      }
    }
  };

  /**
   * 执行路径移动。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 成功移动的提示信息
   */
  execute(args: Record<string, unknown>): string {
    const sourcePath = args.sourcePath;
    const destinationPath = args.destinationPath;

    if (typeof sourcePath !== 'string') {
      throw new Error("sourcePath 必须是字符串");
    }
    if (typeof destinationPath !== 'string') {
      throw new Error("destinationPath 必须是字符串");
    }

    const safeSource = secureResolveWritePath(sourcePath);
    const safeDest = secureResolveWritePath(destinationPath);

    if (!existsSync(safeSource)) {
      throw new Error(`源路径不存在："${sourcePath}"`);
    }

    const parentDir = dirname(safeDest);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    try {
      renameSync(safeSource, safeDest);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'EXDEV') {
        // 跨卷移动兼容降级：复制后删除源
        copyRecursiveSync(safeSource, safeDest);
        rmSync(safeSource, { recursive: true, force: true });
      } else {
        throw err;
      }
    }

    return `成功将 "${sourcePath}" 移动至 "${destinationPath}"。`;
  }
}

/**
 * 复制路径工具类。
 * 原生实现文件或目录的复制，支持递归复制目录并自动创建目标父目录。
 */
export class CopyPathTool implements NativeTool {
  /** 工具的名称。 */
  readonly name = ToolConstants.COPY_PATH;

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: ToolConstants.COPY_PATH,
      description: "复制文件或目录到新的位置，支持目录的递归复制。",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "源文件或目录的相对路径（例如 'src/temp.ts'）。"
          },
          destinationPath: {
            type: "string",
            description: "目标文件或目录的相对路径（例如 'src/temp-backup.ts'）。"
          }
        },
        required: ["sourcePath", "destinationPath"]
      }
    }
  };

  /**
   * 执行路径复制。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 成功复制的提示信息
   */
  execute(args: Record<string, unknown>): string {
    const sourcePath = args.sourcePath;
    const destinationPath = args.destinationPath;

    if (typeof sourcePath !== 'string') {
      throw new Error("sourcePath 必须是字符串");
    }
    if (typeof destinationPath !== 'string') {
      throw new Error("destinationPath 必须是字符串");
    }

    const safeSource = secureResolveReadPath(sourcePath);
    const safeDest = secureResolveWritePath(destinationPath);

    if (!existsSync(safeSource)) {
      throw new Error(`源路径不存在："${sourcePath}"`);
    }

    copyRecursiveSync(safeSource, safeDest);
    return `成功将 "${sourcePath}" 复制至 "${destinationPath}"。`;
  }
}
