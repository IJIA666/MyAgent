import * as path from 'path';
import type { HookContext, Plugin } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import type { LlmPort, ChatMessage } from '../../ports/driven/LlmPort.js';
import type { EmbeddingPort } from '../../ports/driven/EmbeddingPort.js';
import type { VectorDbPort } from '../../ports/driven/VectorDbPort.js';

/**
 * 长期记忆自省与提炼插件。
 * 挂载于所有的核心生命周期节点，在会话结束时异步提炼有价值的知识和事实，并在模型推理前就地注入。
 */
export class LongTermMemoryPlugin implements Plugin {
  public readonly name = 'LongTermMemoryPlugin';
  public readonly weight = 50;

  private driver: LlmPort;
  private vectorDb: VectorDbPort;
  private embedding: EmbeddingPort;
  private memoryFilePath: string;
  private onSessionEndCallback?: (history: ChatMessage[]) => void;
  private refinePromise: Promise<void> = Promise.resolve();

  /**
   * 构造函数。
   *
   * @param driver - 大语言模型驱动接口适配器实例
   * @param vectorDb - 本地向量数据库存储服务契约
   * @param embedding - 文本嵌入生成契约
   * @param memoryFilePath - 可选。持久化长期记忆 file 路径，默认指向项目 .agent/MEMORY.md
   * @param onSessionEndCallback - 可选。会话结束后的异步自省提炼回调函数
   */
  constructor(
    driver: LlmPort,
    vectorDb: VectorDbPort,
    embedding: EmbeddingPort,
    memoryFilePath?: string,
    onSessionEndCallback?: (history: ChatMessage[]) => void
  ) {
    this.driver = driver;
    this.vectorDb = vectorDb;
    this.embedding = embedding;
    this.onSessionEndCallback = onSessionEndCallback;
    /* eslint-disable-next-line n/no-process-env */
    const baseDir = process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd();
    this.memoryFilePath = memoryFilePath || path.resolve(baseDir, '.agent/MEMORY.md');
  }

  public readonly hooks = {
    [HookEventName.BeforeModel]: async (context: HookContext, next: () => Promise<void>) => {
      await this.handleBeforeModel(context);
      await next();
    },
    [HookEventName.SessionEnd]: async (context: HookContext, next: () => Promise<void>) => {
      this.handleSessionEndAsync(context);
      await next();
    }
  };

  /**
   * 处理模型生成前的记忆召回与注入逻辑。
   *
   * @param context - 拦截执行的上下文对象
   */
  private async handleBeforeModel(context: HookContext): Promise<void> {
    if (!context.llmRequest || !context.llmRequest.messages) {
      return;
    }

    try {
      const history = context.sessionContext.getHistory();
      const userMessages = history.filter(m => m.role === 'user');
      const latestUserMessage = userMessages[userMessages.length - 1];

      if (!latestUserMessage || !latestUserMessage.content || typeof latestUserMessage.content !== 'string') {
        return;
      }

      // 防御性截断，最大截取 2000 字符，规避 API 成本与 token 溢出
      const queryText = latestUserMessage.content.substring(0, 2000);
      const queryVector = await this.embedding.generateEmbedding(queryText);
      const searchResults = await this.vectorDb.search(queryVector, 5);

      // 双重保险：过滤掉相似度 < 0.5 的低相关结果 (统一转换公式 similarity = 1 / (1 + distance))
      const validResults = searchResults.filter(r => r.score >= 0.5);

      if (validResults.length > 0) {
        const memoryBlocks = validResults.map(r => r.text).join('\n\n');
        const memoryPrompt = `\n\n<long-term-memory>\n${memoryBlocks}\n</long-term-memory>`;

        const systemMessage = context.llmRequest.messages.find(m => m.role === 'system');
        if (systemMessage) {
          systemMessage.content += memoryPrompt;
        } else {
          context.llmRequest.messages.unshift({
            role: 'system',
            content: memoryPrompt.trim()
          });
        }
      }
    } catch (error) {
      console.error('[LongTermMemoryPlugin] 语义召回或注入长期记忆失败:', error);
    }
  }

  /**
   * 处理会话结束时的异步自省提炼。
   *
   * @param context - 拦截执行的上下文对象
   */
  private handleSessionEndAsync(context: HookContext): void {
    const history = context.sessionContext.getHistory();
    // 过滤掉 system 消息，计算真实对话轮数
    const effectiveHistory = history.filter(m => m.role !== 'system');
    if (!effectiveHistory || effectiveHistory.length < 2) {
      return;
    }

    if (this.onSessionEndCallback) {
      const callback = this.onSessionEndCallback;
      this.refinePromise = Promise.resolve().then(async () => {
        try {
          await callback(history);
        } catch (error) {
          console.error('[LongTermMemoryPlugin] 自省提炼回调触发失败:', error);
        }
      });
    }
  }
}
