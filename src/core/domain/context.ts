import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'node:events';
import { buildSystemPrompt } from '../usecases/brain/prompts.js';
import type { SkillMetadata } from '../usecases/brain/contextLoader.js';
import { ApprovalInteractionService } from '../usecases/security/ApprovalInteractionService.js';
import { AppConfig, ConfigPermissionMode, getDefaultPermissionMode } from '../../config/index.js';
import { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import { createSessionId } from './trace-format.js';
import { PermissionSessionState } from './permissions/permission-session-state.js';
import { ConversationState } from './conversation-state.js';
import type { StoredChatMessage } from './conversation-state.js';
import { InteractionState } from './interaction-state.js';
import type { PendingInteraction, PendingInteractionState, QuestionPayload } from './interaction-state.js';
import { ApprovalInteractionState } from './approval-interaction-state.js';
import { PluginMutationLog } from './plugin-mutation-log.js';
import type { PluginPatchGroup } from './plugin-mutation-log.js';
import type { AskUserAnswer } from '../../ports/driven/session/InteractionPort.js';
import type { ApprovalWaitOptions } from '../../ports/driven/session/ApprovalPort.js';
import type { ApprovalChoiceId } from '../../ports/shared/approval-types.js';
import {
  cloneSkillLearningContinuation,
  type SkillLearningContinuation,
} from './skill-learning-continuation.js';
import {
  SKILL_LEARNING_CADENCE_VERSION,
  cloneSkillLearningCadence,
  type SkillLearningCadenceState,
} from './skill-learning-cadence.js';

// 从子状态文件重导出公开类型与函数（保持向后兼容）
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
export class SessionContext extends EventEmitter implements SessionEventPort {
  // ── 会话元数据（保留在 façade）──
  private sessionId: string;
  private tenantId: string;
  /** 会话唯一的权限状态聚合根。 */
  private readonly permissionSessionState: PermissionSessionState;
  private _appConfig?: AppConfig;

  // ── 子状态对象 ──
  private readonly conversationState: ConversationState;
  private readonly interactionState: InteractionState;
  private readonly approvalInteractionState: ApprovalInteractionState;
  private readonly pluginMutationLog: PluginMutationLog;
  /** 等待用户交互期间需要跨 run 和进程恢复的 Skill 学习证据。 */
  private skillLearningContinuation: Readonly<SkillLearningContinuation> | null = null;
  /** 跨普通成功回合累计的 Skill 学习节奏（零累计起步）。 */
  private skillLearningCadence: Readonly<SkillLearningCadenceState> = Object.freeze({
    version: SKILL_LEARNING_CADENCE_VERSION,
    accumulatedModelLoops: 0,
  });

  // ── 公开属性代理（保持向后兼容）──

  /** 人机协同审批服务（仅负责交互等待） */
  public get approvalInteraction(): ApprovalInteractionService {
    return this.approvalInteractionState.service;
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
    this.permissionSessionState = new PermissionSessionState({
      mode: getDefaultPermissionMode(),
    });

    // 实例化子状态对象
    const systemPrompt = buildSystemPrompt();
    this.conversationState = new ConversationState(systemPrompt);
    this.interactionState = new InteractionState();
    this.approvalInteractionState = new ApprovalInteractionState();
    this.pluginMutationLog = new PluginMutationLog();
  }



  // ── 系统提示词（委托给 ConversationState + busy 检查）──

  /**
   * 重新组装并更新会话消息历史中的首条系统提示词（System Prompt）。
   *
   * 调用约束：该方法只允许在会话构造期（规则初始化、会话打开）以及显式手动
   * 规则重载时调用；Skill 文件自动变更（SkillLibrary 订阅、项目 watcher 热更新）
   * 不得调用本方法改写首条系统消息。会话初始化后，系统提示词中的 Skill 元数据
   * 部分保持构造时快照冻结，变更后的元数据从新会话开始生效。
   *
   * @param customGlobalRules - 可选的全局规则内容缓存
   * @param customLocalRules - 可选的局部规则内容缓存
   * @param skills - 可选的技能元数据列表（活跃会话应传入构造时冻结的快照）
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
    return this.permissionSessionState.getMode();
  }

  /**
   * 获取当前会话唯一的权限状态。
   *
   * @returns 当前 PermissionSessionState
   */
  public getPermissionSessionState(): PermissionSessionState {
    return this.permissionSessionState;
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
        oldValue: this.permissionSessionState.getMode(),
        newValue: mode,
        reason: 'isProcessing=true'
      });
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    const previousMode = this.permissionSessionState.getMode();
    this.permissionSessionState.applyUpdates([{
      type: 'setMode',
      target: 'session',
      mode,
    }]);
    const currentMode = this.permissionSessionState.getMode();
    logger.info('[SessionContext] permission_mode_changed', {
      component: 'context',
      event: 'permission_mode_changed',
      sessionId: this.sessionId,
      oldValue: previousMode,
      newValue: currentMode,
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

  /**
   * 获取等待用户交互前保存的 Skill 学习延续状态。
   *
   * @returns 只读延续状态；当前没有中断学习单元时返回 null
   */
  public getSkillLearningContinuation(): Readonly<SkillLearningContinuation> | null {
    return this.skillLearningContinuation;
  }

  /**
   * 保存等待用户交互前已经产生的 Skill 学习证据。
   * 该插件状态独立于消息沙箱提交，供 RunEnd 后的会话快照持久化。
   *
   * @param continuation - 已完成中断段的学习证据
   */
  public setSkillLearningContinuation(
    continuation: Readonly<SkillLearningContinuation>,
  ): void {
    this.skillLearningContinuation = cloneSkillLearningContinuation(continuation);
  }

  /** 清除已经完成或失效的 Skill 学习延续状态。 */
  public clearSkillLearningContinuation(): void {
    this.skillLearningContinuation = null;
  }

  /**
   * 获取跨普通成功回合累计的 Skill 学习节奏状态。
   * 该状态与延续状态独立：前者累计未达阈值次数，后者表示一个尚未完成的逻辑任务。
   *
   * @returns 只读学习节奏状态；从未设置时返回零累计
   */
  public getSkillLearningCadence(): Readonly<SkillLearningCadenceState> {
    return this.skillLearningCadence;
  }

  /**
   * 保存 Skill 学习节奏状态（深复制冻结）。
   * 只允许在 RunEnd 结算时写入；快照恢复与插件内存态由此保持一致。
   *
   * @param state - 最新累计状态
   */
  public setSkillLearningCadence(
    state: Readonly<SkillLearningCadenceState>,
  ): void {
    this.skillLearningCadence = cloneSkillLearningCadence(state);
  }

  /** 将学习节奏复位为零累计（fail-closed 恢复与显式清零共用）。 */
  public resetSkillLearningCadence(): void {
    this.skillLearningCadence = Object.freeze({
      version: SKILL_LEARNING_CADENCE_VERSION,
      accumulatedModelLoops: 0,
    });
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

  // ── 审批交互 ──

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
    return this.approvalInteractionState.waitApproval(approvalId, actionInfo, options, warningMsg);
  }

}
