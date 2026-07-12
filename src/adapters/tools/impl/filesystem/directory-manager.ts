import { mkdirSync, existsSync, statSync, rmSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import { secureResolveWritePath, secureResolveReadPath, getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { NativeTool } from '../../tool-types.js';
import type { SafetyCheckResult } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SafetyOperation, SafetyResource } from '../../../../ports/shared/tool-policy.js';
import { copyRecursiveSync } from './directory-manager-helper.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';

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
   * 审查创建文件夹的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    if (sessionContext?.getPermissionMode() === 'bypassPermissions') {
      return { status: 'pass', operation: { planSideEffect: 'write', riskReason: '', operationCategory: 'file-write' as const, summary: '创建目录', resources: [] } as SafetyOperation };
    }
    const directoryPath = args.directoryPath;
    if (typeof directoryPath !== 'string') {
      return { status: 'deny', message: 'directoryPath 必须是字符串' };
    }
    let isOutOfSandbox = false;
    let resolvedPath = '';
    try {
      secureResolveWritePath(directoryPath, sessionContext);
    } catch {
      isOutOfSandbox = true;
      const rootDir = getAuthorizedDir();
      resolvedPath = getPhysicalRealPath(resolve(rootDir!, directoryPath));
    }
    return {
      status: 'suspend',
      message: `智能体试图执行修改或写入操作。工具: "${this.name}"，目标路径: "${directoryPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined,
      resources: isOutOfSandbox ? [{ kind: 'path', access: 'write' as const, normalizedPath: resolvedPath }] : [],
      operation: { planSideEffect: 'write', riskReason: `创建目录: ${directoryPath}`, operationCategory: 'file-write' as const, summary: `创建目录 ${directoryPath}`, resources: isOutOfSandbox ? [{ kind: 'path', access: 'write', normalizedPath: resolvedPath }] : [] }
    };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 目录创建由 ToolPermissionService 统一决策。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'passthrough' };
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
   * 审查安全删除路径的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    if (sessionContext?.getPermissionMode() === 'bypassPermissions') {
      return { status: 'pass', operation: { planSideEffect: 'write', riskReason: '', operationCategory: 'file-delete' as const, summary: '删除路径', resources: [] } as SafetyOperation };
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
      message: `智能体试图安全删除以下路径: "${targetPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined,
      resources: isOutOfSandbox ? [{ kind: 'path', access: 'write' as const, normalizedPath: resolvedPath }] : [],
      operation: { planSideEffect: 'write', riskReason: `删除路径: ${targetPath}`, operationCategory: 'file-delete' as const, summary: `删除 ${targetPath}`, resources: isOutOfSandbox ? [{ kind: 'path', access: 'write', normalizedPath: resolvedPath }] : [] }
    };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 路径删除由 ToolPermissionService 统一决策。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'passthrough' };
  }

  /**
   * 异步执行删除路径。
   * 审批已由 checkSafety + HumanApprovalPlugin 前置处理，此处不再内部调用 waitApproval。
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
   * 审查移动路径的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    if (sessionContext?.getPermissionMode() === 'bypassPermissions') {
      return { status: 'pass', operation: { planSideEffect: 'write', riskReason: '', operationCategory: 'file-move' as const, summary: '移动路径', resources: [] } as SafetyOperation };
    }
    const sourcePath = args.sourcePath;
    const destinationPath = args.destinationPath;
    if (typeof sourcePath !== 'string' || typeof destinationPath !== 'string') {
      return { status: 'deny', message: 'sourcePath 和 destinationPath 必须是字符串' };
    }
    let isOutOfSandbox = false;
    let resolvedPath = '';
    try {
      secureResolveWritePath(sourcePath, sessionContext);
      secureResolveWritePath(destinationPath, sessionContext);
    } catch {
      isOutOfSandbox = true;
      const rootDir = getAuthorizedDir();
      try {
        secureResolveWritePath(sourcePath, sessionContext);
        resolvedPath = getPhysicalRealPath(resolve(rootDir!, destinationPath));
      } catch {
        resolvedPath = getPhysicalRealPath(resolve(rootDir!, sourcePath));
      }
    }
    // 双 write 资源：移动删除源路径
    const rootDir = getAuthorizedDir();
    const srcResolved = getPhysicalRealPath(resolve(rootDir!, sourcePath));
    const destResolved = getPhysicalRealPath(resolve(rootDir!, destinationPath));
    const resources: SafetyResource[] = [
      { kind: 'path', access: 'write', normalizedPath: srcResolved },
      { kind: 'path', access: 'write', normalizedPath: destResolved }
    ];
    return {
      status: 'suspend',
      message: `智能体试图将 "${sourcePath}" 移动至 "${destinationPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined,
      resources,
      operation: { planSideEffect: 'write', riskReason: `移动: ${sourcePath} → ${destinationPath}`, operationCategory: 'file-move' as const, summary: `移动 ${sourcePath} 到 ${destinationPath}`, resources }
    };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 路径移动由 ToolPermissionService 统一决策。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'passthrough' };
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
   * 审查复制路径的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    if (sessionContext?.getPermissionMode() === 'bypassPermissions') {
      return { status: 'pass', operation: { planSideEffect: 'write', riskReason: '', operationCategory: 'file-copy' as const, summary: '复制路径', resources: [] } as SafetyOperation };
    }
    const sourcePath = args.sourcePath;
    const destinationPath = args.destinationPath;
    if (typeof sourcePath !== 'string' || typeof destinationPath !== 'string') {
      return { status: 'deny', message: 'sourcePath 和 destinationPath 必须是字符串' };
    }
    let isOutOfSandbox = false;
    let resolvedPath = '';
    try {
      secureResolveReadPath(sourcePath, sessionContext);
      secureResolveWritePath(destinationPath, sessionContext);
    } catch {
      isOutOfSandbox = true;
      const rootDir = getAuthorizedDir();
      try {
        secureResolveReadPath(sourcePath, sessionContext);
        resolvedPath = getPhysicalRealPath(resolve(rootDir!, destinationPath));
      } catch {
        resolvedPath = getPhysicalRealPath(resolve(rootDir!, sourcePath));
      }
    }
    const rootDir = getAuthorizedDir();
    const srcResolved = getPhysicalRealPath(resolve(rootDir!, sourcePath));
    const destResolved = getPhysicalRealPath(resolve(rootDir!, destinationPath));
    const resources: SafetyResource[] = [
      { kind: 'path', access: 'read', normalizedPath: srcResolved },
      { kind: 'path', access: 'write', normalizedPath: destResolved }
    ];
    return {
      status: 'suspend',
      message: `智能体试图将 "${sourcePath}" 复制至 "${destinationPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined,
      resources,
      operation: { planSideEffect: 'write', riskReason: `复制: ${sourcePath} → ${destinationPath}`, operationCategory: 'file-copy' as const, summary: `复制 ${sourcePath} 到 ${destinationPath}`, resources }
    };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 路径复制由 ToolPermissionService 统一决策。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'passthrough' };
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
