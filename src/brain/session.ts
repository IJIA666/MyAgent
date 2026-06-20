import { McpToolManager, ToolRegistry } from '../action/index.js';
import { AppConfig, LlmConfig } from '../config/index.js';
import { AgentTracer } from './tracer.js';
import { SessionContext, ContextTokenUsage } from './context.js';
import type { ChatMessage, LlmPort } from './ports/LlmPort.js';
import type { TokenEstimatorPort, ApiUsage } from './ports/TokenEstimatorPort.js';
import { ContextAdapter, DefaultContextAdapter } from './adapters/index.js';
import { loadSkillContent } from './contextLoader.js';
import { AgentLoop, AgentEvent } from './agent-loop.js';
import { BrowserSession } from '../action/tools/browser/browser-action.js';
import { abortSessionTasks } from '../action/tools/system/terminal-engine.js';
import {
  PluginRegistry,
  TokenWatermarkPlugin,
  JitRulesPlugin,
  TracerLogPlugin,
  LoopPreventionPlugin,
  HumanApprovalPlugin
} from './plugins/index.js';

// 导入领域服务
import { RuleManager } from './services/RuleManager.js';
import { ContextRepository } from './services/ContextRepository.js';
import { ToolDispatcher } from './services/ToolDispatcher.js';
import { CompactionService } from './services/CompactionService.js';
import { ApprovalService } from './services/ApprovalService.js';

/**
 * 会话管理与模型交互调度中心。
 * 重构后退化为纯正的 ReAct 循环执行引擎，相关周边逻辑被下沉至各自领域服务。
 */
export class SessionManager {
  /** 当前系统的工具注册管理台 */
  private toolRegistry: ToolRegistry;
  /** MCP 管理器实例引用，供外层命令动态重载服务使用 */
  public readonly mcpManager?: McpToolManager;
  /** 会话的跟踪记录仪，负责日志落盘 */
  private tracer: AgentTracer;
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  private maxIterations = 20;
  /** 本地会话的上下文与状态存储 */
  private context: SessionContext;
  /** 大语言模型的核心驱动模块 */
  private driver: LlmPort;
  /** 上下文管理与组装适配器 */
  private contextAdapter: ContextAdapter;
  /** 当前的大语言模型连接配置 */
  private llmConfig: LlmConfig;

  // ==== 领域服务集群 ====
  /** 全局与局部规则热加载服务 */
  private ruleManager: RuleManager;
  /** 会话状态物理落盘与回溯服务 */
  private contextRepo: ContextRepository;
  /** 工具调度与返回文本处理服务 */
  private toolDispatcher: ToolDispatcher;
  /** 上下文提炼与截断防爆服务 */
  private compactionService: CompactionService;
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
   * @param mcpManager - 可选的 MCP 客户端管理器，用于挂载外部扩展能力
   * @param contextAdapter - 可选的上下文适配器，若未传则默认使用 DefaultContextAdapter
   */
  constructor(
    llmConfig: LlmConfig,
    driver: LlmPort,
    estimator: TokenEstimatorPort,
    mcpManager?: McpToolManager,
    contextAdapter?: ContextAdapter,
    appConfig?: AppConfig
  ) {
    this.llmConfig = llmConfig;
    this.mcpManager = mcpManager;
    this.toolRegistry = new ToolRegistry(mcpManager, {
      loadSkill: (name) => loadSkillContent(name)
    });
    this.context = new SessionContext();
    if (appConfig) {
      this.context.appConfig = appConfig;
      this.maxIterations = appConfig.runtimeLimits.maxIterations;
    }
    this.driver = driver;
    this.tracer = new AgentTracer(process.cwd(), this.context.getSessionId());
    this.contextAdapter = contextAdapter || new DefaultContextAdapter(estimator);

    // 初始化解耦后的四大领域服务
    this.ruleManager = new RuleManager(this.context);
    this.contextRepo = new ContextRepository(this.context);
    this.toolDispatcher = new ToolDispatcher(this.context);
    this.compactionService = new CompactionService(this.context, this.driver, this.contextRepo);

    // 初始化并注册拦截插件
    this.pluginRegistry = new PluginRegistry();
    this.pluginRegistry.register(new TokenWatermarkPlugin(this.compactionService, estimator, () => this.llmConfig));
    this.pluginRegistry.register(new JitRulesPlugin(this.toolDispatcher));
    this.pluginRegistry.register(new TracerLogPlugin(() => this.tracer));
    this.pluginRegistry.register(new LoopPreventionPlugin());
    this.pluginRegistry.register(new HumanApprovalPlugin());

    // 初始化独立的执行引擎实例
    this.agentLoop = new AgentLoop({
      toolRegistry: this.toolRegistry,
      context: this.context,
      driver: this.driver,
      contextAdapter: this.contextAdapter,
      ruleManager: this.ruleManager,
      contextRepo: this.contextRepo,
      toolDispatcher: this.toolDispatcher,
      compactionService: this.compactionService,
      pluginRegistry: this.pluginRegistry,
      maxIterations: this.maxIterations
    });
  }

