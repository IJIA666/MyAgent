import { existsSync } from 'fs';
import { computeArgumentsDigest } from '../../core/domain/context.js';
import { secureResolveWritePath } from './impl/base.js';
import type { NativeTool, CallToolResult } from './virtual-mcp.js';
import type { ToolExecutionContext } from '../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { ApprovalPort } from '../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';
import type { ToolCatalog } from './ToolCatalog.js';
import { InteractionRequestError } from '../../ports/driven/session/InteractionPort.js';

/**
 * 工具执行调度器。
 * 负责 tools/call 语义：参数进入执行边界、能力认领、工具执行分发与结果包装。
 * 不负责工具目录管理——目录查询由 ToolCatalog 处理。
 */
export class ToolExecutor {
  /** 工具目录引用，用于执行前的工具查找 */
  private catalog: ToolCatalog;

  /**
   * @param catalog - 工具目录实例，用于按名称查找 NativeTool
   */
  constructor(catalog: ToolCatalog) {
    this.catalog = catalog;
  }

  /**
   * 执行指定的工具调用。
   * 保持与当前 callTool() 一致的执行时序：工具查找 → 能力认领 → 工具执行 → 结果包装。
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @param sessionContext - 可选的全功能会话上下文
   * @param interactionPort - 可选的交互端口
   * @param signal - 可选的 AbortSignal
   * @param toolCallId - 可选的工具调用唯一标识（用于 call capability 生命周期管理）
   * @returns 符合 MCP CallToolResult 结构的结果对象
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    sessionContext?: SessionEventPort & ApprovalPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string
  ): Promise<CallToolResult> {
    try {
      const tool = this.catalog.getTool(toolName);
      if (!tool) {
        throw new Error(`虚拟 MCP Server 不支持工具: ${toolName}`);
      }

      // 构建 ToolExecutionContext（若 toolCallId 存在）
      const execContext: ToolExecutionContext | undefined = toolCallId && sessionContext
        ? {
            sessionContext: sessionContext as unknown as ToolExecutionContext['sessionContext'],
            toolCallId,
            toolName,
            argumentsDigest: computeArgumentsDigest(args),
            claimedResources: []
          }
        : undefined;

      // 在 execute 前 claim 一次性令牌（匹配 toolCallId + argumentsDigest）
      if (execContext) {
        const claimed = execContext.sessionContext.claimCapability(toolCallId!, toolName, args);
        if (claimed) {
          execContext.claimedResources = claimed;
        }
      }

      // 底层高危操作安全硬拦截——仅对"未接入新生命周期"的旧调用路径生效
      if (sessionContext && !execContext) {
        await this.enforceDangerCheck(tool, toolName, args, sessionContext);
      }

      // 传入 ToolExecutionContext（含 claim 后的 claimedResources），无 toolCallId 时传入原始 sessionContext
      const contextToPass = execContext ?? sessionContext;
      const resultText = await tool.execute(args, contextToPass, signal, interactionPort);

      return {
        content: [
          {
            type: "text",
            text: resultText
          }
        ]
      };
    } catch (error: unknown) {
      if (error instanceof InteractionRequestError) {
        throw error;
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `执行失败: ${errorMsg}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * 旧调用路径的高危操作安全硬拦截。
   * 仅供未接入 toolCallId / ToolExecutionContext 的旧路径使用。
   * 新路径的审批由 BeforeTool Hook + claimCapability 机制处理。
   */
  private async enforceDangerCheck(
    tool: NativeTool,
    toolName: string,
    args: Record<string, unknown>,
    sessionContext: SessionEventPort & ApprovalPort
  ): Promise<void> {
    let isDangerous = false;
    let warningMsg = '';

    const category = tool.securityCategory;
    if (category !== 'read') {
      const pathKey = tool.filePathParamKey;
      if (pathKey && typeof args[pathKey] === 'string') {
        const targetPath = args[pathKey] as string;
        try {
          const safePath = secureResolveWritePath(targetPath, sessionContext);
          if (existsSync(safePath)) {
            if (toolName === 'deletePath') {
              isDangerous = true;
              warningMsg = `智能体试图删除文件或目录。目标路径: "${targetPath}"`;
            } else if (toolName !== 'createDirectory') {
              isDangerous = true;
              if (toolName === 'writeFile') {
                warningMsg = `智能体试图强行覆盖已有的文件。目标路径: "${targetPath}"`;
              } else {
                warningMsg = `智能体试图修改或覆盖已有的文件。工具: "${toolName}"，目标路径: "${targetPath}"`;
              }
            }
          } else {
            if (toolName === 'deletePath') {
              isDangerous = true;
              warningMsg = `智能体试图删除文件或目录。目标路径: "${targetPath}"`;
            }
          }
        } catch {
          // 路径解析越权或错误，交给工具自身的 checkSafety 处理
        }
      } else {
        isDangerous = true;
        warningMsg = `智能体试图执行高危写入操作（缺少参数元数据声明）。工具: "${toolName}"`;
      }
    }

    if (isDangerous) {
      const approvalId = `approve_dangerous_${Math.random().toString(36).substring(2, 9)}`;
      const decision = await sessionContext.waitApproval(
        approvalId,
        { name: toolName, arguments: args },
        undefined,
        warningMsg
      );

      if (decision.action === 'deny') {
        throw new Error(`用户拒绝了高危操作。工具: "${toolName}"，原因: 用户审批拒绝`);
      }
    }
  }
}
