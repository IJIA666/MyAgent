import { buildNativeTools } from './tool-factory.js';
import type { BuildNativeToolsOptions } from './tool-factory.js';
import { McpToolManager } from './mcp-client.js';
import { ToolCatalog } from './ToolCatalog.js';
import { ToolExecutor } from './ToolExecutor.js';
import { ToolCallGateway } from './ToolCallGateway.js';
import { PermissionSettingsStore } from './PermissionSettingsStore.js';
import { ToolPermissionService } from '../../core/domain/permissions/tool-permission-service.js';
import { PermissionSessionState } from '../../core/domain/permissions/permission-session-state.js';
import { PermissionPromptAdapter } from '../../core/usecases/plugins/PermissionPromptAdapter.js';
import type {
  PermissionUpdate,
  ToolPermissionCheckResult,
} from '../../core/domain/permissions/permission-types.js';
import { getUserPermissionModeLabel } from '../../core/domain/permissions/permission-types.js';
import type {
  PermissionSessionSnapshot,
} from '../../core/domain/permissions/permission-session-state.js';
import { isToolLifecycleError } from '../../core/domain/tool-lifecycle-error.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { ApprovalChoice } from '../../ports/shared/approval-types.js';
import type { EventNotificationPort } from '../../ports/driven/session/EventNotificationPort.js';
import type { ApprovalPort } from '../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';
import type { ToolExecutionLifecycleHooks } from '../../ports/driven/tools/ToolRegistryPort.js';
import type { ToolRegistryPort, ToolMetadata } from '../../ports/driven/tools/ToolRegistryPort.js';
import type { McpManagerPort } from '../../ports/driven/tools/McpManagerPort.js';
import type { ToolExecutionOutcome, ToolExecutionEffect } from './tool-types.js';
import {
  createTrustedCallContext,
  UNTRUSTED_CALLER,
} from '../../core/domain/permissions/trusted-call-context.js';
import type { ApprovalAction } from '../../core/domain/permissions/permission-types.js';
import {
  createMcpPermissionCandidate,
  createMcpToolAuthorizationAdapter,
} from './permissions/mcp-tool-authorization.js';
import {
  configureMemoryAuthorizationRoot,
} from './impl/base.js';

/**
 * 工具注册表管理类。
 * 核心职责：
 * 1. 统管本地内建工具的唯一装配源，通过 buildNativeTools 构造全部本地工具；
 * 2. 集成外部真实 MCP 服务器（McpToolManager）提供的外部工具；
 * 3. 对外提供统一的工具获取（getTools）与工具调用（callTool）接口。
 */
export class ToolRegistry implements ToolRegistryPort {
  // 工具目录管理器（委托 getTools / getTool）
  private catalog: ToolCatalog;
  // 工具执行调度器（委托 callTool）
  private executor: ToolExecutor;
  /** 所有本地工具调用的统一权限网关。 */
  private gateway: ToolCallGateway;
  /** 无会话调用使用的显式受限权限状态。 */
  private readonly restrictedPermissionState: PermissionSessionState;
  /** 已从持久 settings 完成首次解析的会话状态集合。 */
  private readonly initializedPermissionStates = new WeakSet<PermissionSessionState>();
  /** 当前注册表对应的权限服务。 */
  private permissionService: ToolPermissionService;
  /** 可选的权限规则磁盘仓库；测试默认不注入以保持隔离。 */
  private readonly permissionSettingsStore?: PermissionSettingsStore;
  // 可选的外部 MCP 工具管理器实例
  public readonly mcpManager?: McpManagerPort;

