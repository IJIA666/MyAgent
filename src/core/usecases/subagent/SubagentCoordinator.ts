import { randomUUID } from 'node:crypto';
import type { AppConfig, LlmConfig } from '../../../config/index.js';
import { getModelConfig } from '../../../config/models.js';
import { getRuntimeEnv } from '../../../config/env.js';
import type { McpServerEntry } from '../../../config/types.js';
import type {
  SubagentExecutionPort,
  SubagentExecutionRequest,
  SubagentExecutionResult,
  SubagentParentSession,
} from '../../../ports/driving/SubagentExecutionPort.js';
import { SUBAGENT_ERROR_CODES } from '../../../ports/driving/SubagentExecutionPort.js';
import type { ApprovalPort } from '../../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../../ports/driven/session/InteractionPort.js';
import type { ModelRequestSnapshot } from '../../../ports/driven/llm/LlmPort.js';
import type { SubagentTranscriptStore } from './SubagentTranscriptStore.js';
import { snapshotLlmConfig } from './llm-config-snapshot.js';
import { SubagentDefinitionRegistry, type SubagentDefinition } from './SubagentDefinitionRegistry.js';
import { ApprovalRouter } from './ApprovalRouter.js';
import { ChildPermissionResolver } from './ChildPermissionResolver.js';
import { compileDefinitionToolVisibility } from './ScopedToolRegistry.js';
import { resolveSubagentModel } from './resolve-subagent-model.js';
import type { AgentMcpDeclaration } from '../../../ports/driven/tools/McpManagerPort.js';
import { SubagentRuntime, type SubagentRuntimeTaskResult } from './SubagentRuntime.js';
import { TaskManager, type TaskCancelResult } from './TaskManager.js';
import { TaskStateStore } from './TaskStateStore.js';
import { enqueueAgentNotification } from './task-notification.js';
import { isTaskDescription, isTerminalTaskStatus, type TaskStateRecord, type TerminalTaskStatus } from './task-state.js';
import { PermissionSessionState } from '../../domain/permissions/permission-session-state.js';
import {
  createChildTrustedCallContext,
  createTrustedCallContext,
} from '../../domain/permissions/trusted-call-context.js';

/** CLI 查询任务详情时可见的低敏结果。 */
export interface SubagentTaskDetail {
  /** 任务安全索引。 */
  readonly task: TaskStateRecord;
  /** 已扫描的交付文本。 */
  readonly result?: string;
  /** 低敏错误摘要。 */
  readonly error?: string;
}

/**
 * 子代理生命周期协调器。
 * 它把 Agent 端口、exact-fork 解析、冻结运行输入、任务管理和父会话通知连接起来，
 * 运行器本身仍只负责一次隔离 AgentLoop。
 */
export class SubagentCoordinator implements SubagentExecutionPort {
  /** 解析内置与自定义定义。 */
  private readonly definitions: SubagentDefinitionRegistry;
  /** 提交点权限收窄服务（仅允许 plan 或保持父模式）。 */
  private readonly permissionResolver = new ChildPermissionResolver();
  /** 已提交任务到父会话能力视图的绑定。 */
  private readonly parentSessions = new Map<string, SubagentParentSession>();
  /** 关闭后拒绝新的 Agent 和 CLI 任务。 */
  private closed = false;

  /**
   * @param options - 运行器、任务管理器、模型配置和 fork 开关
   */
  constructor(private readonly options: {
    readonly runtime: SubagentRuntime;
    readonly taskManager: TaskManager;
    readonly taskStateStore: TaskStateStore;
    readonly transcriptStore?: SubagentTranscriptStore;
    readonly appConfig: AppConfig;
    readonly llmConfigProvider: () => LlmConfig;
    readonly forkEnabled?: boolean;
    readonly definitionRegistry?: SubagentDefinitionRegistry;
    /** 由 SessionManager 注入的任务状态观察回调，负责向 CLI 转发非终结 task_update 事件。 */
    readonly onTaskStateChange?: (record: TaskStateRecord) => void | Promise<void>;
  }) {
    this.definitions = options.definitionRegistry
      ?? new SubagentDefinitionRegistry(options.forkEnabled ?? false);
    options.taskManager.setHooks({
      onStateChange: record => this.handleStateChange(record),
      onTerminal: (record, result) => this.handleTerminal(record, result),
    });
  }

