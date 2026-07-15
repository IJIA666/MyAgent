import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AppConfig, LlmConfig } from '../../../config/index.js';
import { logger } from '../../../utils/logger.js';
import { SessionContext } from '../../domain/context.js';
import { AgentTracer } from '../../domain/tracer.js';
import { AgentLoop } from '../engine/agent-loop.js';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import { RuleManager } from './RuleManager.js';
import { ContextRepository } from './ContextRepository.js';
import { ToolDispatcher } from '../engine/ToolDispatcher.js';
import { CompactionService } from './CompactionService.js';
import type { ChatMessage, LlmPort } from '../../../ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import type { EmbeddingPort } from '../../../ports/driven/llm/EmbeddingPort.js';
import type { VectorDbPort } from '../../../ports/driven/db/VectorDbPort.js';
import type { ContextAdapter } from '../../../ports/driven/session/ContextAdapter.js';
import type { ToolRegistryPort, ToolMetadata } from '../../../ports/driven/tools/ToolRegistryPort.js';
import type { ToolExecutionOutcome, ToolExecutionEffect } from '../../../adapters/tools/tool-types.js';

/**
 * 长期记忆管理与提炼自省领域服务。
 * 负责物理记忆文件的互斥追加写入、切片（chunking）、向量化生成、向量库自动同步重建，
 * 以及在后台启动隔离的子智能体进行记忆分析和提炼自省。
 */
export class MemoryService {
  /** 本地向量数据库存储服务契约 */
  private vectorDb: VectorDbPort;
  /** 文本嵌入生成契约 */
  private embedding: EmbeddingPort;
  /** 长期记忆文件的物理路径 */
  private memoryFilePath: string;
  /** 应用程序全局系统配置项 */
  private appConfig: AppConfig;
  /** 大语言模型的核心驱动模块 */
  private driver: LlmPort;
  /** 上下文管理与组装适配器 */
  private contextAdapter: ContextAdapter;
  /** 子会话压缩复用的 Token 估算契约 */
  private tokenEstimator: TokenEstimatorPort;
  /** 长期记忆提炼自省任务的物理追加写入队列 */
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * 构造函数。
   *
   * @param vectorDb - 本地向量数据库存储服务契约
   * @param embedding - 文本嵌入生成契约
   * @param appConfig - 应用程序系统配置项
   * @param driver - 大语言模型驱动接口适配器实例
   * @param contextAdapter - 上下文适配器契约
   * @param tokenEstimator - Token 估算契约
   */
  constructor(
    vectorDb: VectorDbPort,
    embedding: EmbeddingPort,
    appConfig: AppConfig,
    driver: LlmPort,
    contextAdapter: ContextAdapter,
    tokenEstimator: TokenEstimatorPort
  ) {
    this.vectorDb = vectorDb;
    this.embedding = embedding;
    this.appConfig = appConfig;
    this.driver = driver;
    this.contextAdapter = contextAdapter;
    this.tokenEstimator = tokenEstimator;
    this.memoryFilePath = path.resolve(appConfig.workspace, '.agent/MEMORY.md');
  }

  /**
   * 获取当前记忆文件的物理路径（主要供给拦截器插件定位使用）。
   *
   * @returns 物理记忆文件路径的绝对字符串
   */
  public getMemoryFilePath(): string {
    return this.memoryFilePath;
  }

