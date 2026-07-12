/**
 * @fileoverview 鏅鸿兘浣撴彃浠朵笌鐢熷懡鍛ㄦ湡 Hook 寮虹被鍨嬪绾﹀畾涔夈€?
 * 鏈ā鍧楀畾涔変簡鎸傝浇鍦ㄦ櫤鑳戒綋鍚勬墽琛岃妭鐐圭殑鎷︽埅鎻掍欢瑙勬牸涓庣閬撴墽琛屼笂涓嬫枃銆?
 * 閮ㄥ垎鍩虹绫诲瀷宸茶縼绉昏嚦 ports/shared/锛屾澶勯€氳繃瀵煎叆涓庢墿灞曚繚鎸佸悜鍚庡吋瀹广€?
 */

import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { SessionContext, ContextTokenUsage } from '../../domain/context.js';
import type { AgentPlugin } from '../../../ports/driven/tools/AgentPlugin.js';
import type { SafetyResource } from '../../../ports/shared/safety-resource.js';
import type { PortHookContext } from '../../../ports/shared/plugin-types.js';
import type { ApprovalChoice, ApprovalChoiceId } from '../../../ports/shared/approval-types.js';
import type { SafetyCheckResult, SafetyOperation } from '../../../ports/shared/tool-policy.js';
/** @deprecated 使用 PermissionDecision 替代 */
import type { SessionEventPort } from '../../../ports/driven/session/SessionEventPort.js';
import type { CallCapabilityPort } from '../../../ports/driven/session/CallCapabilityPort.js';
import type { EventNotificationPort } from '../../../ports/driven/session/EventNotificationPort.js';
export type { ApprovalChoice, ApprovalChoiceId };
export type { SafetyCheckResult, SafetyOperation };
export type { PermissionDecision } from '../../domain/permissions/permission-types.js';

/**
 * 澶фā鍨嬭姹傛墍闇€鐨勫弬鏁拌浇浣撱€?
 */
export interface LlmRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: Record<string, unknown>[];
  [key: string]: unknown;
}
// End of plugin type contracts.
/**
 * 鏅鸿兘浣?Hook 鐢熷懡鍛ㄦ湡鐨勪簨浠舵灇涓俱€?
 * 瀹氫箟宸茶縼绉昏嚦 ports/shared/plugin-types.ts锛屾澶?re-export 浠ヤ繚鎸佸悜鍚庡吋瀹广€?
 */
export { HookEventName } from '../../../ports/shared/plugin-types.js';

/**
 * 鎺у埗娴佸喅绛栨寚浠わ紝鐢ㄤ簬鎸囧紩澶у惊鐜殑涓柇涓庨噸缃€?
 */
export interface HookControl {
  /** 鎺у埗娴佹寚浠わ細continue 涓洪『寤讹紝restart 涓哄帇缂╅噸鍚紝abort 涓虹粓姝㈠ぇ寰幆 */
  action: 'continue' | 'restart' | 'abort';
  /** 涓柇鎴栭噸鍚殑褰掑洜鍘熷洜璇存槑 */
  reason?: string;
}

/**
 * Hook 鎵ц闃舵鐨勪笂涓嬫枃瀵硅薄锛岀粺绠¤緭鍏ュ弬鏁般€佽繑鍥炴暟鎹強鎺у埗娴佺姸鎬併€?
 * 鎵╁睍鑷鍙ｅ眰 PortHookContext锛岃ˉ鍏?SessionContext 绛?core 鐗规湁瀛楁銆?
 */
export interface HookContext extends PortHookContext {
  /** 褰撳墠鏅鸿兘浣撲細璇濈殑 SessionContext */
  sessionContext: SessionContext;
  /** 澶фā鍨嬬殑璇锋眰閰嶇疆椤癸紙 浠呭湪 BeforeModel / BeforeToolSelection 涓瓨鍦紝鍏佽琚氨鍦颁慨鏀?锛?*/
  llmRequest?: LlmRequest;
  /** 绠￠亾鐨勬帶鍒朵俊鍙凤紝鎺у埗澶у惊鐜殑鍚庣画琛屼负锛岄粯璁ゅ垵濮嬪寲涓?continue */
  control: HookControl;
  /** 棰勬祴 of Token 璇︽儏锛屼富瑕佺敱 TokenWatermark 鎻掍欢杩涜浼扮畻骞跺～鍐?*/
  estimatedUsage?: ContextTokenUsage;
  /** 鎻掍欢鍙湪姝ゅ瓧娈佃繑鍥炴巿鏉?grant锛岀敱 AgentLoop 鍦ㄥ畨鍏ㄦ潯浠朵笅鎻愪氦 */
  pendingGrant?: PendingGrant;
  /** 鎻掍欢鍙湪姝ゅ瓧娈佃繑鍥炴寔涔呭寲瑙勫垯鏁堟灉锛岀敱 AgentLoop 鍦ㄥ畨鍏ㄦ潯浠朵笅鎻愪氦鑷?SecurityService */
  persistentRuleEffect?: PersistentRuleEffect;
}

