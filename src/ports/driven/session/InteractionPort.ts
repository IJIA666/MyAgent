/**
 * @file InteractionPort.ts
 * @description 人机对话式交互的输出端口接口契约。与 ApprovalPort 的安全审批语义解耦，仅承载"提问-回答"的对话等待通道。
 */

/**
 * 结构化用户提问的数据载体。
 */
export interface AskUserPayload {
  /** 问题标题 */
  title: string;
  /** 预设选项列表（可选；为空时配合 allowFreeInput 退化为纯文本输入） */
  options?: string[];
  /** 是否允许多选，默认 false */
  multiSelect?: boolean;
  /** 是否允许用户输入自定义文本，默认 false。需显式声明，不自动追加 Other */
  allowFreeInput?: boolean;
}

/**
 * 工具请求进入人机中断状态时抛出的专用异常。
 * 调用方捕获该异常后，应将其转换为 pending interaction，而不是当作普通工具失败处理。
 */
export class InteractionRequestError extends Error {
  /** 待展示给用户的问题载荷 */
  public readonly payload: AskUserPayload;

  /**
   * 创建一个人机中断请求异常。
   *
   * @param payload - 待展示给用户的问题载荷
   */
  constructor(payload: AskUserPayload) {
    super('工具请求进入人机中断等待状态');
    this.name = 'InteractionRequestError';
    this.payload = payload;
  }
}

/**
 * 人机对话交互输出端口接口。
 * 提供 agent 推理过程中向用户发起结构化提问并同步等待回答的抽象能力。
 */
export interface InteractionPort {
  /**
   * 挂起当前工具执行，向用户发起提问并等待回答。
   *
   * @param payload - 提问的结构化数据载体（标题、选项、多选、自由输入）
   * @param signal - 可选的 AbortSignal，用于外部取消等待（如工具超时熔断、用户中断推理）
   * @returns 用户回答的字符串。超时或取消时返回空字符串
   */
  askUser(payload: AskUserPayload, signal?: AbortSignal): Promise<string>;
}
