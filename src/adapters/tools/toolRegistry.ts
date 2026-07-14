import { buildNativeTools } from './tool-factory.js';
import type { BuildNativeToolsOptions } from './tool-factory.js';
import { McpToolManager } from './mcp-client.js';
import { ToolCatalog } from './ToolCatalog.js';
import { ToolExecutor } from './ToolExecutor.js';
import { ToolCallGateway } from './ToolCallGateway.js';
import { PermissionRuleStore } from '../../core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../core/domain/permissions/tool-permission-service.js';
import { PermissionPromptAdapter } from '../../core/usecases/plugins/PermissionPromptAdapter.js';
import type { ToolPermissionCheckResult, ToolPermissionEvidence } from '../../core/domain/permissions/permission-types.js';
import { ToolAccessMetadataProvider } from './ToolAccessMetadataProvider.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { CallCapabilityPort } from '../../ports/driven/session/CallCapabilityPort.js';
import type { EventNotificationPort } from '../../ports/driven/session/EventNotificationPort.js';
import type { ApprovalPort } from '../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';
import type { ToolRegistryPort, ToolMetadata } from '../../ports/driven/tools/ToolRegistryPort.js';
import type { ToolAccessMetadataPort, ResourceExtractor, ToolAccessMetadata } from '../../ports/driven/tools/ToolAccessMetadataPort.js';
import type { McpManagerPort } from '../../ports/driven/tools/McpManagerPort.js';
import type { ToolExecutionOutcome, ToolExecutionEffect } from './tool-types.js';

/**
 * 工具注册表管理类。
 * 核心职责：
 * 1. 统管本地内建工具的唯一装配源，通过 buildNativeTools 构造全部本地工具；
 * 2. 集成外部真实 MCP 服务器（McpToolManager）提供的外部工具；
 * 3. 对外提供统一的工具获取（getTools）与工具调用（callTool）接口。
 */
export class ToolRegistry implements ToolRegistryPort, ToolAccessMetadataPort {
  // 工具目录管理器（委托 getTools / getTool）
  private catalog: ToolCatalog;
  // 工具执行调度器（委托 callTool）
  private executor: ToolExecutor;
  /** 所有本地工具调用的统一权限网关。 */
  private gateway: ToolCallGateway;
  /** 当前注册表对应的规则存储。 */
  private permissionRuleStore: PermissionRuleStore;
  /** 当前注册表对应的权限服务。 */
  private permissionService: ToolPermissionService;
  // 工具访问元数据聚合器（委托资源提取器查询）
  private metadataProvider: ToolAccessMetadataProvider;
  // 可选的外部 MCP 工具管理器实例
  public readonly mcpManager?: McpManagerPort;

  /**
   * 初始化工具注册表。
   *
   * @param mcpManager - 外部的 MCP 工具管理器（可选）
   * @param options - 本地工具装配选项（可选）
   */
  constructor(mcpManager?: McpToolManager, options?: BuildNativeToolsOptions) {
    // 注入可选的外部 MCP 工具管理器
    this.mcpManager = mcpManager;
    // 通过唯一装配源构建本地工具列表
    const allTools = buildNativeTools(options);
    // 构建工具目录
    this.catalog = new ToolCatalog(allTools, mcpManager);
    // 构建执行器与权限网关，网关只使用本实例签发的授权上下文。
    this.permissionRuleStore = new PermissionRuleStore();
    this.permissionService = new ToolPermissionService({ ruleStore: this.permissionRuleStore });
    this.executor = new ToolExecutor(
      this.catalog,
      (context) => this.permissionService.isIssuedContext(context),
    );
    this.gateway = new ToolCallGateway(this.permissionService, this.permissionRuleStore, this.executor);
    this.gateway.registerTools(allTools);
    // 构建元数据聚合器（从工具自带 resourceExtractor 聚合）
    this.metadataProvider = new ToolAccessMetadataProvider(allTools);
  }

  /**
   * 根据工具名称获取本地内置的 NativeTool 实例元数据（委托给 ToolCatalog）。
   *
   * @param name - 工具名称
   * @returns 工具实例元数据，若未找到则返回 undefined
   */
  public getTool(name: string): ToolMetadata | undefined {
    return this.catalog.getToolMetadata(name);
  }

  /**
   * 聚合获取当前系统中所有可用的工具列表（委托给 ToolCatalog）。
   * 包括本地文件系统工具与（如果配置了的）外部 MCP 节点工具。
   *
   * @returns 包含所有工具定义的数组，供大语言模型消费
   */
  public async getTools(): Promise<unknown[]> {
    return this.catalog.getTools();
  }

