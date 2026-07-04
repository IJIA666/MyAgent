import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';
import { InteractionRequestError } from '../../../../ports/driven/session/InteractionPort.js';

/**
 * agent 向用户发起结构化提问的交互工具类。
 * 实现了 NativeTool 契约，支持固定选项选择、自由文本输入及混合模式。
 * 执行模式为 human_interruption：参数校验通过后抛出中断请求，由 agent-loop
 * 将其转为 pending interaction，并在用户回答后恢复同一 run。
 */
export class AskUserQuestionTool implements NativeTool {
  /** 工具的安全类别——只读交互，不产生文件副作用，Plan 模式下不被裁剪 */
  readonly securityCategory = 'read';

  /** 工具的唯一标识名称 */
  readonly name = 'ask_user_question';

  /** 执行模式——人机中断式交互，不走通用工具超时路径 */
  readonly executionMode = 'human_interruption' as const;

  /** 不操作文件，无需声明文件路径参数 */
  readonly filePathParamKey = undefined;

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   * 模型通过此 schema 了解如何调用该工具。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'ask_user_question',
      description:
        "向用户发起结构化提问并等待回答。当需要用户在预设选项中做选择、" +
        "需要用户提供开放式回答、或需要用户对方案进行确认时调用此工具。",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "向用户展示的问题标题"
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "预设选项列表（可选；为空且 allowFreeInput 为 false 时参数校验失败）"
          },
          multiSelect: {
            type: "boolean",
            description: "是否允许多选，默认 false"
          },
          allowFreeInput: {
            type: "boolean",
            description: "是否允许用户输入自定义文本（需显式声明，不自动追加 Other）。为 true 且无 options 时退化为纯文本输入"
          }
        },
        required: ["title"]
      }
    }
  };

  /**
   * 执行用户提问逻辑——校验参数并请求进入人机中断状态。
   *
   * @param args - 工具调用参数（title、options、multiSelect、allowFreeInput）
   * @param _sessionContext - 会话上下文（本工具不使用）
   * @param _signal - 可选的 AbortSignal（本工具不直接等待用户输入）
   * @param _interactionPort - 人机对话交互端口（保留签名兼容；本工具不直接使用）
   * @returns 永不直接返回用户回答；成功路径会抛出 InteractionRequestError 进入挂起
   */
  async execute(
    args: Record<string, unknown>
  ): Promise<string> {
    const title = args.title;
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error("title 必须是非空字符串");
    }

    const options = Array.isArray(args.options) ? args.options as string[] : undefined;
    const multiSelect = typeof args.multiSelect === 'boolean' ? args.multiSelect : false;
    const allowFreeInput = typeof args.allowFreeInput === 'boolean' ? args.allowFreeInput : false;

    // 参数约束：无选项且未开放自由输入时拒绝调用
    if ((!options || options.length === 0) && !allowFreeInput) {
      throw new Error("options 为空且 allowFreeInput 为 false 时，工具调用无效：需要至少提供选项或开放自由输入");
    }

    throw new InteractionRequestError({
      title: title.trim(),
      options,
      multiSelect,
      allowFreeInput
    });
  }

  /**
   * 审查交互调用的安全性——提问不产生副作用，始终放行。
   *
   * @returns 安全评估结论
   */
  checkSafety(): SafetyCheckResult {
    return { status: 'pass' };
  }
}
