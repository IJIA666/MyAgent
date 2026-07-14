import { mkdirSync, existsSync, statSync, rmSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import { secureResolveWritePath, secureResolveReadPath, getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { NativeTool } from '../../tool-types.js';
import { copyRecursiveSync } from './directory-manager-helper.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';

/** 将工具参数中的路径转换为权限层使用的结构化资源证据。 */
function createPathResource(path: string, access: 'read' | 'write'): Readonly<Record<string, unknown>> {
  const rootDir = getAuthorizedDir();
  return {
    kind: 'path',
    access,
    normalizedPath: getPhysicalRealPath(resolve(rootDir!, path)),
  };
}

/**
 * 目录创建工具类。
 * 底层调用 fs.mkdirSync 原生递归创建多级文件夹，以支持跨平台一致性。
 */
export class CreateDirectoryTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'directoryPath';

  /** 工具的名称。 */
  readonly name = 'createDirectory';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'createDirectory',
      description: "递归创建多级目录。默认在工作区内创建；外部路径由工具层依据安全策略处理。可磨平不同操作系统的命令行选项差异。",
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
   * Claude 风格的 tool-level checkPermissions。
   * 目录创建由 ToolPermissionService 统一决策。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const directoryPath = args.directoryPath;
    if (typeof directoryPath !== 'string') {
      return { kind: 'deny', decisionReason: 'directoryPath 必须是字符串' };
    }
    return {
      kind: 'ask',
      message: `创建目录 ${directoryPath}`,
      decisionReason: '创建目录会修改文件系统',
      evidence: {
        operationCategory: 'file-write',
        sideEffect: 'write',
        riskReason: `创建目录: ${directoryPath}`,
        resources: [createPathResource(directoryPath, 'write')],
      },
    };
  }

  /**
   * 执行递归创建目录。
   *
   * @param args - 工具调用参数字典
   * @param _context - 工具调用执行上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @returns 成功创建提示信息
   */
  execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort): string {
    const directoryPath = args.directoryPath;
    if (typeof directoryPath !== 'string') {
      throw new Error("directoryPath 必须是字符串");
    }

    const safePath = _context ? secureResolveWritePath(directoryPath, _context) : secureResolveWritePath(directoryPath);

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
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'targetPath';

  /** 工具的名称。 */
  readonly name = 'deletePath';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'deletePath',
      description: "删除指定的文件或目录。默认在工作区内删除路径；外部路径由工具层依据安全策略处理。（高危操作，会触发控制台审批卡关确权拦截。）",
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
   * Claude 风格的 tool-level checkPermissions。
   * 路径删除由 ToolPermissionService 统一决策。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { kind: 'deny', decisionReason: 'targetPath 必须是字符串' };
    }
    return {
      kind: 'ask',
      message: `删除路径 ${targetPath}`,
      decisionReason: '删除路径是破坏性文件系统操作',
      evidence: {
        operationCategory: 'file-delete',
        sideEffect: 'write',
        riskReason: `删除路径: ${targetPath}`,
        resources: [createPathResource(targetPath, 'write')],
      },
    };
  }

  /**
   * 异步执行删除路径。
   * 审批已由统一权限服务与工具调用网关前置处理，此处不再内部请求授权。
   *
   * @param args - 工具调用参数字典
   * @param _context - 工具调用执行上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @returns 成功删除的提示信息
   */
  async execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort): Promise<string> {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }

    const safePath = _context ? secureResolveWritePath(targetPath, _context) : secureResolveWritePath(targetPath);

    if (!existsSync(safePath)) {
      return `目标路径不存在，无需删除："${targetPath}"。`;
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
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'destinationPath';

  /** 工具的名称。 */
  readonly name = 'movePath';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'movePath',
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
   * Claude 风格的 tool-level checkPermissions。
   * 路径移动由 ToolPermissionService 统一决策。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const sourcePath = args.sourcePath;
    const destinationPath = args.destinationPath;
    if (typeof sourcePath !== 'string' || typeof destinationPath !== 'string') {
      return { kind: 'deny', decisionReason: 'sourcePath 和 destinationPath 必须是字符串' };
    }
    return {
      kind: 'ask',
      message: `移动 ${sourcePath} 到 ${destinationPath}`,
      decisionReason: '移动路径会同时修改源位置和目标位置',
      evidence: {
        operationCategory: 'file-move',
        sideEffect: 'write',
        riskReason: `移动: ${sourcePath} → ${destinationPath}`,
        resources: [createPathResource(sourcePath, 'write'), createPathResource(destinationPath, 'write')],
      },
    };
  }

  /**
   * 执行路径移动。
   *
   * @param args - 工具调用参数字典
   * @param _context - 工具调用执行上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @returns 成功移动的提示信息
   */
  execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort): string {
    const sourcePath = args.sourcePath;
    const destinationPath = args.destinationPath;

    if (typeof sourcePath !== 'string') {
      throw new Error("sourcePath 必须是字符串");
    }
    if (typeof destinationPath !== 'string') {
      throw new Error("destinationPath 必须是字符串");
    }

    const safeSource = _context ? secureResolveWritePath(sourcePath, _context) : secureResolveWritePath(sourcePath);
    const safeDest = _context ? secureResolveWritePath(destinationPath, _context) : secureResolveWritePath(destinationPath);

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
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'destinationPath';

  /** 工具的名称。 */
  readonly name = 'copyPath';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'copyPath',
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
   * Claude 风格的 tool-level checkPermissions。
   * 路径复制由 ToolPermissionService 统一决策。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const sourcePath = args.sourcePath;
    const destinationPath = args.destinationPath;
    if (typeof sourcePath !== 'string' || typeof destinationPath !== 'string') {
      return { kind: 'deny', decisionReason: 'sourcePath 和 destinationPath 必须是字符串' };
    }
    return {
      kind: 'ask',
      message: `复制 ${sourcePath} 到 ${destinationPath}`,
      decisionReason: '复制路径会写入目标位置',
      evidence: {
        operationCategory: 'file-copy',
        sideEffect: 'write',
        riskReason: `复制: ${sourcePath} → ${destinationPath}`,
        resources: [createPathResource(sourcePath, 'read'), createPathResource(destinationPath, 'write')],
      },
    };
  }

  /**
   * 执行路径复制。
   *
   * @param args - 工具调用参数字典
   * @param _context - 工具调用执行上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @returns 成功复制的提示信息
   */
  execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort): string {
    const sourcePath = args.sourcePath;
    const destinationPath = args.destinationPath;

    if (typeof sourcePath !== 'string') {
      throw new Error("sourcePath 必须是字符串");
    }
    if (typeof destinationPath !== 'string') {
      throw new Error("destinationPath 必须是字符串");
    }

    const safeSource = _context ? secureResolveReadPath(sourcePath, _context) : secureResolveReadPath(sourcePath);
    const safeDest = _context ? secureResolveWritePath(destinationPath, _context) : secureResolveWritePath(destinationPath);

    if (!existsSync(safeSource)) {
      throw new Error(`源路径不存在："${sourcePath}"`);
    }

    copyRecursiveSync(safeSource, safeDest);
    return `成功将 "${sourcePath}" 复制至 "${destinationPath}"。`;
  }
}
