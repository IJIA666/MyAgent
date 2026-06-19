import { createHash } from 'crypto';
import type { ChatMessage } from './ports/LlmPort.js';
import { buildSystemPrompt } from './prompts/prompts.js';
import { ApprovalService } from './services/ApprovalService.js';

// 显式重导出 ApiUsage 和 ContextTokenUsage 类型，避免在 ESM 下因类型擦除引发运行时加载错误
export type { ApiUsage, ContextTokenUsage } from './ports/TokenEstimatorPort.js';
import { ApiUsage } from './ports/TokenEstimatorPort.js';

export interface PluginPatchGroup {
  timestamp: string;
  eventName: string;
  patches: Array<{
    op: 'replace' | 'remove' | 'add';
    path: (string | number)[];
    value?: unknown;
  }>;
}

/**
 * 计算字符串的 MD5 哈希。
 *
 * @param text - 待计算哈希的原始文本
 * @returns 32 位的十六进制 MD5 哈希字符串
 */
export function computeStringHash(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/**
 * 会话上下文管理类。
 * 核心职责：
 * 1. 维护当前会话的消息历史（Message History）。
 * 2. 管理会话唯一标识（Session ID）。
 */
export class SessionContext {
  private messageHistory: ChatMessage[] = [];
  private sessionId: string;
  private tenantId: string;
  private checkpointSummary: string | null = null;
  private recentFiles: string[] = [];
  /** 会话是否正在处理生命周期 Hook 中间件（忙状态并发锁） */
  public isProcessing = false;

  private lastApiUsage: ApiUsage | null = null;
  private lastApiHistoryLength: number = 0;

  /** 用于控制危险操作挂起与恢复的人机协同审批服务 */
  public readonly approvalService: ApprovalService;


  /**
   * 实例初始化。
   *
   * @param sessionId - 可选的会话标识，若不传则自动按当前时间戳生成
   * @param tenantId - 可选的租户标识，若不传则默认为 'default'
   */
  constructor(sessionId?: string, tenantId?: string) {
    // 如果没有传入 sessionId，则使用当前时间戳作为默认会话标识
    this.sessionId = sessionId || Date.now().toString();
    this.tenantId = tenantId || 'default';
    // 实例化独立的人机协同审批协调服务
    this.approvalService = new ApprovalService();

    // 初始化系统指令，确立智能体的工作边界与行为准则
    const systemPrompt = buildSystemPrompt();
    // 将系统提示词作为会话的第一条消息压入历史栈
    this.messageHistory.push({
      role: 'system',
      content: systemPrompt
    });
  }



  /**
   * 重新组装并更新会话消息历史中的首条系统提示词（System Prompt）。
   * 此方法保持消息历史中的第 0 个系统消息节点，直接覆写其 content，常用于规则热重载。
   *
   * @param customGlobalRules - 可选的全局规则内容缓存，用于覆盖并锁定
   */
  public updateSystemPrompt(customGlobalRules?: string): void {
    // 忙状态并发锁断言保护
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    const systemPrompt = buildSystemPrompt(customGlobalRules);
    if (this.messageHistory.length > 0 && this.messageHistory[0].role === 'system') {
      this.messageHistory[0].content = systemPrompt;
    }
  }

  /**
   * 获取当前会话唯一标识。
   *
   * @returns 当前会话的唯一 ID 字符串
   */
  public getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 获取当前会话所关联的租户标识（Tenant ID）。
   *
   * @returns 租户 ID 字符串
   */
  public getTenantId(): string {
    return this.tenantId;
  }

  /**
   * 设定当前会话所关联的租户标识（Tenant ID）。
   *
   * @param tenantId - 租户唯一标识符
   */
  public setTenantId(tenantId: string): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.tenantId = tenantId;
  }

  /**
   * 获取当前物理会话所关联的 Checkpoint 提炼摘要。
   *
   * @returns 提炼的摘要内容，若无则返回 null
   */
  public getCheckpointSummary(): string | null {
    return this.checkpointSummary;
  }

  /**
   * 设定当前物理会话所关联的 Checkpoint 提炼摘要。
   *
   * @param summary - 提炼的摘要内容
   */
  public setCheckpointSummary(summary: string | null): void {
    this.checkpointSummary = summary;
  }

  /**
   * 获取最近读写的文件记忆列表。
   *
   * @returns 被剔除历史中最近访问的文件相对路径列表
   */
  public getRecentFiles(): string[] {
    return this.recentFiles;
  }

  /**
   * 设定最近读写的文件记忆列表。
   *
   * @param files - 最近访问的文件相对路径列表
   */
  public setRecentFiles(files: string[]): void {
    this.recentFiles = files;
  }

  /**
   * 获取当前 System Prompt 的哈希值（用于缓存抖动监测）。
   *
   * @returns 系统提示词的 MD5 哈希字符串，若不存在则返回空字符串
   */
  public getSystemPromptHash(): string {
    if (this.messageHistory.length > 0 && this.messageHistory[0].role === 'system') {
      const content = this.messageHistory[0].content;
      return typeof content === 'string' ? computeStringHash(content) : '';
    }
    return '';
  }

  /**
   * 更新最近一次大模型的 API 结算 Usage。
   *
   * @param usage - 最近一次 API 结算的真实用量
   * @param historyLength - 上次调用时的历史数组长度
   */
  public updateLastApiUsage(usage: ApiUsage, historyLength: number): void {
    this.lastApiUsage = usage;
    this.lastApiHistoryLength = historyLength;
  }

  /**
   * 获取最近一次 API 的 Usage 基准值。
   *
   * @returns 最近一次 API 结算的真实用量，若无则返回 null
   */
  public getLastApiUsage(): ApiUsage | null {
    return this.lastApiUsage;
  }

  /**
   * 获取最近一轮的真实 API Usage 数据与历史数组长度基准。
   * 此方法专供 TokenEstimator 在增量计算时获取基准。
   *
   * @returns 包含上次用量与历史长度的基准对象
   */
  public getLastApiUsageBaseline(): { usage: ApiUsage | null; historyLength: number } {
    return {
      usage: this.lastApiUsage,
      historyLength: this.lastApiHistoryLength
    };
  }

  /**
   * 输出当前关联的上下文状态数据（不含深拷贝保护机制）。
   *
   * @returns 包含所有历史消息的数组
   */
  public getHistory(): ChatMessage[] {
    return this.messageHistory;
  }

  /**
   * 增加一条上下文消息。
   *
   * @param message - 待追加的标准模型消息载体对象
   */
  public addMessage(message: ChatMessage): void {
    // 忙状态并发锁断言保护
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    // 将新消息追加到历史记录末尾
    this.messageHistory.push(message);
  }

  /**
   * 弹出一条上下文消息
   *
   * @returns 从队尾弹出的最新一条消息，若历史为空则返回 undefined
   */
  public popMessage(): ChatMessage | undefined {
    // 忙状态并发锁断言保护
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    // 从历史记录末尾移除并返回该消息
    return this.messageHistory.pop();
  }

  /**
   * 指针级硬截断（无延迟截断）。
   * 丢弃中间的消息数组，保留 system prompt (index 0) 以及最后的 keepLastN 条消息。
   *
   * @param keepLastN - 保留的最近消息数量
   */
  public truncateHistory(keepLastN: number): void {
    // 忙状态并发锁断言保护
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    if (this.messageHistory.length <= keepLastN + 1) return;
    const systemMsg = this.messageHistory[0];
    const keptMsgs = this.messageHistory.slice(this.messageHistory.length - keepLastN);
    this.messageHistory = [systemMsg, ...keptMsgs];
  }

  /**
   * 设定当前会话唯一标识（用于恢复会话状态重新绑定）。
   *
   * @param id - 新的会话唯一标识符
   */
  public setSessionId(id: string): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.sessionId = id;
  }

  private pluginPatches: PluginPatchGroup[] = [];

  /**
   * 追加记录插件运行产生的 Immer Patches 变更。
   *
   * @param eventName - 变更所在的生命周期事件名称
   * @param patches - Immer 产生的变更 Patches 数组
   */
  public addPluginPatches(eventName: string, patches: PluginPatchGroup['patches']): void {
    this.pluginPatches.push({
      timestamp: new Date().toISOString(),
      eventName,
      patches
    });
  }

  /**
   * 提取并清空当前已积压的插件变更补丁记录。
   *
   * @returns 已记录的插件补丁变更列表
   */
  public getAndClearPluginPatches(): PluginPatchGroup[] {
    const patches = this.pluginPatches;
    this.pluginPatches = [];
    return patches;
  }

  /**
   * 覆写整个消息历史记录。
   *
   * @param history - 新的消息历史数组
   */
  public updateHistory(history: ChatMessage[]): void {
    // 忙状态并发锁断言保护
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.messageHistory = history;
  }
}
