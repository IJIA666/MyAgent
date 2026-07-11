import { SecurityService } from '../security/SecurityService.js';
import { computeArgumentsDigest } from '../../domain/call-capability.js';
import type { SessionContext } from '../../domain/context.js';
import type { PendingGrant, PersistentRuleEffect } from '../plugins/plugin-types.js';

/**
 * 审批效果提交协作者。
 *
 * 集中处理 `pendingGrant`（call capability 注册与会话级白名单写入）
 * 与 `persistentRuleEffect`（持久化安全白名单落盘），消除主工具调用与
 * tail call 之间的重复代码。
 *
 * 该类为无状态工具类，所有副作用操作通过参数传入的 `SessionContext`
 * 与全局 `SecurityService` 单例完成。
 */
export class ApprovalEffectApplier {
  /**
   * 提交待定的授权许可（pendingGrant）。
   *
   * 根据授权类型分流处理：
   * - `call`：注册一次性调用授权令牌（Call Capability），绑定 toolCallId + 工具名 + 参数摘要
   * - `session`：将授权资源写入当前会话的临时白名单（读/写/目录范围）
   *
   * @param grant - 插件管线返回的授权许可凭证
   * @param context - 当前会话上下文，授权效果将写入其中
   * @param functionArgs - call 类型 grant 所需的工具参数（用于计算 argumentsDigest），session 类型可省略
   */
  public applyPendingGrant(
    grant: PendingGrant,
    context: SessionContext,
    functionArgs?: Record<string, unknown>
  ): void {
    switch (grant.type) {
      case 'call': {
        // 在注册点计算 argumentsDigest，确保 claimCapability 侧有可靠比对源
        const digest = functionArgs
          ? computeArgumentsDigest(functionArgs)
          : computeArgumentsDigest({});
        context.registerCallCapability({
          toolCallId: grant.toolCallId,
          toolName: grant.toolName,
          resources: grant.resources,
          argumentsDigest: digest,
          state: 'registered',
          createdAt: Date.now()
        });
        break;
      }
      case 'session': {
        // 根据资源 kind 分流写入：directory-scope 写入目录范围白名单，
        // path 按 access 写入精确读/写白名单（command-prefix 和 command-operation 不会出现在会话授权中）
        for (const r of grant.resources) {
          if (r.kind === 'command-prefix' || r.kind === 'command-operation') continue;
          if (r.kind === 'directory-scope') {
            context.addTemporaryDirectoryScopeReadWhitelist(r.normalizedPath);
          } else if (r.access === 'read') {
            context.addTemporaryReadWhitelist(r.normalizedPath);
          } else {
            context.addTemporaryWriteWhitelist(r.normalizedPath);
          }
        }
        break;
      }
    }
  }

  /**
   * 提交持久化规则授权效果。
   *
   * 将插件的 `PersistentRuleEffect` 中的 prefix 规则持久化写入磁盘白名单。
   * 仅在 prefix 规则尚未存在于现有白名单中时才执行写入（防重复）。
   *
   * @param effect - 插件管线返回的持久化规则效果
   */
  public applyPersistentRuleEffect(effect: PersistentRuleEffect): void {
    const securityService = SecurityService.getInstance();
    const whitelist = securityService.getSecurityAllowlist();
    const prefixRule = `${effect.prefix}:*`;
    if (!whitelist.includes(prefixRule)) {
      securityService.saveSecurityAllowlist([...whitelist, prefixRule]);
    }
  }
}