  /**
   * 统一路由并执行指定的工具调用请求（委托给 ToolExecutor）。
   * 优先匹配本地工具，若未命中则下发至外部 MCP 管理器执行。
   *
   * @param functionName - 要调用的目标工具名称
   * @param functionArgs - 传递给目标工具的动态参数键值对
   * @param timeoutMs - 获得权限后开始计算的工具执行超时
   * @returns 工具执行完毕后返回的序列化/结构化数据
   * @throws 当指定的工具在本地和外部均未找到时，抛出未知工具异常
   */
  public async callTool(
    functionName: string,
    functionArgs: Record<string, unknown>,
    sessionContext?: SessionEventPort & ApprovalPort & CallCapabilityPort & EventNotificationPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    _toolCallId?: string,
    timeoutMs: number = 30000,
  ): Promise<ToolExecutionOutcome<unknown>> {
    // 检查目标工具是否隶属于本地内置集合
    const toolMeta = this.catalog.getToolMetadata(functionName);
    const isLocalTool = toolMeta !== undefined;
    const hasMcp = this.mcpManager !== undefined;

    // 工具完全不存在时直接抛出，不包装为 outcome
    if (!isLocalTool && !hasMcp) {
      throw new Error(`未知的工具名称："${functionName}"`);
    }

    try {
      const mode = sessionContext?.getPermissionMode() ?? 'default';
      const promptAdapter = this.createPromptAdapter(functionName, functionArgs, sessionContext);
      if (isLocalTool) {
        const gatewayResult = await this.gateway.execute(
          functionName,
          functionArgs,
          mode,
          {
            promptAdapter,
            runtime: {
              context: sessionContext,
              signal,
              timeoutMs,
              interactionPort,
            },
          },
        );
        return gatewayResult.outcome;
      } else if (this.mcpManager) {
        const evidence = this.createExternalEvidence(functionName);
        const checker = {
          checkPermissions: (): ToolPermissionCheckResult => evidence.sideEffect === 'read'
            ? { kind: 'allow', decisionReason: '外部工具声明为只读', evidence }
            : {
                kind: 'ask',
                message: `外部工具 "${functionName}" 需要权限确认`,
                decisionReason: evidence.riskReason,
                evidence,
              },
        };
        const gatewayResult = await this.gateway.executeExternal(
          functionName,
          functionArgs,
          mode,
          {
            checker,
            execute: (authorizedArgs, executionSignal) => this.mcpManager!.callMcpTool(
              functionName,
              authorizedArgs,
              executionSignal,
            ),
          },
          { promptAdapter, runtime: { signal, timeoutMs } },
        );
        return gatewayResult.outcome;
      } else {
        throw new Error(`未知的工具名称："${functionName}"`);
      }
    } catch (error: unknown) {
      // 执行超时必须交给编排器统一转换为用户可见的超时阻断事件。
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw error;
      }
      if (error instanceof Error && (
        error.name === 'InteractionRequestError' ||
        error.message.includes('权限拒绝') ||
        error.message.includes('审批拒绝') ||
        error.message.includes('被拒绝') ||
        error.message.includes('找不到提供工具')
      )) {
        throw error; // 交互类或工具找不到异常向上冒泡
      }
      const toolEffect: ToolExecutionEffect = {
        kind: isLocalTool && toolMeta?.securityCategory === 'read' ? 'read' : 'unknown',
        executionStarted: true,
        completed: false,
        resources: [],
        reason: isLocalTool && toolMeta?.securityCategory === 'read' ? 'declared_read_tool' : 'execution_failed_after_start'
      };
      return {
        value: error instanceof Error ? error.message : String(error),
        effect: toolEffect,
        cause: error instanceof Error ? error : undefined
      };
    }
  }

  /** 为当前调用创建只负责 ask 交互的权限提示适配器。 */
  private createPromptAdapter(
    toolName: string,
    args: Record<string, unknown>,
    sessionContext?: SessionEventPort & ApprovalPort & CallCapabilityPort & EventNotificationPort,
  ): PermissionPromptAdapter | undefined {
    if (!sessionContext) {
      return undefined;
    }
    return new PermissionPromptAdapter(
      this.permissionRuleStore,
      async (decision) => {
        const approval = await sessionContext.waitApproval(
          `permission_${Date.now()}_${toolName}`,
          { name: toolName, arguments: args },
          undefined,
          `${decision.message}（${decision.decisionReason}）`,
        );
        return { approved: approval.action === 'approve', scope: 'once' };
      },
    );
  }

  /** 根据外部工具访问声明生成保守权限证据。 */
  private createExternalEvidence(toolName: string): ToolPermissionEvidence {
    const accessMetadata = this.getAccessMetadata(toolName);
    const descriptor = this.mcpManager?.getToolDescriptor(toolName);
    const sideEffect = accessMetadata?.accessMode === 'read'
      ? 'read'
      : accessMetadata?.accessMode === 'write' || descriptor?.annotations?.destructiveHint === true
        ? 'write'
        : 'unknown';
    return {
      operationCategory: 'external-tool-call',
      sideEffect,
      riskReason: sideEffect === 'read'
        ? '外部工具声明为只读'
        : sideEffect === 'write'
          ? '外部工具声明可能产生破坏性写入'
          : '外部工具缺少可自动允许的只读证据',
      resources: [],
    };
  }

  /**
   * 获取本地内置工具的资源提取器注册表只读副本（委托给 ToolAccessMetadataProvider）。
   * 供统一权限服务生成外部工具的结构化资源证据。
   *
   * @returns 工具名 → 资源提取器的 Map
   */
  public getResourceExtractors(): Map<string, ResourceExtractor> {
    return this.metadataProvider.getResourceExtractors();
  }

  /**
   * 根据工具名称获取对应的资源提取器。
   *
   * @param toolName - 工具名称
   * @returns 对应的资源提取器，若未注册则返回 undefined
   */
  public getResourceExtractor(toolName: string): ResourceExtractor | undefined {
    return this.metadataProvider.getResourceExtractor(toolName);
  }

  /**
   * 根据工具名称获取访问元数据声明。
   *
   * @param toolName - 工具名称
   * @returns 对应的访问元数据，若未注册则返回 undefined
   */
  public getAccessMetadata(toolName: string): ToolAccessMetadata | undefined {
    return this.metadataProvider.getAccessMetadata(toolName);
  }

  /**
   * 获取当前注册表私有的权限规则存储，供会话装配和契约测试注入规则。
   *
   * @returns 当前注册表的权限规则存储
   */
  public getPermissionRuleStore(): PermissionRuleStore {
    return this.permissionRuleStore;
  }

  /**
   * 优雅断开并清理工具注册表内管理的所有物理连接（如 MCP 子进程）。
   */
  public async close(): Promise<void> {
    if (this.mcpManager) {
      await this.mcpManager.close();
    }
  }
}
