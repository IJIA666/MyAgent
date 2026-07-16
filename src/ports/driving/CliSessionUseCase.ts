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

/**
 * CLI 可消费的技能摘要信息。
 */
export interface CliSkillSummary {
  /** 技能名称 */
  name: string;
  /** 技能简介 */
  description: string;
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
}
