/**
 * @file 工具策略评估的共享数据契约。
 * 定义 ToolPolicyCall、SafetyCheckResult、SafetyOperation 等跨层复用的安全类型。
 *
 * @deprecated 将在 10.x 删除。新权限模型使用 `src/core/domain/permissions/` 下的
 * `ToolPermissionCheckResult`、`ToolPermissionService` 和 `ToolPermissionChecker` 接口。
 * 现有类型保留仅用于过渡期兼容，新代码应直接使用权限域的 checkPermissions 协议。
 */

import type { SafetyResource } from './safety-resource.js';
import type { SessionEventPort } from '../driven/session/SessionEventPort.js';

// ── 从 safety-resource.ts re-export ──

export type { SafetyResource };

// ── ToolPolicyCall ──

/**
 * 进入策略评估的工具调用描述。
 * 只读数据对象，包含策略端口评估所需的最小调用信息集。
 */
export interface ToolPolicyCall {
  /** 工具调用唯一标识符 */
  readonly toolCallId: string;
  /** 工具名称 */
  readonly toolName: string;
  /** 本次工具调用的参数键值对 */
  readonly args: Readonly<Record<string, unknown>>;
}

// ── ToolPolicyPort ──

/**
 * 工具安全策略评估输出端口。
 *
 * 职责：
 * 以标准化的 `ToolPolicyCall` 和当前会话事件契约为输入，
 * 返回统一的 `SafetyCheckResult`，覆盖 pass / suspend / deny 三种结果。
 *
 * 实现方（适配器）负责区分工具来源并进行对应的安全判定，
 * 消费方（如 HumanApprovalPlugin）只通过此端口获取结果，不关心来源。
 *
 * @deprecated 将在 10.x 由 `ToolPermissionService` + `ToolPermissionChecker` 替代。
 *   工具不再负责最终决策，改为实现 `checkPermissions` 返回中间结果，
 *   由统一权限服务产生最终 PermissionDecision。
 */
export interface ToolPolicyPort {
  /**
   * 评估一次工具调用的安全性。
   *
   * @param call - 工具调用描述（只读）
   * @param sessionContext - 当前会话事件契约，
   *   传入目的为使工具内建 checkSafety() 可访问会话白名单
   * @returns 统一的安全校验结果
   */
  evaluate(
    call: ToolPolicyCall,
    sessionContext: SessionEventPort,
  ): Promise<SafetyCheckResult>;
}

// ── SafetyCheckResult ──

/**
 * 工具安全校验结果契约接口。
 *
 * @deprecated 将在 10.x 由 `PermissionDecision` 替代。
 *   `status` 字段的 pass/suspend/deny 三分流将被 `allow / ask / deny` 取代。
 */
export interface SafetyCheckResult {
  /** 安全核查状态：通过（pass）、挂起确认（suspend）或拒绝（deny） */
  status: 'pass' | 'suspend' | 'deny';
  /** 用于人机审批时向用户展示的警告提示信息 */
  message?: string;
  /** 终端工具特有，用于安全白名单持久化的匹配前缀 */
  safePrefix?: string;
  /** 文件工具特有，越界读写的物理目标路径（保留向后兼容） */
  targetPath?: string;
  /** 原子资源列表，按工具类型正确标注 read/write */
  resources?: SafetyResource[];
  /** 标准化安全操作描述，由工具 checkSafety() 向策略层报告操作细节的统一接口 */
  operation?: SafetyOperation;
}

// ── SafetyOperation ──

/** 安全操作类别 */
export type OperationCategory =
  | 'file-read' | 'file-write' | 'file-edit' | 'file-delete'
  | 'file-move' | 'file-copy'
  | 'command-execute'
  /** 无可信资源提取器的外部工具调用 */
  | 'external-tool';

/**
 * Plan 模式副作用分类。
 * 工具根据自身元数据和参数分析，向策略层报告本次调用的实际副作用。
 * 策略层据此决定 Plan 模式下的 pass/suspend/deny。
 *
 * @deprecated 将在 10.x 删除。Plan 模式的限制由 `ToolPermissionService` 的模式后处理统一实现。
 */
export type PlanSideEffect =
  /** 可证明安全的原子只读操作，参数结构有效且不涉及敏感资源 */
  | 'read'
  /** 写入或修改操作 */
  | 'write'
  /** 无法确定副作用的操作（复合命令、未知 shell 结构等） */
  | 'unknown'
  /** 语法只读但涉及凭据、敏感配置等受保护资源的操作 */
  | 'sensitive-read'
  /** 系统毁灭级硬红线操作 */
  | 'hardline';

/**
 * 标准化安全操作描述契约。
 * 工具 checkSafety() 向策略层报告操作细节的统一接口。
 *
 * @deprecated 将在 10.x 删除。操作描述由 `ToolPermissionCheckResult` 的 decisionReason 替代。
 */
export interface SafetyOperation {
  /** 原子资源列表 */
  resources: SafetyResource[];
  /** 触发审批的风险原因 */
  riskReason: string;
  /** 操作类别 */
  operationCategory: OperationCategory;
  /** 人类可读的操作摘要（用于审批 UI 展示） */
  summary: string;
  /**
   * Plan 模式副作用分类。
   * 工具通过自身元数据和参数解析产出可信分类；
   * 策略层据此决定 Plan 模式下是直接放行、受限审批还是拒绝。
   */
  planSideEffect?: PlanSideEffect;
}
