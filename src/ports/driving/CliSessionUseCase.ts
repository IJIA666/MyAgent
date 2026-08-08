/**
 * @file 定义 CLI 输入适配器驱动会话的专用 driving port。
 * 在通用 ChatUseCase 基础上补充斜杠命令与终端渲染所需的最小能力，
 * 避免 CLI 再直接依赖 SessionManager 等 core 实现细节。
 */

import type { LlmConfig, ConfigPermissionMode } from '../../config/index.js';
import type { ToolRegistryPort } from '../driven/tools/ToolRegistryPort.js';
import type {
  CompactionPreference,
  CompactionResult,
} from '../driven/llm/LlmPort.js';
import type { ChatUseCase } from './ChatUseCase.js';
import type {
  PermissionUpdate,
} from '../../core/domain/permissions/permission-types.js';
import type {
  PermissionSessionSnapshot,
} from '../../core/domain/permissions/permission-session-state.js';
import type {
  MemoryDiagnostic,
  MemoryTopicDiagnosticResult,
} from '../../core/usecases/brain/memory-loader.js';
import type {
  MemoryCandidate,
} from '../../core/usecases/brain/memory-candidate-store.js';
import type { TaskStatus, TaskUsage, TaskMode } from '../../core/usecases/subagent/task-state.js';

/**
 * CLI 可消费的技能摘要信息。
 */
export interface CliSkillSummary {
  /** 技能名称 */
  name: string;
  /** 技能简介 */
  description: string;
}

/** CLI 可展示的一条 Skill pending 摘要。 */
export interface CliSkillPendingSummary {
  readonly id: string;
  readonly action: string;
  readonly name: string;
  readonly origin: string;
  readonly summary: string;
  readonly createdAt: string;
}

/** `/skill diff` 返回的只读结果。 */
export type CliSkillPendingDiff =
  | { readonly status: 'ready'; readonly diff: string; readonly pending: CliSkillPendingSummary }
  | { readonly status: 'missing' | 'stale' | 'error'; readonly error: string };

/** approve/reject 对单条 pending 的结果。 */
export interface CliSkillPendingActionResult {
  readonly id: string;
  readonly status: 'success' | 'error';
  readonly summary: string;
}

/** CLI 可见的 Curator 状态，不含 Skill 正文或内部物理路径。 */
export interface CliCuratorStatus {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly stateStatus: 'missing' | 'healthy' | 'degraded';
  readonly lastRunAt: string | null;
  readonly lastActivityAt: string | null;
  readonly paused: boolean;
  readonly recentReportId: string | null;
  readonly usageHealthy: boolean;
  readonly usageDegradedReason?: string;
  readonly activeSkillCount: number;
  readonly archivedSkillCount: number;
  readonly intervalHours: number;
  readonly minIdleHours: number;
  readonly staleAfterDays: number;
  readonly archiveAfterDays: number;
  readonly consolidate: boolean;
}

/** CLI 可见的 Curator 运行摘要。 */
export interface CliCuratorRunSummary {
  readonly status: string;
  readonly checkedCount: number;
  readonly candidateCount: number;
  readonly plannedTransitionCount: number;
  readonly appliedTransitionCount: number;
  readonly skippedTransitionCount: number;
  readonly consolidationCount: number;
  readonly backupId: string | null;
  readonly reportId: string | null;
  readonly reason?: string;
}

/** adopt/pin/unpin/restore 的 CLI 结果。 */
export interface CliCuratorSkillActionResult {
  readonly status: 'changed' | 'skipped' | 'error';
  readonly name: string;
  readonly summary: string;
}

/** CLI 可见的归档 Skill，不含归档物理路径。 */
export interface CliCuratorArchivedSkill {
  readonly name: string;
  readonly archivedAt: string | null;
  readonly absorbedInto: string | null;
}

/** CLI 可见的 Curator 备份，不含备份物理路径。 */
export interface CliCuratorBackup {
  readonly id: string;
  readonly createdAt: string;
}

/** `/memory` 命令可查看的低敏长期记忆状态。 */
export interface CliMemoryStatus {
  /** 启动自动投影是否启用。 */
  readonly enabled: boolean;
  /** 当前精确 memory 根。 */
  readonly memoryDir: string;
  /** 当前根来自默认项目路径还是受信自定义配置。 */
  readonly rootKind: 'default' | 'custom';
  /** 启动快照是否为空。 */
  readonly isEmpty: boolean;
  /** 启动快照是否被 200 行或 25KB 上限截断。 */
  readonly isTruncated: boolean;
  /** 索引中已解析的 topic 引用数量，不代表已读取正文。 */
  readonly indexedTopicCount: number;
  /** 最近一次启动索引加载诊断。 */
  readonly diagnostic: MemoryDiagnostic;
}

