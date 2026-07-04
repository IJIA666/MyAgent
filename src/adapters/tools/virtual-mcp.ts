import { gitTools } from './impl/git/index.js';
import { fileSystemTools } from './impl/filesystem/index.js';
import { systemTools } from './impl/system/index.js';
import { getSkillTools } from './impl/skill/index.js';
import { getInteractionTools } from './impl/interaction/index.js';
import type { SafetyCheckResult, ToolExecutionContext } from '../../core/usecases/plugins/plugin-types.js';
import type { SafetyResource } from '../../core/usecases/security/SafetyResource.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { ApprovalPort } from '../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';
import { secureResolveWritePath } from './impl/base.js';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { computeArgumentsDigest } from '../../core/domain/context.js';
import { extractSafePrefix } from './impl/system/terminal.js';
import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserScrollTool,
  BrowserBackTool,
  BrowserPressTool,
  BrowserVisionTool,
  BrowserEnsureLoginTool,
  BrowserGetTextTool
} from './impl/browser/browser-action.js';
export type { SafetyCheckResult };

/**
 * 本地内置工具的契约接口。
 * 所有系统内置的本地工具实例都必须实现该接口。
 */
export interface NativeTool {
  /**
   * 工具的安全类别，标示是只读（'read'）还是写入/高危操作（'write'）。
   */
  readonly securityCategory: 'read' | 'write';

  /**
   * 工具的名称，作为检索和分发的唯一标识。
   */
  readonly name: string;

  /**
   * 可选的文件路径参数字段键名。
   */
  readonly filePathParamKey?: string;

  /**
   * 工具的大模型调用声明定义，包含描述与参数模式。
   */
  readonly definition: Record<string, unknown>;

  /**
   * 异步或同步执行该工具的逻辑。
   *
   * @param args - 调用工具时传入的参数字典
   * @param _context - 可选的智能体会话上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @param signal - 可选的 AbortSignal，用于物理取消工具执行
   * @param _interactionPort - 可选的交互端口
   * @returns 工具执行完毕后返回的文本结果
   */
  execute(
    args: Record<string, unknown>,
    _context?: ToolExecutionContext | SessionEventPort,
    signal?: AbortSignal,
    _interactionPort?: InteractionPort
  ): Promise<string> | string;

  /**
   * 异步或同步审查该工具执行调用的安全性。
   * 为安全控制决策提供统一的多态评估 Ports 接口。
   *
   * @param args - 调用工具时传入的参数字典
   * @param sessionContext - 可选的会话上下文，用于获取安全状态服务
   * @param signal - 可选的 AbortSignal，用于物理取消安全校验
   * @returns 安全评估结论
   */
  checkSafety(
    args: Record<string, unknown>,
    sessionContext?: SessionEventPort,
    signal?: AbortSignal
  ): Promise<SafetyCheckResult> | SafetyCheckResult;
}

/**
 * 资源提取器类型定义。
 * 从工具调用的原始参数中重新计算原子资源列表，
 * 用于 ApprovalPolicy 交叉校验工具层报告的 SafetyOperation.resources。
 */
export type ResourceExtractor = (args: Record<string, unknown>) => SafetyResource[];

/**
 * 虚拟 MCP 调用请求接口定义
 * 用于标准化内部工具的调用传参结构
 */
export interface CallToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * 虚拟 MCP 调用结果接口定义
 * 统一工具调用后的返回数据格式
 */
export interface CallToolResult {
  content: {
    type: string;
    text: string;
  }[];
  isError?: boolean;
}

export interface LocalServerOptions {
  loadSkill?: (name: string) => string | null;
}

/**
 * 虚拟 MCP Server，负责在进程内提供文件系统的 MCP 标准操作。
 * 实现了标准的 MCP callTool 和工具声明接口，但通过直接内存调用绕开了实际的子进程通信开销。
 */
export class LocalFileSystemMcpServer {
  /**
   * 已注册的本地内置工具映射字典。
   */
  private toolsMap = new Map<string, NativeTool>();

