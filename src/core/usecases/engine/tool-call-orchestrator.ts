import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { runHookPipeline } from '../plugins/plugin-runner.js';
import { HookEventName } from '../plugins/plugin-types.js';
import { FileLockManager } from '../security/FileLockManager.js';
import { FileBackupManager } from '../security/FileBackupManager.js';
import { InteractionRequestError, type InteractionPort } from '../../../ports/driven/session/InteractionPort.js';
import type { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import type { SessionContext, StoredChatMessage } from '../../domain/context.js';
import type { PluginRegistry } from '../plugins/plugin-registry.js';
import type { AgentEvent } from './agent-loop.js';
import type { ToolExecutionEffect } from '../../../adapters/tools/tool-types.js';
import { deriveDefaultToolExecutionEffect } from '../../../adapters/tools/tool-types.js';
import { logger, LOG_COMPONENT, LOG_EVENT } from '../../../utils/logger.js';
import {
  serializeToolOutcomeForModel,
  ToolDispatcher,
} from './ToolDispatcher.js';
import { ToolLifecycleError, isToolLifecycleError } from '../../domain/tool-lifecycle-error.js';

/**
 * 单次工具调用执行的结果载体。
 */
export interface ToolExecutionResult {
  /** 工具在并发数组中的原始索引 */
  index: number;
  /** 工具执行期间产生的事件列表（不含通过 emitEvent 实时广播的 suspend 事件） */
  events: AgentEvent[];
  /** 执行完毕后需追加到消息历史的工具回执消息 */
  toolMessage?: StoredChatMessage;
  /** 本次工具调用的实际副作用（废弃 hasWrite，改用 effect），向下兼容保留旧字段供过渡 */
  hasWrite: boolean;
  /** 本次工具调用的实际副作用 */
  effect: ToolExecutionEffect;
  /** 最终的工具调用更新（error 或 result），携带 outcome 包装 */
  finalCallUpdate: {
    error?: string;
    result?: string;
  };
  /** 是否因 InteractionRequestError 挂起等待人机交互 */
  interrupted: boolean;
  /** 是否由用户在执行前明确拒绝审批。 */
  userDenied: boolean;
  /** 是否因插件 abort 而被阻断 */
  aborted: boolean;
  /** abort 阻断的原因说明 */
  abortReason?: string;
}

/** 工具调用原始描述符（来自 LLM 响应） */
export interface ToolCallDescriptor {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 工具调用编排协作者。
 *
 * 封装单次工具调用的完整生命周期：参数解析 → BeforeTool 管线 →
 * 文件锁/备份 → 实际执行 → AfterTool 管线 → tail call 级联 → capability 消费 → 错误恢复。
 *
 * 当前仅支持一级 tail call 级联（即 AfterTool 插件注入的单个 `tailToolCallRequest`）。
 * 若未来需要多级 tail call，需在 `execute()` 内部改为循环。
 */
export class ToolCallOrchestrator {
  private toolRegistry: ToolRegistryPort;
  private toolDispatcher: ToolDispatcher;
  private pluginRegistry: PluginRegistry;
  private context: SessionContext;
  private interactionPort?: InteractionPort;

  /**
   * @param toolRegistry - 工具注册端口，用于获取工具元数据与执行工具
   * @param toolDispatcher - 工具调度器，用于大输出截断与 JIT 规则注入
   * @param pluginRegistry - 插件注册管理器，用于获取 BeforeTool/AfterTool 管线插件
   * @param context - 当前会话上下文
   * @param interactionPort - 可选的人机对话交互端口
   */
  constructor(
    toolRegistry: ToolRegistryPort,
    toolDispatcher: ToolDispatcher,
    pluginRegistry: PluginRegistry,
    context: SessionContext,
    interactionPort?: InteractionPort
  ) {
    this.toolRegistry = toolRegistry;
    this.toolDispatcher = toolDispatcher;
    this.pluginRegistry = pluginRegistry;
    this.context = context;
    this.interactionPort = interactionPort;
  }

  /**
   * 更新协作者持有的人机交互端口。
   *
   * AgentLoop 在构造阶段尚未拿到 CLI 层回注的 InteractionPort，
   * 需要在 SessionManager 完成后置注入时同步更新此协作者，避免继续持有过期引用。
   *
   * @param interactionPort - 最新的人机交互端口
   */
  public setInteractionPort(interactionPort: InteractionPort | undefined): void {
    this.interactionPort = interactionPort;
  }

  /**
   * 执行单次工具调用（含可能的 tail call 级联）。
   *
   * @param index - 工具在并发数组中的原始索引，用于结果排序
   * @param toolCall - LLM 返回的工具调用描述符
   * @param signal - 上游主动取消信号；执行超时由 Gateway 在审批完成后启动
   * @param pushSuspendEvent - 实时广播 suspend 事件的回调（由 AgentLoop 的事件队列桥接）
   * @returns 工具执行结果，包含事件列表、工具消息、写操作标记等
   */
  public async execute(
    index: number,
    toolCall: ToolCallDescriptor,
    signal: AbortSignal,
    pushSuspendEvent: (evt: AgentEvent) => void
  ): Promise<ToolExecutionResult> {
    const functionName = toolCall.function.name;
    const taskEvents: AgentEvent[] = [];
    const taskFinalCallUpdate: { error?: string; result?: string } = {};
    let hasWrite = false;
    let toolMessage: StoredChatMessage | undefined;
    let userDenied = false;
    let executionStarted = false;
    let toolSecurityCategory: 'read' | 'write' = 'read';
    let resolvedEffect: ToolExecutionEffect = {
      kind: 'none',
      executionStarted: false,
      completed: false,
      resources: [],
      reason: 'no_execution'
    };

    /**
     * 区分对待事件类型：suspend 挂起审批事件实时通过回调广播给外层 UI 确权以防死锁；
     * 其它事件暂存做顺序渲染。
     */
    const taskEmitEvent = (evt: unknown) => {
      const agentEvt = evt as AgentEvent;
      if (agentEvt.type === 'suspend') {
        pushSuspendEvent(agentEvt);
      } else {
        taskEvents.push(agentEvt);
      }
    };

    let functionArgs: Record<string, unknown>;
    try {
      functionArgs = JSON.parse(toolCall.function.arguments);
    } catch (parseError: unknown) {
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      taskFinalCallUpdate.error = `解析参数失败：${errorMsg}`;
      taskEvents.push({ type: 'error', message: `解析工具参数失败：${errorMsg}`, cause: parseError });
      const noExecEffect = deriveDefaultToolExecutionEffect(toolSecurityCategory, false, false);
      return {
        index,
        events: taskEvents,
        hasWrite,
        effect: noExecEffect,
        finalCallUpdate: taskFinalCallUpdate,
        interrupted: false,
        userDenied: false,
        aborted: false
      };
    }

    const toolMeta = this.toolRegistry.getTool(functionName);
    const isHumanInterruption = toolMeta?.executionMode === 'human_interruption';

    try {
      if (signal.aborted) {
        throw createCancellationError(signal, 'authorization', false);
      }

      // BeforeTool 管线
      const beforeToolResult = await runHookPipeline(
        HookEventName.BeforeTool,
        this.context,
        this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeTool),
        {
          toolCall: { id: toolCall.id, name: functionName, arguments: functionArgs },
          emitEvent: taskEmitEvent,
          toolRegistry: this.toolRegistry
        }
      );

      if (beforeToolResult.control.action === 'abort') {
        const toolResult = `错误：工具调用被插件拦截：${beforeToolResult.control.reason ?? '安全策略限制'}`;
        taskFinalCallUpdate.error = beforeToolResult.control.reason ?? '安全策略限制';
        taskEvents.push({ type: 'error', message: `[插件拦截] 工具调用被拦截阻断：${beforeToolResult.control.reason ?? '策略安全限制'}` });
        taskEvents.push({
          type: 'tool_call_result',
          functionName,
          result: toolResult,
          status: 'error',
        });
        toolMessage = {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
          isError: true,
        };
        const abortEffect: ToolExecutionEffect = {
          kind: 'none',
          executionStarted: false,
          completed: false,
          resources: [],
          reason: 'pre_execution_abort'
        };
        return {
          index,
          events: taskEvents,
          toolMessage,
          hasWrite,
          effect: abortEffect,
          finalCallUpdate: taskFinalCallUpdate,
          interrupted: false,
          userDenied: false,
          aborted: false
        };
      }

      const actualArgs = beforeToolResult.toolCall?.arguments ?? functionArgs;
      taskEvents.push({ type: 'tool_call_start', functionName, functionArgs: actualArgs });

      const toolInstance = this.toolRegistry.getTool(functionName);
      if (toolInstance && toolInstance.securityCategory === 'write') {
        hasWrite = true;
        toolSecurityCategory = toolInstance.securityCategory;
      } else if (toolInstance) {
        toolSecurityCategory = toolInstance.securityCategory;
      }

      if (signal.aborted) {
        throw createCancellationError(signal, 'preparation', false);
      }

      // 并发锁物理路径冲突排队编排
      const pathsToLock = resolveFilePaths(actualArgs, toolInstance?.filePathParamKey, this.context.appConfig?.workspace);
      const lockType = (toolInstance?.securityCategory === 'read') ? 'read' : 'write';
      const prepareExecution = async (): Promise<() => void> => {
        const releases: Array<() => void> = [];
        try {
          for (const pathToLock of pathsToLock) {
            const release = await FileLockManager.getInstance().acquireLock(pathToLock, lockType, signal);
            releases.push(release);
          }
          if (signal.aborted) {
            throw createCancellationError(signal, 'preparation', false);
          }
          if (toolInstance?.securityCategory === 'write') {
            const snapshotId = `snap_${this.context.getSessionId()}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const workspace = this.context.appConfig?.workspace || process.cwd();
            const historyLength = this.context.getHistory().length;
            for (const pathToLock of pathsToLock) {
              FileBackupManager.captureSnapshot(snapshotId, pathToLock, historyLength, workspace);
            }
          }
          return () => {
            for (let index = releases.length - 1; index >= 0; index--) {
              releases[index]();
            }
          };
        } catch (error) {
          for (let index = releases.length - 1; index >= 0; index--) {
            releases[index]();
          }
          throw error;
        }
      };

      let toolResult = '';
      let outputResult: { content: string; originalPath?: string; isTruncated: boolean; } | null = null;
      // 超时值只向 Gateway 传递，Gateway 在权限审批完成后才创建计时信号。
      const executionTimeoutMs = this.context.appConfig?.runtimeLimits?.toolTimeoutMs ?? 30000;
      try {
        const outcome = await this.toolRegistry.callTool(
          functionName,
          actualArgs,
          this.context,
          this.interactionPort,
          signal,
          toolCall.id,
          executionTimeoutMs,
          { prepareExecution },
        );
        executionStarted = outcome.effect.executionStarted;
        // 使用 outcome 中的 effect（工具可能已精化），供后续质量门禁消费
        if (outcome.effect) {
          resolvedEffect = outcome.effect;
        }
        const rawResult = serializeToolOutcomeForModel(outcome.value);
        outputResult = this.toolDispatcher.handleLargeToolOutput(functionName, rawResult);
        toolResult = outputResult.content;
      } catch (toolError: unknown) {
        if (isToolLifecycleError(toolError)) {
          throw toolError;
        }
        const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
        const isAbortError = toolError instanceof Error && (toolError.name === 'AbortError' || errorMsg.includes('Abort') || errorMsg.includes('abort'));
        if (isAbortError) {
          throw new ToolLifecycleError(
            signal.aborted ? 'execution_cancelled_after_start' : 'execution_timed_out',
            signal.aborted ? '工具执行已被上游取消' : `工具执行超时熔断阻断: ${errorMsg}`,
            'execution',
            true,
            toolError,
          );
        }
        throw toolError;
      }

      if (signal.aborted) {
        throw createCancellationError(signal, 'execution', true);
      }

      // AfterTool 管线
      const afterToolResult = await runHookPipeline(
        HookEventName.AfterTool,
        this.context,
        this.pluginRegistry.getPluginsForEvent(HookEventName.AfterTool),
        {
          toolCall: { id: toolCall.id, name: functionName, arguments: actualArgs },
          toolResult: { content: toolResult },
          emitEvent: taskEmitEvent
        }
      );

      if (afterToolResult.control.action === 'abort') {
        // AfterTool abort 不得抹去已发生的 write/unknown effect——工具已经执行完毕
        // 仅当权限 evidence 未产生有效 effect 时才回退到保守默认推导。
        if (resolvedEffect.kind === 'none' || resolvedEffect.reason === 'no_execution') {
          resolvedEffect = deriveDefaultToolExecutionEffect(toolSecurityCategory, executionStarted, true);
        }
        taskFinalCallUpdate.error = afterToolResult.control.reason ?? '无原因';
        return {
          index,
          events: taskEvents,
          hasWrite,
          effect: resolvedEffect,
          finalCallUpdate: taskFinalCallUpdate,
          interrupted: false,
          userDenied: false,
          aborted: true,
          abortReason: afterToolResult.control.reason ?? '无原因'
        };
      }

      // 正常完成：仅当 outcome 未提供精确 effect 时才回退默认推导
      if (resolvedEffect.kind === 'none' && resolvedEffect.reason === 'no_execution') {
        resolvedEffect = deriveDefaultToolExecutionEffect(toolSecurityCategory, executionStarted, true);
      }

      const finalToolResultContent = afterToolResult.toolResult?.content ?? toolResult;
      taskFinalCallUpdate.result = finalToolResultContent;

      // tail call 级联处理
      if (afterToolResult.tailToolCallRequest) {
        const tailCall = afterToolResult.tailToolCallRequest;
        taskEvents.push({ type: 'thinking', content: `[尾随调用] 插件触发尾随工具链调用: ${tailCall.name}` });
        if (signal.aborted) {
          throw createCancellationError(signal, 'execution', true);
        }
        // tail call 生成独立 toolCallId
        const tailCallId = randomUUID();

        // tail call 走完整 beforeTool 管线
        const tailBeforeToolResult = await runHookPipeline(
          HookEventName.BeforeTool,
          this.context,
          this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeTool),
          {
            toolCall: { id: tailCallId, name: tailCall.name, arguments: tailCall.args },
            emitEvent: taskEmitEvent,
            toolRegistry: this.toolRegistry
          }
        );

        if (tailBeforeToolResult.control.action === 'abort') {
          taskEvents.push({ type: 'error', message: `[插件拦截] 尾随工具调用被拦截阻断：${tailBeforeToolResult.control.reason ?? '安全策略限制'}` });
          throw new Error(`尾随工具调用被插件拦截：${tailBeforeToolResult.control.reason ?? '安全策略限制'}`);
        }

        const tailOutcome = await this.toolRegistry.callTool(
          tailCall.name, tailCall.args, this.context, this.interactionPort, signal, tailCallId, executionTimeoutMs
        );
        const tailResultRaw: unknown = tailOutcome.value;

        // tail call 同样需要进入 AfterTool 生命周期
        const tailToolResult = JSON.stringify(tailResultRaw);
        const tailAfterToolResult = await runHookPipeline(
          HookEventName.AfterTool,
          this.context,
          this.pluginRegistry.getPluginsForEvent(HookEventName.AfterTool),
          {
            toolCall: { id: tailCallId, name: tailCall.name, arguments: tailCall.args },
            toolResult: { content: tailToolResult },
            emitEvent: taskEmitEvent
          }
        );

        if (tailAfterToolResult.control.action === 'abort') {
          taskEvents.push({ type: 'error', message: `[插件拦截] 尾随工具后置处理被阻断：${tailAfterToolResult.control.reason ?? '安全策略限制'}` });
          throw new Error(`尾随工具后置处理被插件拦截：${tailAfterToolResult.control.reason ?? '安全策略限制'}`);
        }

        taskFinalCallUpdate.result = tailAfterToolResult.toolResult?.content ?? tailToolResult;
      }

      taskEvents.push({
        type: 'tool_call_result',
        functionName,
        result: taskFinalCallUpdate.result ?? '',
        status: 'success',
      });

      toolMessage = {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: taskFinalCallUpdate.result ?? '',
        originalPath: (outputResult && outputResult.isTruncated) ? outputResult.originalPath : undefined,
        isTruncated: (outputResult && outputResult.isTruncated) ? true : false
      };
    } catch (toolError: unknown) {
      if (toolError instanceof InteractionRequestError && isHumanInterruption) {
        const interaction = this.context.setPendingInteraction({
          id: `interaction_${toolCall.id}`,
          toolName: functionName,
          payload: toolError.payload,
          toolCallId: toolCall.id
        });
        taskEvents.push({ type: 'interaction_request', interaction });
        const interactionEffect = deriveDefaultToolExecutionEffect(toolSecurityCategory, executionStarted, false);
        return {
          index,
          events: taskEvents,
          hasWrite,
          effect: interactionEffect,
          finalCallUpdate: taskFinalCallUpdate,
          interrupted: true,
          userDenied: false,
          aborted: false
        };
      }

      const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
      const lifecycleError = isToolLifecycleError(toolError) ? toolError : undefined;
      userDenied = lifecycleError?.code === 'approval_denied_before_execution';
      const finalExecutionStarted = lifecycleError?.executionStarted ?? executionStarted;
      const finalErrorMsg = lifecycleError?.code === 'execution_timed_out'
        ? `工具执行超时熔断阻断: ${errorMsg}`
        : `错误：${errorMsg}`;
      taskFinalCallUpdate.error = finalErrorMsg;
      taskEvents.push({
        type: 'error',
        message: formatLifecycleEventMessage(lifecycleError, errorMsg),
        cause: toolError,
      });
      taskEvents.push({
        type: 'tool_call_result',
        functionName,
        result: finalErrorMsg,
        status: 'error',
      });
      // 生命周期错误携带真实执行事实，不再从展示文案反推是否已经启动。
      resolvedEffect = lifecycleError && !finalExecutionStarted
        ? {
            kind: 'none',
            executionStarted: false,
            completed: false,
            resources: [],
            reason: lifecycleError.code,
          }
        : lifecycleError
          ? {
              ...deriveDefaultToolExecutionEffect(toolSecurityCategory, finalExecutionStarted, false),
              reason: lifecycleError.code,
            }
          : deriveDefaultToolExecutionEffect(toolSecurityCategory, executionStarted, false);
      toolMessage = {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: finalErrorMsg,
        isError: true,
      };
    }

    // 记录 effect 解析结果（DEBUG 级，只含执行事实和脱敏资源数量）
    logger.debug('[ToolOrchestrator] tool_effect_resolved', {
      component: LOG_COMPONENT.TOOL_EFFECT,
      event: LOG_EVENT.TOOL_EFFECT_RESOLVED,
      sessionId: this.context.getSessionId(),
      correlationId: toolCall.id,
      kind: resolvedEffect.kind,
      reason: resolvedEffect.reason,
      executionStarted: resolvedEffect.executionStarted,
      completed: resolvedEffect.completed,
      resourceCount: resolvedEffect.resources.length,
    });

    return {
      index,
      events: taskEvents,
      toolMessage,
      hasWrite,
      effect: resolvedEffect,
      finalCallUpdate: taskFinalCallUpdate,
      interrupted: false,
      userDenied,
      aborted: false
    };
  }
}

/** 根据取消发生阶段创建带真实执行事实的生命周期错误。 */
function createCancellationError(
  signal: AbortSignal,
  phase: 'authorization' | 'queue' | 'preparation' | 'execution',
  executionStarted: boolean,
): ToolLifecycleError {
  return new ToolLifecycleError(
    executionStarted ? 'execution_cancelled_after_start' : 'cancelled_before_execution',
    executionStarted ? '工具执行已被上游取消' : '工具调用在执行前被上游取消',
    phase,
    executionStarted,
    signal.reason,
  );
}

/** 根据稳定生命周期代码生成用户可读事件文字。 */
function formatLifecycleEventMessage(
  error: ToolLifecycleError | undefined,
  fallbackMessage: string,
): string {
  switch (error?.code) {
    case 'permission_denied_before_execution':
    case 'approval_denied_before_execution':
      return `工具执行前被拒绝：${fallbackMessage}`;
    case 'cancelled_while_awaiting_approval':
      return '等待审批时已取消工具调用';
    case 'cancelled_while_queued':
      return '等待文件锁时已取消工具调用';
    case 'cancelled_before_execution':
      return '工具开始执行前已取消';
    case 'failed_during_preparation':
      return '工具执行前的准备工作失败';
    case 'execution_timed_out':
      return '工具执行超时阻断';
    case 'execution_cancelled_after_start':
      return '工具执行过程中被取消';
    default:
      return `工具执行失败：${fallbackMessage}`;
  }
}

/**
 * 解析物理路径并进行字典序排序，防范并发文件工具死锁。
 *
 * 优先使用工具声明中指定的命名参数键（filePathParamKey），
 * 若未指定则按启发式键名集合（targetPath, filePath 等）自动探测。
 *
 * @param args - 工具调用参数
 * @param pathKey - 工具声明的命名参数键
 * @param workspaceDir - 工作区根目录
 * @returns 去重并按字典序排序的物理绝对路径列表
 */
function resolveFilePaths(
  args: Record<string, unknown>,
  pathKey?: string,
  workspaceDir?: string
): string[] {
  const rootDir = workspaceDir || process.cwd();
  const paths: string[] = [];

  const addPath = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item.trim()) {
              paths.push(resolve(rootDir, item.trim()));
            }
          }
          return;
        }
      } catch {
        // 降级为普通字符串处理
      }
    }
    const parts = trimmed.split(',').map(item => item.trim()).filter(Boolean);
    for (const item of parts) {
      paths.push(resolve(rootDir, item));
    }
  };

  if (pathKey && typeof args[pathKey] === 'string') {
    addPath(args[pathKey] as string);
  } else {
    const heuristicKeys = new Set([
      'targetPath',
      'targetPaths',
      'target',
      'file',
      'filePath',
      'directoryPath',
      'destinationPath',
      'sourcePath',
      'path'
    ]);
    for (const key of Object.keys(args)) {
      if (heuristicKeys.has(key) && typeof args[key] === 'string') {
        addPath(args[key] as string);
      }
    }
  }

  return Array.from(new Set(paths)).sort();
}
