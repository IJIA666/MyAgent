import { resolve, relative } from 'path';
import type { ChatMessage, LlmPort } from '../../../ports/driven/llm/LlmPort.js';
import { SessionContext, StoredChatMessage } from '../../domain/context.js';
import { buildCompactionSummaryPrompt, buildStaticFallbackSummary } from './prompts.js';
import { ContextRepository } from './ContextRepository.js';
import { logger } from '../../../utils/logger.js'; // 导入统一日志单例 logger
import type { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';

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

  /** 保留最近历史消息条数默认上限，由 4 扩大至 8 以保留充足 ReAct 上下文 */
  private compactionRetainCount = 8;
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
   * 执行首尾双保中段有损压缩（Middle Compaction）。
   * 保留 System 提示词、第一轮交互与最近第 N 轮交互，将中段消息提炼总结为单条摘要消息进行原位合并替代。
   * 
   * @returns 压缩轮换是否成功
   */
  public async compact(): Promise<boolean> {
    try {
      const fullHistory = this.context.getHistory();
      if (fullHistory.length <= 4) {
        return false;
      }

      // 1. 界定首部保护区截止点
      // 必须包含 index 0 (System Prompt)，以及首轮交互：
      // 首个 user (通常在 index 1) -> 紧随其后的首个 assistant (含 tool_calls) -> 紧随其后的首个 tool (或多个 tool_result)
      let headEndIndex = 0;
      let foundFirstUser = false;
      let foundFirstAssistant = false;

      for (let i = 1; i < fullHistory.length; i++) {
        const msg = fullHistory[i];
        if (msg.role === 'user' && !foundFirstUser) {
          foundFirstUser = true;
          headEndIndex = i;
        } else if (msg.role === 'assistant' && foundFirstUser && !foundFirstAssistant) {
          foundFirstAssistant = true;
          headEndIndex = i;
        } else if (msg.role === 'tool' && foundFirstAssistant) {
          headEndIndex = i;
        } else if (foundFirstAssistant && msg.role !== 'tool') {
          // 当遇到非 tool 消息，说明首轮 tool_result 结算结束，跳出
          break;
        }
      }

      // 2. 界定尾部保护区起始点
      // 从后往前数第 compactionRetainCount 个 role === "user" 消息的起点索引
      let userCount = 0;
      let tailStartIndex = -1;
      for (let i = fullHistory.length - 1; i >= 1; i--) {
        if (fullHistory[i].role === 'user') {
          userCount++;
          if (userCount === this.compactionRetainCount) {
            tailStartIndex = i;
            break;
          }
        }
      }

      // 3. 边界检查：若没有足够的 user 消息，或者首尾保护区重叠交叉，直接安全跳过
      if (tailStartIndex === -1 || tailStartIndex <= headEndIndex) {
        return false;
      }

      // 4. 精确划定中段有损压缩区
      const middleMessages = fullHistory.slice(headEndIndex + 1, tailStartIndex);
      if (middleMessages.length === 0) {
        return false;
      }

      // 5. 提炼中段消息
      let summaryText = '';
      try {
        const summaryPrompt = buildCompactionSummaryPrompt(middleMessages);
        summaryText = await this.driver.generateSummaryAsync(summaryPrompt);
      } catch (summaryError: unknown) {
        logger.warn(`[CompactionService] 提炼中段摘要失败，执行兜底：${summaryError}`);
      }

      if (!summaryText || summaryText.trim().length === 0) {
        summaryText = buildStaticFallbackSummary(undefined, undefined);
      }

      // 组装中段总结消息 (Summary Notice)
      const summaryNotice: StoredChatMessage = {
        role: 'user',
        content: `[Summary of Previous Operations: ${summaryText.trim()}]`
      };

      // 6. 重组历史消息：[首部保护] + [中段总结] + [尾部保护]
      const newHistory = [
        ...fullHistory.slice(0, headEndIndex + 1),
        summaryNotice,
        ...fullHistory.slice(tailStartIndex)
      ];

      this.context.updateHistory(newHistory);
      await this.contextRepo.saveState();
      return true;
    } catch (e) {
      logger.warn(`[CompactionService] 首尾双保中段有损压缩失败: ${e}`);
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
          const recentFiles = this.collectRecentFileOperations(messagesToCompact);
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
   * 从待剔除的历史消息中，反向扫描找出最近大模型读写过的核心代码文件绝对路径及其操作类型。
   *
   * @param messages - 待扫描的历史消息数组
   * @returns 收集到的核心代码文件路径及操作类型数组（去重后）
   */
  public collectRecentFileOperations(messages: ChatMessage[]): { filePath: string; opType: 'read' | 'edit' }[] {
    const filesMap = new Map<string, { filePath: string; opType: 'read' | 'edit' }>();
    const rootDir = this.context.appConfig?.workspace || process.cwd();

    const getOpType = (name: string): 'read' | 'edit' => {
      if (this.toolRegistry) {
        const meta = this.toolRegistry.getTool(name);
        if (meta && meta.securityCategory) {
          return meta.securityCategory === 'write' ? 'edit' : 'read';
        }
      }
      if (name === 'editFile' || name === 'applyPatch' || name === 'writeFile') {
        return 'edit';
      }
      return 'read';
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
      if (filesMap.size >= this.compactionRecentFilesLimit) {
        // 如果已满，但历史中仍然有已存在文件的修改记录，我们仍需允许状态升级，因此不能直接 break
      }
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
              if (this.toolRegistry) {
                const meta = this.toolRegistry.getTool(name);
                if (meta && meta.filePathParamKey) {
                  pathKey = meta.filePathParamKey;
                }
              }

              const opType = getOpType(name);

              const addPathOrPaths = (pathVal: string) => {
                const trimmed = pathVal.trim();
                const pathsList: string[] = [];
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                  try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) {
                      for (const p of parsed) {
                        if (typeof p === 'string' && p.trim()) {
                          pathsList.push(resolve(rootDir, p.trim()));
                        }
                      }
                    }
                  } catch {
                    // 忽略并降级
                  }
                }
                if (pathsList.length === 0) {
                  const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean);
                  for (const p of parts) {
                    pathsList.push(resolve(rootDir, p));
                  }
                }

                for (const absolutePath of pathsList) {
                  if (filesMap.has(absolutePath)) {
                    const existing = filesMap.get(absolutePath)!;
                    if (existing.opType === 'read' && opType === 'edit') {
                      filesMap.set(absolutePath, { filePath: absolutePath, opType: 'edit' });
                    }
                  } else {
                    if (filesMap.size < this.compactionRecentFilesLimit) {
                      filesMap.set(absolutePath, { filePath: absolutePath, opType });
                    }
                  }
                }
              };

              if (pathKey && typeof args[pathKey] === 'string') {
                addPathOrPaths(args[pathKey]);
              } else {
                for (const key of Object.keys(args)) {
                  if (heuristicKeys.has(key) && typeof args[key] === 'string') {
                    addPathOrPaths(args[key]);
                  }
                }
              }
            } catch {
              // 忽略参数反序列化异常
            }
          }
        }
      }
    }

    return Array.from(filesMap.values()).map(item => {
      const relativePath = relative(rootDir, item.filePath).replace(/\\/g, '/');
      return {
        filePath: relativePath,
        opType: item.opType
      };
    });
  }
}

