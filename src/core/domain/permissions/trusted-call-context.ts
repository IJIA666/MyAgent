/**
 * @file 宿主验证的调用者上下文。
 * 定义 callerId、channelTrust、audience、parentAgent 和 policyVersion。
 * 入口未验证时使用明确的 untrusted caller，不依赖 session id 作为授权凭证。
 */

/** 调用渠道可信度。 */
export type ChannelTrust = 'interactive' | 'script' | 'remote' | 'background';

/** 调用者身份。 */
export interface CallerIdentity {
  /** 调用者唯一标识。 */
  readonly callerId: string;
  /** 渠道可信度。 */
  readonly channelTrust: ChannelTrust;
  /** 调用意图受众。 */
  readonly audience: 'user' | 'agent' | 'subagent' | 'system';
  /** 父 Agent 标识（子 Agent 调用时存在）。 */
  readonly parentAgent?: string;
}

/** 宿主验证的调用者上下文。 */
export interface TrustedCallContext {
  /** 调用者身份。 */
  readonly caller: CallerIdentity;
  /** 当前生效的策略版本。 */
  readonly policyVersion: string;
  /** 调用者身份是否由当前宿主进程验证，而非从会话 id 或请求字段推断。 */
  readonly hostVerified: boolean;
  /** 是否为已验证的本地交互用户。 */
  readonly isLocalInteractive: boolean;
}

/** 未经验证的调用者（默认兜底）。 */
export const UNTRUSTED_CALLER: TrustedCallContext = Object.freeze({
  caller: Object.freeze({
    callerId: 'untrusted',
    channelTrust: 'remote',
    audience: 'system',
  }),
  policyVersion: '0.0.0',
  hostVerified: false,
  isLocalInteractive: false,
});

/**
 * 创建受信调用者上下文。
 *
 * @param callerId - 调用者标识
 * @param channelTrust - 渠道可信度
 * @param policyVersion - 策略版本
 * @param audience - 调用意图受众
 * @returns TrustedCallContext
 */
export function createTrustedCallContext(
  callerId: string,
  channelTrust: ChannelTrust = 'interactive',
  policyVersion = '1.0.0',
  audience: CallerIdentity['audience'] = 'user',
): TrustedCallContext {
  return Object.freeze({
    caller: Object.freeze({
      callerId,
      channelTrust,
      audience,
    }),
    policyVersion,
    hostVerified: true,
    isLocalInteractive: channelTrust === 'interactive',
  });
}

/**
 * 从宿主验证的父 caller 派生受限子 Agent caller。
 * 子 caller 继承父策略版本与验证结果，但永远不是本地交互用户，
 * 并显式记录 parentAgent，避免复用父 caller 身份。
 *
 * @param parent - 父 Agent 的宿主 caller
 * @param childCallerId - 子 Agent 的唯一标识
 * @param channelTrust - 子任务渠道，默认 background
 * @returns 不共享可变引用的子 caller
 */
export function createChildTrustedCallContext(
  parent: TrustedCallContext,
  childCallerId: string,
  channelTrust: Extract<ChannelTrust, 'background' | 'script'> = 'background',
): TrustedCallContext {
  if (!childCallerId.trim()) {
    throw new Error('子 Agent callerId 不能为空');
  }
  return Object.freeze({
    caller: Object.freeze({
      callerId: childCallerId.trim(),
      channelTrust,
      audience: 'subagent',
      parentAgent: parent.caller.callerId,
    }),
    policyVersion: parent.policyVersion,
    hostVerified: parent.hostVerified,
    isLocalInteractive: false,
  });
}
