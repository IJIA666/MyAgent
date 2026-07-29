/**
 * @file 权限与执行网关测试使用的不可变 ExecutionPlan 工厂。
 * 测试必须显式提供计划，禁止通过生产代码重新引入兼容 fallback。
 */

import { ExecutionPlan } from '../../src/core/domain/permissions/execution-plan.js';
import type {
  PermissionIdentity,
  ResourceEvidence,
} from '../../src/core/domain/permissions/permission-types.js';
import { createSandboxAttestation } from '../../src/core/domain/security/sandbox-attestation.js';

/**
 * 创建绑定当前 sandbox attestation 的测试执行计划。
 *
 * @param toolName - 运行时工具名
 * @param args - 不可变参数
 * @param options - 身份、资源和状态版本覆盖
 * @returns 测试 ExecutionPlan
 */
export function createTestExecutionPlan(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  options: {
    identity?: PermissionIdentity;
    resources?: readonly ResourceEvidence[];
    stateVersion?: number;
  } = {},
): ExecutionPlan {
  const attestation = createSandboxAttestation();
  return new ExecutionPlan({
    runtimeToolName: toolName,
    permissionIdentity: options.identity ?? 'UnknownEffect',
    normalizedArgs: args,
    resourceEvidences: options.resources ?? [],
    evidenceDigest: `test:${toolName}`,
    callerId: 'test-local',
    stateVersion: options.stateVersion ?? 0,
    hostPolicyVersion: 'test',
    sandboxProfile: {
      platform: attestation.platform,
      containment: attestation.level,
      version: attestation.version,
    },
    expiryMs: 30_000,
  });
}