  /**
   * 资源提取器注册表：工具名 → 提取器函数。
   * 由 ApprovalPolicy 在构造时注入引用，用于交叉校验工具层报告的 SafetyOperation。
   */
  private resourceExtractors = new Map<string, ResourceExtractor>();

  /**
   * 初始化虚拟 MCP 服务器并注册所有内置工具。
   *
   * @param options - 附加配置选项，包含可选的 loadSkill 解析器
   */
  constructor(options?: LocalServerOptions) {
    // 聚合各业务领域 Feature 原生工具实例列表
    const allTools: NativeTool[] = [
      ...gitTools,
      ...fileSystemTools,
      ...systemTools,
      ...getSkillTools(options?.loadSkill),
      ...getInteractionTools(),
      new BrowserNavigateTool(),
      new BrowserClickTool(),
      new BrowserTypeTool(),
      new BrowserScrollTool(),
      new BrowserBackTool(),
      new BrowserPressTool(),
      new BrowserVisionTool(),
      new BrowserEnsureLoginTool(),
      new BrowserGetTextTool()
    ];

    // 循环迭代注册到本地虚拟服务器中
    allTools.forEach(tool => this.register(tool));

    // 注册资源提取器（用于 ApprovalPolicy 交叉校验）
    this.registerExtractorsForBuiltinTools();
  }

  /**
   * 注册一个新的本地内置工具实例。
   *
   * @param tool - 要注册的工具对象
   */
  register(tool: NativeTool): void {
    this.toolsMap.set(tool.name, tool);
  }

  /**
   * 注册一个资源提取器函数。
   * 提取器用于从工具原始参数中提取资源列表，供 ApprovalPolicy 交叉校验工具层报告的资源真实性。
   *
   * @param toolName - 工具名称
   * @param extractor - 资源提取器函数
   */
  public registerResourceExtractor(toolName: string, extractor: ResourceExtractor): void {
    this.resourceExtractors.set(toolName, extractor);
  }

  /**
   * 获取资源提取器注册表的只读副本。
   * 供 ApprovalPolicy 在装配阶段注入使用。
   *
   * @returns 工具名 → 提取器的 Map 副本
   */
  public getResourceExtractors(): Map<string, ResourceExtractor> {
    return new Map(this.resourceExtractors);
  }

  /**
   * 根据工具名称获取 NativeTool 实例。
   *
   * @param name - 工具名称
   * @returns 工具实例，若未找到则返回 undefined
   */
  getTool(name: string): NativeTool | undefined {
    return this.toolsMap.get(name);
  }

  /**
   * 获取此虚拟 Server 暴露的所有已注册工具列表。
   *
   * @returns 工具定义数组
   */
  async getTools(): Promise<Record<string, unknown>[]> {
    return Array.from(this.toolsMap.values()).map(t => t.definition);
  }

