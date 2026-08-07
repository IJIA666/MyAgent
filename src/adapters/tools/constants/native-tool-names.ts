/**
 * @file 系统内置原生工具名称契约常量模块。
 * 集中承载跨模块需要引用的稳定工具名，避免子代理策略和装配代码重复拼写协议名称。
 */

/** 第一阶段同步子代理编排工具名。 */
export const AGENT_TOOL_NAME = 'Agent' as const;

/** 子代理协作工具名：消息投递与 transcript 恢复（对齐官方命名）。 */
export const SEND_MESSAGE_TOOL_NAME = 'SendMessage' as const;

/** 子代理协作工具名：停止运行中任务（对齐官方命名）。 */
export const TASK_STOP_TOOL_NAME = 'TaskStop' as const;

/**
 * 系统内置原生工具名称集合。
 * 目前只保留跨模块使用的 Agent 名称，具体业务工具仍由各 Feature 自己维护。
 */
export class NativeToolNames {
  /** 同步子代理工具名。 */
  public static readonly AGENT = AGENT_TOOL_NAME;

  private constructor() {} // 限制外部实例化行为
}
