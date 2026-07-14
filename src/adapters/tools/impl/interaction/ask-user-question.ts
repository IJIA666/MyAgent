import type { NativeTool } from '../../tool-types.js';
import { InteractionRequestError } from '../../../../ports/driven/session/InteractionPort.js';
import type { AskUserPayload, UserQuestion } from '../../../../ports/driven/session/InteractionPort.js';

/**
 * agent 向用户发起结构化提问的交互工具类。
 * 实现了 NativeTool 契约，支持结构化选项、批量问题、多选等多种提问模式。
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
   * 支持结构化选项（label + description）、多问题批量提交、多选等模式。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'ask_user_question',
      description:
        "向用户发起结构化提问并等待回答。当需要用户在预设选项中做选择、" +
        "需要用户提供开放式回答、或需要用户对方案进行确认时调用此工具。" +
        "支持单次携带多个问题以拆解不同语义维度，每个问题可独立指定提问模式。",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "问题列表（1-4 个）。建议将不同语义维度的问题拆为独立问题，不要混在一个问题中。",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "问题唯一标识符（snake_case），用于答案映射"
                },
                header: {
                  type: "string",
                  description: "短标签（≤12 字符），如 'Auth method'、'Library'"
                },
                question: {
                  type: "string",
                  description: "完整的提问文本"
                },
                mode: {
                  type: "string",
                  enum: ["single-select", "multi-select", "free-text", "single-select-or-text"],
                  description: "提问模式：single-select（单选）、multi-select（多选）、free-text（纯文本输入）、single-select-or-text（单选 + Other 自定义输入）"
                },
                options: {
                  type: "array",
                  description: "预设选项列表（mode 为 single-select/multi-select/single-select-or-text 时必须提供 2-4 个）",
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description: "选项显示文本（1-5 词）"
                      },
                      description: {
                        type: "string",
                        description: "选项的简要说明（可选），如影响/权衡描述"
                      }
                    },
                    required: ["label"]
                  }
                }
              },
              required: ["id", "header", "question", "mode"]
            },
            minItems: 1,
            maxItems: 4
          }
        },
        required: ["questions"]
      }
    }
  };

  /**
   * 执行用户提问逻辑——校验参数并请求进入人机中断状态。
   * 校验规则：questions 长度 1-4、mode 为 single-select/multi-select/single-select-or-text 时必须提供 2-4 个选项、
   * mode 为 free-text 时不得提供选项。
   *
   * @param args - 工具调用参数（questions 数组）
   * @returns 永不直接返回用户回答；成功路径会抛出 InteractionRequestError 进入挂起
   */
  async execute(
    args: Record<string, unknown>
  ): Promise<string> {
    const questions = this.normalizeQuestions(args.questions);

    // 数量校验
    if (questions.length < 1) {
      throw new Error("至少需要提供 1 个问题");
    }
    if (questions.length > 4) {
      throw new Error("单次最多提交 4 个问题");
    }

    // 逐题校验
    for (const q of questions) {
      if (!q.id || typeof q.id !== 'string') {
        throw new Error(`问题 "${q.question}" 缺少有效的 id 字段`);
      }
      if (!q.header || typeof q.header !== 'string') {
        throw new Error(`问题 "${q.question}" 缺少有效的 header 字段`);
      }
      if (!q.question || typeof q.question !== 'string') {
        throw new Error(`问题 "${q.id || '(unknown)'}" 缺少有效的 question 字段`);
      }

      const mode = q.mode;
      const allowedModes = ['single-select', 'multi-select', 'free-text', 'single-select-or-text'];
      if (!allowedModes.includes(mode)) {
        throw new Error(`问题 "${q.question}" 的 mode 无效：${mode}，允许的值：${allowedModes.join(', ')}`);
      }

      // 选择题必须提供选项
      if ((mode === 'single-select' || mode === 'multi-select' || mode === 'single-select-or-text')) {
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
          throw new Error(`问题 "${q.question}" 的 mode 为 ${mode}，必须提供 2-4 个选项`);
        }
        // 校验选项结构
        for (const opt of q.options) {
          if (!opt.label || typeof opt.label !== 'string') {
            throw new Error(`问题 "${q.question}" 的选项缺少有效的 label 字段`);
          }
        }
      }

      // free-text 不得提供选项
      if (mode === 'free-text' && Array.isArray(q.options) && q.options.length > 0) {
        throw new Error(`问题 "${q.question}" 的 mode 为 free-text，不应提供 options`);
      }
    }

    // 构造执行 payload
    const payload: AskUserPayload = {
      questions: questions as UserQuestion[]
    };

    throw new InteractionRequestError(payload);
  }

  /**
   * 规范化 questions 参数，将原始输入转为统一的结构化数组。
   */
  private normalizeQuestions(raw: unknown): Array<{
    id: string;
    header: string;
    question: string;
    mode: string;
    options?: Array<{ label: string; description?: string }>;
  }> {
    if (!Array.isArray(raw)) {
      // 参数类型错误时抛出明确中文错误，帮助模型理解 JSON 结构问题
      const receivedType = raw === null ? 'null' : typeof raw;
      throw new Error(
        `参数解析失败：questions 必须是数组，但收到的类型为 "${receivedType}"。` +
        `请检查 JSON 语法是否正确。正确格式示例：{"questions":[{"id":"q1","header":"选项","question":"请选择？","mode":"single-select","options":[{"label":"A","description":"描述"}]}]}`
      );
    }
    return raw.map((item: unknown) => {
      const q = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      return {
        id: typeof q.id === 'string' ? q.id.trim() : '',
        header: typeof q.header === 'string' ? q.header.trim() : '',
        question: typeof q.question === 'string' ? q.question.trim() : '',
        mode: typeof q.mode === 'string' ? q.mode : 'single-select',
        options: Array.isArray(q.options) ? q.options.map((opt: unknown) => {
          const o = (opt && typeof opt === 'object' ? opt : {}) as Record<string, unknown>;
          return {
            label: typeof o.label === 'string' ? o.label.trim() : '',
            description: typeof o.description === 'string' ? o.description.trim() : undefined
          };
        }) : undefined
      };
    });
  }

  /**
   * 审查交互调用的安全性——提问不产生副作用，始终放行。
   *
   * @returns 安全评估结论
   */
  /**
   * Claude 风格的 tool-level checkPermissions。
   * 用户提问是安全的交互操作。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return {
      kind: 'allow',
      decisionReason: '用户交互操作',
      evidence: {
        operationCategory: 'user-interaction',
        sideEffect: 'read',
        riskReason: '向用户收集结构化输入',
        resources: [],
      },
    };
  }
}
