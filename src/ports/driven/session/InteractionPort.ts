/**
 * @file InteractionPort.ts
 * @description 人机对话式交互的输出端口接口契约。与 ApprovalPort 的安全审批语义解耦，仅承载"提问-回答"的对话等待通道。
 */

/**
 * 结构化选项的数据模型。
 * 用于替代平铺 string[]，每个选项包含显示标签与描述说明。
 */
export interface QuestionOption {
  /** 选项的显示文本 */
  label: string;
  /** 选项的描述说明（可选），在 UI 中作为 hint/secondary 文本展示 */
  description?: string;
}

/**
 * 提问模式枚举，用于显式声明问题的交互方式。
 * - `single-select`: 单选，用户从选项中选择一项
 * - `multi-select`: 多选，用户可从选项中选择多项
 * - `free-text`: 纯文本输入，无预设选项
 * - `single-select-or-text`: 单选 + Other 自由输入
 */
export type QuestionMode = 'single-select' | 'multi-select' | 'free-text' | 'single-select-or-text';

/**
 * 单个用户提问的结构化数据。
 */
export interface UserQuestion {
  /** 问题唯一标识符，用于答案映射 */
  id: string;
  /** 短标签（≤12 字符），如 "Auth method"、"Library" */
  header: string;
  /** 完整的提问文本 */
  question: string;
  /** 提问模式 */
  mode: QuestionMode;
  /** 预设选项列表（仅 mode 为 single-select/multi-select/single-select-or-text 时必须） */
  options?: QuestionOption[];
}

/**
 * 结构化用户提问的数据载体。
 * 支持单次携带多个独立问题，每个问题可独立指定模式和选项。
 */
export interface AskUserPayload {
  /** 问题列表（1-4 个，建议将不同语义维度拆为独立问题） */
  questions: UserQuestion[];
}

/**
 * 用户回答的类型：单选返回 string，多选返回 string[]。
 */
export type QuestionAnswer = string | string[];

/**
 * 用户回答的结构化映射，按问题 id 索引。
 * 取消或外部 abort 时返回空对象 {}。
 */
export interface AskUserAnswer {
  [questionId: string]: QuestionAnswer;
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
   * 支持单次携带多个结构化问题，每个问题可独立指定模式与选项。
   *
   * @param payload - 提问的结构化数据载体（问题列表、每个问题的模式与选项）
   * @param signal - 可选的 AbortSignal，用于外部取消等待（如工具超时熔断、用户中断推理）
   * @returns 按问题 id 索引的结构化答案映射。取消或超时返回空对象
   */
  askUser(payload: AskUserPayload, signal?: AbortSignal): Promise<AskUserAnswer>;
}
