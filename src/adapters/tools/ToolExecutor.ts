/**
 * @file 宸ュ叿鎵ц璋冨害鍣ㄣ€? * 璐熻矗 tools/call 璇箟锛氬弬鏁拌繘鍏ユ墽琛岃竟鐣屻€佽兘鍔涜棰嗐€佸伐鍏锋墽琛屽垎鍙戜笌缁撴灉鍖呰銆? * 鏂版潈闄愰摼璺笅浣跨敤 executeAuthorized() 鏂规硶銆? */

import type { CallToolResult, ToolExecutionOutcome, ToolExecutionEffect } from './tool-types.js';
import type { ToolCatalog } from './ToolCatalog.js';
import type { AuthorizedExecutionContext } from '../../core/domain/permissions/tool-permission-service.js';

/**
 * 宸ュ叿鎵ц璋冨害鍣ㄣ€? * 璐熻矗 tools/call 璇箟锛氬弬鏁拌繘鍏ユ墽琛岃竟鐣屻€佽兘鍔涜棰嗐€佸伐鍏锋墽琛屽垎鍙戜笌缁撴灉鍖呰銆? */
export class ToolExecutor {
  private catalog: ToolCatalog;
  private readonly isAuthorizedContext: (context: AuthorizedExecutionContext) => boolean;

  constructor(
    catalog: ToolCatalog,
    isAuthorizedContext: (context: AuthorizedExecutionContext) => boolean = () => false,
  ) {
    this.catalog = catalog;
    this.isAuthorizedContext = isAuthorizedContext;
  }

  async executeAuthorized(
    authorizedContext: AuthorizedExecutionContext,
  ): Promise<ToolExecutionOutcome<CallToolResult>> {
    if (!this.isAuthorizedContext(authorizedContext)) {
      throw new Error('ToolExecutor 拒绝未经当前权限服务签发的执行上下文');
    }
    const tool = this.catalog.getTool(authorizedContext.toolName);
    if (!tool) {
      throw new Error('Tool is not registered: ' + authorizedContext.toolName);
    }
    const resultText = await tool.execute(authorizedContext.args);
    const rawResult: CallToolResult = {
      content: [{ type: "text", text: resultText }]
    };
    const effect: ToolExecutionEffect = { kind: "none", executionStarted: true, completed: true, resources: [], reason: "no_execution" };
    return { value: rawResult, effect };
  }

  /**
   * 保留旧方法签名用于显式拒绝绕过请求。
   *
   * @param _toolName - 被拒绝的工具名称
   * @param _args - 被拒绝的工具参数
   * @returns 不返回执行结果
   * @throws 所有未经 Gateway 的直接执行请求
   */
  async execute(
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<ToolExecutionOutcome<CallToolResult>> {
    throw new Error('ToolExecutor 不接受未经 ToolCallGateway 授权的直接执行请求');
  }

}
