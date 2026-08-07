import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type {
  SubagentExecutionResult,
  SubagentMessagingPort,
  SubagentParentSession,
} from '../../../../ports/driving/SubagentExecutionPort.js';
import { SUBAGENT_ERROR_CODES } from '../../../../ports/driving/SubagentExecutionPort.js';
import type { NativeTool } from '../../tool-types.js';
import type { ToolPermissionCheckResult } from '../../../../core/domain/permissions/permission-types.js';
import { SEND_MESSAGE_TOOL_NAME } from '../../constants/native-tool-names.js';

/**
 * 主代理向子代理投递消息或恢复已结束子代理的协作工具（子代理子集，不含 swarm 协议）。
 * 路由语义：任务非终态 → 入队投递（下一轮注入）；任务终态 → 从 transcript 恢复并后台续跑；
 * 任务不存在或不可恢复 → 稳定错误。仅主代理工具面可见（子代理工具面不含本工具）。
 */
export class SendMessageTool implements NativeTool {
  /** 由组合根注入的消息端口。 */
  private readonly messagingPort?: SubagentMessagingPort;
  /** 消息投递不声明直接业务副作用。 */
  public readonly securityCategory = 'read' as const;
  /** 模型可见的稳定工具名。 */
  public readonly name = SEND_MESSAGE_TOOL_NAME;
  /** 模型可见的参数 schema。 */
  public readonly definition: Record<string, unknown>;

  /**
   * @param messagingPort - 会话绑定的消息端口；未注入时保持 fail-closed
   */
  constructor(messagingPort?: SubagentMessagingPort) {
    this.messagingPort = messagingPort;
    this.definition = {
      type: 'function',
      function: {
        name: SEND_MESSAGE_TOOL_NAME,
        description: '向一个子代理投递消息：运行中的子代理在下一轮收到；已结束的子代理从 transcript 恢复并后台续跑。',
        parameters: {
          type: 'object',
          properties: {
            agent_id: {
              type: 'string',
              description: '目标子代理的任务 ID（Agent 工具返回的 agentId）。',
            },
            message: {
              type: 'string',
              description: '要投递的非空消息内容。',
            },
          },
          required: ['agent_id', 'message'],
          additionalProperties: false,
        },
      },
    };
  }

  /**
   * 消息投递不需要再次申请文件、Shell 或 MCP 权限。
   * 恢复执行内部每个工具仍会独立进入统一权限网关。
   *
   * @returns 允许进入协作端口的只读权限证据
   */
  public checkPermissions(): ToolPermissionCheckResult {
    return {
      kind: 'allow',
      decisionReason: 'SendMessage 仅投递消息或按既有边界恢复子代理',
      evidence: {
        operationCategory: 'subagent-orchestration',
        sideEffect: 'read',
        riskReason: '恢复执行内部工具仍逐次进入独立权限链',
        resources: [],
      },
    };
  }

  /**
   * 校验参数并按任务状态路由投递或恢复。
   *
   * @param args - SendMessage 工具参数
   * @param context - 统一执行器注入的执行上下文（sessionContext 作为恢复的父会话视图）
   * @returns JSON 序列化的投递/恢复结果
   */
  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const agentId = typeof args.agent_id === 'string' ? args.agent_id.trim() : undefined;
    if (!agentId) {
      return serializeResult({
        status: 'error',
        code: 'INVALID_AGENT_ID',
        message: 'SendMessage.agent_id 必须是非空字符串',
      });
    }
    const message = typeof args.message === 'string' ? args.message : undefined;
    if (!message || message.trim().length === 0) {
      return serializeResult({
        status: 'error',
        code: 'INVALID_MESSAGE',
        message: 'SendMessage.message 必须是非空字符串',
      });
    }
    const port = this.messagingPort;
    if (!port) {
      return serializeResult({
        status: 'error',
        code: SUBAGENT_ERROR_CODES.notBound,
        message: '当前会话尚未绑定子代理消息端口',
      });
    }
    try {
      // 优先入队：非终态任务在下一轮注入；终态任务返回 NOT_ACTIVE 改走恢复路径。
      const queued = await port.enqueueMessage(agentId, message);
      if (queued.ok) {
        return serializeResult({
          status: 'success',
          kind: 'queued',
          agentId,
          message: '消息已投递，子代理将在下一轮收到',
        });
      }
      if (queued.code === 'SUBAGENT_TASK_NOT_ACTIVE') {
        const parentSession = context?.sessionContext as SubagentParentSession | undefined;
        const result = await port.resumeTask(agentId, message, parentSession);
        return serializeResult(result);
      }
      return serializeResult({
        status: 'error',
        code: queued.code,
        message: queued.message,
      });
    } catch {
      // 工具边界将意外异常收敛为稳定结果，避免模型侧收到未结构化拒绝。
      return serializeResult({
        status: 'error',
        code: SUBAGENT_ERROR_CODES.executionFailed,
        message: 'SendMessage 执行失败',
      });
    }
  }
}

/** 将结构化结果转为 SendMessage 工具交付给父模型的文本。 */
function serializeResult(result: SubagentExecutionResult | Record<string, string>): string {
  return JSON.stringify(result);
}