/**
 * 涓茶娲嬭懕绠￠亾涓紝鎸囧悜涓嬩竴涓腑闂翠欢鎵ц鐨勫紓姝?Next 鍥炶皟濂戠害銆?
 */
export type HookNext = () => Promise<void>;

/**
 * Hook 鐢熷懡鍛ㄦ湡鐨勬磱钁辩閬撲腑闂翠欢瀹氫箟銆?
 */
export type HookMiddleware = (context: HookContext, next: HookNext) => Promise<void>;

/**
 * 鏅鸿兘浣撳彲鎸傝浇鐨勭嫭绔嬫嫤鎴彃浠跺绾︺€?
 * 鍙傛暟鍖栦负 HookContext 浠ヤ笌 core 灞傜殑鎻掍欢瀹炵幇绫诲瀷鍏煎銆?
 */
export type Plugin = AgentPlugin<HookContext>;

/**
 * 瀹℃壒璇锋眰杞戒綋鎺ュ彛銆?
 * 鐢?ApprovalPolicy 鐢熸垚锛屽寘鍚鎵规秷鎭拰鍙俊鐨?choice 鍒楄〃銆?
 */
export interface ApprovalRequest {
  /** 瀹℃壒璇锋眰鍞竴鏍囪瘑 */
  id: string;
  /** 鍚戠敤鎴峰睍绀虹殑瀹℃壒娑堟伅 */
  message: string;
  /** 鍙俊鐨勯€夋嫨椤瑰垪琛?*/
  choices: ApprovalChoice[];
  /** 绛栫暐灞傚綊涓€鍖栧悗鐨勫彈淇℃搷浣滄弿杩帮紝渚涙巿鏉冩槧灏勯樁娈靛鐢?*/
  operation?: SafetyOperation;
}

/**
 * 鎸佷箙鍖栬鍒欐巿鏉冩晥鏋滅被鍨嬨€?
 * 鐢ㄤ簬灏嗗懡浠ゅ墠缂€瑙勫垯鎸佷箙鍖栧啓鍏ョ鐩樼櫧鍚嶅崟锛屼笌 PendingGrant锛坈all/session锛夊钩绾с€?
 */
export interface PersistentRuleEffect {
  type: 'persistent';
  prefix: string;
}

/**
 * 鎺堟潈鏁堟灉鑱斿悎绫诲瀷銆?
 * 鍖呭惈涓€娆℃€т护鐗岋紙call锛夈€佷細璇濈櫧鍚嶅崟锛坰ession锛夊拰鎸佷箙鍖栬鍒欙紙persistent锛夈€?
 */
export type ApprovalEffect = PendingGrant | PersistentRuleEffect;

/**
 * 鎺堟潈璁稿彲鍑瘉鐨勮仈鍚堢被鍨嬨€?
 * 鎻掍欢杩斿洖缁?AgentLoop锛岀敱 AgentLoop 鍦ㄥ畨鍏ㄦ潯浠舵弧瓒虫椂鎻愪氦銆?
 */
export type PendingGrant =
  | { type: 'call'; toolCallId: string; toolName: string; resources: SafetyResource[] }
  | { type: 'session'; toolCallId: string; resources: SafetyResource[] };

/**
 * 鍗曟宸ュ叿璋冪敤鎵ц鏈熼棿鐨勯殧绂讳笂涓嬫枃銆?
 * 鎼哄甫 toolCallId銆佸凡棰嗗彇鐨勬巿鏉冭祫婧愮瓑锛岃В鍐冲苟鍙戝伐鍏疯皟鐢ㄩ殧绂婚棶棰樸€?
 * sessionContext 鐨勭被鍨嬩负绔彛灞傚绾?`SessionEventPort & CallCapabilityPort`锛?
 * 浣垮伐鍏峰疄鐜颁笉渚濊禆 core 灞傚叿浣?`SessionContext` 绫诲瀷銆?
 */
export interface ToolExecutionContext {
  /** 褰撳墠鏅鸿兘浣撲細璇濅笂涓嬫枃锛堢鍙ｅ眰濂戠害瑙嗗浘锛屽寘鍚簨浠堕€氱煡鑳藉姏锛?*/
  sessionContext: SessionEventPort & CallCapabilityPort & EventNotificationPort;
  /** 鏈宸ュ叿璋冪敤鐨勫敮涓€鏍囪瘑绗?*/
  toolCallId: string;
  /** 璋冪敤鐨勫伐鍏峰悕绉?*/
  toolName: string;
  /** 瑙勮寖鍖栧弬鏁版憳瑕侊紝鐢ㄤ簬 capability 浠ょ墝鍖归厤 */
  argumentsDigest: string;
  /** 鏈璋冪敤宸查鍙栫殑鎺堟潈璧勬簮鍒楄〃 */
  claimedResources: SafetyResource[];
}