  /**
   * 使用互斥写队列，向物理长期记忆文件追加写入自省提炼要点，并链式同步至向量库。
   *
   * @param text - 待追加写入的文本
   * @returns 互斥写入执行完毕的 Promise
   */
  public queueWrite(text: string): Promise<void> {
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
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[MemoryService] 写入长期记忆文件发生错误: ${msg}`);
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
    return await this.embedding.generateEmbeddings(chunks);
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
      const embeddings = await this.batchEmbeddings(chunks);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vector = embeddings[i];
        if (vector && vector.length > 0) {
          const id = crypto.createHash('md5').update(chunk).digest('hex');
          await this.vectorDb.add(id, chunk, vector);
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[MemoryService] 长期记忆增量同步向量库失败: ${msg}`);
    }
  }

  /**
   * 如果本地向量库内容为空且物理长期记忆文件存在，则在后台异步运行增量重建。
   *
   * @returns 向量库重建完成的 Promise
   */
  public async rebuildVectorDbIfEmpty(): Promise<void> {
    try {
      const dbCount = await this.vectorDb.count();
      if (dbCount === 0) {
        if (fs.existsSync(this.memoryFilePath)) {
          const fileContent = await fs.promises.readFile(this.memoryFilePath, 'utf-8');
          const chunks = this.chunkMemoryText(fileContent);
          if (chunks.length > 0) {
            logger.info(`[MemoryService] 检测到向量库为空，开始从 MEMORY.md 重建，共 ${chunks.length} 个切片...`);
            const embeddings = await this.batchEmbeddings(chunks);
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              const vector = embeddings[i];
              if (vector && vector.length > 0) {
                const id = crypto.createHash('md5').update(chunk).digest('hex');
                await this.vectorDb.add(id, chunk, vector);
              }
            }
            logger.info('[MemoryService] 长期记忆向量库重建完成。');
          }
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[MemoryService] 自动重建向量数据库失败: ${msg}`);
    }
  }

  /**
   * 使用隔离的子智能体在后台异步运行自省提炼。
   *
   * @param history - 对话历史消息
   * @param llmConfig - 当前实时的大语言模型配置
   */
  public async triggerMemoryRefinementAsync(history: ChatMessage[], llmConfig: LlmConfig): Promise<void> {
    try {
      await this.runMemoryRefinementSubAgent(history, llmConfig);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[MemoryService] 子智能体长期记忆自省自损失败: ${msg}`);
    }
  }

  /**
   * 运行自省子智能体的核心编排步骤。
   *
   * @param history - 对话历史消息
   * @param llmConfig - 当前实时的大语言模型配置
   */
  private async runMemoryRefinementSubAgent(history: ChatMessage[], llmConfig: LlmConfig): Promise<void> {
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
    if (this.appConfig) {
      subContext.appConfig = this.appConfig;
      // 内部子上下文复用同一语言偏好，但不继承主会话消息和规则缓存。
      subContext.updateSystemPrompt();
    }
    subContext.addMessage({ role: 'user', content: prompt });

    // 2. 构造只读/写工具注册表，物理写入指向当前服务的队列
    const subToolRegistry = new MemoryRefinementToolRegistry(async (content) => {
      await this.queueWrite(`\n\n${content.trim()}\n`);
    });

    // 3. 实例化专用的沙箱追踪器
    const subBaseDir = this.appConfig ? this.appConfig.workspace : process.cwd();
    const subTracer = new AgentTracer(subBaseDir, subContext.getSessionId(), this.appConfig?.diagnostics);

    // 4. 初始化空的 PluginRegistry
    const emptyPluginRegistry = new PluginRegistry();

    // 5. 实例化隔离的子领域服务
    const subRuleManager = new RuleManager(subContext);
    const subContextRepo = new ContextRepository(subContext, undefined, true);
    const subToolDispatcher = new ToolDispatcher(subContext, subToolRegistry);
    const subCompactionService = new CompactionService(
      subContext,
      this.driver,
      subContextRepo,
      this.tokenEstimator
    );

    // 6. 实例化隔离的子 AgentLoop，限制最大步数为 3 轮
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

    const subAgentTimeoutMs = this.appConfig.runtimeLimits.subAgentTimeoutMs;
    const subAgentAC = new AbortController();
    const timeoutId = setTimeout(() => {
      subAgentAC.abort(new Error('SubAgentIntrospectionTimeout'));
    }, subAgentTimeoutMs);

    try {
      // 7. 用 for await 驱动子智能体并静默消费其输出
      const generator = forkedAgent.chat('', subTracer, llmConfig, { signal: subAgentAC.signal });
      for await (const chunk of generator) {
        void chunk;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const isAbort = error instanceof Error && (error.name === 'AbortError' || msg.includes('Abort') || msg.includes('abort') || msg.includes('IntrospectionTimeout'));
      if (isAbort) {
        logger.warn(`[MemoryService] 子智能体自省超时或被取消，已静默中断: ${msg}`);
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    // 8. 确保物理记忆文件异步追加写入以及向量数据库同步重建全部落盘完毕，避免单元测试或异步链路中出现未完成竞态
    await this.writeQueue;
  }
}

/**
 * 长期记忆提炼自省任务专属的受限工具注册表。
 * 仅且唯一提供 writeMemoryFile 追加长期记忆能力，且锁定其安全属性为 safe。
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
  ): Promise<ToolExecutionOutcome<unknown>> {
    if (functionName === 'writeMemoryFile') {
      const content = functionArgs.content;
      if (typeof content !== 'string') {
        throw new Error('content 参数缺失或非字符串');
      }
      await this.writeMemoryFn(content);
      const writeEffect: ToolExecutionEffect = {
        kind: 'write',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_write_tool'
      };
      return { value: '成功追加写入记忆。', effect: writeEffect };
    }
    throw new Error(`未知的工具名称："${functionName}"`);
  }

  /**
   * 根据工具名称获取本地工具实例的元信息。
   *
   * @param name - 工具名称
   * @returns 包含安全类别元信息的对象，若未找到则返回 undefined
   */
  public getTool(name: string): ToolMetadata | undefined {
    if (name === 'writeMemoryFile') {
      return { securityCategory: 'write', name: 'writeMemoryFile' };
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