  /**
   * 初始化工具注册表。
   *
   * @param mcpManager - 外部的 MCP 工具管理器（可选）
   * @param options - 本地工具装配选项（可选）
   * @param permissionSettingsStore - 可选的权限规则磁盘仓库
   */
  constructor(
    mcpManager?: McpToolManager,
    options?: BuildNativeToolsOptions,
    permissionSettingsStore?: PermissionSettingsStore,
  ) {
    // 注入可选的外部 MCP 工具管理器
    this.mcpManager = mcpManager;
    // 通过唯一装配源构建本地工具列表
    const allTools = buildNativeTools(options);
    // 构建工具目录
    this.catalog = new ToolCatalog(allTools, mcpManager);
    // 构建执行器与权限网关，网关只使用本实例签发的授权上下文。
    this.restrictedPermissionState = new PermissionSessionState();
    this.permissionSettingsStore = permissionSettingsStore;
    this.permissionService = new ToolPermissionService({
      ruleStore: this.restrictedPermissionState.getRuleStore(),
    });
    this.executor = new ToolExecutor(
      this.catalog,
      context => this.permissionService.consumeAuthorizedContext(context),
    );
    this.gateway = new ToolCallGateway(
      this.permissionService,
      this.restrictedPermissionState.getRuleStore(),
      this.executor,
    );
    this.gateway.registerTools(allTools);
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
   * 执行本地工具的候选权限分析，但不进行最终授权或真实执行。
   * 该入口主要供受限后台 Agent 判断 Bash 是否经过正式分析证明为只读。
   *
   * @param name - 本地工具名称
   * @param args - 待分析参数
   * @param permissionState - 当前受限权限状态
   * @returns 工具候选结果；未知、MCP 或无检查器工具返回 undefined
   */
  public async evaluateToolPermissionCandidate(
    name: string,
    args: Record<string, unknown>,
    permissionState: PermissionSessionState,
  ): Promise<ToolPermissionCheckResult | undefined> {
    const tool = this.catalog.getTool(name);
    if (!tool?.checkPermissions) {
      return undefined;
    }
    return await tool.checkPermissions(args, {
      mode: permissionState.getMode(),
      rules: permissionState.getRuleStore(),
    });
  }

  /**
   * 同步 Auto Memory 文件授权根，不改变当前工作区身份。
   *
   * @param memoryDir - 启用时的精确根；undefined 表示关闭
   * @param rootKind - 默认根或受信自定义根
   * @param candidateMemoryDir - 始终受保护的候选仓储所属根
   */
  public configureMemoryAuthorizationRoot(
    memoryDir: string | undefined,
    rootKind: 'default' | 'custom',
    candidateMemoryDir: string,
  ): void {
    configureMemoryAuthorizationRoot(memoryDir, rootKind, candidateMemoryDir);
  }

  /**
   * 获取当前会话权限状态的不可变快照。
   *
   * @param sessionContext - 当前会话上下文
   * @returns 权限状态快照
   */
  public getPermissionSnapshot(
    sessionContext: SessionEventPort,
  ): PermissionSessionSnapshot {
    return sessionContext.getPermissionSessionState!().snapshot();
  }

  /**
   * 使用与审批动作相同的磁盘优先提交语义更新权限状态。
   *
   * @param updates - 待提交更新
   * @param sessionContext - 当前会话上下文
   */
  public async applyPermissionUpdates(
    updates: readonly PermissionUpdate[],
    sessionContext: SessionEventPort,
  ): Promise<void> {
    const state = sessionContext.getPermissionSessionState!();
    const promptAdapter = new PermissionPromptAdapter(
      state,
      undefined,
      this.permissionSettingsStore
        ? persistentUpdates => this.permissionSettingsStore!.persistAll(persistentUpdates)
        : undefined,
    );
    await promptAdapter.applyUpdates(updates);
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
    sessionContext?: SessionEventPort & ApprovalPort & EventNotificationPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string,
    timeoutMs: number = 30000,
    lifecycleHooks?: ToolExecutionLifecycleHooks,
  ): Promise<ToolExecutionOutcome<unknown>> {
    // 检查目标工具是否隶属于本地内置集合
    const localTool = this.catalog.getTool(functionName);
    const toolMeta = this.catalog.getToolMetadata(functionName);
    // 元数据同时覆盖 MCP 工具，因此必须用本地实例判断 Gateway 分流，避免把 MCP 当成本地工具执行。
    const isLocalTool = localTool !== undefined;
    const hasMcp = this.mcpManager !== undefined;

    // 工具完全不存在时直接抛出，不包装为 outcome
    if (!isLocalTool && !hasMcp) {
      throw new Error(`未知的工具名称："${functionName}"`);
    }

    try {
      const securityContext = lifecycleHooks?.securityContext;
      const permissionState = securityContext?.permissionState
        ?? this.resolvePermissionState(sessionContext);
      const mode = permissionState.getMode();
      const caller = securityContext?.caller
        ?? (sessionContext
          ? createTrustedCallContext(sessionContext.getSessionId(), 'interactive')
          : UNTRUSTED_CALLER);
      const promptAdapter = securityContext && !securityContext.approvalAllowed
        ? undefined
        : this.createPromptAdapter(
          functionName,
          functionArgs,
          permissionState,
          sessionContext,
          securityContext ? (securityContext.approvalPort ?? null) : sessionContext,
        );
      if (isLocalTool) {
        const gatewayResult = await this.gateway.execute(
          functionName,
          functionArgs,
          mode,
          {
            promptAdapter,
            permissionState,
            caller,
            runtime: {
              sessionId: sessionContext?.getSessionId(),
              correlationId: toolCallId,
              context: sessionContext,
              signal,
              timeoutMs: lifecycleHooks?.timeoutPolicy === 'parent-signal'
                ? undefined
                : timeoutMs ?? 30000,
              interactionPort,
              prepareExecution: lifecycleHooks?.prepareExecution,
              getPermissionStateVersion: () => permissionState.getStateVersion(),
              auditSource: securityContext?.auditSource,
              caller,
              approvalPort: securityContext
                ? (securityContext.approvalPort ?? null)
                : undefined,
            },
          },
        );
        return gatewayResult.outcome;
      } else if (this.mcpManager) {
        // 子代理专属 MCP 工具优先经作用域 descriptor 与路由执行（内联 owned / 引用 borrowed）。
        const agentScope = securityContext?.agentMcpScope;
        const scopeDescriptor = agentScope?.getToolDescriptor(functionName);
        const descriptor = scopeDescriptor ?? this.mcpManager.getToolDescriptor(functionName);
        if (!descriptor) {
          throw new Error(`MCP 工具 "${functionName}" 缺少当前 descriptor，拒绝授权`);
        }
        const authorizationAdapter = createMcpToolAuthorizationAdapter(descriptor);
        const checker = {
          checkPermissions: () => createMcpPermissionCandidate(descriptor),
        };
        const gatewayResult = await this.gateway.executeExternal(
          functionName,
          functionArgs,
          mode,
          {
            authorizationAdapter,
            checker,
            getCurrentDescriptorVersion: () =>
              (agentScope?.getToolDescriptor(functionName) ?? this.mcpManager?.getToolDescriptor(functionName))
                ?.descriptorVersion,
            execute: (authorizedArgs, executionSignal) => {
              const scopeDescriptorNow = agentScope?.getToolDescriptor(functionName);
              if (scopeDescriptorNow && agentScope) {
                // 作用域路由：内联默认断开清理（owned）、引用永不销毁物理连接（borrowed 由作用域内部保证）。
                return agentScope.callTool(
                  functionName,
                  authorizedArgs,
                  {
                    serverName: scopeDescriptorNow.serverName,
                    descriptorVersion: scopeDescriptorNow.descriptorVersion,
                  },
                  executionSignal,
                );
              }
              return this.mcpManager!.callMcpTool(
                functionName,
                authorizedArgs,
                {
                  serverName: descriptor.serverName,
                  descriptorVersion: descriptor.descriptorVersion,
                },
                executionSignal,
              );
            },
          },
          {
            promptAdapter,
            permissionState,
            caller,
            runtime: {
              sessionId: sessionContext?.getSessionId(),
              correlationId: toolCallId,
              signal,
              timeoutMs: lifecycleHooks?.timeoutPolicy === 'parent-signal'
                ? undefined
                : timeoutMs ?? 30000,
              prepareExecution: lifecycleHooks?.prepareExecution,
              getPermissionStateVersion: () => permissionState.getStateVersion(),
              auditSource: securityContext?.auditSource,
              caller,
              approvalPort: securityContext
                ? (securityContext.approvalPort ?? null)
                : undefined,
            },
          },
        );
        return gatewayResult.outcome;
      } else {
        throw new Error(`未知的工具名称："${functionName}"`);
      }
    } catch (error: unknown) {
      if (isToolLifecycleError(error)) {
        throw error;
      }
      // 执行超时必须交给编排器统一转换为用户可见的超时阻断事件。
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw error;
      }
      if (error instanceof Error && (
        error.name === 'InteractionRequestError' ||
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
    permissionState: PermissionSessionState,
    sessionContext?: SessionEventPort & ApprovalPort & EventNotificationPort,
    approvalPort?: ApprovalPort | null,
  ): PermissionPromptAdapter | undefined {
    const promptPort = approvalPort === null ? undefined : approvalPort ?? sessionContext;
    if (!promptPort) {
      return undefined;
    }
    const promptAdapter = new PermissionPromptAdapter(
      permissionState,
      async (decision, _mode, signal, actions) => {
        // 使用工具适配器提供的 ApprovalAction 构建选择项
        const choices: ApprovalChoice[] = (actions ?? []).map(renderApprovalActionChoice);

        // 工具没有提供正式动作时只允许单次放行或拒绝，禁止从参数猜测持久规则。
        if (choices.length === 0) {
          choices.push(
            { choiceId: 'allowOnce', label: '单次放行 (Allow Once)', description: '只允许当前这一次调用' },
          );
          choices.push(
            { choiceId: 'deny', label: '拒绝执行 (Deny)', description: '拒绝当前调用' },
          );
        }

        const approval = await promptPort.waitApproval(
          `permission_${Date.now()}_${toolName}`,
          { name: toolName, arguments: args },
          { signal, choices },
          `${decision.message}（${decision.decisionReason}）`,
        );
        return {
          approved: approval.action !== 'deny',
          actionId: isApprovalActionId(approval.action) ? approval.action : undefined,
        };
      },
      async updates => {
        if (!this.permissionSettingsStore) {
          throw new Error('当前运行时没有配置权限设置仓库');
        }
        await this.permissionSettingsStore.persistAll(updates);
      },
    );
    return promptAdapter;
  }

  /** 解析调用所属的会话状态，并在首次使用时加载持久规则。 */
  private resolvePermissionState(
    sessionContext?: SessionEventPort,
  ): PermissionSessionState {
    const state = sessionContext?.getPermissionSessionState?.()
      ?? this.restrictedPermissionState;
    if (state !== this.restrictedPermissionState && !this.initializedPermissionStates.has(state)) {
      this.permissionSettingsStore?.loadInto(state);
      this.initializedPermissionStates.add(state);
    }
    return state;
  }

  /**
   * 优雅断开并清理工具注册表内管理的所有物理连接（如 MCP 子进程）。
   */
  public async close(): Promise<void> {
    // 清理仅供无会话调用使用的受限状态，真实会话状态由 SessionContext 生命周期持有。
    this.restrictedPermissionState.getRuleStore().clearSessionRules();
    if (this.mcpManager) {
      await this.mcpManager.close();
    }
  }
}

/** 校验审批端口返回的是工具适配器定义的稳定 action id。 */
function isApprovalActionId(value: string): value is ApprovalAction['type'] {
  return value === 'allowOnce'
    || value === 'allowAndAddRules'
    || value === 'allowAndSetMode'
    || value === 'allowAndAddDirectories'
    || value === 'allowAndSetModeWithDirectories'
    || value === 'deny';
}

/**
 * 将正式审批动作渲染为用户可见选择项。
 * 模式必须使用产品标签，目录扩权必须显示真实目录范围。
 *
 * @param action - 工具适配器提供的正式动作
 * @returns 审批端口可展示的选择项
 */
export function renderApprovalActionChoice(action: ApprovalAction): ApprovalChoice {
  switch (action.type) {
    case 'allowOnce':
      return {
        choiceId: 'allowOnce',
        label: '单次放行 (Allow Once)',
        description: '只允许当前这一次调用',
      };
    case 'allowAndAddRules':
      return {
        choiceId: 'allowAndAddRules',
        label: '允许，并在本会话中不再询问',
        description: `允许本次调用，并在当前会话放行：${action.rules
          .map(rule => `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent ?? '*'})`)
          .join(', ')}`,
      };
    case 'allowAndSetMode':
      return {
        choiceId: 'allowAndSetMode',
        label: '允许并开启 Accept edits on',
        description: `允许本次调用并将当前会话切换为 ${getUserPermissionModeLabel(action.mode)}`,
      };
    case 'allowAndAddDirectories':
      return {
        choiceId: 'allowAndAddDirectories',
        label: '允许并添加目录',
        description: `允许本次调用并添加目录：${action.directories.join(', ')}`,
      };
    case 'allowAndSetModeWithDirectories':
      return {
        choiceId: 'allowAndSetModeWithDirectories',
        label: '在此目录开启 Accept edits on',
        description: `允许本次调用、切换为 ${getUserPermissionModeLabel(action.mode)}，并授权目录：${action.directories.join(', ')}`,
      };
    case 'deny':
      return {
        choiceId: 'deny',
        label: '拒绝执行 (Deny)',
        description: '拒绝当前调用',
      };
  }
}
