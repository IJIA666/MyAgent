import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { HookContext, Plugin } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import type { ChatMessage } from '../../ports/driven/LlmPort.js';
import type { EmbeddingPort } from '../../ports/driven/EmbeddingPort.js';
import type { VectorDbPort } from '../../ports/driven/VectorDbPort.js';
import { logger } from '../../utils/logger.js'; // 导入统一日志单例 logger

/**
 * 长期记忆自省与提炼插件。
 * 挂载于所有的核心生命周期节点，在会话结束时异步提炼有价值的知识和事实，并在模型推理前就地注入。
 */
export class LongTermMemoryPlugin implements Plugin {
  public readonly name = 'LongTermMemoryPlugin';
  public readonly weight = 50;

  private vectorDb: VectorDbPort;
  private embedding: EmbeddingPort;
  private memoryFilePath: string;
  private onSessionEndCallback?: (history: ChatMessage[]) => void;
  private refinePromise: Promise<void> = Promise.resolve();

  /**
   * 构造函数。
   *
   * @param vectorDb - 本地向量数据库存储服务契约
   * @param embedding - 文本嵌入生成契约
   * @param memoryFilePath - 可选。持久化长期记忆 file 路径，默认指向项目 .agent/MEMORY.md
   * @param onSessionEndCallback - 可选。会话结束后的异步自省提炼回调函数
   */
  constructor(
    vectorDb: VectorDbPort,
    embedding: EmbeddingPort,
    memoryFilePath?: string,
    onSessionEndCallback?: (history: ChatMessage[]) => void
  ) {
    this.vectorDb = vectorDb;
    this.embedding = embedding;
    this.onSessionEndCallback = onSessionEndCallback;
    this.memoryFilePath = memoryFilePath || path.resolve(process.cwd(), '.agent/MEMORY.md');
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

      // 并行开启向量检索路与物理文本关键字匹配路，并做单路容错保护
      let validVectorResults: Array<{ id: string; text: string; score: number }> = [];
      try {
        const queryVector = await this.embedding.generateEmbedding(queryText);
        const searchResults = await this.vectorDb.search(queryVector, 5);
        validVectorResults = searchResults.filter(r => r.score >= 0.5);
      } catch (vectorError) {
        // 使用统一日志单例 logger 打印向量检索失败错误
        logger.error('[LongTermMemoryPlugin] 向量检索路失败:', vectorError);
      }

      let keywordResults: Array<{ id: string; text: string }> = [];
      try {
        const keywords = this.extractKeywords(queryText);
        keywordResults = await this.searchMemoryByKeywords(keywords);
      } catch (keywordError) {
        // 使用统一日志单例 logger 打印关键字检索失败错误
        logger.error('[LongTermMemoryPlugin] 关键字检索路失败:', keywordError);
      }

      // 双路结果调用 RRF 排序重整，过滤保留排名前 5 的有效事实
      const fusedResults = this.reciprocalRankFusion(validVectorResults, keywordResults);
      const topResults = fusedResults.slice(0, 5);

      if (topResults.length > 0) {
        const memoryBlocks = topResults.map(r => r.text).join('\n\n');
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
      // 使用统一日志单例 logger 打印双路召回或注入长期记忆失败错误
      logger.error('[LongTermMemoryPlugin] 双路召回或注入长期记忆失败:', error);
    }
  }

