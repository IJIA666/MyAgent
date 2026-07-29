/**
 * @file 不可变执行计划。
 * 授权绑定深冻结的计划，禁止执行期再次读取可变原始参数。
 * 计划内容、权限状态版本、host policy 或 sandbox profile 变化时 grant 失效。
 */

import type { PermissionIdentity, ResourceEvidence } from './permission-types.js';

/** Sandbox profile 摘要。 */
export interface SandboxProfile {
  readonly platform: string;
  readonly containment: 'contained' | 'policy-only' | 'degraded';
  readonly version: string;
}

/** 执行计划绑定的最小凭据 profile 摘要。 */
export interface CredentialProfileBinding {
  /** 凭据受众。 */
  readonly audience: 'model-provider' | 'browser' | 'mcp-server' | 'plugin' | 'terminal' | 'sub-agent';
  /** profile 版本。 */
  readonly version: string;
  /** 是否允许复制受众 allowlist 中的宿主环境。 */
  readonly inheritHostEnv: boolean;
}

/** ExecutionPlan 创建选项。 */
export interface ExecutionPlanOptions {
  readonly runtimeToolName: string;
  readonly permissionIdentity: PermissionIdentity;
  readonly normalizedArgs: Readonly<Record<string, unknown>>;
  readonly resourceEvidences: readonly ResourceEvidence[];
  readonly evidenceDigest: string;
  readonly callerId: string;
  readonly stateVersion: number;
  readonly hostPolicyVersion: string;
  readonly sandboxProfile: SandboxProfile;
  /** 当前执行使用的最小凭据 profile。 */
  readonly credentialProfile?: CredentialProfileBinding;
  readonly expiryMs: number;
}

/**
 * 深冻结的执行计划。
 * 授权依赖于计划内容、策略版本和状态版本的不可变性。
 */
export class ExecutionPlan {
  /** 创建时间戳 */
  readonly createdAt: number;
  /** 过期时间戳 */
  readonly expiresAt: number;
  /** 运行时工具名 */
  readonly runtimeToolName: string;
  /** 稳定权限身份 */
  readonly permissionIdentity: PermissionIdentity;
  /** 规范化、深冻结的参数 */
  readonly normalizedArgs: Readonly<Record<string, unknown>>;
  /** 资源身份与 evidence 摘要 */
  readonly evidenceDigest: string;
  /** 授权时解析出的正式资源证据。 */
  readonly resourceEvidences: readonly ResourceEvidence[];
  /** 调用者身份 id */
  readonly callerId: string;
  /** 权限状态版本 */
  readonly stateVersion: number;
  /** host policy 版本 */
  readonly hostPolicyVersion: string;
  /** sandbox/network/credential profile */
  readonly sandboxProfile: SandboxProfile;
  /** 最小凭据受众与版本。 */
  readonly credentialProfile: CredentialProfileBinding;

  constructor(options: ExecutionPlanOptions) {
    const now = Date.now();
    this.createdAt = now;
    this.expiresAt = now + options.expiryMs;
    this.runtimeToolName = options.runtimeToolName;
    this.permissionIdentity = options.permissionIdentity;
    this.normalizedArgs = deepFreezeArgs(options.normalizedArgs);
    this.evidenceDigest = options.evidenceDigest;
    this.resourceEvidences = deepFreezeValue(
      options.resourceEvidences,
    ) as readonly ResourceEvidence[];
    this.callerId = options.callerId;
    this.stateVersion = options.stateVersion;
    this.hostPolicyVersion = options.hostPolicyVersion;
    this.sandboxProfile = Object.freeze({ ...options.sandboxProfile });
    this.credentialProfile = Object.freeze({
      ...(options.credentialProfile ?? {
        audience: 'plugin',
        version: '1.0.0',
        inheritHostEnv: false,
      }),
    });
    Object.freeze(this);
  }

  /**
   * 检查计划是否已过期。
   *
   * @returns 已过期返回 true
   */
  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }
}

/** 深冻结参数对象。 */
function deepFreezeArgs(args: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return deepFreezeValue(args) as Readonly<Record<string, unknown>>;
}

/** 递归复制并冻结对象与数组，避免授权后的嵌套参数被修改。 */
function deepFreezeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => deepFreezeValue(item)));
  }
  if (value !== null && typeof value === 'object') {
    const frozen: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      frozen[key] = deepFreezeValue(nestedValue);
    }
    return Object.freeze(frozen);
  }
  return value;
}
