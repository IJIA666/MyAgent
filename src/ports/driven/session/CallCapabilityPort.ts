/**
 * @file CallCapabilityPort.ts
 * @description 一次性授权能力（Call Capability）的领取与资源验证输出端口契约。
 *
 * Call Capability 是 BeforeTool 阶段经用户审批后注册的一次性授权令牌。
 * 执行边界在执行工具前领取该令牌，执行完成后由编排器消费。
 * 此端口将能力生命周期操作抽象为接口，使类型系统可以表达
 * "执行上下文只需能力领取能力，不依赖完整 SessionContext"。
 */

import type { SafetyResource } from '../../shared/safety-resource.js';

/**
 * Call Capability 领取与资源验证端口。
 *
 * 内建工具执行边界（ToolExecutor）和外部 MCP 远端调用前均消费此端口：
 * - `claimCapability`：认领匹配 toolCallId + toolName + args 的令牌
 * - `hasClaimedResource`：检查已认领令牌是否包含指定路径资源
 */
export interface CallCapabilityPort {
  /**
   * 认领一个 registered 状态的 call capability 令牌。
   * 验证 toolCallId + toolName + args 摘要三重匹配，防止参数篡改。
   *
   * @param toolCallId - 工具调用唯一标识
   * @param toolName - 工具名称
   * @param args - 工具参数（用于计算 argumentsDigest 比对）
   * @returns 匹配令牌的资源列表，若返回 null 表示无匹配或重复领取；
   *   空数组 `[]` 表示精确调用授权有效但没有路径资源
   */
  claimCapability(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): SafetyResource[] | null;

  /**
   * 检查指定 toolCallId 的已认领令牌中是否包含匹配的路径资源。
   *
   * @param toolCallId - 工具调用唯一标识
   * @param access - 访问类型（read / write）
   * @param normalizedPath - 经归一化的物理绝对路径
   * @returns 资源存在且匹配时返回 true
   */
  hasClaimedResource(
    toolCallId: string,
    access: 'read' | 'write',
    normalizedPath: string,
  ): boolean;
}