  /**
   * 从用户输入中提取高优的技术关键标识符。
   * 使用三级级联捕获：反引号文本、大写驼峰标识词、常见文件名后缀。
   *
   * @param text - 用户原始输入文本
   * @returns 提纯去重后的关键词列表
   */
  public extractKeywords(text: string): string[] {
    if (!text) {
      return [];
    }
    const keywordsSet = new Set<string>();

    // 1. 反引号捕获: `([^`]+)`
    const backtickRegex = /`([^`]+)`/g;
    let match;
    while ((match = backtickRegex.exec(text)) !== null) {
      if (match[1]?.trim()) {
        keywordsSet.add(match[1].trim());
      }
    }

    // 2. 驼峰标识捕获: \b[A-Z][a-zA-Z0-9]{3,}\b
    const camelRegex = /\b[A-Z][a-zA-Z0-9]{3,}\b/g;
    while ((match = camelRegex.exec(text)) !== null) {
      if (match[0]?.trim()) {
        keywordsSet.add(match[0].trim());
      }
    }

    // 3. 物理文件名捕获: \b[a-zA-Z0-9_-]+\.(?:ts|js|json|md|py|go|java)\b
    const fileRegex = /\b[a-zA-Z0-9_-]+\.(?:ts|js|json|md|py|go|java)\b/g;
    while ((match = fileRegex.exec(text)) !== null) {
      if (match[0]?.trim()) {
        keywordsSet.add(match[0].trim());
      }
    }

    return Array.from(keywordsSet).filter(kw => kw.length > 0);
  }

  /**
   * 基于关键字匹配检索 MEMORY.md 物理 facts 文件。
   *
   * @param keywords - 关键词列表
   * @returns 匹配并降序排列的记忆片段列表
   */
  private async searchMemoryByKeywords(keywords: string[]): Promise<Array<{ id: string; text: string }>> {
    if (keywords.length === 0) {
      return [];
    }
    try {
      if (!fs.existsSync(this.memoryFilePath)) {
        return [];
      }
      const fileContent = await fs.promises.readFile(this.memoryFilePath, 'utf-8');
      
      const lines = fileContent
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.startsWith('- **'));

      const results: Array<{ text: string; matchCount: number }> = [];

      for (const line of lines) {
        let matchCount = 0;
        for (const kw of keywords) {
          if (line.includes(kw)) {
            matchCount++;
          }
        }
        if (matchCount > 0) {
          results.push({ text: line, matchCount });
        }
      }

      return results
        .sort((a, b) => b.matchCount - a.matchCount)
        .map(r => {
          const id = crypto.createHash('md5').update(r.text).digest('hex');
          return { id, text: r.text };
        });
    } catch (error) {
      // 使用统一日志单例 logger 打印物理关键字检索失败错误
      logger.error('[LongTermMemoryPlugin] 物理关键字检索失败:', error);
      return [];
    }
  }

  /**
   * 倒数排名融合（RRF - Reciprocal Rank Fusion）算法。
   * 用于无偏地合并向量检索路与物理文本检索路的不同度量结果。
   *
   * @param vectorResults - 向量数据库检索返回的排位结果列表
   * @param keywordResults - 物理文本关键字检索返回的排位结果列表
   * @returns 经过 RRF 融合重排后的结果列表
   */
  public reciprocalRankFusion(
    vectorResults: Array<{ id: string; text: string; score: number }>,
    keywordResults: Array<{ id: string; text: string }>
  ): Array<{ id: string; text: string; score: number }> {
    const k = 60;
    const scoreMap = new Map<string, { text: string; rrfScore: number }>();

    // 1. 处理向量检索路
    vectorResults.forEach((item, index) => {
      const rank = index + 1;
      const current = scoreMap.get(item.id) || { text: item.text, rrfScore: 0 };
      current.rrfScore += 1 / (k + rank);
      scoreMap.set(item.id, current);
    });

    // 2. 处理物理关键字检索路
    keywordResults.forEach((item, index) => {
      const rank = index + 1;
      const current = scoreMap.get(item.id) || { text: item.text, rrfScore: 0 };
      current.rrfScore += 1 / (k + rank);
      scoreMap.set(item.id, current);
    });

    // 3. 将 Map 转换为数组并降序排列，统一赋分并排重
    return Array.from(scoreMap.entries())
      .map(([id, val]) => ({
        id,
        text: val.text,
        score: val.rrfScore
      }))
      .sort((a, b) => b.score - a.score);
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
          // 使用统一日志单例 logger 打印自省提炼回调触发失败错误
          logger.error('[LongTermMemoryPlugin] 自省提炼回调触发失败:', error);
        }
      });
    }
  }
}
