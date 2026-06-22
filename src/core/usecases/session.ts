import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, LlmConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js'; // 导入统一日志单例 logger
import { AgentTracer } from '../domain/tracer.js';
import { SessionContext, ContextTokenUsage } from '../domain/context.js';
import type { ChatMessage, LlmPort } from '../../ports/driven/LlmPort.js';
import type { TokenEstimatorPort, ApiUsage } from '../../ports/driven/TokenEstimatorPort.js';
import { ContextAdapter } from '../../ports/driven/ContextAdapter.js';
import { ToolRegistryPort } from '../../ports/driven/ToolRegistryPort.js';
import { AgentLoop } from './agent-loop.js';
import { ChatUseCase } from '../../ports/driving/ChatUseCase.js';
import { TaskAborterPort } from '../../ports/driven/TaskAborterPort.js';
import { PluginRegistry } from './plugin-registry.js';
import { TokenWatermarkPlugin } from './TokenWatermarkPlugin.js';
import { JitRulesPlugin } from './JitRulesPlugin.js';
import { HumanApprovalPlugin } from './HumanApprovalPlugin.js';
import { TracerLogPlugin } from './TracerLogPlugin.js';
import { LoopPreventionPlugin } from './LoopPreventionPlugin.js';
import { LongTermMemoryPlugin } from './LongTermMemoryPlugin.js';
import type { EmbeddingPort } from '../../ports/driven/EmbeddingPort.js';
import type { VectorDbPort } from '../../ports/driven/VectorDbPort.js';
import * as crypto from 'crypto';

// 导入领域服务
import { RuleManager } from './RuleManager.js';
import { ContextRepository } from './ContextRepository.js';
import { ToolDispatcher } from './ToolDispatcher.js';
import { CompactionService } from './CompactionService.js';
import { ApprovalService } from './ApprovalService.js';

/**
 * 会话管理与模型交互调度中心。
 * 重构后退化为纯正的 ReAct 循环执行引擎，相关周边逻辑被下沉至各自领域服务。
 */
export class SessionManager extends EventEmitter implements ChatUseCase {
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
  /** 长期记忆提炼自省任务的物理追加写入队列 */
  private writeQueue: Promise<void> = Promise.resolve();
  /** 长期记忆文件的物理路径 */
  private memoryFilePath: string;
  /** 本地向量数据库存储服务契约 */
  private vectorDb: VectorDbPort;
  /** 文本嵌入生成契约 */
  private embedding: EmbeddingPort;

