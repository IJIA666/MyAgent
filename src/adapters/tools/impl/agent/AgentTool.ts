import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type {
  SubagentExecutionPort,
  SubagentExecutionResult,
} from '../../../../ports/driving/SubagentExecutionPort.js';
import { SUBAGENT_ERROR_CODES } from '../../../../ports/driving/SubagentExecutionPort.js';
import type { NativeTool } from '../../tool-types.js';
import type { ToolPermissionCheckResult } from '../../../../core/domain/permissions/permission-types.js';
import { AGENT_TOOL_NAME } from '../../constants/native-tool-names.js';

/**
 * 主 Agent 同步调用前台 general-purpose 子代理的原生工具。
 * 工具自身只负责参数和执行上下文边界，实际循环由 SubagentExecutionPort 承担。
 */
export class AgentTool implements NativeTool {
  /** 由组合根注入的会话绑定执行端口。 */
  private readonly executionPort?: SubagentExecutionPort;
  /** Agent 编排调用不直接声明业务副作用。 */
  public readonly securityCategory = 'read' as const;
  /** 模型可见的稳定工具名。 */
  public readonly name = AGENT_TOOL_NAME;
  /** 长时编排只跟随父取消信号，不使用普通工具总超时。 */
  public readonly executionTimeoutPolicy = 'parent-signal' as const;
  /** Agent 不得出现在自身的子代理工具作用域中。 */
  public readonly subagentToolPolicy = Object.freeze({
    freshForeground: false,
    freshBackground: false,
    fork: false,
  });
  /** 第一阶段严格限制为 prompt 与 subagent_type 两个参数。 */
  public readonly definition = {
    type: 'function' as const,
    function: {
      name: AGENT_TOOL_NAME,
      description: '同步调用一个隔离的 general-purpose 子代理完成独立任务，并返回最终报告。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '交给子代理执行的非空任务描述。',
          },
          subagent_type: {
            type: 'string',
            description: '已注册的子代理类型；省略时使用 general-purpose。',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  };

  /**
   * @param executionPort - 会话绑定的子代理执行端口；未注入时保持 fail-closed
   */
  constructor(executionPort?: SubagentExecutionPort) {
    this.executionPort = executionPort;
  }

  /**
   * Agent 编排调用不需要再次申请文件、Shell 或 MCP 权限。
   * 子代理内部每个工具仍会独立进入统一权限网关。
   *
   * @returns 允许进入编排端口的只读权限证据
   */
  public checkPermissions(): ToolPermissionCheckResult {
    return {
      kind: 'allow',
      decisionReason: 'Agent 仅创建受边界约束的同步子代理调用',
      evidence: {
        operationCategory: 'subagent-orchestration',
        sideEffect: 'read',
        riskReason: '子代理内部工具仍逐次进入独立权限链',
        resources: [],
      },
    };
  }

  /**
   * 校验参数并将父会话能力安全传入子代理执行端口。
   *
   * @param args - Agent 工具参数
   * @param context - 统一执行器注入的执行上下文
   * @returns JSON 序列化的子代理结果
   */
  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
    if (!prompt || prompt.trim().length === 0) {
      return serializeResult({
        status: 'error',
        code: 'INVALID_PROMPT',
        message: 'Agent.prompt 必须是非空字符串',
      });
    }

    const subagentType = args.subagent_type === undefined
      ? 'general-purpose'
      : typeof args.subagent_type === 'string' ? args.subagent_type : undefined;
    if (!subagentType || subagentType.trim().length === 0) {
      return serializeResult({
        status: 'error',
        code: 'UNKNOWN_SUBAGENT_TYPE',
        message: 'Agent.subagent_type 必须是非空字符串',
      });
    }

    const parentSession = context?.sessionContext;
    const port = this.executionPort;
    if (!parentSession || !port) {
      return serializeResult({
        status: 'error',
        code: 'SUBAGENT_EXECUTOR_NOT_BOUND',
        message: '当前会话尚未绑定子代理执行器',
      });
    }

    try {
      const result = await port.execute({
        prompt,
        subagentType,
        parentSession,
        parentApprovalPort: context?.approvalPort,
        interactionPort: context?.interactionPort,
        signal,
        parentCaller: context?.caller,
      });
      return serializeResult(result);
    } catch {
      // 工具边界将意外异常收敛为稳定结果，避免模型侧收到未结构化拒绝。
      return serializeResult({
        status: 'error',
        code: SUBAGENT_ERROR_CODES.executionFailed,
        message: '子代理执行失败',
      });
    }
  }
}

/** 将结构化结果转为 Agent 工具交付给父模型的文本。 */
function serializeResult(result: SubagentExecutionResult | Record<string, string>): string {
  return JSON.stringify(result);
}
