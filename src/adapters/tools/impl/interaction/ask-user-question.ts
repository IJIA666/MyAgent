import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';
import type { InteractionPort } from '../../../../ports/driven/session/InteractionPort.js';

/**
 * agent 向用户发起结构化提问并等待回答的交互工具类。
 * 实现了 NativeTool 契约，支持固定选项选择、自由文本输入及混合模式。
 */
export class AskUserQuestionTool implements NativeTool {
  /** 工具的安全类别——只读交互，不产生文件副作用，Plan 模式下不被裁剪 */
  readonly securityCategory = 'read';

  /** 工具的唯一标识名称 */
  readonly name = 'ask_user_question';

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
   * 执行用户提问逻辑——挂起当前工具执行，展示交互界面，等待用户回答。
   *
   * @param args - 工具调用参数（title、options、multiSelect、allowFreeInput）
   * @param _sessionContext - 会话上下文（本工具不使用）
   * @param signal - 可选的 AbortSignal，用于外部取消等待
   * @param _interactionPort - 人机对话交互端口
   * @returns 用户回答的字符串
   */
  async execute(
    args: Record<string, unknown>,
    _sessionContext?: unknown,
    signal?: AbortSignal,
    _interactionPort?: InteractionPort
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

    if (!_interactionPort) {
      throw new Error("当前系统未配置 InteractionPort，无法执行 ask_user_question。");
    }

    const answer = await _interactionPort.askUser(
      { title: title.trim(), options, multiSelect, allowFreeInput },
      signal
    );

    return answer;
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
