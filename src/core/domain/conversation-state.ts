import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';
import type { ApiUsage } from '../../ports/driven/llm/TokenEstimatorPort.js';
import { createHash } from 'node:crypto';

/**
 * 内部会话扩展消息接口契约，继承底层大模型消息，
 * 扩充 originalPath 与 isTruncated 属性，供大文本去噪和快照记录使用。
 */
export interface StoredChatMessage extends ChatMessage {
  /** 完整工具大输出外带临时文件的物理路径 */
  originalPath?: string;
  /** 本条消息内容是否已被截断 */
  isTruncated?: boolean;
}

/**
 * 会话消息历史状态管理。
 * 负责消息历史的增删截断、系统提示词管理与 API Usage 缓存。
 * 本对象不感知 `isProcessing` 忙锁，调用方（SessionContext façade）负责在委托前做并发保护。
 */
export class ConversationState {
  private messageHistory: StoredChatMessage[] = [];
  private lastApiUsage: ApiUsage | null = null;
  private lastApiHistoryLength: number = 0;

  /**
   * @param initialSystemPrompt - 可选的初始系统提示词内容，若提供则作为第一条 system 消息压入历史
   */
  constructor(initialSystemPrompt?: string) {
    if (initialSystemPrompt) {
      this.messageHistory.push({
        role: 'system',
        content: initialSystemPrompt
      });
    }
  }

  /** 获取会话消息历史的只读引用 */
  getHistory(): StoredChatMessage[] {
    return this.messageHistory;
  }

  /** 追加一条上下文消息 */
  addMessage(message: StoredChatMessage): void {
    this.messageHistory.push(message);
  }

  /**
   * 判断历史中是否存在尚未收到对应工具结果的 assistant tool call。
   * OpenAI 协议要求一组 tool call 的全部结果闭合后才能插入普通消息。
   *
   * @returns 存在未闭合工具调用时返回 true
   */
  hasUnresolvedToolCalls(): boolean {
    const unresolvedToolCallIds = new Set<string>();
    for (const message of this.messageHistory) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          unresolvedToolCallIds.add(toolCall.id);
        }
        continue;
      }
      if (message.role === 'tool' && message.tool_call_id) {
        unresolvedToolCallIds.delete(message.tool_call_id);
      }
    }
    return unresolvedToolCallIds.size > 0;
  }

  /** 弹出末尾一条消息 */
  popMessage(): StoredChatMessage | undefined {
    return this.messageHistory.pop();
  }

  /** 覆写整个消息历史 */
  updateHistory(history: StoredChatMessage[]): void {
    this.messageHistory = history;
  }

  /**
   * 指针级硬截断。保留 system prompt (index 0) 以及最后的 keepLastN 条消息。
   *
   * @param keepLastN - 保留的最近消息数量
   */
  truncateHistory(keepLastN: number): void {
    if (this.messageHistory.length <= keepLastN + 1) return;
    const systemMsg = this.messageHistory[0];
    const keptMsgs = this.messageHistory.slice(this.messageHistory.length - keepLastN);
    this.messageHistory = [systemMsg, ...keptMsgs];
  }

  /**
   * 基于起始索引进行物理截断。保留 system prompt (index 0) 以及从 startIndex 开始的所有消息。
   *
   * @param startIndex - 保留历史消息的起始索引点
   */
  truncateHistoryFromIndex(startIndex: number): void {
    if (startIndex <= 1 || startIndex >= this.messageHistory.length) return;
    const systemMsg = this.messageHistory[0];
    const keptMsgs = this.messageHistory.slice(startIndex);
    this.messageHistory = [systemMsg, ...keptMsgs];
  }

  /**
   * 将消息历史回滚至指定长度。
   *
   * @param length - 回滚到的目标历史长度
   */
  rollbackHistoryToLength(length: number): void {
    if (length < 0 || length > this.messageHistory.length) {
      throw new Error(`Invalid rollback length: ${length}, current length: ${this.messageHistory.length}`);
    }
    this.messageHistory = this.messageHistory.slice(0, length);
  }

  /**
   * 重新组装并更新消息历史中的首条系统提示词。
   * 保持消息历史中的第 0 个系统消息节点，直接覆写其 content。
   *
   * 调用约束：该写入只允许发生在会话构造期（规则初始化、会话打开）以及
   * 显式的手动规则重载；Skill 文件自动变更（SkillLibrary 订阅、项目 watcher）
   * 不得调用本方法改写首条系统消息，活跃会话的 Skill 元数据快照保持冻结，
   * 变更后的元数据从新会话开始生效。
   *
   * @param systemPrompt - 由 buildSystemPrompt 生成的完整系统提示词
   */
  updateSystemPrompt(systemPrompt: string): void {
    if (this.messageHistory.length > 0 && this.messageHistory[0].role === 'system') {
      this.messageHistory[0].content = systemPrompt;
    }
  }

  /** 获取当前系统提示词的 MD5 哈希 */
  getSystemPromptHash(): string {
    if (this.messageHistory.length > 0 && this.messageHistory[0].role === 'system') {
      const content = this.messageHistory[0].content;
      return typeof content === 'string' ? computeStringHash(content) : '';
    }
    return '';
  }

  /**
   * 更新最近一次大模型 API 结算 Usage。
   *
   * @param usage - 最近一次 API 结算的真实用量
   * @param historyLength - 上次调用时的历史数组长度
   */
  updateLastApiUsage(usage: ApiUsage, historyLength: number): void {
    this.lastApiUsage = usage;
    this.lastApiHistoryLength = historyLength;
  }

  /** 获取最近一次 API 的 Usage 基准值 */
  getLastApiUsage(): ApiUsage | null {
    return this.lastApiUsage;
  }

  /**
   * 获取最近一轮的真实 API Usage 数据与历史数组长度基准，
   * 供 TokenEstimator 在增量计算时获取基准。
   */
  getLastApiUsageBaseline(): { usage: ApiUsage | null; historyLength: number } {
    return {
      usage: this.lastApiUsage,
      historyLength: this.lastApiHistoryLength
    };
  }

  /** 清除因历史整体替换而失效的 API Usage 增量估算基线。 */
  clearLastApiUsageBaseline(): void {
    this.lastApiUsage = null;
    this.lastApiHistoryLength = 0;
  }
}

/** 计算消息正文摘要，用于检测历史内容是否变化。 */
function computeStringHash(text: string): string {
  return createHash('md5').update(text).digest('hex');
}