  /**
   * 处理 Agent 工具请求；前台仍等待终态，后台和 fork 返回接受态。
   *
   * @param request - 父会话捕获的 Agent 请求
   * @returns Agent 工具可直接序列化的结果
   */
  public async execute(request: SubagentExecutionRequest): Promise<SubagentExecutionResult> {
    return this.submitRequest(request, false);
  }

  /**
   * 从空闲且协议闭合的父会话启动后台 exact-fork。
   *
   * @param prompt - 子任务正文
   * @param description - 3-5 词任务摘要
   * @param parentSession - 父会话能力视图
   * @param parentApprovalPort - 父审批展示端口
   * @param interactionPort - 父交互端口
   * @returns 后台接受态或稳定错误
   */
  public async startForkedTask(
    prompt: string,
    description: string,
    parentSession: SubagentParentSession,
    parentApprovalPort?: ApprovalPort,
    interactionPort?: InteractionPort,
  ): Promise<SubagentExecutionResult> {
    if (parentSession.isGenerating?.()) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.sessionBusy,
        message: '当前会话正在生成，暂不能创建 exact-fork 任务',
      };
    }
    if (parentSession.hasPendingInteraction?.()) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.sessionBusy,
        message: '当前会话正在等待用户交互，暂不能创建 exact-fork 任务',
      };
    }
    if (parentSession.isMessageProtocolClosed?.() === false) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.protocolNotClosed,
        message: '当前会话存在未闭合的工具调用，暂不能创建 exact-fork 任务',
      };
    }
    const snapshot = parentSession.getLatestModelRequestSnapshot?.();
    if (!snapshot) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.forkContextUnavailable,
        message: '当前会话尚未产生可用的最终模型请求快照',
      };
    }
    const parentCaller = createTrustedCallContext(
      parentSession.getSessionId(),
      'interactive',
      '1.0.0',
      'agent',
    );
    return this.submitRequest({
      prompt,
      description,
      subagentType: undefined,
      runInBackground: true,
      parentSession,
      parentApprovalPort,
      interactionPort,
      parentCaller,
      requestSnapshot: snapshot,
    }, true);
  }

  /** 返回当前父会话任务列表。 */
  public async listTasks(): Promise<readonly TaskStateRecord[]> {
    return this.options.taskManager.list();
  }

  /** 返回不包含 transcript 原始消息的低敏任务详情。 */
  public async getTaskDetail(agentId: string): Promise<SubagentTaskDetail | undefined> {
    const task = await this.options.taskManager.get(agentId);
    if (!task) {
      return undefined;
    }
    const transcript = await this.options.transcriptStore?.read(task.parentSessionId, agentId);
    return {
      task,
      ...(transcript?.deliveredOutput ? { result: transcript.deliveredOutput } : {}),
      ...(task.errorSummary || transcript?.errorSummary
        ? { error: task.errorSummary ?? transcript?.errorSummary }
        : {}),
    };
  }

  /** 取消指定任务或全部任务，始终复用统一任务管理器。 */
  public async cancelTask(agentId: string | 'all'): Promise<TaskCancelResult | readonly TaskCancelResult[]> {
    if (agentId === 'all') {
      const tasks = await this.options.taskManager.list();
      return Promise.all(tasks
        .filter(task => !isTerminalStatus(task.status))
        .map(task => this.options.taskManager.cancel(task.agentId)));
    }
    return this.options.taskManager.cancel(agentId);
  }

  /** 普通父会话 abort 只取消尚未后台化的前台任务。 */
  public cancelForeground(_reason = 'Session aborted'): void {
    void this.options.taskManager.cancelForeground();
  }

  /** 会话关闭时有界取消全部后台与前台任务。 */
  public async closeAll(timeoutMs: number): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.options.taskManager.close(timeoutMs);
    this.parentSessions.clear();
  }

  /**
   * 会话恢复后重新绑定任务索引，避免旧父 session 的任务混入当前控制面。
   *
   * @param sessionId - 恢复后的父会话 ID
   */
  public async updateSessionId(sessionId: string): Promise<void> {
    if (this.closed) {
      throw new Error('子代理协调器已关闭，不能重新绑定会话');
    }
    // 先解除通知路由，再取消旧任务，避免恢复期间把取消结果写回旧父会话。
    this.parentSessions.clear();
    await this.options.taskManager.rebindSession(sessionId);
    this.parentSessions.clear();
  }

  /** 让状态更新以非终结 task_update 形式到达 CLI（经 SessionManager 回调转发）。 */
  private async handleStateChange(record: TaskStateRecord): Promise<void> {
    if (this.options.onTaskStateChange) {
      await this.options.onTaskStateChange(record);
      return;
    }
    // 未注入回调（测试替身）时直接向父会话发出非终结事件，保持向后兼容。
    const parent = this.parentSessions.get(record.agentId);
    parent?.emit('agent_event', {
      type: 'task_update',
      agentId: record.agentId,
      description: record.description,
      subagentType: record.agentType,
      contextPolicy: record.contextPolicy,
      status: record.status,
      time: record.updatedAt,
    });
  }

  /** 先更新 transcript，再单次通知后台终态，最后释放父会话绑定。 */
  private async handleTerminal(record: TaskStateRecord, result: SubagentRuntimeTaskResult): Promise<void> {
    if (isTerminalStatus(record.status)) {
      await this.options.transcriptStore?.updateStatus(
        record.parentSessionId,
        record.agentId,
        record.status,
        record.errorSummary,
      );
    }
    const parent = this.parentSessions.get(record.agentId);
    if (parent && record.mode === 'background' && !this.closed) {
      try {
        enqueueAgentNotification(parent, record, result);
        await this.options.taskStateStore.markNotified(record.agentId);
      } catch {
        // 通知失败时不标记 notified，允许后续控制面再次观察并补偿。
      }
    }
    this.parentSessions.delete(record.agentId);
  }

  /** 执行一次请求解析、输入冻结和任务登记。 */
  private async submitRequest(
    request: SubagentExecutionRequest,
    forceExactFork: boolean,
  ): Promise<SubagentExecutionResult> {
    if (this.closed) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.sessionClosed,
        message: '当前会话已关闭，不再接受子代理任务',
      };
    }
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.invalidPrompt,
        message: 'Agent.prompt 必须是非空字符串',
      };
    }
    if (!isTaskDescription(request.description)) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.invalidDescription,
        message: 'Agent.description 必须是 3-5 个词的非空字符串',
      };
    }
    // caller depth 检查必须发生在快照、权限和任务文件创建之前。
    if (request.parentCaller?.caller.audience === 'subagent') {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.nestedCall,
        message: '不允许子代理继续创建子代理',
      };
    }
    const definition = forceExactFork
      ? exactForkDefinition()
      : this.definitions.resolve(request.subagentType);
    if (!definition) {
      // 生产路径错误必须携带全部已注册类型清单，供模型修正 subagent_type。
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.unknownType,
        message: `未知的子代理类型: ${request.subagentType ?? ''}。可用类型: ${this.definitions.list().map(item => item.type).join(', ')}`,
      };
    }
    const snapshot = definition.contextPolicy === 'exact-fork'
      ? request.requestSnapshot ?? request.parentSession.getLatestModelRequestSnapshot?.()
      : undefined;
    if (definition.contextPolicy === 'exact-fork' && !snapshot) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.forkContextUnavailable,
        message: 'exact-fork 缺少父会话最终请求快照',
      };
    }

    // exact-fork（含模型省略类型隐式 fork）语义下模型始终继承提交点父配置
    // （冻结快照字节一致），env、工具参数与定义 model 一律忽略。
    const modelResolution = definition.contextPolicy === 'exact-fork'
      ? { ok: true as const, resolved: { kind: 'inherit' as const } }
      : resolveSubagentModel(getRuntimeEnv().MYAGENT_SUBAGENT_MODEL, request.model, definition.model);
    if (!modelResolution.ok) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.invalidModel,
        message: modelResolution.error,
      };
    }
    let frozenConfig: LlmConfig;
    try {
      // profile ID 用完整模型档案构造冻结配置（禁止 AGENT_LLM_MODEL 环境覆盖，
      // 避免显式指定 flash 实际却运行 pro 的静默漂移）；inherit 沿用提交点父配置。
      frozenConfig = modelResolution.resolved.kind === 'inherit'
        ? snapshotLlmConfig(this.options.llmConfigProvider())
        : getModelConfig(modelResolution.resolved.profileId, { allowEnvModelOverride: false });
    } catch {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.executionFailed,
        message: '子代理模型配置不可用',
      };
    }
    // 配置、权限和循环上限都在提交点冻结，排队期间不读取父会话的后续变化。
    const parentPermissionSnapshot = request.parentSession.getPermissionSessionState?.()?.snapshot()
      ?? new PermissionSessionState().snapshot();
    // 定义级 permissionMode 在提交点收窄（仅允许 plan 或保持父模式），派生快照再冻结。
    const frozenPermissionSnapshot = definition.permissionMode
      ? this.permissionResolver.derive(parentPermissionSnapshot, definition.permissionMode).snapshot()
      : parentPermissionSnapshot;
    const frozenMaxIterations = definition.maxTurns ?? this.options.appConfig.runtimeLimits.maxIterations;
    const frozenRequestSnapshot = snapshot ? cloneModelRequestSnapshot(snapshot) : undefined;
    const agentId = randomUUID();
    const parentCaller = request.parentCaller
      ?? createTrustedCallContext(request.parentSession.getSessionId(), 'interactive', '1.0.0', 'agent');
    const childCaller = createChildTrustedCallContext(
      parentCaller,
      `subagent:${agentId}`,
      'script',
    );
    const background = forceExactFork || this.options.forkEnabled === true || request.runInBackground === true;
    this.parentSessions.set(agentId, request.parentSession);
    try {
      const submission = await this.options.taskManager.submit({
        agentId,
        description: request.description.trim(),
        agentType: definition.type,
        contextPolicy: definition.contextPolicy,
        mode: background ? 'background' : 'foreground',
        parentSignal: request.signal,
        execute: signal => {
          const approvalRouter = new ApprovalRouter(
            request.parentApprovalPort,
            this.options.taskManager,
            agentId,
            request.parentSession.getSessionId(),
            signal,
          );
          return this.options.runtime.runTask({
            agentId,
            agentType: definition.type,
            contextPolicy: definition.contextPolicy,
            prompt: request.prompt,
            requestSnapshot: frozenRequestSnapshot,
            currentAssistantMessage: definition.contextPolicy === 'exact-fork'
              ? request.currentAssistantMessage
              : undefined,
            fixedToolNames: definition.contextPolicy === 'exact-fork'
              ? extractToolNames(frozenRequestSnapshot)
              : undefined,
            llmConfig: frozenConfig,
            permissionSnapshot: frozenPermissionSnapshot,
            caller: childCaller,
            parentApprovalPort: approvalRouter,
            interactionPort: request.interactionPort,
            signal,
            toolPolicyKey: background && definition.contextPolicy === 'fresh'
              ? 'freshBackground'
              : definition.toolPolicyKey,
            // 定义级工具池在提交点编译为可见性谓词，运行器构造作用域时与默认策略取交集。
            definitionToolVisibility: compileDefinitionToolVisibility(definition.tools, definition.disallowedTools),
            // 自定义正文在运行器创建子上下文后组装进 system（exact-fork 冻结父 system 不适用）。
            definitionSystemPromptBuilder: definition.contextPolicy === 'fresh'
              ? definition.buildSystemPrompt
              : undefined,
            // omitClaudeMd 透传运行器，控制 RuleManager 是否加载 CLAUDE.md 规则。
            omitClaudeMd: definition.omitClaudeMd,
            // 定义级 MCP 声明在提交点归一化透传（仅 fresh 消费；exact-fork 冻结父快照不适用）。
            agentMcpDeclarations: definition.contextPolicy === 'fresh' && definition.mcpServers
              ? normalizeMcpDeclarations(definition.mcpServers)
              : undefined,
            maxIterations: frozenMaxIterations,
            persistTranscript: true,
            enableDefaultSafetyPlugins: true,
          });
        },
      });
      if (submission.kind === 'error') {
        this.parentSessions.delete(agentId);
        return { status: 'error', code: submission.code, message: submission.message };
      }
      if (submission.kind === 'async_launched') {
        return {
          status: 'async_launched',
          agentId: submission.agentId,
          description: submission.description,
        };
      }
      return toExecutionResult(submission.result);
    } catch {
      this.parentSessions.delete(agentId);
      return {
        status: 'error',
        agentId,
        code: SUBAGENT_ERROR_CODES.executionFailed,
        message: '子代理任务登记失败',
      };
    }
  }
}

