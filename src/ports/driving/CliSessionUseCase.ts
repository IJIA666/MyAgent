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

/**
 * CLI 可消费的技能摘要信息。
 */
export interface CliSkillSummary {
  /** 技能名称 */
  name: string;
  /** 技能简介 */
  description: string;
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
}
