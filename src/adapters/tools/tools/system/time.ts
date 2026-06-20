import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';

/**
 * 原生高精度当前系统时间获取工具。
 * 核心职责：提供只读、无副作用的高精度系统时间戳，消除大模型在诊断或执行任务时的环境感知盲区。
 */
export class GetCurrentTimeTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /** 工具的名称。 */
  readonly name = 'get_current_time';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'get_current_time',
      description: '获取当前操作系统的精确高精度时间戳，适用于分析日志时间差、计算操作耗时或需要分秒级精度定位的场景。该工具为只读系统调用，无任何副作用。',
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  };

  /**
   * 审查工具调用的安全性。
   * 由于是无副作用的只读时间查询工具，安全检查直接放行。
   *
   * @returns 安全评估结论
   */
  checkSafety(): SafetyCheckResult {
    return { status: 'pass' };
  }

  /**
   * 执行原生系统时间查询。
   *
   * @returns 包含系统高精度ISO时间戳及本地格式时间的JSON字符串描述
   */
  execute(): string {
    const now = new Date();
    const result = {
      success: true,
      formattedTime: now.toISOString(),
      localTime: now.toLocaleString()
    };
    return JSON.stringify(result, null, 2);
  }
}
