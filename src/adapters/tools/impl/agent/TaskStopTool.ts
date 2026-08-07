import type { SubagentMessagingPort, TaskStopResult } from '../../../../ports/driving/SubagentExecutionPort.js';
import { SUBAGENT_ERROR_CODES } from '../../../../ports/driving/SubagentExecutionPort.js';
import type { NativeTool } from '../../tool-types.js';
import type { ToolPermissionCheckResult } from '../../../../core/domain/permissions/permission-types.js';
import { TASK_STOP_TOOL_NAME } from '../../constants/native-tool-names.js';
import { taskStopAuthorizationAdapter } from '../../permissions/task-stop-authorization.js';

/**
 * 主代理停止运行中任务的协作工具（对齐官方 TaskStopTool 语义）。
 * 仅停止 running 状态任务；pending/waiting_approval/终态返回 not_running、未知返回 not_found。
 * 仅主代理工具面可见（子代理工具面不含本工具，对齐官方 ALL_AGENT_DISALLOWED_TOOLS）。
 */
export class TaskStopTool implements NativeTool {
  /** 由组合根注入的消息端口。 */
  private readonly messagingPort?: SubagentMessagingPort;
  /** 停止任务影响运行中执行，声明为写入类。 */
  public readonly securityCategory = 'write' as const;
  /** 模型可见的稳定工具名。 */
  public readonly name = TASK_STOP_TOOL_NAME;
  /** 模型可见的参数 schema。 */
  public readonly definition: Record<string, unknown>;
  /** 停止任务属于副作用操作，注册正式权限适配器（无文件资源，网关统一决策）。 */
  public readonly authorizationAdapter = taskStopAuthorizationAdapter;

  /**
   * @param messagingPort - 会话绑定的消息端口；未注入时保持 fail-closed
   */
  constructor(messagingPort?: SubagentMessagingPort) {
    this.messagingPort = messagingPort;
    this.definition = {
      type: 'function',
      function: {
        name: TASK_STOP_TOOL_NAME,
        description: '停止一个正在运行的子代理任务（仅 running 状态；排队或等待审批的任务请使用 /tasks stop）。',
        parameters: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '要停止的任务 ID（Agent 工具返回的 agentId）。',
            },
          },
          required: ['task_id'],
          additionalProperties: false,
        },
      },
    };
  }

  /**
   * 停止任务属于编排控制操作，允许进入端口；任务停止的内部资源回收由任务管理器负责。
   *
   * @returns 允许进入协作端口的权限证据
   */
  public checkPermissions(): ToolPermissionCheckResult {
    return {
      kind: 'allow',
      decisionReason: 'TaskStop 仅停止运行中的子代理任务',
      evidence: {
        operationCategory: 'subagent-orchestration',
        sideEffect: 'write',
        riskReason: '停止任务将中断子代理执行并回收其资源',
        resources: [],
      },
    };
  }

  /**
   * 校验参数并停止运行中任务。
   *
   * @param args - TaskStop 工具参数
   * @returns JSON 序列化的停止结果
   */
  public async execute(args: Record<string, unknown>): Promise<string> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : undefined;
    if (!taskId) {
      return serializeResult({
        status: 'error',
        code: 'INVALID_TASK_ID',
        message: 'TaskStop.task_id 必须是非空字符串',
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
      const result: TaskStopResult = await port.stopTask(taskId);
      return serializeResult(result);
    } catch {
      // 工具边界将意外异常收敛为稳定结果，避免模型侧收到未结构化拒绝。
      return serializeResult({
        status: 'error',
        code: SUBAGENT_ERROR_CODES.executionFailed,
        message: 'TaskStop 执行失败',
      });
    }
  }
}

/** 将结构化结果转为 TaskStop 工具交付给父模型的文本。 */
function serializeResult(result: TaskStopResult | Record<string, string>): string {
  return JSON.stringify(result);
}
