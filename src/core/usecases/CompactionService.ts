import { resolve } from 'path';
import type { ChatMessage, LlmPort } from '../../ports/driven/LlmPort.js';
import { SessionContext } from '../domain/context.js';
import { buildCompactionSummaryPrompt, buildStaticFallbackSummary } from './prompts.js';
import { ContextRepository } from './ContextRepository.js';
import { logger } from '../../utils/logger.js'; // 导入统一日志单例 logger
import type { ToolRegistryPort } from '../../ports/driven/ToolRegistryPort.js';

/**
 * 负责防范 Token 爆仓及上下文的截断与提炼。
 */
export class CompactionService {
  /** 连续上下文压缩失败的次数，用于执行熔断防护 */
  private compactionFailures = 0;
  /** 上次提炼时的 Token 水平 */
  private lastSummaryTokenLevel = 0;
  /** 后台提炼是否在途 */
  private isCompacting = false;

  private compactionRetainCount = 4;
  private compactionTriggerDelta = 5000;
  private compactionFailureLimit = 3;
  private compactionRecentFilesLimit = 5;

  /**
   * 实例初始化。
   *
   * @param context - 会话上下文管理实例
   * @param driver - 大语言模型驱动接口
   * @param contextRepo - 会话状态仓储实例
   * @param toolRegistry - 可选的工具注册表端口
   */
  constructor(
    private context: SessionContext,
    private driver: LlmPort,
    private contextRepo: ContextRepository,
    private toolRegistry?: ToolRegistryPort
  ) {
    const limits = context.appConfig?.runtimeLimits;
    if (limits) {
      this.compactionRetainCount = limits.compactionRetainCount;
      this.compactionTriggerDelta = limits.compactionTriggerDelta;
      this.compactionFailureLimit = limits.compactionFailureLimit;
      this.compactionRecentFilesLimit = limits.compactionRecentFilesLimit;
    }
  }

  /**
   * 执行无延迟硬截断（Pointer-based Truncation）。
   * 丢弃中间消息并在头部拼接 session_summary.md。
   * 
   * @returns 压缩轮换是否成功
   */
  public async compact(): Promise<boolean> {
    try {
      const fullHistory = this.context.getHistory();
      if (fullHistory.length <= this.compactionRetainCount) return false;

      // 指针级截断：保留最后 compactionRetainCount 条消息
      this.context.truncateHistory(this.compactionRetainCount);

      // 如果兜底也没有摘要，则塞一个默认兜底
      if (!this.context.getCheckpointSummary()) {
        const fallback = buildStaticFallbackSummary(undefined, undefined);
        this.context.setCheckpointSummary(fallback);
      }

      await this.contextRepo.saveState();
      return true;
    } catch (e) {
      logger.warn(`[CompactionService] 上下文硬截断失败: ${e}`);
      return false;
    }
  }

  /**
   * 触发后台异步提炼摘要（afterTurn 机制）。
   *
   * @param currentTokens - 当前的 Token 数量
   * @returns 无返回值的 Promise
   */
  public async triggerAsyncCompactionIfNeeded(currentTokens: number): Promise<void> {
    if (this.isCompacting) return;
    
    // 当累积增量 Token 达到指定配置差额时触发后台提炼任务
    if (currentTokens - this.lastSummaryTokenLevel >= this.compactionTriggerDelta) {
      this.isCompacting = true;
      try {
        const fullHistory = this.context.getHistory();
        if (fullHistory.length <= 2) return;
        const messagesToCompact = fullHistory.slice(1);
        const summaryPrompt = buildCompactionSummaryPrompt(messagesToCompact);
        
        const summary = await this.driver.generateSummaryAsync(summaryPrompt);
        if (summary && summary.trim().length > 0) {
          this.context.setCheckpointSummary(summary.trim());
          this.lastSummaryTokenLevel = currentTokens;
          const recentFiles = this.collectReadToolFilePaths(messagesToCompact);
          this.context.setRecentFiles(recentFiles);
          await this.contextRepo.saveState();
          this.compactionFailures = 0;
        }
      } catch (e) {
        logger.warn(`[CompactionService] 异步提炼失败: ${e}`);
        this.compactionFailures++;
        if (this.compactionFailures >= this.compactionFailureLimit) {
          // 连续达到失败上限次数，使用兜底摘要
          const fallback = buildStaticFallbackSummary('后台异步失败', '无响应');
          this.context.setCheckpointSummary(fallback);
        }
      } finally {
        this.isCompacting = false;
      }
    }
  }

  /**
   * 从待剔除的历史消息中，反向扫描找出最近大模型读写过的核心代码文件路径。
   *
   * @param messages - 待扫描的历史消息数组
   * @returns 收集到的核心代码文件路径数组（去重后）
   */
  /**
   * 从待剔除的历史消息中，反向扫描找出最近大模型读写过的核心代码文件绝对路径。
   *
   * @param messages - 待扫描的历史消息数组
   * @returns 收集到的核心代码文件绝对路径数组（去重后）
   */
  public collectReadToolFilePaths(messages: ChatMessage[]): string[] {
    const files = new Set<string>();
    const rootDir = this.context.appConfig?.workspace || process.cwd();

    const addPathOrPaths = (pathVal: string) => {
      const trimmed = pathVal.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            for (const p of parsed) {
              if (typeof p === 'string' && p.trim()) {
                files.add(resolve(rootDir, p.trim()));
              }
            }
            return;
          }
        } catch {
          // 忽略并降级为逗号拆分
        }
      }

      const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean);
      for (const p of parts) {
        files.add(resolve(rootDir, p));
      }
    };

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

    for (let i = messages.length - 1; i >= 0; i--) {
      if (files.size >= this.compactionRecentFilesLimit) break;
      const msg = messages[i];
      const customMsg = msg as {
        tool_calls?: Array<{
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
      if (msg.role === 'assistant' && customMsg.tool_calls && Array.isArray(customMsg.tool_calls)) {
        for (const tc of customMsg.tool_calls) {
          if (tc.function && tc.function.name) {
            try {
              const name = tc.function.name;
              const args = JSON.parse(tc.function.arguments || '{}');
              if (!args || typeof args !== 'object') continue;

              let pathKey: string | undefined;
              // 优先查找工具注册表元数据声明
              if (this.toolRegistry) {
                const meta = this.toolRegistry.getTool(name);
                if (meta && meta.filePathParamKey) {
                  pathKey = meta.filePathParamKey;
                }
              }

              if (pathKey && typeof args[pathKey] === 'string') {
                addPathOrPaths(args[pathKey]);
              } else {
                // 启发式参数名解析
                for (const key of Object.keys(args)) {
                  if (heuristicKeys.has(key) && typeof args[key] === 'string') {
                    addPathOrPaths(args[key]);
                  }
                }
              }

              if (files.size >= this.compactionRecentFilesLimit) break;
            } catch {
              // 忽略参数反序列化失败 of 异常
            }
          }
        }
      }
    }

    return Array.from(files);
  }
}