/** CLI 可见的子代理任务摘要，不含 prompt、transcript 路径和原始消息。 */
export interface CliAgentTaskSummary {
  readonly agentId: string;
  readonly description: string;
  readonly agentType: string;
  readonly contextPolicy: 'fresh' | 'history-replay' | 'exact-fork';
  readonly mode: TaskMode;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly usage?: TaskUsage;
}

/** CLI 可见的子代理任务详情，仅展示扫描结果和低敏错误。 */
export interface CliAgentTaskDetail {
  readonly task: CliAgentTaskSummary;
  readonly result?: string;
  readonly error?: string;
}

/** CLI 取消任务的幂等结果。 */
export type CliAgentTaskCancelResult =
  | { readonly status: 'cancelled'; readonly agentId: string }
  | { readonly status: 'already_terminal'; readonly agentId: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'error'; readonly agentId?: string; readonly message: string };

/** `/subtask` 的受信 exact-fork 入口返回值。 */
export type CliSubtaskResult =
  | { readonly status: 'async_launched'; readonly agentId: string; readonly description: string }
  | { readonly status: 'error'; readonly agentId?: string; readonly code: string; readonly message: string };

/**
 * CLI 驱动会话专用端口。
 * 该接口聚合终端斜杠命令真正需要的最小能力，
 * 使输入适配器不必再回落到 SessionManager 实现类。
 */
export interface CliSessionUseCase extends ChatUseCase {
  /** 当前工具注册表端口 */
  readonly toolRegistryInstance: ToolRegistryPort;

  /**
   * 获取当前会话唯一标识。
   *
   * @returns 会话 ID
   */
  getSessionId(): string;

  /**
   * 显式恢复持久化会话状态。
   *
   * @param targetSessionId - 目标会话 ID
   * @returns 恢复是否成功
   */
  loadState(targetSessionId: string): Promise<boolean>;

  /**
   * 动态切换当前会话的大模型配置。
   *
   * @param newConfig - 新模型配置
   * @param options - 可选的运行参数
   */
  switchModel(newConfig: LlmConfig, options?: Record<string, unknown>): void;

  /**
   * 获取当前生效的完整大语言模型连接配置（只读）。
   *
   * @returns 当前生效的 LlmConfig
   */
  getLlmConfig(): LlmConfig;

  /**
   * 规划并执行当前会话的上下文压缩。
   *
   * @param preference - 自动选择策略，或显式要求全量压缩
   * @returns 包含状态、策略、前后预算与原因的结构化结果
   */
  compact(preference?: CompactionPreference): Promise<CompactionResult>;

  /**
   * 重新加载全局规则、局部规则和技能索引。
   */
  reloadRules(): void;

  /**
   * 列出当前可用技能摘要。
   *
   * @returns 技能列表
   */
  getAvailableSkills(): CliSkillSummary[];

  /**
   * 获取指定技能的完整内容。
   *
   * @param name - 技能名称
   * @returns 技能正文，若不存在则返回 null
   */
  getSkillContent(name: string): string | null;

  /** @returns 当前全部 Skill pending 摘要 */
  listSkillPending?(): readonly CliSkillPendingSummary[];

  /**
   * 获取一条 pending 的只读 diff。
   *
   * @param id - pending id
   */
  getSkillPendingDiff?(id: string): Promise<CliSkillPendingDiff>;

  /**
   * 批准一条或全部 pending，每条独立重放。
   *
   * @param target - pending id 或 all
   */
  approveSkillPending?(target: string): Promise<readonly CliSkillPendingActionResult[]>;

  /**
   * 拒绝一条或全部 pending。
   *
   * @param target - pending id 或 all
   */
  rejectSkillPending?(target: string): readonly CliSkillPendingActionResult[];

  /** @returns 当前 writeApproval 开关 */
  getSkillWriteApprovalEnabled?(): boolean;

  /**
   * 持久化并切换 writeApproval。
   *
   * @param enabled - 是否开启暂存批准
   */
  setSkillWriteApprovalEnabled?(enabled: boolean): Promise<void>;

  /** @returns 当前 Curator 低敏控制面状态 */
  getCuratorStatus?(): CliCuratorStatus;

