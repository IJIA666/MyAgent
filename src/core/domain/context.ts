import { createHash } from 'crypto';
import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'node:events';
import { relative, isAbsolute } from 'path';
import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';
import { buildSystemPrompt } from '../usecases/brain/prompts.js';
import type { SkillMetadata } from '../usecases/brain/contextLoader.js';
import { ApprovalService } from '../usecases/security/ApprovalService.js';
import { AppConfig, WorkMode, getDefaultWorkMode } from '../../config/index.js';
import { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import { SecurityService } from '../usecases/security/SecurityService.js';
import { createSessionId } from './trace-format.js';
import type { SafetyResource } from '../usecases/security/SafetyResource.js';
import type {
  AskUserAnswer,
  AskUserPayload
} from '../../ports/driven/session/InteractionPort.js';

/**
 * 人机中断交互的状态。
 * - `pending`：已发起提问，正在等待用户回答
 * - `answered`：用户已回答，等待恢复 run
 * - `canceled`：用户取消或会话关闭，交互已终止
 */
export type PendingInteractionState = 'pending' | 'answered' | 'canceled';

/**
 * 工具载荷的结构化数据，对应 ask_user_question 的参数 schema。
 * 升级后直接复用 InteractionPort 中的结构化提问模型。
 */
export type QuestionPayload = AskUserPayload;

/**
 * 待回答的人机中断交互记录。
 * 当工具声明 executionMode 为 'human_interruption' 时，系统创建此记录
 * 以跟踪等待用户输入的状态，并支持后续从同一 run 恢复执行。
 */
export interface PendingInteraction {
  /** 交互唯一标识符 */
  id: string;
  /** 工具名称（如 'ask_user_question'） */
  toolName: string;
  /** 工具调用的完整参数载荷 */
  payload: QuestionPayload;
  /** 对应的工具调用 ID，用于 capability 生命周期管理 */
  toolCallId: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 当前交互状态 */
  state: PendingInteractionState;
  /** 用户回答内容（answered 状态下有效），按问题 id 索引的结构化映射 */
  answer?: AskUserAnswer;
}

/**
 * 单次工具调用的授权令牌生命周期状态。
 */
export type CallCapabilityState = 'registered' | 'claimed' | 'removed';

/**
 * 单次工具调用的授权令牌（Call Capability）。
 * 绑定 toolCallId + 工具名 + 资源 + 参数摘要，遵循 registered→claimed→removed 三状态生命周期。
 */
export interface CallCapability {
  /** 工具调用唯一标识符 */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 本次调用所涉及的原子资源列表 */
  resources: SafetyResource[];
  /** 规范化参数摘要，用于 claim 时比对防篡改 */
  argumentsDigest: string;
  /** 令牌生命周期状态 */
  state: CallCapabilityState;
  /** 领取该令牌的调用标识（claim 时填入） */
  claimedBy?: string;
  /** 令牌创建时间戳 */
  createdAt: number;
}

/**
 * 计算工具调用参数的规范化摘要，用于 capability 令牌的防篡改比对。
 * 按 key 排序后序列化为 JSON 字符串，再计算 MD5 哈希。
 *
 * @param args - 工具调用参数
 * @returns 规范化参数的 MD5 摘要
 */
export function computeArgumentsDigest(args: Record<string, unknown>): string {
  const normalized = JSON.stringify(
    Object.keys(args).sort().map(k => [k, args[k]])
  );
  return computeStringHash(normalized);
}

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

// 显式重导出 ApiUsage 和 ContextTokenUsage 类型，避免在 ESM 下因类型擦除引发运行时加载错误
export type { ApiUsage, ContextTokenUsage } from '../../ports/driven/llm/TokenEstimatorPort.js';
import type { ApiUsage } from '../../ports/driven/llm/TokenEstimatorPort.js';

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
export class SessionContext extends EventEmitter implements SessionEventPort {
  private messageHistory: StoredChatMessage[] = [];
  private sessionId: string;
  private tenantId: string;
  private checkpointSummary: string | null = null;
  private recentFiles: { filePath: string; opType: 'read' | 'edit' }[] = [];
  /** 当前会话持有的工作安全模式，初始时从全局默认配置中拷贝 */
  private workMode: WorkMode;
  /** 会话是否正在处理生命周期 Hook 中间件（忙状态并发锁，内部存储变量） */
  private _isProcessing = false;
  /** 缓冲在 Hook 忙锁执行期间到达的后台系统通知 */
  private pendingNotifications: StoredChatMessage[] = [];

  /**
   * 获取会话是否正在处理生命周期 Hook 中间件。
   *
   * @returns 忙状态标识
   */
  public get isProcessing(): boolean {
    return this._isProcessing;
  }

  /**
   * 设定会话是否正在处理生命周期 Hook 中间件。
   *
   * @param val - 新的忙锁状态值
   */
  public set isProcessing(val: boolean) {
    this._isProcessing = val;
  }

  /**
   * 追加一条系统通知消息，若当前处于 Hook 管道忙碌状态则暂存，否则直接写入物理历史。
   *
   * @param message - 系统通知消息对象
   */
  public addNotification(message: StoredChatMessage): void {
    if (this._isProcessing) {
      this.pendingNotifications.push(message);
    } else {
      this.addMessage(message);
    }
  }

  /**
   * 物理地将暂存的后台系统通知消息同步追加并刷入当前的对话历史栈，然后清空队列。
   * 彻底废除 process.nextTick 异步隐式操作，改用确定性的同步合并，规避 Immer 覆写风险。
   */
  public flushPendingNotifications(): void {
    if (this.pendingNotifications.length > 0) {
      this.messageHistory.push(...this.pendingNotifications);
      this.pendingNotifications = [];
    }
  }

  private lastApiUsage: ApiUsage | null = null;
  private lastApiHistoryLength: number = 0;

  /** 用于控制危险操作挂起与恢复的人机协同审批服务 */
  public readonly approvalService: ApprovalService;
  /** 全局配置对象（用于将配置项注入给具体的工具和插件） */
  public appConfig?: AppConfig;
  /** call capability 令牌存储 Map，以 toolCallId 为键 */
  private callCapabilities: Map<string, CallCapability> = new Map();
  /** 当前会话中活跃的人机中断交互（仅允许同时存在一个） */
  private _pendingInteraction: PendingInteraction | null = null;

  /**
   * 获取当前活跃的人机中断交互记录。
   *
   * @returns 当前挂起的中断交互，若无则返回 null
   */
  public get pendingInteraction(): PendingInteraction | null {
    return this._pendingInteraction;
  }

  /**
   * 创建一个新的人机中断交互记录。
   * 若已存在活跃交互，则抛出错误，防止输入路由歧义。
   *
   * @param interaction - 待创建的中断交互数据（不含 state 与 createdAt，由方法自动填充）
   * @throws 当已存在活跃交互时抛出错误
   */
  public setPendingInteraction(interaction: Omit<PendingInteraction, 'state' | 'createdAt'>): PendingInteraction {
    if (this._pendingInteraction && this._pendingInteraction.state === 'pending') {
      throw new Error(`已存在活跃的人机交互 (id=${this._pendingInteraction.id})，不允许并发创建。`);
    }
    this._pendingInteraction = {
      ...interaction,
      state: 'pending',
      createdAt: Date.now()
    };
    return this._pendingInteraction;
  }

  /**
   * 从持久化快照恢复待回答的人机中断交互。
   *
   * @param interaction - 已校验合法的待恢复交互记录
   */
  public restorePendingInteraction(interaction: PendingInteraction): void {
    this._pendingInteraction = interaction;
  }

  /**
   * 回答当前活跃的人机中断交互，记录回答内容并将状态切换为 answered。
   *
   * @param answer - 用户回答的结构化映射（按问题 id 索引）
   * @returns 更新后的交互记录，若无活跃交互则返回 null
   */
  public answerPendingInteraction(answer: AskUserAnswer): PendingInteraction | null {
    if (!this._pendingInteraction || this._pendingInteraction.state !== 'pending') {
      return null;
    }
    this._pendingInteraction.state = 'answered';
    this._pendingInteraction.answer = answer;
    return this._pendingInteraction;
  }

  /**
   * 取消当前活跃的人机中断交互，将状态切换为 canceled。
   * 用于用户主动取消、会话关闭或恢复失败等场景。
   */
  public cancelPendingInteraction(): void {
    if (this._pendingInteraction && this._pendingInteraction.state === 'pending') {
      this._pendingInteraction.state = 'canceled';
    }
  }

  /**
   * 清除当前活跃的人机中断交互记录。
   * 用于回答后恢复完成或取消后清理。
   */
  public clearPendingInteraction(): void {
    this._pendingInteraction = null;
  }


  /**
   * 实例初始化。
   *
   * @param sessionId - 可选的会话标识，若不传则自动按当前时间戳生成
   * @param tenantId - 可选的租户标识，若不传则默认为 'default'
   */
  constructor(sessionId?: string, tenantId?: string) {
    super();
    // 如果没有传入 sessionId，则使用当前时间戳作为默认会话标识
    this.sessionId = sessionId || createSessionId();
    this.tenantId = tenantId || 'default';
    // 实例化独立的人机协同审批协调服务
    this.approvalService = new ApprovalService();
    // 拷贝全局只读的默认安全模式作为该会话的局部安全级别副本
    this.workMode = getDefaultWorkMode();

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
   * 此方法保持消息历史中的第 0 个系统消息节点，直接覆写其 content，常用于规则和技能热重载。
   *
   * @param customGlobalRules - 可选的全局规则内容缓存
   * @param customLocalRules - 可选的局部规则内容缓存
   * @param skills - 可选的技能元数据列表
   */
  public updateSystemPrompt(
    customGlobalRules?: string,
    customLocalRules?: string,
    skills?: SkillMetadata[]
  ): void {
    // 忙状态并发锁断言保护
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    const systemPrompt = buildSystemPrompt(customGlobalRules, customLocalRules, skills);
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
   * 将会话消息历史回滚至指定的长度。
   * 用于物理与内存双轨倒退。
   *
   * @param length - 回滚到的目标历史长度
   */
  public rollbackHistoryToLength(length: number): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    if (length < 0 || length > this.messageHistory.length) {
      throw new Error(`Invalid rollback length: ${length}, current length: ${this.messageHistory.length}`);
    }
    this.messageHistory = this.messageHistory.slice(0, length);
    logger.info(`[SessionContext] 消息历史回滚截断至长度: ${length}`);
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
   * 获取最近读写的文件操作记忆列表。
   *
   * @returns 最近访问的文件及操作类型列表
   */
  public getRecentFiles(): { filePath: string; opType: 'read' | 'edit' }[] {
    return this.recentFiles;
  }

  /**
   * 设定最近读写的文件操作记忆列表。
   *
   * @param files - 最近访问的文件及操作类型列表
   */
  public setRecentFiles(files: { filePath: string; opType: 'read' | 'edit' }[]): void {
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
  public getHistory(): StoredChatMessage[] {
    return this.messageHistory;
  }

  /**
   * 增加一条上下文消息。
   *
   * @param message - 待追加的标准模型消息载体对象
   */
  public addMessage(message: StoredChatMessage): void {
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
  public popMessage(): StoredChatMessage | undefined {
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
   * 基于指定起始索引进行物理截断。
   * 丢弃中间的消息数组，保留 system prompt (index 0) 以及从指定索引开始的后续所有消息。
   *
   * @param startIndex - 保留历史消息的起始索引点
   */
  public truncateHistoryFromIndex(startIndex: number): void {
    // 忙状态并发锁断言保护
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    if (startIndex <= 1 || startIndex >= this.messageHistory.length) return;
    const systemMsg = this.messageHistory[0];
    const keptMsgs = this.messageHistory.slice(startIndex);
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

  /**
   * 获取当前会话私有的安全工作模式。
   *
   * @returns 当前会话的工作安全模式
   */
  public getWorkMode(): WorkMode {
    return this.workMode;
  }

  /**
   * 设定当前会话私有的安全工作模式。
   *
   * @param mode - 目标工作安全模式
   */
  public setWorkMode(mode: WorkMode): void {
    if (this.isProcessing) {
      logger.warn('[SessionContext] work_mode_change_blocked', {
        component: 'context',
        event: 'work_mode_change_blocked',
        sessionId: this.sessionId,
        oldValue: this.workMode,
        newValue: mode,
        reason: 'isProcessing=true'
      });
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    const previousMode = this.workMode;
    this.workMode = mode;
    logger.info('[SessionContext] work_mode_changed', {
      component: 'context',
      event: 'work_mode_changed',
      sessionId: this.sessionId,
      oldValue: previousMode,
      newValue: mode,
      reason: 'user_request'
    });
  }

  /**
   * 获取当前有效的安全命令白名单列表。
   * 桥接调用核心层的安全服务。
   *
   * @returns 安全命令白名单规则列表
   */
  public getSecurityAllowlist(): string[] {
    return SecurityService.getInstance().getSecurityAllowlist();
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
  public updateHistory(history: StoredChatMessage[]): void {
    // 忙状态并发锁断言保护
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.messageHistory = history;
  }

  /**
   * 挂起当前高危操作， 等待人机协同的确权审批。
   *
   * @param approvalId - 本次审批请求的唯一随机 ID
   * @param actionInfo - 触发审批的动作与参数信息
   * @param options - 附加的运行时配置项
   * @param warningMsg - 可选的向用户展示的安全警示信息
   * @returns 包含用户动作（允许/拒绝）的审批决策结果对象
   */
  public async waitApproval(
    approvalId: string,
    actionInfo: { name: string; arguments?: Record<string, unknown> },
    options: unknown,
    warningMsg?: string
  ): Promise<{ action: 'approve' | 'deny'; reason?: string }> {
    const decision = await this.approvalService.wait(
      approvalId,
      { name: actionInfo.name, arguments: actionInfo.arguments || {} },
      typeof options === 'string' ? options : undefined,
      warningMsg
    );
    return {
      action: (
        decision.action === 'call' ||
        decision.action === 'session' ||
        decision.action === 'persistent'
      ) ? 'approve' : 'deny'
    };
  }

  /**
   * 检查指定绝对物理路径是否处于临时只读授权白名单中。
   *
   * @param pathStr - 物理绝对路径
   * @returns 在白名单中返回 true，否则返回 false
   */
  public hasTemporaryReadWhitelist(pathStr: string): boolean {
    return SecurityService.getInstance().hasTemporaryReadWhitelist(this.sessionId, pathStr);
  }

  /**
   * 检查指定绝对物理路径是否处于临时可写授权白名单中。
   *
   * @param pathStr - 物理绝对路径
   * @returns 在白名单中返回 true，否则返回 false
   */
  public hasTemporaryWriteWhitelist(pathStr: string): boolean {
    return SecurityService.getInstance().hasTemporaryWriteWhitelist(this.sessionId, pathStr);
  }

  /**
   * 将指定物理绝对路径加入当前会话的临时只读白名单。
   * 受到 busy 状态锁防护。
   *
   * @param pathStr - 物理绝对路径
   */
  public addTemporaryReadWhitelist(pathStr: string): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    SecurityService.getInstance().addTemporaryReadWhitelist(this.sessionId, pathStr);
  }

  /**
   * 将指定物理绝对路径加入当前会话的临时可写白名单。
   * 受到 busy 状态锁防护。
   *
   * @param pathStr - 物理绝对路径
   */
  public addTemporaryWriteWhitelist(pathStr: string): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    SecurityService.getInstance().addTemporaryWriteWhitelist(this.sessionId, pathStr);
  }

  /**
   * 将指定目录根路径加入当前会话的目录范围只读白名单。
   * 受到 busy 状态锁防护。
   *
   * @param dirRoot - 经物理路径归一化的目录根路径
   */
  public addTemporaryDirectoryScopeReadWhitelist(dirRoot: string): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    SecurityService.getInstance().addTemporaryDirectoryScopeReadWhitelist(this.sessionId, dirRoot);
  }

  /**
   * 清空当前会话在内存中暂存的所有临时读写白名单。
   * 受到 busy 状态锁防护。
   */
  public clearTemporaryWhitelists(): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    SecurityService.getInstance().clearTemporaryWhitelists(this.sessionId);
  }

  /**
   * 注册一个 call 级授权令牌（registered 状态）。
   * 由 AgentLoop 在 pendingGrant 条件满足时调用。
   *
   * @param cap - 待注册的授权令牌，必须包含 argumentsDigest
   */
  public registerCallCapability(cap: CallCapability): void {
    cap.state = 'registered';
    cap.createdAt = Date.now();
    this.callCapabilities.set(cap.toolCallId, cap);
  }

  /**
   * 领取（claim）一个 registered 状态的令牌，将其切换为 claimed。
   * 验证 toolCallId + toolName + argumentsDigest 三重匹配，防止参数篡改。
   * 由 virtual-mcp 在 execute 边界调用。
   *
   * @param toolCallId - 工具调用唯一标识
   * @param toolName - 工具名称
   * @param args - 工具调用参数，用于计算摘要与注册时的 digest 比对
   * @returns 已 claim 的资源列表，若令牌不存在/状态非 registered/摘要不匹配则返回 null
   */
  public claimCapability(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>
  ): SafetyResource[] | null {
    const cap = this.callCapabilities.get(toolCallId);
    if (!cap || cap.state !== 'registered') {
      return null;
    }
    if (cap.toolName !== toolName) {
      return null;
    }
    const digest = computeArgumentsDigest(args);
    if (cap.argumentsDigest !== digest) {
      return null;
    }
    cap.state = 'claimed';
    cap.claimedBy = toolCallId;
    return cap.resources;
  }

  /**
   * 消费（consume）一个 claimed 状态的令牌，将其切换为 removed。
   * 由 agent-loop 在工具调用完成（成功/失败/abort）的 finally 块中调用。
   *
   * @param toolCallId - 工具调用唯一标识
   */
  public consumeCapability(toolCallId: string): void {
    const cap = this.callCapabilities.get(toolCallId);
    if (cap && cap.state === 'claimed') {
      cap.state = 'removed';
    }
  }

  /**
   * 检查指定 toolCallId 的 claimed 令牌中是否包含匹配的路径资源。
   * 同时校验路径和 access（read/write）类型，防止读授权升级为写。
   *
   * @param toolCallId - 工具调用唯一标识
   * @param access - 访问类型（'read' 或 'write'）
   * @param normalizedPath - 规范化后的物理路径
   * @returns 存在匹配的 claimed 资源返回 true，否则 false
   */
  public hasClaimedResource(toolCallId: string, access: 'read' | 'write', normalizedPath: string): boolean {
    const cap = this.callCapabilities.get(toolCallId);
    if (!cap || cap.state !== 'claimed') {
      return false;
    }
    return cap.resources.some(
      (r) => {
        if (r.kind === 'path') {
          return r.access === access && r.normalizedPath === normalizedPath;
        }
        if (r.kind === 'directory-scope') {
          return access === 'read' && this.isPathWithinDirectoryScope(r.normalizedPath, normalizedPath);
        }
        return false;
      }
    );
  }

  /** 判断目标路径是否位于某个目录范围资源所覆盖的子树内。 */
  private isPathWithinDirectoryScope(scopeRoot: string, targetPath: string): boolean {
    const rel = relative(scopeRoot, targetPath);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }
}
