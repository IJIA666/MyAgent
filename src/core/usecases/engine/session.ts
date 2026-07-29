import { EventEmitter } from 'events';
import { AppConfig, LlmConfig, ConfigPermissionMode } from '../../../config/index.js';
import { logger } from '../../../utils/logger.js'; // 导入统一日志单例 logger
import { AgentTracer } from '../../domain/tracer.js';
import { SessionContext, ContextTokenUsage, type PendingInteraction } from '../../domain/context.js';
import type {
  ChatMessage,
  CompactionPreference,
  CompactionResult,
  LlmPort,
} from '../../../ports/driven/llm/LlmPort.js';
import type { AskUserAnswer } from '../../../ports/driven/session/InteractionPort.js';
import type { TokenEstimatorPort, ApiUsage } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import { ContextAdapter } from '../../../ports/driven/session/ContextAdapter.js';
import { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import { AgentLoop } from './agent-loop.js';
import type {
  CliMemoryStatus,
  CliSessionUseCase,
  CliSkillSummary,
} from '../../../ports/driving/CliSessionUseCase.js';
import { TaskAborterPort } from '../../../ports/driven/tools/TaskAborterPort.js';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import { HookEventName, type HookContext, type ApprovalChoice } from '../plugins/plugin-types.js';
import { runHookPipeline } from '../plugins/plugin-runner.js';
import { JitRulesPlugin } from '../plugins/JitRulesPlugin.js';
import { TracerLogPlugin } from '../plugins/TracerLogPlugin.js';
import { LoopPreventionPlugin } from '../plugins/LoopPreventionPlugin.js';
import type { InteractionPort } from '../../../ports/driven/session/InteractionPort.js';
import { LifecycleManager } from './LifecycleManager.js';
import { FileBackupManager } from '../security/FileBackupManager.js';

// 导入领域服务
import { RuleManager } from '../brain/RuleManager.js';
import { ContextRepository } from '../brain/ContextRepository.js';
import { ToolDispatcher } from './ToolDispatcher.js';
import { CompactionService } from '../brain/CompactionService.js';
import { ContextHistoryPruner } from '../brain/ContextHistoryPruner.js';
import { ContextBudgetPlanner } from '../brain/ContextBudgetPlanner.js';
import { ContextBudgetCoordinator } from '../brain/ContextBudgetCoordinator.js';
import { ApprovalInteractionService } from '../security/ApprovalInteractionService.js';
import {
  createEmptyMemorySnapshot,
  diagnoseMemoryTopics,
  loadMemorySnapshot,
  type MemoryDiagnostic,
  type MemorySnapshot,
  type MemoryTopicDiagnosticResult,
} from '../brain/memory-loader.js';
import {
  MemoryCandidateStore,
  type MemoryCandidate,
  type StageMemoryCandidateInput,
} from '../brain/memory-candidate-store.js';
import type {
  PermissionUpdate,
} from '../../domain/permissions/permission-types.js';
import type {
  PermissionSessionSnapshot,
} from '../../domain/permissions/permission-session-state.js';

/**
 * 会话管理与模型交互调度中心。
 * 重构后退化为纯正的 ReAct 循环执行引擎，相关周边逻辑被下沉至各自领域服务。
 */
export class SessionManager extends EventEmitter implements CliSessionUseCase {
  /** 当前系统的工具注册管理台端口契约 */
  private toolRegistry: ToolRegistryPort;
  /** 会话的跟踪记录仪，负责日志落盘 */
  private tracer: AgentTracer;
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  private maxIterations = 20;
  /** 本地会话的上下文与状态存储 */
  private context: SessionContext;
  /** 大语言模型是否正在推理生成中 */
  private isGenerating = false;
  /** 连续自动唤醒大模型的次数 */
  private autoWakeupCount = 0;
  /** 标识当前推理期间是否到达了积压的异步系统通知 */
  private hasPendingAsyncNotification = false;
  /** 会话是否已关闭（幂等保护） */
  private isClosed = false;
  /** 当前项目长期记忆目录，用于在 open 阶段加载快照。 */
  private memoryDir: string;
  /** 是否启用启动期 Auto Memory 加载与投影。 */
  private autoMemoryEnabled: boolean;
  /** 当前记忆根是否由受信自定义配置提供。 */
  private readonly autoMemoryRootKind: 'default' | 'custom';
  /** 当前冻结的长期记忆快照，由 open() 及压缩刷新后装载。 */
  private memorySnapshot: MemorySnapshot;
  /** 最近一次启动索引加载诊断；不会包含隐式 topic 读取结果。 */
  private memoryDiagnostic: MemoryDiagnostic;
  /** 未激活记忆候选的独立暂存仓储。 */
  private readonly memoryCandidateStore: MemoryCandidateStore;
  /** Auto Memory 开关使用的统一原子 settings 仓储。 */
  private readonly settingsRepository: AppConfig['settingsRepository'];
  /** 大语言模型的核心驱动模块 */
  private driver: LlmPort;
  /** 上下文管理与组装适配器 */
  private contextAdapter: ContextAdapter;
  /** 当前的大语言模型连接配置 */
  private llmConfig: LlmConfig;
  /** 任务中止服务端口 */
  private taskAborter?: TaskAborterPort;

  // ==== 领域服务集群 ====
  /** 全局与局部规则热加载服务 */
  public readonly ruleManager: RuleManager;
  /** 会话状态物理落盘与回溯服务 */
  private contextRepo: ContextRepository;
  /** 工具调度与返回文本处理服务 */
  private toolDispatcher: ToolDispatcher;
  /** 上下文提炼与截断防爆服务 */
  /** 插件注册中心 */
  private pluginRegistry: PluginRegistry;
  /** 独立的智能体执行循环引擎 */
  private agentLoop: AgentLoop;

  /**
   * 实例初始化。
   *
   * @param llmConfig - 大语言模型连接配置
   * @param driver - 大语言模型驱动接口适配器实例
   * @param estimator - Token 预估与水位计算接口实例
   * @param toolRegistry - 工具注册表与调度管理端口契约
   * @param contextAdapter - 上下文适配器契约
   * @param appConfig - 应用程序系统配置项
   * @param taskAborter - 任务中止服务端口
   */
  constructor(
    llmConfig: LlmConfig,
    driver: LlmPort,
    estimator: TokenEstimatorPort,
    toolRegistry: ToolRegistryPort,
    contextAdapter: ContextAdapter,
    appConfig: AppConfig,
    taskAborter?: TaskAborterPort,
  ) {
    super();
    this.llmConfig = llmConfig;
    this.toolRegistry = toolRegistry;
    this.taskAborter = taskAborter;
    this.context = new SessionContext();
    this.context.appConfig = appConfig;
    this.maxIterations = appConfig.runtimeLimits.maxIterations;
    this.driver = driver;
    // 实例化主跟踪仪，使用应用路径中的 traces/audits 目录
    this.tracer = new AgentTracer(
      appConfig.applicationPaths.tracesDir,
      appConfig.applicationPaths.auditsDir,
      this.context.getSessionId(),
      appConfig.diagnostics,
    );
    if (appConfig.diagnostics.replayEnabled) {
      logger.warn('[诊断] replay_mode_enabled', {
        component: 'diagnostic_governance',
        event: 'replay_mode_enabled',
        sessionId: this.context.getSessionId(),
        retentionDays: appConfig.diagnostics.traceRetentionDays,
        retentionSessions: appConfig.diagnostics.traceRetentionSessions
      });
    }
    this.contextAdapter = contextAdapter;

    // 初始化长期记忆目录与空快照（真实加载延迟到 open() 执行）
    this.autoMemoryEnabled = appConfig.autoMemoryEnabled;
    this.memoryDir = appConfig.autoMemoryDirectory ?? appConfig.applicationPaths.memoryDir;
    this.autoMemoryRootKind = appConfig.autoMemoryDirectory ? 'custom' : 'default';
    this.settingsRepository = appConfig.settingsRepository;
    this.memorySnapshot = createEmptyMemorySnapshot(
      this.autoMemoryEnabled ? this.memoryDir : '',
    );
    this.memoryDiagnostic = createEmptyMemoryDiagnostic();
    this.memoryCandidateStore = new MemoryCandidateStore(this.memoryDir);

    // 初始化领域服务集群
    const paths = appConfig.applicationPaths;
    this.ruleManager = new RuleManager(
      this.context,
      paths.userRulesDir,
      paths.projectRulesDir,
      paths.userSkillsDir,
      paths.projectSkillsDir,
    );
    this.contextRepo = new ContextRepository(this.context, paths.sessionsDir);
    this.toolDispatcher = new ToolDispatcher(this.context, this.toolRegistry, paths.toolOutputsDir);
    // 工具输出位于 workspace 外，通过正式会话目录状态开放其精确目录树。
    this.context.getPermissionSessionState().applyUpdates([{
      type: 'addDirectories',
      target: 'session',
      directories: [paths.toolOutputsDir],
    }]);
    // 回滚备份必须使用当前项目的应用数据目录，禁止从 workspace 推导旧路径。
    FileBackupManager.setBackupsDir(paths.backupsDir);
    const compactionService = new CompactionService(
      this.context, this.driver, this.contextRepo, estimator,
      () => { this.refreshMemorySnapshot(); }
    );
    const contextHistoryPruner = new ContextHistoryPruner(estimator);
    const contextBudgetPlanner = new ContextBudgetPlanner(estimator, contextHistoryPruner);
    const contextBudgetCoordinator = new ContextBudgetCoordinator(
      this.context,
      contextBudgetPlanner,
      compactionService,
      () => this.llmConfig
    );

    // 初始化并注册拦截插件
    this.pluginRegistry = new PluginRegistry();
    this.pluginRegistry.register(new JitRulesPlugin(this.toolDispatcher));
    this.pluginRegistry.register(new TracerLogPlugin(() => this.tracer));
    this.pluginRegistry.register(new LoopPreventionPlugin(appConfig));

    LifecycleManager.register('file-backup-manager', async () => {
      FileBackupManager.cleanup(appConfig.workspace);
    });

    // 初始化独立的执行引擎实例
    this.agentLoop = new AgentLoop({
      toolRegistry: this.toolRegistry,
      context: this.context,
      driver: this.driver,
      contextAdapter: this.contextAdapter,
      ruleManager: this.ruleManager,
      contextRepo: this.contextRepo,
      toolDispatcher: this.toolDispatcher,
      contextBudgetCoordinator,
      pluginRegistry: this.pluginRegistry,
      maxIterations: this.maxIterations,
      memorySnapshotProvider: () => this.memorySnapshot,
    });

    // 监听底层 Driven 事件总线抛出的异步任务事件，实施下沉后的自唤醒调度
    this.context.on('async_event', () => {
      this.handleAsyncEvent();
    });
  }

  /**
   * 将新到达的用户指令同步到会话状态链。
   *
   * @param content - 用户侧的原始输入数据
   */
  private addUserMessage(content: string): void {
    this.context.addMessage({ role: 'user', content });
  }

  /**
   * 输出当前关联的上下文状态数据。
   *
   * @returns 包含对话历史的消息参数数组
   */
  public getHistory(): ChatMessage[] {
    return this.context.getHistory();
  }

  /**
   * 获取当前激活的模型名称。
   * 会基于当前会话绑定的 llmConfig.contextWindow 动态拼装类似于 [1m]、[128k] 的窗口大小后缀，
   * 用于提示符（Prompt）等视图上的状态信息展示。
   *
   * @returns 带上下文限制后缀的模型名称字符串
   */
  public getModelName(): string {
    // 获取基础模型名称
    const baseName = this.driver.getModelName();
    // 级联读取内存配置中的上下文限制，动态拼接换算后的后缀标签
    const window = this.llmConfig.contextWindow;
    if (window) {
      if (window >= 1000000) {
        return `${baseName}[${Math.round(window / 1000000)}m]`;
      } else if (window >= 1000) {
        return `${baseName}[${Math.round(window / 1000)}k]`;
      }
    }
    return baseName;
  }

  /**
   * 延迟注入人机对话交互端口。
   * 由于 InteractionPort 依赖 CLI 层的 InputListener（在 CliFacade 构造时创建），
   * 无法在 SessionManager 构造时同步注入，需通过此方法在 CliFacade 就绪后回注。
   *
   * @param interactionPort - 人机对话交互端口实现
   */
  public setInteractionPort(interactionPort: InteractionPort): void {
    this.agentLoop.interactionPort = interactionPort;
  }

  /**
   * 获取当前会话中挂起的人机中断交互。
   *
   * @returns 当前挂起的交互，若无则返回 null
   */
  public getPendingInteraction(): PendingInteraction | null {
    return this.context.pendingInteraction;
  }

  /**
   * 获取当前会话唯一标识。
   *
   * @returns 会话 ID 字符串
   */
  public getSessionId(): string {
    return this.context.getSessionId();
  }

  /**
   * 获取当前会话绑定的工具注册表管理台端口契约实例。
   *
   * @returns 工具注册表端口契约实例
   */
  public get toolRegistryInstance(): ToolRegistryPort {
    return this.toolRegistry;
  }

  /**
   * 获取当前会话绑定的人机协同审批协调服务。
   *
   * @returns 审批服务实例
   */
  public get approvalInteraction(): ApprovalInteractionService {
    return this.context.approvalInteraction;
  }

  /**
   * 将当前上下文静默序列化落盘到工作区文件。
   *
   * @returns 无返回值的 Promise
   */
  public async saveState(): Promise<void> {
    await this.contextRepo.saveState();
  }

  /**
   * 恢复指定的会话持久化数据覆盖当前内存上下文。
   *
   * @param targetSessionId - 需要恢复加载的目标会话 ID
   * @returns 成功返回 true，否则返回 false
   */
  public async loadState(targetSessionId: string): Promise<boolean> {
    const success = await this.contextRepo.loadState(targetSessionId);
    if (success) {
      const appConfig = this.context.appConfig;
      if (!appConfig) {
        throw new Error('会话状态恢复后缺少 AppConfig，无法重建 tracer');
      }
      const paths = appConfig.applicationPaths;
      // 状态恢复成功后，重置跟踪记录仪以绑定新的 Session ID 目录
      this.tracer = new AgentTracer(
        paths.tracesDir,
        paths.auditsDir,
        this.context.getSessionId(),
        appConfig.diagnostics,
      );
      this.agentLoop.resetTraceState();
    }
    return success;
  }

  /**
   * 动态切换当前会话的大模型配置。
   *
   * @param newConfig - 新的大语言模型配置
   * @param options - 额外的运行时交互配置选项
   */
  public switchModel(newConfig: LlmConfig, options?: Record<string, unknown>): void {
    const previousConfig = this.llmConfig;
    try {
      this.driver.switchModel(newConfig, options);
      this.llmConfig = newConfig;

      logger.info('[会话] model_switch_succeeded', {
        component: 'session',
        event: 'model_switch_succeeded',
        sessionId: this.context.getSessionId(),
        previousProfile: previousConfig.profile?.id,
        previousModel: previousConfig.model,
        previousContextWindow: previousConfig.contextWindow,
        previousReasoningEffort: previousConfig.reasoningEffort,
        newProfile: newConfig.profile?.id,
        newModel: newConfig.model,
        newContextWindow: newConfig.contextWindow,
        newReasoningEffort: newConfig.reasoningEffort
      });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // 驱动层切换失败时，llmConfig 仍保留旧配置不变
      logger.warn('[会话] model_switch_failed', {
        component: 'session',
        event: 'model_switch_failed',
        sessionId: this.context.getSessionId(),
        targetProfile: newConfig.profile?.id,
        targetModel: newConfig.model,
        currentProfile: previousConfig.profile?.id,
        currentModel: previousConfig.model,
        error: errorMsg
      });
      throw error;
    }
  }

  /**
   * 中断当前正在进行的大模型推理流或网络请求，并异步终止该会话的后台任务。
   */
  public abort(): void {
    this.driver.abort();
    this.context.cancelPendingInteraction();
    if (this.taskAborter) {
      this.taskAborter(this.context.getSessionId()).catch((err: unknown) => {
        logger.error('Failed to abort session tasks on session abort:', err);
      });
    }
  }

  /**
   * 获取当前长期记忆快照（只读提供器，供 AgentLoop 和请求组装使用）。
   *
   * @returns 当前冻结的记忆快照
   */
  public getMemorySnapshot(): MemorySnapshot {
    return this.memorySnapshot;
  }

  /**
   * 获取 `/memory` 使用的低敏状态摘要。
   * 不返回 MEMORY.md 内容或候选正文，避免管理视图变成新的内容注入通道。
   *
   * @returns 当前开关、根、索引数量和最近加载诊断
   */
  public getMemoryStatus(): CliMemoryStatus {
    return Object.freeze({
      enabled: this.autoMemoryEnabled,
      memoryDir: this.memoryDir,
      rootKind: this.autoMemoryRootKind,
      isEmpty: this.memorySnapshot.isEmpty,
      isTruncated: this.memorySnapshot.isTruncated,
      indexedTopicCount: this.memorySnapshot.topics.length,
      diagnostic: cloneMemoryDiagnostic(this.memoryDiagnostic),
    });
  }

  /**
   * 持久化用户级 Auto Memory 开关，并只在磁盘成功后更新当前会话。
   *
   * @param enabled - 是否启用启动索引投影
   */
  public async setAutoMemoryEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.autoMemoryEnabled) {
      return;
    }
    const updated = await this.settingsRepository.updateField(
      'user',
      {
        field: 'autoMemoryEnabled',
        value: enabled,
      },
    );
    if (!updated) {
      throw new Error('Auto Memory 开关持久化失败，当前会话未改变');
    }
    this.toolRegistry.configureMemoryAuthorizationRoot?.(
      enabled ? this.memoryDir : undefined,
      this.autoMemoryRootKind,
      this.memoryDir,
    );
    this.autoMemoryEnabled = enabled;
    this.refreshMemorySnapshot();
  }

  /**
   * 显式按需诊断索引引用的 topic 文件。
   * 会话启动和普通刷新不会调用此方法。
   *
   * @returns topic 元数据与结构化诊断
   */
  public diagnoseMemoryTopics(): MemoryTopicDiagnosticResult {
    return diagnoseMemoryTopics(this.memoryDir);
  }

  /**
   * 暂存一个不会自动注入的候选记忆。
   *
   * @param input - 候选正文、摘要和来源证明
   * @returns 已持久化候选
   */
  public stageMemoryCandidate(input: StageMemoryCandidateInput): MemoryCandidate {
    return this.memoryCandidateStore.stage(input);
  }

  /**
   * 列出尚未激活的候选及 provenance。
   *
   * @returns 冻结候选数组
   */
  public listMemoryCandidates(): readonly MemoryCandidate[] {
    return this.memoryCandidateStore.list();
  }

  /**
   * 撤销一个尚未激活的候选。
   *
   * @param candidateId - 候选 UUID
   * @returns 候选存在并删除时为 true
   */
  public discardMemoryCandidate(candidateId: string): boolean {
    return this.memoryCandidateStore.discard(candidateId);
  }

  /**
   * 从磁盘重新加载长期记忆快照，原子替换当前内存快照。
   * 刷新失败时记录结构化诊断并保留旧快照。
   *
   * @returns 刷新成功或磁盘上合法为空时返回 true，读取失败返回 false
   */
  public refreshMemorySnapshot(): boolean {
    if (!this.autoMemoryEnabled) {
      // 空 memoryDir 是请求组装器“不投影 memory 边界”的显式信号。
      this.memorySnapshot = createEmptyMemorySnapshot('');
      this.memoryDiagnostic = createEmptyMemoryDiagnostic();
      return true;
    }
    try {
      const result = loadMemorySnapshot(this.memoryDir);
      this.logMemoryDiagnostic(result.diagnostic);
      if (result.status === 'failed') {
        logger.warn('[记忆] refresh_memory_snapshot_failed', {
          component: 'session',
          event: 'refresh_memory_snapshot_failed',
          memoryDir: this.memoryDir,
        });
        return false;
      }

      this.memorySnapshot = result.snapshot;
      this.memoryDiagnostic = result.diagnostic;
      return true;
    } catch (error: unknown) {
      logger.warn('[记忆] refresh_memory_snapshot_failed', {
        component: 'session',
        event: 'refresh_memory_snapshot_failed',
        memoryDir: this.memoryDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 记录非空的记忆加载诊断。 */
  private logMemoryDiagnostic(diagnostic: MemoryDiagnostic): void {
    const hasDiagnostic = diagnostic.truncation !== null
      || diagnostic.duplicates.length > 0
      || diagnostic.brokenLinks.length > 0
      || diagnostic.invalidFilenames.length > 0
      || diagnostic.unknownTypes.length > 0
      || diagnostic.invalidFrontmatter.length > 0
      || diagnostic.warnings.length > 0;
    if (!hasDiagnostic) {
      return;
    }

    logger.warn('[记忆] refresh_memory_snapshot_diagnostic', {
      component: 'session',
      event: 'refresh_memory_snapshot_diagnostic',
      memoryDir: this.memoryDir,
      diagnostic: {
        truncation: diagnostic.truncation,
        duplicates: [...diagnostic.duplicates],
        brokenLinks: [...diagnostic.brokenLinks],
        invalidFilenames: [...diagnostic.invalidFilenames],
        unknownTypes: [...diagnostic.unknownTypes],
        invalidFrontmatter: [...diagnostic.invalidFrontmatter],
        warnings: [...diagnostic.warnings],
      },
    });
  }

  /**
   * 显式打开会话，派发 SessionOpened 生命周期事件。
   * 由组合根在构造完成后调用，插件可在此阶段执行初始化逻辑。
   *
   * @returns 无返回值的 Promise
   * @throws 若任一插件返回 abort，则抛出异常阻止会话进入可用状态
   */
  public async open(): Promise<void> {
    // 在生命周期事件前加载长期记忆快照
    this.refreshMemorySnapshot();

    const result = await runHookPipeline(
      HookEventName.SessionOpened,
      this.context,
      this.pluginRegistry.getPluginsForEvent(HookEventName.SessionOpened),
      {}
    );

    if (result.control.action === 'abort') {
      throw new Error(`[SessionManager] 会话打开被拦截：${result.control.reason ?? '无原因'}`);
    }
  }

  /**
   * 关闭会话，派发 SessionClosing / SessionClosed 生命周期事件，
   * 终止推理流、拒绝挂起审批、强制终止所有后台子进程并关闭 MCP 连接。
   * PermissionSessionState 由当前 SessionContext 独占，不落盘也不进入进程级共享容器；
   * 会话关闭后该状态不再能被新的运行或会话复用。
   *
   * @returns 无返回值的 Promise
   */
  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    // 派发 SessionClosing 可拦截事件
    const closingResult = await runHookPipeline(
      HookEventName.SessionClosing,
      this.context,
      this.pluginRegistry.getPluginsForEvent(HookEventName.SessionClosing),
      {}
    );

    if (closingResult.control.action === 'abort') {
      throw new Error(`[SessionManager] 会话关闭被拦截：${closingResult.control.reason ?? '无原因'}`);
    }

    this.abort();
    this.approvalInteraction.rejectAll('Session is closing');

    // 清理待回答的人机中断交互
    this.context.cancelPendingInteraction();

    if (this.taskAborter) {
      await this.taskAborter(this.context.getSessionId());
    }

    // 代理给 ToolRegistryPort close，物理断开并清理所有物理连接（含 MCP）
    await this.toolRegistry.close();

    // 关闭一旦走到此处已不可逆，先设置幂等标记，避免 SessionClosed 收尾异常导致重复清理
    this.isClosed = true;

    // 派发 SessionClosed 不可逆终结通知（忽略插件控制流）
    await this.runSessionClosedPipeline();
  }

  /**
   * 派发 SessionClosed 不可逆通知事件。
   * 逐个插件顺序派发，忽略其 control 信号，并吞掉单个插件异常，
   * 确保某个插件即便返回 abort/restart、未调用 next() 或执行失败，
   * 也不会阻断后续订阅者收到真实的会话终结通知。
   */
  private async runSessionClosedPipeline(): Promise<void> {
    const middlewares = this.pluginRegistry.getPluginsForEvent(HookEventName.SessionClosed);
    if (middlewares.length === 0) {
      return;
    }

    for (const middleware of middlewares) {
      const hookContext: HookContext = {
        sessionContext: this.context,
        eventName: HookEventName.SessionClosed,
        control: { action: 'continue' }
      };

      try {
        await middleware(hookContext, async () => { });
      } catch (error: unknown) {
        logger.error('[SessionManager] SessionClosed hook failed:', error);
      }
    }
  }

  /**
   * 执行上下文记忆截断（Context Rollback），安全丢弃最近数轮对话。
   *
   * @param turns - 需要丢弃的交互轮次
   * @returns 返回被弹栈丢弃的历史消息数组（按原本对话顺序排列）
   */
  public rollback(turns: number): ChatMessage[] {
    return this.contextRepo.rollback(turns);
  }

  /**
   * 清除全局 and 局部规则的内存缓存，并重新从磁盘中加载。
   * 会在下一轮交互时强制生效最新的规则内容。
   */
  public reloadRules(): void {
    this.ruleManager.reloadRules();
  }

  /**
   * 获取当前可用技能摘要列表，供 CLI 菜单与斜杠命令消费。
   *
   * @returns 技能摘要数组
   */
  public getAvailableSkills(): CliSkillSummary[] {
    return this.ruleManager.getSkills().map((skill) => ({
      name: skill.name,
      description: skill.description
    }));
  }

  /**
   * 获取指定技能的完整内容。
   *
   * @param name - 技能名称
   * @returns 技能正文，若不存在则返回 null
   */
  public getSkillContent(name: string): string | null {
    return this.ruleManager.getSkillContent(name);
  }

  /**
   * 手动规划并执行当前活跃会话的上下文压缩。
   *
   * @param preference - 自动选择策略，或显式要求全量压缩
   * @returns 包含状态、策略与 Token 预算的结构化压缩结果
   */
  public async compact(preference: CompactionPreference = 'auto'): Promise<CompactionResult> {
    return this.agentLoop.compact(preference);
  }

  /**
   * 统一人类输入接口。
   * 该接口为 fire-and-forget 异步通知设计。
   *
   * @param input - 用户输入的指令
   * @param transientSkillContent - 可选。当前请求独占的临时技能规范内容
   */
  public handleUserInput(input: string, transientSkillContent?: string): void {
    if (this.isGenerating) {
      throw new Error('Session is currently busy generating a response.');
    }

    const previousWakeupCount = this.autoWakeupCount;
    this.isGenerating = true; // 同步原子加锁，防止同 Tick 重入
    this.autoWakeupCount = 0;  // 每次人类主动交互，重置自动唤醒计数器

    // 1. 同步将消息写入上下文历史
    logger.debug('[SessionManager] generation_requested', {
      component: 'session',
      event: 'generation_requested',
      sessionId: this.context.getSessionId(),
      oldValue: previousWakeupCount,
      newValue: this.autoWakeupCount,
      reason: 'user_input',
      hasPendingAsyncNotification: this.hasPendingAsyncNotification,
      isGenerating: this.isGenerating
    });
    this.addUserMessage(input);

    // 2. 异步调起内部推理并广播事件
    this.runInternalGeneration(transientSkillContent).catch((err: unknown) => {
      logger.error('[SessionManager] handleUserInput 推理执行失败:', err);
    });
  }

  /**
   * 提交当前挂起提问的用户回答，并从原 run 的工具调用点继续推理。
   *
   * @param interactionId - 待恢复的交互 ID
   * @param answer - 用户回答的结构化映射（按问题 id 索引）
   * @returns 无返回值的 Promise
   */
  public async resumePendingInteraction(interactionId: string, answer: AskUserAnswer): Promise<void> {
    if (this.isGenerating) {
      throw new Error('Session is currently busy generating a response.');
    }

    const current = this.context.pendingInteraction;
    if (!current || current.state !== 'pending') {
      throw new Error('当前不存在可恢复的人机中断交互。');
    }
    if (current.id !== interactionId) {
      throw new Error(`待恢复交互不匹配：期望 ${current.id}，实际收到 ${interactionId}。`);
    }

    const answered = this.context.answerPendingInteraction(answer);
    if (!answered) {
      throw new Error('记录用户回答失败，挂起交互已失效。');
    }

    this.context.addMessage({
      role: 'tool',
      tool_call_id: answered.toolCallId,
      content: JSON.stringify(answered.answer ?? {})
    });
    this.context.clearPendingInteraction();
    await this.contextRepo.saveState();

    const previousWakeupCount = this.autoWakeupCount;
    this.isGenerating = true;
    this.autoWakeupCount = 0;
    logger.debug('[SessionManager] interaction_resume_requested', {
      component: 'session',
      event: 'interaction_resume_requested',
      sessionId: this.context.getSessionId(),
      interactionId,
      oldValue: previousWakeupCount,
      newValue: this.autoWakeupCount,
      reason: 'human_interruption_answer'
    });

    this.runInternalGeneration().catch((err: unknown) => {
      logger.error('[SessionManager] resumePendingInteraction 推理执行失败:', err);
    });
  }

  /**
   * 内部推理循环调度，并进行事件的流式广播分发。
   *
   * @param transientSkillContent - 可选。当前请求专享的临时技能规范内容
   */
  private async runInternalGeneration(transientSkillContent?: string): Promise<void> {
    let hasError = false;
    logger.debug('[SessionManager] generation_cycle_started', {
      component: 'session',
      event: 'generation_cycle_started',
      sessionId: this.context.getSessionId(),
      wakeupCount: this.autoWakeupCount,
      hasPendingAsyncNotification: this.hasPendingAsyncNotification
    });
    try {
      // 订阅并逐步消费大脑层抛出的推理事件，对外分发统一的 'agent_event'
      for await (const event of this.agentLoop.chat(transientSkillContent, this.tracer, this.llmConfig)) {
        this.emit('agent_event', event);
      }
    } catch (error: unknown) {
      hasError = true;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[SessionManager] generation_cycle_error', {
        component: 'session',
        event: 'generation_cycle_error',
        sessionId: this.context.getSessionId(),
        wakeupCount: this.autoWakeupCount,
        hasPendingAsyncNotification: this.hasPendingAsyncNotification,
        message
      });
      this.emit('agent_event', {
        type: 'error',
        message
      });
      // 对称契约：无论正常结束还是灾难崩溃，complete 作为本轮推理生命周期的唯一终点
      this.emit('agent_event', { type: 'complete' });
    } finally {
      this.isGenerating = false;
      const waitingForInteraction = this.context.pendingInteraction?.state === 'pending';
      logger.debug('[SessionManager] generation_cycle_finished', {
        component: 'session',
        event: 'generation_cycle_finished',
        sessionId: this.context.getSessionId(),
        wakeupCount: this.autoWakeupCount,
        hasPendingAsyncNotification: this.hasPendingAsyncNotification,
        hasError,
        waitingForInteraction
      });

      // 对称契约：complete 是唯一的生命周期终点。
      // catch 块已在灾难性异常时补发 complete，此处仅处理正常路径。
      const willWakeup = !hasError && this.hasPendingAsyncNotification && this.autoWakeupCount < 3;
      if (!hasError && !willWakeup && !waitingForInteraction) {
        this.emit('agent_event', { type: 'complete' });
      }

      // 检测本轮推理生成期间是否积压了新的后台通知事件，延迟到下一 Tick 处理，防止爆栈
      process.nextTick(() => {
        if (!hasError && !waitingForInteraction && !this.isGenerating && this.hasPendingAsyncNotification) {
          const previousPendingState = this.hasPendingAsyncNotification;
          this.hasPendingAsyncNotification = false;
          logger.debug('[SessionManager] async_notification_wakeup_scheduled', {
            component: 'session',
            event: 'async_notification_wakeup_scheduled',
            sessionId: this.context.getSessionId(),
            oldValue: previousPendingState,
            newValue: this.hasPendingAsyncNotification,
            reason: 'deferred_wakeup'
          });

          if (this.autoWakeupCount >= 3) {
            logger.warn('[SessionManager] auto_wakeup_limit_reached', {
              component: 'session',
              event: 'auto_wakeup_limit_reached',
              sessionId: this.context.getSessionId(),
              autoWakeupCount: this.autoWakeupCount
            });
            this.emit('agent_event', {
              type: 'error',
              message: '[系统提示] 检测到连续自动唤醒次数已达上限（3次），已暂停自动唤醒，等待人工介入。'
            });
            // 熔断后不再唤醒，补发 complete 事件
            this.emit('agent_event', { type: 'complete' });
            return;
          }

          this.autoWakeupCount++;
          this.isGenerating = true; // 同步加锁
          this.runInternalGeneration().catch((err: unknown) => {
            logger.error('[SessionManager] 自唤醒级联推理失败:', err);
          });
        }
      });
    }
  }

  /**
   * 处理从底层会话总线分发的异步后台通知事件。
   * 当推理忙碌时进行缓冲记录，空闲时触发自唤醒推理。
   */
  private handleAsyncEvent(): void {
    if (this.isGenerating) {
      // 忙碌状态：仅记录积压标识，避免产生竞态并发
      const previousPendingState = this.hasPendingAsyncNotification;
      this.hasPendingAsyncNotification = true;
      logger.debug('[SessionManager] async_event_buffered', {
        component: 'session',
        event: 'async_event_buffered',
        sessionId: this.context.getSessionId(),
        oldValue: previousPendingState,
        newValue: this.hasPendingAsyncNotification,
        reason: 'busy_buffered',
        hasPendingAsyncNotification: this.hasPendingAsyncNotification
      });
      return;
    }

    // 限制连续自动唤醒的最大上限（无人值守防御）
    if (this.autoWakeupCount >= 3) {
      logger.warn('[SessionManager] auto_wakeup_limit_reached', {
        component: 'session',
        event: 'auto_wakeup_limit_reached',
        sessionId: this.context.getSessionId(),
        oldValue: this.hasPendingAsyncNotification,
        newValue: false,
        reason: 'wakeup_limit_reached',
        wakeupCount: this.autoWakeupCount
      });
      this.emit('agent_event', {
        type: 'error',
        message: '[系统提示] 检测到连续自动唤醒次数已达上限（3次），已暂停自动唤醒，等待人工介入。'
      });
      this.hasPendingAsyncNotification = false;
      return;
    }

    const previousWakeupCount = this.autoWakeupCount;
    this.autoWakeupCount++;
    // 必须在启动异步生成前同步加锁，防止同一事件循环中的后续通知并发启动模型。
    this.isGenerating = true;
    logger.debug('[SessionManager] auto_wakeup_triggered', {
      component: 'session',
      event: 'auto_wakeup_triggered',
      sessionId: this.context.getSessionId(),
      oldValue: previousWakeupCount,
      newValue: this.autoWakeupCount,
      reason: 'async_event'
    });
    // 异步调起后台任务更新研判
    this.runInternalGeneration().catch((err: unknown) => {
      logger.error('[SessionManager] 自动唤醒推理执行失败:', err);
    });
  }

  /**
   * 获取当前智能体是否正在推理生成中。
   *
   * @returns 正在推理返回 true，否则返回 false
   */
  public getIsGenerating(): boolean {
    return this.isGenerating;
  }

  /**
   * 获取最近一次大模型的 API 结算 Usage。
   *
   * @returns 最近一次 API 结算的真实用量，若无则返回 null
   */
  public getLastApiUsage(): ApiUsage | null {
    return this.context.getLastApiUsage();
  }

  /**
   * 获取最近一轮大模型请求前的 Token 估算明细。
   *
   * @returns Token 估算明细，若无则返回 null
   */
  public getLastEstimatedUsage(): ContextTokenUsage | null {
    return this.agentLoop.getLastEstimatedUsage();
  }

  /**
   * 获取当前 System Prompt 的哈希值。
   *
   * @returns 缓存的 System Prompt 哈希值字符串
   */
  public getSystemPromptHash(): string {
    return this.agentLoop.getSystemPromptHash();
  }

  /**
   * @internal 仅供集成测试模拟底层 async_event 唤醒流程的测试辅助方法。
   *
   * @param event - 模拟的异步事件载体
   */
  public __testEmitAsyncEvent(event: unknown): void {
    this.context.emit('async_event', event);
  }

  /**
   * @internal 仅供集成测试驱动内部推理循环以验证 finally 块级联调度行为的测试辅助方法。
   *
   * @returns 内部生成循环的 Promise
   */
  public __testRunInternalGeneration(): Promise<void> {
    return this.runInternalGeneration();
  }

  /**
   * 将会话消息和物理文件系统同步回退到指定的快照点。
   * 
   * @param snapshotId - 要回退的目标快照 ID
   */
  public rollbackToSnapshot(snapshotId: string): void {
    const workspace = this.context.appConfig?.workspace || process.cwd();
    // 1. 物理层回退，写回备份文件并删除后增文件
    const messageHistoryLength = FileBackupManager.rollbackToSnapshot(snapshotId, workspace);
    // 2. 内存层回退，截断消息历史
    this.context.rollbackHistoryToLength(messageHistoryLength);
    logger.info(`[SessionManager] 会话和文件系统已成功双轨回退至快照: ${snapshotId}, 消息历史长度截断至: ${messageHistoryLength}`);
  }

  /**
   * 获取当前会话绑定的上下文实例。
   *
   * @returns 会话上下文实例
   */
  public getContext(): SessionContext {
    return this.context;
  }

  /**
   * 获取当前生效的完整大语言模型连接配置（只读）。
   * 返回当前会话实际使用的 LlmConfig，包含 profile、provider model、context window
   * 和 reasoning effort 等有效字段。UI 层和 Token 估算链路应从此方法获取配置，
   * 而不是维护独立副本。
   *
   * @returns 当前生效的大语言模型连接配置
   */
  public getLlmConfig(): LlmConfig {
    return this.llmConfig;
  }

  /**
   * 获取当前智能体的工作模式。
   *
   * @returns 工作模式标识
   */
  /**
   * 设置当前智能体的工作模式。
   *
   * @param mode - 目标工作模式
   */
  /**
   * 获取当前智能体的权限模式。
   *
   * @returns 当前权限模式
   */
  public getPermissionMode(): ConfigPermissionMode {
    return this.context.getPermissionMode();
  }

  /**
   * 设置当前智能体的权限模式。
   *
   * @param mode - 目标权限模式
   */
  public setPermissionMode(mode: ConfigPermissionMode): void {
    this.context.setPermissionMode(mode);
  }

  /**
   * 获取当前唯一权限状态的不可变快照。
   *
   * @returns 当前权限状态快照
   */
  public getPermissionSnapshot(): PermissionSessionSnapshot {
    const getSnapshot = this.toolRegistry.getPermissionSnapshot;
    return getSnapshot
      ? getSnapshot.call(this.toolRegistry, this.context)
      : this.context.getPermissionSessionState().snapshot();
  }

  /**
   * 通过工具注册表的统一持久化边界提交权限更新。
   *
   * @param updates - 待提交权限更新
   */
  public async applyPermissionUpdates(
    updates: readonly PermissionUpdate[],
  ): Promise<void> {
    const applyUpdates = this.toolRegistry.applyPermissionUpdates;
    if (!applyUpdates) {
      const hasPersistentUpdate = updates.some(update => update.target !== 'session');
      if (hasPersistentUpdate) {
        throw new Error('当前运行时未装配权限设置仓储，无法持久化该更新');
      }
      this.context.getPermissionSessionState().applyUpdates(updates);
      return;
    }
    await applyUpdates.call(this.toolRegistry, updates, this.context);
  }

  /**
   * 注册审批处理器回调，委托给内部的审批交互等待器。
   *
   * @param handler - 审批处理器函数
   */
  public registerApprovalHandler(
    handler: (
      id: string,
      toolCall: { name: string; arguments: Record<string, unknown> },
      allowedPrefix?: string,
      message?: string,
      choices?: ApprovalChoice[],
      signal?: AbortSignal,
    ) => void | Promise<void>
  ): void {
    this.approvalInteraction.registerApprovalHandler(handler);
  }
}

/** 创建不含任何 topic 隐式读取结果的空记忆诊断。 */
function createEmptyMemoryDiagnostic(): MemoryDiagnostic {
  return Object.freeze({
    truncation: null,
    duplicates: Object.freeze([]),
    brokenLinks: Object.freeze([]),
    invalidFilenames: Object.freeze([]),
    unknownTypes: Object.freeze([]),
    invalidFrontmatter: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

/** 复制并冻结诊断，避免 CLI 持有会话内部数组引用。 */
function cloneMemoryDiagnostic(diagnostic: MemoryDiagnostic): MemoryDiagnostic {
  return Object.freeze({
    truncation: diagnostic.truncation
      ? Object.freeze({
          reason: diagnostic.truncation.reason,
          limit: diagnostic.truncation.limit,
        })
      : null,
    duplicates: Object.freeze([...diagnostic.duplicates]),
    brokenLinks: Object.freeze([...diagnostic.brokenLinks]),
    invalidFilenames: Object.freeze([...diagnostic.invalidFilenames]),
    unknownTypes: Object.freeze([...diagnostic.unknownTypes]),
    invalidFrontmatter: Object.freeze([...diagnostic.invalidFrontmatter]),
    warnings: Object.freeze([...diagnostic.warnings]),
  });
}