  /**
   * 执行手动 Curator 运行。
   *
   * @param options - dry-run 和可选融合开关
   * @returns 运行摘要
   */
  runCurator?(options: {
    readonly dryRun: boolean;
    /** true 表示显式启用融合；省略时沿用 settings 默认值。 */
    readonly consolidate?: boolean;
  }): Promise<CliCuratorRunSummary>;

  /**
   * 暂停或恢复 Curator。
   *
   * @param paused - 是否暂停
   */
  setCuratorPaused?(paused: boolean): void;

  /** @param name - Skill 名称 */
  adoptCuratorSkill?(name: string): Promise<CliCuratorSkillActionResult>;
  /** @param name - Skill 名称 */
  pinCuratorSkill?(name: string): Promise<CliCuratorSkillActionResult>;
  /** @param name - Skill 名称 */
  unpinCuratorSkill?(name: string): Promise<CliCuratorSkillActionResult>;
  /** @returns 已归档 Skill 摘要 */
  listCuratorArchived?(): readonly CliCuratorArchivedSkill[];
  /** @param name - Skill 名称 */
  restoreCuratorSkill?(name: string): Promise<CliCuratorSkillActionResult>;
  /** @returns 新建备份摘要 */
  createCuratorBackup?(): CliCuratorBackup;
  /** @returns 有效备份摘要 */
  listCuratorBackups?(): readonly CliCuratorBackup[];
  /** @param id - 可选备份标识，缺省恢复最新 */
  rollbackCuratorBackup?(id?: string): CliCuratorBackup;

  /**
   * 动态切换当前会话的工作模式。
   *
   * @param mode - 目标工作模式
   */
  /**
   * 动态切换当前会话的权限模式。
   *
   * @param mode - 目标权限模式
   */
  setPermissionMode(mode: ConfigPermissionMode): void;

  /**
   * 获取当前会话权限状态快照。
   *
   * @returns 模式、规则、额外目录和状态版本
   */
  getPermissionSnapshot?(): PermissionSessionSnapshot;

  /**
   * 提交权限管理命令产生的更新。
   *
   * @param updates - 待提交更新
   */
  applyPermissionUpdates?(updates: readonly PermissionUpdate[]): Promise<void>;

  /**
   * 获取当前 Auto Memory 状态，不返回 MEMORY.md 或候选正文。
   *
   * @returns 低敏状态摘要
   */
  getMemoryStatus?(): CliMemoryStatus;

  /**
   * 原子持久化用户级 Auto Memory 开关，并刷新当前会话投影。
   *
   * @param enabled - 是否启用
   */
  setAutoMemoryEnabled?(enabled: boolean): Promise<void>;

  /**
   * 手动触发一次后台记忆巩固（/memory-dream 命令入口）。
   * 只绕过时间/会话门，仍原子获取同一互斥锁。
   *
   * @returns 执行结果或失败原因
   */
  runMemoryDream?(): Promise<
    | { readonly ok: true; readonly improvedFiles: number }
    | { readonly ok: false; readonly reason: string }
  >;

  /**
   * 显式按需读取并诊断索引引用的 topic 文件。
   *
   * @returns topic 元数据与诊断；不得由启动流程隐式调用
   */
  diagnoseMemoryTopics?(): MemoryTopicDiagnosticResult;

  /**
   * 列出尚未激活的候选及其 provenance。
   *
   * @returns 候选列表
   */
  listMemoryCandidates?(): readonly MemoryCandidate[];

  /**
   * 撤销一个尚未激活的候选。
   *
   * @param candidateId - 候选 UUID
   * @returns 候选存在并删除时为 true
   */
  discardMemoryCandidate?(candidateId: string): boolean;

  /** 从空闲且协议闭合的父会话启动后台 exact-fork。 */
  startSubtask(prompt: string, description: string): Promise<CliSubtaskResult>;

  /** 列出当前父会话的低敏子代理任务。 */
  listAgentTasks(): Promise<readonly CliAgentTaskSummary[]>;

  /** 查看一条当前父会话任务的扫描结果和低敏错误。 */
  getAgentTask(agentId: string): Promise<CliAgentTaskDetail | { readonly status: 'not_found' }>;

  /** 取消一条任务或全部任务。 */
  cancelAgentTask(agentId: string | 'all'): Promise<CliAgentTaskCancelResult | readonly CliAgentTaskCancelResult[]>;
}
