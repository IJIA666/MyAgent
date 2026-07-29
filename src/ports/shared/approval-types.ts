/**
 * @file 端口层共享的审批相关基础类型。
 * 使审批契约不再依赖 core 中的安全与插件类型定义。
 */

/**
 * 审批选择项标识联合类型。
 * 权限审批使用工具适配器提供的稳定 action id；其它人机协作入口可继续使用通用 id。
 */
export type ApprovalChoiceId =
  | 'allowOnce'
  | 'allowAndAddRules'
  | 'allowAndSetMode'
  | 'allowAndAddDirectories'
  | 'allowAndSetModeWithDirectories'
  | 'call'
  | 'session'
  | 'project'
  | 'user'
  | 'persistent'
  | 'deny';

/** 审批选择项接口。 */
export interface ApprovalChoice {
  /** 选择项标识 */
  choiceId: ApprovalChoiceId;
  /** 展示标签（如"单次放行"、"本次会话始终放行"） */
  label: string;
  /** 可选的详细描述 */
  description?: string;
  /** 可选的下一层选择，用于先确认规则内容、再选择生效范围。 */
  followUp?: {
    /** 下一层选择的提示文字。 */
    prompt: string;
    /** 下一层可选项。 */
    choices: readonly ApprovalChoice[];
  };
}
