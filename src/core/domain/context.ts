import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'node:events';
import type { SafetyResource } from '../usecases/security/SafetyResource.js';
import type { CallCapabilityPort } from '../../ports/driven/session/CallCapabilityPort.js';
import { buildSystemPrompt } from '../usecases/brain/prompts.js';
import type { SkillMetadata } from '../usecases/brain/contextLoader.js';
import { ApprovalService } from '../usecases/security/ApprovalService.js';
import { AppConfig, ConfigPermissionMode, getDefaultPermissionMode } from '../../config/index.js';
import { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import { createSessionId } from './trace-format.js';
import type { CallCapability, CallCapabilityState } from './call-capability.js';
import { PermissionModeManager } from './permissions/mode-manager.js';
import { PermissionRuleStore } from './permissions/rule-store.js';
import { ConversationState } from './conversation-state.js';
import type { StoredChatMessage } from './conversation-state.js';
import { InteractionState } from './interaction-state.js';
import type { PendingInteraction, PendingInteractionState, QuestionPayload } from './interaction-state.js';
import { AuthorizationState } from './authorization-state.js';
import { PluginMutationLog } from './plugin-mutation-log.js';
import type { PluginPatchGroup } from './plugin-mutation-log.js';
import type { AskUserAnswer } from '../../ports/driven/session/InteractionPort.js';
import type { ApprovalWaitOptions } from '../../ports/driven/session/ApprovalPort.js';
import type { ApprovalChoiceId } from '../../ports/shared/approval-types.js';

// 从子状态文件重导出公开类型与函数（保持向后兼容）
export { computeArgumentsDigest } from './call-capability.js';
export type { CallCapabilityState, CallCapability };
export type { StoredChatMessage };
export type { PendingInteractionState, QuestionPayload, PendingInteraction };
export type { PluginPatchGroup };
// 显式重导出 ApiUsage 和 ContextTokenUsage 类型，避免在 ESM 下因类型擦除引发运行时加载错误
export type { ApiUsage, ContextTokenUsage } from '../../ports/driven/llm/TokenEstimatorPort.js';
import type { ApiUsage } from '../../ports/driven/llm/TokenEstimatorPort.js';

/**
 * 会话上下文管理类。
 * 核心职责：
 * 1. 维护当前会话的消息历史（Message History）。
 * 2. 管理会话唯一标识（Session ID）。
 */
export class SessionContext extends EventEmitter implements SessionEventPort, CallCapabilityPort {
  // ── 会话元数据（保留在 façade）──
  private sessionId: string;
  private tenantId: string;
  private permissionMode: ConfigPermissionMode;
  /** 会话私有的统一模式管理器，避免进程级共享模式状态。 */
  private readonly permissionModeManager: PermissionModeManager;
  private _appConfig?: AppConfig;

  // ── 子状态对象 ──
  private readonly conversationState: ConversationState;
  private readonly interactionState: InteractionState;
  private readonly authorizationState: AuthorizationState;
  private readonly pluginMutationLog: PluginMutationLog;

  // ── 公开属性代理（保持向后兼容）──

  /** 人机协同审批服务（委托给 AuthorizationState） */
  public get approvalService(): ApprovalService {
    return this.authorizationState.approvalService;
  }

  /** 全局配置对象 */
  public get appConfig(): AppConfig | undefined {
    return this._appConfig;
  }

  public set appConfig(val: AppConfig | undefined) {
    this._appConfig = val;
  }

  /** 会话是否正在处理生命周期 Hook 中间件（委托给 InteractionState） */
  public get isProcessing(): boolean {
    return this.interactionState.isProcessing;
  }

  public set isProcessing(val: boolean) {
    this.interactionState.isProcessing = val;
  }

  /** 当前活跃的人机中断交互记录（委托给 InteractionState） */
  public get pendingInteraction(): PendingInteraction | null {
    return this.interactionState.pendingInteraction;
  }

  // ── 构造函数 ──

  /**
   * 实例初始化。
   *
   * @param sessionId - 可选的会话标识，若不传则自动按当前时间戳生成
   * @param tenantId - 可选的租户标识，若不传则默认为 'default'
   */
  constructor(sessionId?: string, tenantId?: string) {
    super();
    this.sessionId = sessionId || createSessionId();
    this.tenantId = tenantId || 'default';
    this.permissionMode = getDefaultPermissionMode();
    this.permissionModeManager = new PermissionModeManager(
      this.permissionMode,
      new PermissionRuleStore(),
    );

    // 实例化子状态对象
    const systemPrompt = buildSystemPrompt();
    this.conversationState = new ConversationState(systemPrompt);
    this.interactionState = new InteractionState();
    this.authorizationState = new AuthorizationState();
    this.pluginMutationLog = new PluginMutationLog();
  }



  // ── 系统提示词（委托给 ConversationState + busy 检查）──

  /**
   * 重新组装并更新会话消息历史中的首条系统提示词（System Prompt）。
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
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    const systemPrompt = buildSystemPrompt(customGlobalRules, customLocalRules, skills, {
      language: this._appConfig?.language,
    });
    this.conversationState.updateSystemPrompt(systemPrompt);
    this.conversationState.clearLastApiUsageBaseline();
  }

  // ── 会话元数据（保留在 façade）──

  /** 获取当前会话唯一标识 */
  public getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 将会话消息历史回滚至指定的长度。
   *
   * @param length - 回滚到的目标历史长度
   */
  public rollbackHistoryToLength(length: number): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    const currentLength = this.conversationState.getHistory().length;
    if (length < 0 || length > currentLength) {
      throw new Error(`Invalid rollback length: ${length}, current length: ${currentLength}`);
    }
    this.conversationState.rollbackHistoryToLength(length);
    this.conversationState.clearLastApiUsageBaseline();
    logger.info(`[SessionContext] 消息历史回滚截断至长度: ${length}`);
  }

  /** 获取当前会话所关联的租户标识（Tenant ID） */
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

  /** 获取当前 System Prompt 的哈希值（委托给 ConversationState） */
  public getSystemPromptHash(): string {
    return this.conversationState.getSystemPromptHash();
  }

  // ── API Usage（委托给 ConversationState）──

  /**
   * 更新最近一次大模型的 API 结算 Usage。
   *
   * @param usage - 最近一次 API 结算的真实用量
   * @param historyLength - 上次调用时的历史数组长度
   */
  public updateLastApiUsage(usage: ApiUsage, historyLength: number): void {
    this.conversationState.updateLastApiUsage(usage, historyLength);
  }

  /** 获取最近一次 API 的 Usage 基准值 */
  public getLastApiUsage(): ApiUsage | null {
    return this.conversationState.getLastApiUsage();
  }

  /**
   * 获取最近一轮的真实 API Usage 数据与历史数组长度基准，
   * 供 TokenEstimator 在增量计算时获取基准。
   */
  public getLastApiUsageBaseline(): { usage: ApiUsage | null; historyLength: number } {
    return this.conversationState.getLastApiUsageBaseline();
  }

  /** 清除因压缩等历史整体替换而失效的 API Usage 基线。 */
  public clearLastApiUsageBaseline(): void {
    this.conversationState.clearLastApiUsageBaseline();
  }

  // ── 消息历史管理（委托给 ConversationState + busy 检查）──

  /** 输出当前关联的上下文状态数据 */
  public getHistory(): StoredChatMessage[] {
    return this.conversationState.getHistory();
  }

  /**
   * 增加一条上下文消息。
   *
   * @param message - 待追加的标准模型消息载体对象
   */
  public addMessage(message: StoredChatMessage): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.conversationState.addMessage(message);
  }

  /** 弹出一条上下文消息 */
  public popMessage(): StoredChatMessage | undefined {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    return this.conversationState.popMessage();
  }

  /**
   * 指针级硬截断。保留 system prompt (index 0) 以及最后的 keepLastN 条消息。
   *
   * @param keepLastN - 保留的最近消息数量
   */
  public truncateHistory(keepLastN: number): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.conversationState.truncateHistory(keepLastN);
    this.conversationState.clearLastApiUsageBaseline();
  }

  /**
   * 基于指定起始索引进行物理截断。
   *
   * @param startIndex - 保留历史消息的起始索引点
   */
  public truncateHistoryFromIndex(startIndex: number): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.conversationState.truncateHistoryFromIndex(startIndex);
    this.conversationState.clearLastApiUsageBaseline();
  }

  /** 设定当前会话唯一标识（用于恢复会话状态重新绑定） */
  public setSessionId(id: string): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.sessionId = id;
  }

  /** 获取当前会话私有的安全工作模式 */
  /**
   * 设定当前会话私有的安全工作模式。
   *
   * @param mode - 目标工作安全模式
   */
  /** 获取当前会话的权限模式。 */
  public getPermissionMode(): ConfigPermissionMode {
    return this.permissionModeManager.getMode();
  }

  /**
   * 设定当前会话的权限模式。
   *
   * @param mode - 目标权限模式
   */
  public setPermissionMode(mode: ConfigPermissionMode): void {
    if (this.isProcessing) {
      logger.warn('[SessionContext] permission_mode_change_blocked', {
        component: 'context',
        event: 'permission_mode_change_blocked',
        sessionId: this.sessionId,
        oldValue: this.permissionMode,
        newValue: mode,
        reason: 'isProcessing=true'
      });
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    const previousMode = this.permissionModeManager.getMode();
    this.permissionModeManager.transitionTo(mode);
    this.permissionMode = this.permissionModeManager.getMode();
    logger.info('[SessionContext] permission_mode_changed', {
      component: 'context',
      event: 'permission_mode_changed',
      sessionId: this.sessionId,
      oldValue: previousMode,
      newValue: mode,
      reason: 'user_request'
    });
  }

  // ── 通知缓冲与人机中断（委托给 InteractionState，跨对象编排由 façade 完成）──

  /**
   * 追加一条系统通知消息。
   * Hook 忙碌或工具调用结果尚未闭合时暂存，避免破坏模型协议消息顺序。
   *
   * @param message - 系统通知消息对象
   */
  public addNotification(message: StoredChatMessage): void {
    if (this.isProcessing || this.conversationState.hasUnresolvedToolCalls()) {
      this.interactionState.bufferNotification(message);
    } else {
      this.conversationState.addMessage(message);
    }
  }

  /**
   * 在 Hook 空闲且工具调用结果全部闭合后，将暂存通知刷入消息历史。
   * 不满足安全边界时保留原队列，等待后续生命周期检查点再次刷新。
   */
  public flushPendingNotifications(): void {
    if (this.isProcessing || this.conversationState.hasUnresolvedToolCalls()) {
      return;
    }
    const notifications = this.interactionState.drainPendingNotifications();
    if (notifications.length > 0) {
      for (const n of notifications) {
        this.conversationState.addMessage(n);
      }
    }
  }

  /**
   * 创建一个新的人机中断交互记录（委托给 InteractionState）。
   *
   * @param interaction - 待创建的中断交互数据
   * @throws 当已存在活跃交互时抛出错误
   */
  public setPendingInteraction(interaction: Omit<PendingInteraction, 'state' | 'createdAt'>): PendingInteraction {
    return this.interactionState.setPendingInteraction(interaction);
  }

  /** 从持久化快照恢复待回答的人机中断交互（委托给 InteractionState） */
  public restorePendingInteraction(interaction: PendingInteraction): void {
    this.interactionState.restorePendingInteraction(interaction);
  }

  /**
   * 回答当前活跃的人机中断交互（委托给 InteractionState）。
   *
   * @param answer - 用户回答的结构化映射
   */
  public answerPendingInteraction(answer: AskUserAnswer): PendingInteraction | null {
    return this.interactionState.answerPendingInteraction(answer);
  }

  /** 取消当前活跃的人机中断交互（委托给 InteractionState） */
  public cancelPendingInteraction(): void {
    this.interactionState.cancelPendingInteraction();
  }

  /** 清除当前活跃的人机中断交互记录（委托给 InteractionState） */
  public clearPendingInteraction(): void {
    this.interactionState.clearPendingInteraction();
  }

  // ── 插件补丁（委托给 PluginMutationLog）──

  /**
   * 追加记录插件运行产生的 Immer Patches 变更。
   *
   * @param eventName - 变更所在的生命周期事件名称
   * @param patches - Immer 产生的变更 Patches 数组
   */
  public addPluginPatches(eventName: string, patches: PluginPatchGroup['patches']): void {
    this.pluginMutationLog.addPluginPatches(eventName, patches);
  }

  /** 提取并清空当前已积压的插件变更补丁记录 */
  public getAndClearPluginPatches(): PluginPatchGroup[] {
    return this.pluginMutationLog.getAndClearPluginPatches();
  }

  /**
   * 覆写整个消息历史记录（委托给 ConversationState + busy 检查）。
   *
   * @param history - 新的消息历史数组
   * @param preserveApiUsageBaseline - 是否在外层事务完成前暂时保留旧 API 用量基线
   */
  public updateHistory(
    history: StoredChatMessage[],
    preserveApiUsageBaseline = false
  ): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.conversationState.updateHistory(history);
    if (!preserveApiUsageBaseline) {
      this.conversationState.clearLastApiUsageBaseline();
    }
  }

  // ── 审批（委托给 AuthorizationState）──

  /**
   * 挂起当前高危操作，等待人机协同的确权审批。
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
    options?: string | ApprovalWaitOptions,
    warningMsg?: string
  ): Promise<{ action: ApprovalChoiceId; reason?: string }> {
    return this.authorizationState.waitApproval(approvalId, actionInfo, options, warningMsg);
  }

  // ── 临时白名单（委托给 AuthorizationState + busy 检查）──

  /**
   * 检查指定绝对物理路径是否处于临时只读授权白名单中。
   *
   * @param pathStr - 物理绝对路径
   */
  public hasTemporaryReadWhitelist(pathStr: string): boolean {
    return this.authorizationState.hasReadWhitelist(this.sessionId, pathStr);
  }

  /**
   * 检查指定绝对物理路径是否处于临时可写授权白名单中。
   *
   * @param pathStr - 物理绝对路径
   */
  public hasTemporaryWriteWhitelist(pathStr: string): boolean {
    return this.authorizationState.hasWriteWhitelist(this.sessionId, pathStr);
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
    this.authorizationState.addReadWhitelist(this.sessionId, pathStr);
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
    this.authorizationState.addWriteWhitelist(this.sessionId, pathStr);
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
    this.authorizationState.addDirectoryScopeReadWhitelist(this.sessionId, dirRoot);
  }

  /**
   * 清空当前会话在内存中暂存的所有临时读写白名单。
   * 受到 busy 状态锁防护。
   */
  public clearTemporaryWhitelists(): void {
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    this.authorizationState.clearWhitelists(this.sessionId);
  }

  // ── Call Capability 令牌生命周期（委托给 AuthorizationState）──

  /**
   * 注册一个 call 级授权令牌（registered 状态）。
   *
   * @param cap - 待注册的授权令牌，必须包含 argumentsDigest
   */
  public registerCallCapability(cap: CallCapability): void {
    this.authorizationState.registerCallCapability(cap);
  }

  /**
   * 领取（claim）一个 registered 状态的令牌。
   * 验证 toolCallId + toolName + argumentsDigest 三重匹配，防止参数篡改。
   */
  public claimCapability(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>
  ): SafetyResource[] | null {
    return this.authorizationState.claimCapability(toolCallId, toolName, args);
  }

  /**
   * 消费（consume）一个 claimed 状态的令牌。
   *
   * @param toolCallId - 工具调用唯一标识
   */
  public consumeCapability(toolCallId: string): void {
    this.authorizationState.consumeCapability(toolCallId);
  }

  /**
   * 检查指定 toolCallId 的 claimed 令牌中是否包含匹配的路径资源。
   */
  public hasClaimedResource(toolCallId: string, access: 'read' | 'write', normalizedPath: string): boolean {
    return this.authorizationState.hasClaimedResource(toolCallId, access, normalizedPath);
  }
}
