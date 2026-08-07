import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type {
  SubagentExecutionPort,
  SubagentExecutionResult,
  SubagentParentSession,
} from '../../../../ports/driving/SubagentExecutionPort.js';
import { SUBAGENT_ERROR_CODES } from '../../../../ports/driving/SubagentExecutionPort.js';
import type { ChatMessage } from '../../../../ports/driven/llm/LlmPort.js';
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
  /** 控制模型是否使用省略类型即 exact-fork 的调用语义。 */
  private readonly forkEnabled: boolean;
  /** 已注册子代理类型快照（会话内字节稳定），写入 schema enum 供模型发现。 */
  private readonly agentTypes?: readonly string[];
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
  /** 模型可见的 Agent 参数 schema；fork 模式不泄露后台开关。 */
  public readonly definition: Record<string, unknown>;

  /**
   * @param executionPort - 会话绑定的子代理执行端口；未注入时保持 fail-closed
   * @param forkEnabled - 是否启用省略类型即 exact-fork 的调用语义
   * @param agentTypes - 已注册子代理类型快照；写入 schema enum 供模型发现
   */
  constructor(executionPort?: SubagentExecutionPort, forkEnabled = false, agentTypes?: readonly string[]) {
    this.executionPort = executionPort;
    this.forkEnabled = forkEnabled;
    this.agentTypes = agentTypes;
    this.definition = buildAgentDefinition(forkEnabled, agentTypes);
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

    const description = typeof args.description === 'string' ? args.description.trim() : undefined;
    if (!description || !isThreeToFiveWordDescription(description)) {
      return serializeResult({
        status: 'error',
        code: SUBAGENT_ERROR_CODES.invalidDescription,
        message: 'Agent.description 必须是 3-5 个词的非空字符串',
      });
    }

    const subagentType = args.subagent_type === undefined
      ? undefined
      : typeof args.subagent_type === 'string' ? args.subagent_type : undefined;
    if (args.subagent_type !== undefined && (!subagentType || subagentType.trim().length === 0)) {
      return serializeResult({
        status: 'error',
        code: 'UNKNOWN_SUBAGENT_TYPE',
        message: 'Agent.subagent_type 必须是非空字符串',
      });
    }

    const runInBackground = args.run_in_background === undefined
      ? false
      : typeof args.run_in_background === 'boolean' ? args.run_in_background : undefined;
    if (runInBackground === undefined) {
      return serializeResult({
        status: 'error',
        code: 'INVALID_RUN_IN_BACKGROUND',
        message: 'Agent.run_in_background 必须是布尔值',
      });
    }

    // model 只做类型校验；值域（inherit / 已注册 profile ID）由协调器提交点解析校验。
    const model = args.model === undefined
      ? undefined
      : typeof args.model === 'string' ? args.model.trim() : undefined;
    if (args.model !== undefined && (!model || model.length === 0)) {
      return serializeResult({
        status: 'error',
        code: SUBAGENT_ERROR_CODES.invalidModel,
        message: 'Agent.model 必须是非空字符串',
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
        description,
        subagentType,
        runInBackground: this.forkEnabled || runInBackground,
        model,
        parentSession,
        parentApprovalPort: context?.approvalPort,
        interactionPort: context?.interactionPort,
        signal,
        parentCaller: context?.caller,
        // 工具执行时当前 assistant 消息已在会话历史中；fork 用它闭合历史并追加分支指令。
        currentAssistantMessage: findCurrentAssistantMessage(parentSession),
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

/** 从会话历史中定位触发本次调用的最后一条带工具调用的 assistant 消息。 */
function findCurrentAssistantMessage(
  session: SubagentParentSession,
): ChatMessage | undefined {
  const history = session.getHistory?.();
  if (!history) {
    return undefined;
  }
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) {
      return message;
    }
  }
  return undefined;
}

/** 将结构化结果转为 Agent 工具交付给父模型的文本。 */
function serializeResult(result: SubagentExecutionResult | Record<string, string>): string {
  return JSON.stringify(result);
}

/** 构造不泄露 fork 内部细节的 Agent OpenAI function schema。 */
function buildAgentDefinition(
  forkEnabled: boolean,
  agentTypes?: readonly string[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    description: {
      type: 'string',
      description: '用 3-5 个词概括任务，供任务列表展示。',
    },
    prompt: {
      type: 'string',
      description: '交给子代理执行的非空任务描述。',
    },
    subagent_type: {
      type: 'string',
      description: forkEnabled
        ? '可选的已注册子代理类型；省略时使用当前会话的 exact-fork 上下文。'
        : '可选的已注册子代理类型；省略时使用 general-purpose。',
      // 已注册类型快照写入 enum，模型无需猜测即可发现自定义子代理类型。
      ...(agentTypes && agentTypes.length > 0 ? { enum: agentTypes } : {}),
    },
  };
  if (!forkEnabled) {
    properties.run_in_background = {
      type: 'boolean',
      description: '是否立即转为后台任务，默认 false。',
    };
    properties.model = {
      type: 'string',
      description: '可选：子代理使用的模型（inherit 或已注册 profile ID）；省略时继承父模型。',
    };
  }
  return {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAME,
      description: forkEnabled
        ? '在当前会话快照上后台运行一个隔离子代理并返回任务 ID。'
        : '调用一个隔离子代理完成独立任务，可选择后台运行并返回任务 ID。',
      parameters: {
        type: 'object',
        properties,
        required: ['description', 'prompt'],
        additionalProperties: false,
      },
    },
  };
}

/** 校验用户可读任务描述的词数，拒绝把长正文塞入任务索引。 */
function isThreeToFiveWordDescription(value: string): boolean {
  const words = value.split(/\s+/u).filter(Boolean);
  return words.length >= 3 && words.length <= 5;
}