  /**
   * 将新到达的用户指令同步到会话状态链。
   *
   * @param content - 用户侧的原始输入数据
   */
  public addUserMessage(content: string): void {
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
   * 获取当前会话唯一标识。
   *
   * @returns 会话 ID 字符串
   */
  public getSessionId(): string {
    return this.context.getSessionId();
  }

  /**
   * 获取当前会话绑定的人机协同审批协调服务。
   *
   * @returns 审批服务实例
   */
  public get approvalService(): ApprovalService {
    return this.context.approvalService;
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
   * 注册浏览器人机协作风控的干预回调函数，将其绑定到 BrowserSession 生命周期。
   *
   * @param handler - 用户干预等待处理器
   */
  public registerInterventionHandler(handler: (message: string) => Promise<void>): void {
    BrowserSession.userInterventionHandler = handler;
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
      // 状态恢复成功后，重置跟踪记录仪以绑定新的 Session ID 目录
      this.tracer = new AgentTracer(process.cwd(), this.context.getSessionId());
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
    this.llmConfig = newConfig;
    this.driver.switchModel(newConfig, options);
  }

  /**
   * 中断当前正在进行的大模型推理流或网络请求，并异步终止该会话的后台任务。
   */
  public abort(): void {
    this.driver.abort();
    abortSessionTasks(this.context.getSessionId()).catch((err) => {
      console.error('Failed to abort session tasks on session abort:', err);
    });
  }

  /**
   * 关闭会话，终止推理流、清理挂起审批、强制终止所有后台子进程并关闭 MCP 连接。
   *
   * @returns 无返回值的 Promise
   */
  public async close(): Promise<void> {
    this.abort();
    this.approvalService.rejectAll('Session is closing');
    await abortSessionTasks(this.context.getSessionId());

    // 关闭所有 MCP 子进程连接，防止产生僵尸进程
    if (this.mcpManager) {
      await this.mcpManager.close();
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
   * 手动触发当前活跃会话的上下文压缩与物理会话轮换。
   *
   * @returns 是否压缩成功
   */
  public async compact(): Promise<boolean> {
    return await this.compactionService.compact();
  }

  /**
   * 处理单次对话请求的完整生命周期。
   * 委托给底层的 AgentLoop 执行器进行推理。
   * 
   * @param transientSkillContent - 可选。当前请求独占的临时技能规范内容
   * @returns 抛出 AgentEvent 流，由外部消费者负责呈现
   */
  public async *chat(transientSkillContent?: string): AsyncGenerator<AgentEvent, void, unknown> {
    yield* this.agentLoop.chat(transientSkillContent, this.tracer, this.llmConfig);
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
   * 注册异步后台任务事件监听器。
   *
   * @param listener - 接收后台通知事件的监听器函数
   */
  public onAsyncEvent(listener: (event: unknown) => void): void {
    this.context.on('async_event', listener);
  }
}
