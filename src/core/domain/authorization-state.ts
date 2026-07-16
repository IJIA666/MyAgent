import { relative, isAbsolute } from 'path';
import { ApprovalService } from '../usecases/security/ApprovalService.js';
import { SecurityService } from '../usecases/security/SecurityService.js';
import type { CallCapability } from './call-capability.js';
import { computeArgumentsDigest } from './call-capability.js';
import type { TemporaryWhitelistAccess } from './whitelist-access.js';
import type { SafetyResource } from '../usecases/security/SafetyResource.js';
import type { ApprovalWaitOptions } from '../../ports/driven/session/ApprovalPort.js';

/**
 * 授权状态管理。
 * 负责审批服务生命周期、CallCapability 令牌状态机与临时白名单访问。
 * 实现 `TemporaryWhitelistAccess` 接口以解耦 SessionContext 与 SecurityService 的直接桥接。
 */
export class AuthorizationState implements TemporaryWhitelistAccess {
  /** 用于控制危险操作挂起与恢复的人机协同审批服务 */
  public readonly approvalService: ApprovalService;

  /** call capability 令牌存储 Map，以 toolCallId 为键 */
  private callCapabilities: Map<string, CallCapability> = new Map();

  constructor() {
    this.approvalService = new ApprovalService();
  }

  // ── 审批 ──

  /**
   * 挂起当前高危操作，等待人机协同的确权审批。
   *
   * @param approvalId - 本次审批请求的唯一随机 ID
   * @param actionInfo - 触发审批的动作与参数信息
   * @param options - 附加的运行时配置项
   * @param warningMsg - 可选的向用户展示的安全警示信息
   * @returns 包含用户动作（允许/拒绝）的审批决策结果对象
   */
  async waitApproval(
    approvalId: string,
    actionInfo: { name: string; arguments?: Record<string, unknown> },
    options?: string | ApprovalWaitOptions,
    warningMsg?: string
  ): Promise<{ action: 'approve' | 'deny'; reason?: string }> {
    const waitOptions = typeof options === 'object' && options !== null ? options : undefined;
    const decision = await this.approvalService.wait(
      approvalId,
      { name: actionInfo.name, arguments: actionInfo.arguments || {} },
      typeof options === 'string' ? options : undefined,
      warningMsg,
      waitOptions?.timeoutMs,
      waitOptions?.sessionId,
      undefined,
      waitOptions?.signal,
    );
    return {
      action: (
        decision.action === 'call' ||
        decision.action === 'session' ||
        decision.action === 'persistent'
      ) ? 'approve' : 'deny'
    };
  }

  // ── Call Capability 令牌生命周期 ──

  /**
   * 注册一个 call 级授权令牌（registered 状态）。
   *
   * @param cap - 待注册的授权令牌，必须包含 argumentsDigest
   */
  registerCallCapability(cap: CallCapability): void {
    cap.state = 'registered';
    cap.createdAt = Date.now();
    this.callCapabilities.set(cap.toolCallId, cap);
  }

  /**
   * 领取（claim）一个 registered 状态的令牌，将其切换为 claimed。
   * 验证 toolCallId + toolName + argumentsDigest 三重匹配，防止参数篡改。
   *
   * @param toolCallId - 工具调用唯一标识
   * @param toolName - 工具名称
   * @param args - 工具调用参数，用于计算摘要与注册时的 digest 比对
   * @returns 已 claim 的资源列表，若令牌不存在/状态非 registered/摘要不匹配则返回 null
   */
  claimCapability(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>
  ): SafetyResource[] | null {
    const cap = this.callCapabilities.get(toolCallId);
    if (!cap || cap.state !== 'registered') {
      return null;
    }
    if (cap.toolName !== toolName) {
      return null;
    }
    const digest = computeArgumentsDigest(args);
    if (cap.argumentsDigest !== digest) {
      return null;
    }
    cap.state = 'claimed';
    cap.claimedBy = toolCallId;
    return cap.resources;
  }

  /**
   * 消费（consume）一个 claimed 状态的令牌，将其切换为 removed。
   *
   * @param toolCallId - 工具调用唯一标识
   */
  consumeCapability(toolCallId: string): void {
    const cap = this.callCapabilities.get(toolCallId);
    if (cap && cap.state === 'claimed') {
      cap.state = 'removed';
    }
  }

  /**
   * 检查指定 toolCallId 的 claimed 令牌中是否包含匹配的路径资源。
   * 同时校验路径和 access（read/write）类型，防止读授权升级为写。
   *
   * @param toolCallId - 工具调用唯一标识
   * @param access - 访问类型（'read' 或 'write'）
   * @param normalizedPath - 规范化后的物理路径
   * @returns 存在匹配的 claimed 资源返回 true，否则 false
   */
  hasClaimedResource(toolCallId: string, access: 'read' | 'write', normalizedPath: string): boolean {
    const cap = this.callCapabilities.get(toolCallId);
    if (!cap || cap.state !== 'claimed') {
      return false;
    }
    return cap.resources.some(
      (r) => {
        if (r.kind === 'path') {
          return r.access === access && r.normalizedPath === normalizedPath;
        }
        if (r.kind === 'directory-scope') {
          return access === 'read' && this.isPathWithinDirectoryScope(r.normalizedPath, normalizedPath);
        }
        return false;
      }
    );
  }

  // ── 安全白名单 ──

  /** 获取当前有效的安全命令白名单列表 */
  getSecurityAllowlist(): string[] {
    return SecurityService.getInstance().getSecurityAllowlist();
  }

  // ── TemporaryWhitelistAccess 实现 ──

  hasReadWhitelist(sessionId: string, path: string): boolean {
    return SecurityService.getInstance().hasTemporaryReadWhitelist(sessionId, path);
  }

  hasWriteWhitelist(sessionId: string, path: string): boolean {
    return SecurityService.getInstance().hasTemporaryWriteWhitelist(sessionId, path);
  }

  addReadWhitelist(sessionId: string, path: string): void {
    SecurityService.getInstance().addTemporaryReadWhitelist(sessionId, path);
  }

  addWriteWhitelist(sessionId: string, path: string): void {
    SecurityService.getInstance().addTemporaryWriteWhitelist(sessionId, path);
  }

  addDirectoryScopeReadWhitelist(sessionId: string, dirRoot: string): void {
    SecurityService.getInstance().addTemporaryDirectoryScopeReadWhitelist(sessionId, dirRoot);
  }

  clearWhitelists(sessionId: string): void {
    SecurityService.getInstance().clearTemporaryWhitelists(sessionId);
  }

  // ── 私有辅助 ──

  /** 判断目标路径是否位于某个目录范围资源所覆盖的子树内 */
  private isPathWithinDirectoryScope(scopeRoot: string, targetPath: string): boolean {
    const rel = relative(scopeRoot, targetPath);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }
}