  /**
   * 实例初始化。
   *
   * @param llmConfig - 大语言模型连接配置
   * @param driver - 大语言模型驱动接口适配器实例
   * @param estimator - Token 预估与水位计算接口实例
   * @param toolRegistry - 工具注册表与调度管理端口契约
   * @param contextAdapter - 上下文适配器契约
   * @param vectorDb - 本地向量数据库存储服务契约
   * @param embedding - 文本嵌入生成契约
   * @param appConfig - 应用程序系统配置项
   * @param taskAborter - 任务中止服务端口
   */
  constructor(
    llmConfig: LlmConfig,
    driver: LlmPort,
    estimator: TokenEstimatorPort,
    toolRegistry: ToolRegistryPort,
    contextAdapter: ContextAdapter,
    vectorDb: VectorDbPort,
    embedding: EmbeddingPort,
    appConfig: AppConfig,
    taskAborter?: TaskAborterPort
  ) {
    super();
    this.llmConfig = llmConfig;
    this.toolRegistry = toolRegistry;
    this.taskAborter = taskAborter;
    this.context = new SessionContext();
    this.context.appConfig = appConfig;
    this.maxIterations = appConfig.runtimeLimits.maxIterations;
    this.driver = driver;
    const baseDir = appConfig.workspace;
    // 实例化主跟踪仪，支持沙箱环境变量重定向
    this.tracer = new AgentTracer(baseDir, this.context.getSessionId());
    this.contextAdapter = contextAdapter;
    this.vectorDb = vectorDb;
    this.embedding = embedding;

    this.memoryFilePath = path.resolve(baseDir, '.agent/MEMORY.md');

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
    this.pluginRegistry.register(
      new LongTermMemoryPlugin(
        this.vectorDb,
        this.embedding,
        this.memoryFilePath,
        async (history) => {
          await this.triggerMemoryRefinementAsync(history);
        }
      )
    );
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

    // 监听底层 Driven 事件总线抛出的异步任务事件，实施下沉后的自唤醒调度
    this.context.on('async_event', () => {
      this.handleAsyncEvent();
    });

    // 异步尝试重建向量数据库，仅当库为空且物理 MEMORY.md 存在时生效
    this.rebuildVectorDbIfEmpty().catch((error) => {
      // 使用统一日志单例 logger 打印异步重建向量库失败错误
      logger.error('[SessionManager] 异步重建向量库失败:', error);
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
   * 恢复指定的会话持久化数据覆盖当前内存上下文。
   *
   * @param targetSessionId - 需要恢复加载的目标会话 ID
   * @returns 成功返回 true，否则返回 false
   */
  public async loadState(targetSessionId: string): Promise<boolean> {
    const success = await this.contextRepo.loadState(targetSessionId);
    if (success) {
      const baseDir = this.context.appConfig ? this.context.appConfig.workspace : process.cwd();
      // 状态恢复成功后，重置跟踪记录仪以绑定新的 Session ID 目录
      this.tracer = new AgentTracer(baseDir, this.context.getSessionId());
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
    if (this.taskAborter) {
      this.taskAborter(this.context.getSessionId()).catch((err: unknown) => {
        // 使用统一日志单例 logger 打印任务中断失败错误
        logger.error('Failed to abort session tasks on session abort:', err);
      });
    }
  }

  /**
   * 关闭会话，终止推理流、清理挂起审批、强制终止所有后台子进程并关闭 MCP 连接。
   *
   * @returns 无返回值的 Promise
   */
  public async close(): Promise<void> {
    this.abort();
    this.approvalService.rejectAll('Session is closing');
    if (this.taskAborter) {
      await this.taskAborter(this.context.getSessionId());
    }

    // 代理给 ToolRegistryPort close，物理断开并清理所有物理连接（含 MCP）
    await this.toolRegistry.close();
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

    this.isGenerating = true; // 同步原子加锁，防止同 Tick 重入
    this.autoWakeupCount = 0;  // 每次人类主动交互，重置自动唤醒计数器

    // 1. 同步将消息写入上下文历史
    this.addUserMessage(input);

    // 2. 异步调起内部推理并广播事件
    this.runInternalGeneration(transientSkillContent).catch((err: unknown) => {
      // 使用统一日志单例 logger 打印用户输入推理失败错误
      logger.error('[SessionManager] handleUserInput 推理执行失败:', err);
    });
  }

  /**
   * 内部推理循环调度，并进行事件的流式广播分发。
   *
   * @param transientSkillContent - 可选。临时技能规范内容
   */
  private async runInternalGeneration(transientSkillContent?: string): Promise<void> {
    let hasError = false;
    try {
      // 订阅并逐步消费大脑层抛出的推理事件，对外分发统一的 'agent_event'
      for await (const event of this.agentLoop.chat(transientSkillContent, this.tracer, this.llmConfig)) {
        this.emit('agent_event', event);
      }
    } catch (error: unknown) {
      hasError = true;
      const message = error instanceof Error ? error.message : String(error);
      this.emit('agent_event', {
        type: 'error',
        message
      });
    } finally {
      this.isGenerating = false;

      // 判定后续是否会触发自唤醒级联，若不会则在此 emit 'complete'。
      // 【非对称契约说明】：若推理期间抛出 error 异常，将直接由 'error' 广播事件接管
      // 且直接由终端捕获并恢复 stdin，故无需（也不应该）在此处重复发送 'complete'。
      const willWakeup = !hasError && this.hasPendingAsyncNotification && this.autoWakeupCount < 3;
      if (!hasError && !willWakeup) {
        this.emit('agent_event', { type: 'complete' });
      }

      // 检测本轮推理生成期间是否积压了新的后台通知事件，延迟到下一 Tick 处理，防止爆栈
      process.nextTick(() => {
        if (!this.isGenerating && this.hasPendingAsyncNotification) {
          this.hasPendingAsyncNotification = false;

          if (this.autoWakeupCount >= 3) {
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
            // 使用统一日志单例 logger 打印自唤醒推理失败错误
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
      this.hasPendingAsyncNotification = true;
      return;
    }

    // 限制连续自动唤醒的最大上限（无人值守防御）
    if (this.autoWakeupCount >= 3) {
      this.emit('agent_event', {
        type: 'error',
        message: '[系统提示] 检测到连续自动唤醒次数已达上限（3次），已暂停自动唤醒，等待人工介入。'
      });
      this.hasPendingAsyncNotification = false;
      return;
    }

    this.autoWakeupCount++;
    // 异步调起后台任务更新研判
    this.runInternalGeneration().catch((err: unknown) => {
      // 使用统一日志单例 logger 打印自动唤醒推理执行失败错误
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
   * 使用互斥队列将提炼记忆安全追加写入长期记忆文件。
   *
   * @param text - 待追加写入的文本
   * @returns 互斥写入执行完毕的 Promise
   */
  private queueWrite(text: string): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(async () => {
        const dir = path.dirname(this.memoryFilePath);
        if (!fs.existsSync(dir)) {
          await fs.promises.mkdir(dir, { recursive: true });
        }
        await fs.promises.appendFile(this.memoryFilePath, text, 'utf-8');

        // 自动触发向量化同步 upsert
        await this.syncNewMemoryToVectorDb(text);
      })
      .catch((error) => {
        // 使用统一日志单例 logger 打印写入长期记忆文件发生错误
        logger.error('[SessionManager] 写入长期记忆文件发生错误:', error);
      });
    return this.writeQueue;
  }

  /**
   * 将记忆文本拆分为独立的语义切片。
   * 支持按行（即以 `- **` 开头的记忆要点条目）进行拆分。
   *
   * @param text - 长期记忆文本
   * @returns 拆分后的语义切片数组
   */
  public chunkMemoryText(text: string): string[] {
    if (!text) {
      return [];
    }
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('- **'));
  }

  /**
   * 对文本切片列表分批生成 Embedding 向量。
   * DashScope text-embedding-v3 单次 batch 上限为 10，超出时自动拆批串行调用。
   *
   * @param chunks - 待向量化的文本切片列表
   * @returns 与 chunks 等长的向量数组
   */
  private async batchEmbeddings(chunks: string[]): Promise<number[][]> {
    // 每批最多 10 条，与 DashScope API 限制对齐
    const BATCH_SIZE = 10;
    const result: number[][] = [];
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const batchEmbeddings = await this.embedding.generateEmbeddings(batch);
      result.push(...batchEmbeddings);
    }
    return result;
  }

  /**
   * 将新增的记忆事实同步切片并 upsert 存入向量数据库中。
   *
   * @param text - 新写入的记忆文本
   */
  private async syncNewMemoryToVectorDb(text: string): Promise<void> {
    try {
      const chunks = this.chunkMemoryText(text);
      if (chunks.length === 0) {
        return;
      }
      // 分批调用避免超过 DashScope batch size 上限
      const embeddings = await this.batchEmbeddings(chunks);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vector = embeddings[i];
        if (vector && vector.length > 0) {
          const id = crypto.createHash('md5').update(chunk).digest('hex');
          await this.vectorDb.add(id, chunk, vector);
        }
      }
    } catch (error) {
      // 使用统一日志单例 logger 打印长期记忆增量同步向量库失败错误
      logger.error('[SessionManager] 长期记忆增量同步向量库失败:', error);
    }
  }

  /**
   * 如果本地向量库内容为空且物理长期记忆文件存在，则在后台异步运行增量重建。
   */
  private async rebuildVectorDbIfEmpty(): Promise<void> {
    try {
      const dbCount = await this.vectorDb.count();
      if (dbCount === 0) {
        if (fs.existsSync(this.memoryFilePath)) {
          const fileContent = await fs.promises.readFile(this.memoryFilePath, 'utf-8');
          const chunks = this.chunkMemoryText(fileContent);
          if (chunks.length > 0) {
            // 使用统一日志单例 logger 打印向量库重建开始信息
            logger.info(`[SessionManager] 检测到向量库为空，开始从 MEMORY.md 重建，共 ${chunks.length} 个切片...`);
            // 分批调用避免超过 DashScope batch size 上限
            const embeddings = await this.batchEmbeddings(chunks);
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              const vector = embeddings[i];
              if (vector && vector.length > 0) {
                const id = crypto.createHash('md5').update(chunk).digest('hex');
                await this.vectorDb.add(id, chunk, vector);
              }
            }
            // 使用统一日志单例 logger 打印长期记忆向量库重建完成信息
            logger.info('[SessionManager] 长期记忆向量库重建完成。');
          }
        }
      }
    } catch (error) {
      // 使用统一日志单例 logger 打印自动重建向量数据库失败错误
      logger.error('[SessionManager] 自动重建向量数据库失败:', error);
    }
  }

  /**
   * 使用隔离的子智能体在后台异步运行自省提炼。
   *
   * @param history - 对话历史消息
   */
  private async triggerMemoryRefinementAsync(history: ChatMessage[]): Promise<void> {
    try {
      await this.runMemoryRefinementSubAgent(history);
    } catch (error) {
      // 使用统一日志单例 logger 打印子智能体长期记忆自省失败错误
      logger.error('[SessionManager] 子智能体长期记忆自省自损失败:', error);
    }
  }

  /**
   * 实例化隔离的子智能体运行自省提炼。
   *
   * @param history - 对话历史消息
   */
  private async runMemoryRefinementSubAgent(history: ChatMessage[]): Promise<void> {
    const historyText = history
      .map(m => {
        let contentText = '';
        if (m.content !== null && m.content !== undefined) {
          if (typeof m.content === 'string') {
            contentText = m.content;
          } else {
            contentText = JSON.stringify(m.content);
          }
        }
        if (m.tool_calls && m.tool_calls.length > 0) {
          contentText += `\n[调用工具]: ${JSON.stringify(m.tool_calls)}`;
        }
        return `[${m.role}]: ${contentText}`;
      })
      .join('\n\n');

    const prompt = `您是一个长期记忆提炼助手。下面是当前会话的对话历史。请仔细阅读并提炼出对于未来开发有长期保留价值的事实、用户偏好或关键教训。

历史对话内容：
${historyText}

请遵循以下规则提炼并调用 writeMemoryFile 保存：
1. 提炼结果应当精炼为要点列表，每条一个独立知识点，且条目之间空一行，总数不超过 5 条。
2. 每一个要点开头使用加粗的 4-6 个字总结核心主题作为视觉锚点，格式如：- **核心主题**：事实描述。
3. 英文前后空一格，始终使用简体中文。
4. 只返回提炼后的无序列表，不要包含任何前导词、总结词。
5. 提炼完毕后，请务必直接调用 writeMemoryFile 工具将这些要点列表保存。
6. 如果没有发现任何有保留价值的事实或关键信息，请不要调用工具。`;

    // 1. 派生干净的隔离 SessionContext
    const subContext = new SessionContext();
    if (this.context.appConfig) {
      subContext.appConfig = this.context.appConfig;
    }
    // 注入 Initial User Prompt
    subContext.addMessage({ role: 'user', content: prompt });

    // 2. 构造只读/写工具注册表
    const subToolRegistry = new MemoryRefinementToolRegistry(async (content) => {
      await this.queueWrite(`\n\n${content.trim()}\n`);
    });

    // 3. 实例化专用的沙箱追踪器，使用注入的工作区绝对目录
    const subBaseDir = this.context.appConfig ? this.context.appConfig.workspace : process.cwd();
    const subTracer = new AgentTracer(subBaseDir, subContext.getSessionId());

    // 4. 初始化空的 PluginRegistry
    const emptyPluginRegistry = new PluginRegistry();

    // 5. 实例化专为子智能体隔离上下文服务的四大领域服务，避免对主会话的串扰及多余的主会话落盘
    const subRuleManager = new RuleManager(subContext);
    const subContextRepo = new ContextRepository(subContext, undefined, true);
    const subToolDispatcher = new ToolDispatcher(subContext);
    const subCompactionService = new CompactionService(subContext, this.driver, subContextRepo);

    // 6. 实例化隔离的子 AgentLoop，限制最大步数为 3 轮防止无限循环
    const forkedAgent = new AgentLoop({
      toolRegistry: subToolRegistry,
      context: subContext,
      driver: this.driver,
      contextAdapter: this.contextAdapter,
      ruleManager: subRuleManager,
      contextRepo: subContextRepo,
      toolDispatcher: subToolDispatcher,
      compactionService: subCompactionService,
      pluginRegistry: emptyPluginRegistry,
      maxIterations: 3
    });

    // 7. 用 for await 驱动子智能体自旋并消费其 chat 异步生成器
    const generator = forkedAgent.chat('', subTracer, this.llmConfig);
    for await (const chunk of generator) {
      // 子智能体运行过程静默输出，不需要在此处将自提炼流输出给前台用户
      void chunk;
    }
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
}

/**
 * 长期记忆提炼自省任务专属的受限工具注册表。
 * 仅且唯一提供 writeMemoryFile 追加长期记忆能力，且锁定其安全属性为 safe，
 * 规避自省智能体执行完写盘后误触 PostRunHook 的代码编译/Lint 质检开销。
 */
class MemoryRefinementToolRegistry implements ToolRegistryPort {
  /** 代理执行物理写入的回调函数 */
  private writeMemoryFn: (content: string) => Promise<void>;

  /**
   * 初始化专用的受限工具注册表。
   *
   * @param writeMemoryFn - 代理的物理追加写入函数
   */
  constructor(writeMemoryFn: (content: string) => Promise<void>) {
    this.writeMemoryFn = writeMemoryFn;
  }

  /**
   * 获取当前提炼自省任务可用的工具定义。
   *
   * @returns 仅包含 writeMemoryFile 工具定义的数组
   */
  public async getTools(): Promise<unknown[]> {
    return [
      {
        type: 'function',
        function: {
          name: 'writeMemoryFile',
          description: '追加并保存提炼后的长期记忆。此工具仅可被用于在提炼结束后追加并写入重要记忆，请提供精炼的要点列表，每条一个独立知识点，条目之间空一行。在每个要点列表的开头，用加粗的 4-6 个字总结该条目的核心主题，作为视觉锚点。',
          parameters: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: '追加写入的长期记忆内容，必须使用简体中文，且条目之间空一行，中英文之间加空格。'
              }
            },
            required: ['content']
          }
        }
      }
    ];
  }

  /**
   * 执行指定的工具调用。
   *
   * @param functionName - 调用的工具名称
   * @param functionArgs - 工具参数
   * @returns 执行成功后的确认消息
   * @throws 当被调用了非 writeMemoryFile 工具时抛出未知工具异常
   */
  public async callTool(
    functionName: string,
    functionArgs: Record<string, unknown>
  ): Promise<unknown> {
    if (functionName === 'writeMemoryFile') {
      const content = functionArgs.content;
      if (typeof content !== 'string') {
        throw new Error('content 参数缺失或非字符串');
      }
      await this.writeMemoryFn(content);
      return '成功追加写入记忆。';
    }
    throw new Error(`未知的工具名称："${functionName}"`);
  }

  /**
   * 根据工具名称获取本地工具实例的元信息。
   * 特别将 writeMemoryFile 工具的安全类别属性设为 safe，避开代码 Lint 编译检查。
   *
   * @param name - 工具名称
   * @returns 包含安全类别元信息的对象，若未找到则返回 undefined
   */
  public getTool(name: string): { securityCategory: string; name: string } | undefined {
    if (name === 'writeMemoryFile') {
      return { securityCategory: 'safe', name: 'writeMemoryFile' };
    }
    return undefined;
  }

  /**
   * 优雅断开并物理清理工具连接。本受限注册表无外部连接，为 no-op。
   */
  public async close(): Promise<void> {
    // 提炼专属工具，无 MCP 连接需要清理，为 no-op
  }
}