/** 构造不依赖运行时配置的 exact-fork 定义。 */
function exactForkDefinition(): SubagentDefinition {
  return {
    type: 'exact-fork',
    description: '在当前会话快照中后台执行任务的 exact-fork 子代理。',
    contextPolicy: 'exact-fork',
    toolPolicyKey: 'fork',
    buildSystemPrompt: context => context.getHistory()[0]?.content?.toString() ?? '',
  };
}

/** 将运行器结果映射成 Agent 端口的前台协议。 */
function toExecutionResult(result: SubagentRuntimeTaskResult): SubagentExecutionResult {
  if (result.status === 'completed' && result.output !== undefined) {
    return { status: 'completed', agentId: result.agentId, output: result.output };
  }
  if (result.status === 'cancelled') {
    return { status: 'cancelled', agentId: result.agentId };
  }
  return {
    status: 'error',
    agentId: result.agentId,
    code: result.errorCode ?? SUBAGENT_ERROR_CODES.executionFailed,
    message: result.errorMessage ?? '子代理执行失败',
  };
}

/** 任务列表只允许把终态用于终态操作。 */
function isTerminalStatus(status: TaskStateRecord['status']): status is TerminalTaskStatus {
  return isTerminalTaskStatus(status);
}

/** 将定义级 mcpServers 归一化为引用/内联声明结构。 */
function normalizeMcpDeclarations(
  specs: readonly (string | { readonly name: string; readonly config: McpServerEntry })[],
): AgentMcpDeclaration {
  const references: string[] = [];
  const inline: Array<{ name: string; config: McpServerEntry }> = [];
  for (const spec of specs) {
    if (typeof spec === 'string') {
      references.push(spec);
    } else {
      inline.push(spec);
    }
  }
  return {
    references: Object.freeze(references),
    inline: Object.freeze(inline),
  };
}

