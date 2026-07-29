/**
 * @file 一次性 ExecutionGrant 签发与验证服务。
 * 使用 Node crypto 安全随机源签发 opaque grant。
 * 验证服务实例身份、计划摘要、版本、过期时间和单次消费。
 */

import { randomBytes, createHash } from 'node:crypto';
import type { ExecutionPlan } from './execution-plan.js';

/** 不透明一次性执行 grant。 */
export interface ExecutionGrant {
  /** 不透明令牌。 */
  readonly token: string;
  /** 授权时的计划摘要。 */
  readonly planDigest: string;
  /** 授权时的 stateVersion。 */
  readonly stateVersion: number;
  /** 创建时间戳。 */
  readonly createdAt: number;
  /** 授权时绑定的 caller id。 */
  readonly callerId: string;
}

/** Grant 验证结果。 */
export type GrantVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * 一次性 ExecutionGrant 服务。
 * 每个服务实例产生唯一身份，cross-instance grant 自动失效。
 */
export class ExecutionGrantService {
  /** 服务实例唯一身份。 */
  private readonly serviceId: string;
  /** 当前服务实际签发的 grant 及其不可变摘要。 */
  private readonly issuedGrants = new Map<string, ExecutionGrant>();
  /** 已消费的 grant token 集合。 */
  private readonly consumedTokens = new Set<string>();

  constructor() {
    this.serviceId = randomBytes(16).toString('hex');
  }

  /**
   * 为执行计划签发一次性 grant。
   *
   * @param plan - 已构建的执行计划
   * @returns 一次性 grant
   */
  issueGrant(plan: ExecutionPlan): ExecutionGrant {
    const planDigest = computePlanDigest(plan, this.serviceId);
    const token = randomBytes(24).toString('hex');
    const grant: ExecutionGrant = Object.freeze({
      token,
      planDigest,
      stateVersion: plan.stateVersion,
      createdAt: Date.now(),
      callerId: plan.callerId,
    });
    this.issuedGrants.set(token, grant);
    return grant;
  }

  /**
   * 验证并消费一次 grant。
   *
   * @param grant - 待验证的 grant
   * @param plan - 待比对的实际计划
   * @returns 验证结果
   */
  consumeGrant(grant: ExecutionGrant, plan: ExecutionPlan): GrantVerification {
    if (this.consumedTokens.has(grant.token)) {
      return { valid: false, reason: 'grant 已被消费' };
    }
    const issued = this.issuedGrants.get(grant.token);
    if (!issued || issued !== grant) {
      return { valid: false, reason: 'grant 未由当前服务签发' };
    }
    if (grant.stateVersion !== plan.stateVersion) {
      return { valid: false, reason: `stateVersion 不匹配: ${grant.stateVersion} vs ${plan.stateVersion}` };
    }
    if (plan.isExpired()) {
      return { valid: false, reason: '执行计划已过期' };
    }
    const expectedDigest = computePlanDigest(plan, this.serviceId);
    if (grant.planDigest !== expectedDigest) {
      return { valid: false, reason: '计划摘要不匹配' };
    }
    if (grant.callerId !== plan.callerId) {
      return { valid: false, reason: 'callerId 不匹配' };
    }
    this.consumedTokens.add(grant.token);
    this.issuedGrants.delete(grant.token);
    return { valid: true };
  }
}

/** 计算计划摘要（包含服务身份以防止跨实例重用）。 */
function computePlanDigest(plan: ExecutionPlan, serviceId: string): string {
  const hash = createHash('sha256');
  hash.update(serviceId);
  hash.update(plan.runtimeToolName);
  hash.update(plan.permissionIdentity);
  hash.update(plan.evidenceDigest);
  hash.update(JSON.stringify(plan.resourceEvidences));
  hash.update(JSON.stringify(plan.normalizedArgs));
  hash.update(String(plan.stateVersion));
  hash.update(plan.hostPolicyVersion);
  hash.update(plan.callerId);
  hash.update(JSON.stringify(plan.sandboxProfile));
  hash.update(JSON.stringify(plan.credentialProfile));
  hash.update(String(plan.expiresAt));
  return hash.digest('hex').slice(0, 16);
}