  /**
   * 遵循 MCP 标准格式调用本地工具。
   *
   * @param request - 符合 MCP CallToolRequest 结构的请求对象
   * @param sessionContext - 可选的智能体会话上下文
   * @param interactionPort - 可选的交互端口
   * @param signal - 可选的 AbortSignal
   * @param toolCallId - 可选的工具调用唯一标识（用于 call capability 生命周期管理）
   * @returns 符合 MCP CallToolResult 结构的结果对象
   */
  async callTool(
    request: CallToolRequest,
    sessionContext?: SessionEventPort & ApprovalPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string
  ): Promise<CallToolResult> {
    try {
      const args = request.arguments || {};
      const tool = this.toolsMap.get(request.name);
      if (!tool) {
        throw new Error(`虚拟 MCP Server 不支持工具: ${request.name}`);
      }

      // 构建 ToolExecutionContext（若 toolCallId 存在）
      const execContext: ToolExecutionContext | undefined = toolCallId && sessionContext
        ? {
            sessionContext: sessionContext as unknown as ToolExecutionContext['sessionContext'],
            toolCallId,
            toolName: request.name,
            argumentsDigest: computeArgumentsDigest(args),
            claimedResources: []
          }
        : undefined;

      // 在 execute 前 claim 一次性令牌（匹配 toolCallId + argumentsDigest）
      if (execContext) {
        const claimed = execContext.sessionContext.claimCapability(toolCallId!, request.name, args);
        if (claimed) {
          execContext.claimedResources = claimed;
        }
      }

      // 底层高危操作安全硬拦截仅保留给“未接入新生命周期”的旧调用路径。
      // 一旦存在 toolCallId / ToolExecutionContext，说明调用已进入新的 Hook 生命周期：
      // - call grant 走 claimCapability
      // - session grant 依赖 secureResolve{Read,Write}Path 白名单放行
      // - execute_command 等工具依赖 BeforeTool.checkSafety 的既有放行结果
      // 因此这里绝不能再二次覆盖新的授权决策。
      if (sessionContext && !execContext) {
        let isDangerous = false;
        let warningMsg = '';

        const category = tool.securityCategory;
        if (category !== 'read') {
          // 降级防御：如果不是显式声明的只读工具，一律判定为写入/高危操作进行确权拦截
          const pathKey = tool.filePathParamKey;
          if (pathKey && typeof args[pathKey] === 'string') {
            const targetPath = args[pathKey] as string;
            try {
              const safePath = secureResolveWritePath(targetPath, sessionContext);
              if (existsSync(safePath)) {
                if (request.name === 'deletePath') {
                  isDangerous = true;
                  warningMsg = `智能体试图删除文件或目录。目标路径: "${targetPath}"`;
                } else if (request.name !== 'createDirectory') {
                  isDangerous = true;
                  if (request.name === 'writeFile') {
                    warningMsg = `智能体试图强行覆盖已有的文件。目标路径: "${targetPath}"`;
                  } else {
                    warningMsg = `智能体试图修改或覆盖已有的文件。工具: "${request.name}"，目标路径: "${targetPath}"`;
                  }
                }
              } else {
                // 路径不存在时，如果是 deletePath，仍需无条件确权拦截
                if (request.name === 'deletePath') {
                  isDangerous = true;
                  warningMsg = `智能体试图删除文件或目录。目标路径: "${targetPath}"`;
                }
              }
            } catch {
              // 路径解析越权或错误，直接交给工具自身的 execute 跑 checkSafety，这里不作硬拦截
            }
          } else {
            // 降级防御：如果未声明 filePathParamKey，或者参数非法，为策安全一律强制拦截
            isDangerous = true;
            warningMsg = `智能体试图执行高危写入操作（缺少参数元数据声明）。工具: "${request.name}"`;
          }
        }

        if (isDangerous) {
          const approvalId = `approve_dangerous_${Math.random().toString(36).substring(2, 9)}`;
          const decision = await sessionContext.waitApproval(
            approvalId,
            { name: request.name, arguments: args },
            undefined,
            warningMsg
          );

          if (decision.action === 'deny') {
            throw new Error(`用户拒绝了高危操作。工具: "${request.name}"，原因: 用户审批拒绝`);
          }
        }
      }

      // 传入 ToolExecutionContext（含 claim 后的 claimedResources），无 toolCallId 时传入原始 sessionContext
      const contextToPass = execContext ?? sessionContext;
      const resultText = await tool.execute(args, contextToPass, signal, interactionPort);

      return {
        content: [
          {
            type: "text",
            text: resultText
          }
        ]
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `执行失败: ${errorMsg}`
          }
        ],
        isError: true
      };
    }
  }

  /** 为所有内置工具注册资源提取器（用于 ApprovalPolicy 交叉校验） */
  private registerExtractorsForBuiltinTools(): void {
    const cwd = process.cwd();

    /** 创建路径提取器辅助函数 */
    const pathExtractor = (pathKey: string, access: 'read' | 'write'): ResourceExtractor =>
      (args) => {
        const rawPath = args[pathKey];
        if (typeof rawPath === 'string' && rawPath.trim()) {
          return [{ kind: 'path', access, normalizedPath: resolve(cwd, rawPath.trim()) }];
        }
        return [];
      };

    /** 创建多路径提取器（用于 readManyFiles） */
    const multiPathExtractor = (pathKey: string, access: 'read' | 'write'): ResourceExtractor =>
      (args) => {
        const rawPaths = args[pathKey];
        if (typeof rawPaths === 'string') {
          let paths: string[];
          try {
            const parsed = JSON.parse(rawPaths);
            paths = Array.isArray(parsed) ? parsed.map(String) : [rawPaths.trim()];
          } catch {
            paths = rawPaths.split(',').map(s => s.trim()).filter(Boolean);
          }
          return paths.map(p => ({ kind: 'path' as const, access, normalizedPath: resolve(cwd, p) }));
        }
        return [];
      };

    /** 创建命令前缀提取器 */
    const commandPrefixExtractor: ResourceExtractor = (args) => {
      const command = args.command;
      if (typeof command === 'string' && command.trim()) {
        const safePrefix = extractSafePrefix(command);
        if (safePrefix) {
          return [{ kind: 'command-prefix', prefix: safePrefix }];
        }
      }
      return [];
    };

    // ── 文件工具：只读 ──
    this.registerResourceExtractor('readFile', pathExtractor('targetPath', 'read'));
    this.registerResourceExtractor('readManyFiles', multiPathExtractor('targetPaths', 'read'));
    this.registerResourceExtractor('listFiles', pathExtractor('targetPath', 'read'));
    this.registerResourceExtractor('grepSearch', (args) => {
      const rawPath = args.searchPath;
      if (typeof rawPath === 'string' && rawPath.trim()) {
        // grepSearch 的 path 参数可能是逗号分隔的多个路径
        const paths = rawPath.split(',').map(s => s.trim()).filter(Boolean);
        return paths.map(p => ({ kind: 'path' as const, access: 'read' as const, normalizedPath: resolve(cwd, p) }));
      }
      return [];
    });
    this.registerResourceExtractor('globSearch', () => {
      // globSearch 可能不传具体路径，提取器返回空列表表示无法校验
      return [];
    });

    // ── 文件工具：写入 ──
    this.registerResourceExtractor('writeFile', pathExtractor('targetPath', 'write'));
    this.registerResourceExtractor('editFile', pathExtractor('targetPath', 'write'));
    this.registerResourceExtractor('createDirectory', pathExtractor('directoryPath', 'write'));
    this.registerResourceExtractor('deletePath', pathExtractor('targetPath', 'write'));
    this.registerResourceExtractor('applyPatch', pathExtractor('targetPath', 'write'));

    // ── 文件工具：双路径 ──
    this.registerResourceExtractor('movePath', (args) => {
      const source = args.sourcePath;
      const dest = args.destinationPath;
      const resources: SafetyResource[] = [];
      if (typeof source === 'string' && source.trim()) {
        resources.push({ kind: 'path', access: 'write', normalizedPath: resolve(cwd, source.trim()) });
      }
      if (typeof dest === 'string' && dest.trim()) {
        resources.push({ kind: 'path', access: 'write', normalizedPath: resolve(cwd, dest.trim()) });
      }
      return resources;
    });
    this.registerResourceExtractor('copyPath', (args) => {
      const source = args.sourcePath;
      const dest = args.destinationPath;
      const resources: SafetyResource[] = [];
      if (typeof source === 'string' && source.trim()) {
        resources.push({ kind: 'path', access: 'read', normalizedPath: resolve(cwd, source.trim()) });
      }
      if (typeof dest === 'string' && dest.trim()) {
        resources.push({ kind: 'path', access: 'write', normalizedPath: resolve(cwd, dest.trim()) });
      }
      return resources;
    });

    // ── 命令工具 ──
    this.registerResourceExtractor('execute_command', commandPrefixExtractor);
  }
}