/** 从冻结快照提取工具名集合，用于收束 fork 工具作用域到提交点。 */
function extractToolNames(snapshot: ModelRequestSnapshot | undefined): ReadonlySet<string> | undefined {
  if (!snapshot) {
    return undefined;
  }
  return new Set(
    snapshot.tools
      .map(tool => {
        if (typeof tool === 'object' && tool !== null) {
          const record = tool as Record<string, unknown>;
          if (typeof record.name === 'string') {
            return record.name;
          }
          const nested = record.function as Record<string, unknown> | undefined;
          if (nested && typeof nested.name === 'string') {
            return nested.name;
          }
        }
        return undefined;
      })
      .filter((name): name is string => name !== undefined),
  );
}

/** 深复制 exact-fork 请求快照，隔离排队期间父上下文的可变引用。 */
function cloneModelRequestSnapshot(snapshot: ModelRequestSnapshot): ModelRequestSnapshot {
  return {
    model: snapshot.model,
    messages: snapshot.messages.map(message => ({
      ...message,
      ...(message.tool_calls ? {
        tool_calls: message.tool_calls.map(call => ({
          ...call,
          function: { ...call.function },
        })),
      } : {}),
    })),
    tools: snapshot.tools.map(tool => structuredClone(tool)),
  };
}
