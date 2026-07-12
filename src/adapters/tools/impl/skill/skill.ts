import type { NativeTool } from '../../tool-types.js';
import type { SafetyCheckResult } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SafetyOperation } from '../../../../ports/shared/tool-policy.js';

/**
 * 扩展技能拉取工具类。
 * 实现了 NativeTool 契约，支持动态按需加载系统提供的 Markdown 格式技能文档。
 */
export class LoadSkillTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /**
   * 工具的名称.
   */
  readonly name = 'load_skill';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'load_skill',
      description: "当需要使用特定扩展技能时调用此工具拉取技能全文，技能名称需从 <available_skills> 中选取。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "需要加载的技能名称"
          }
        },
        required: ["name"]
      }
    }
  };

  /**
   * 外部注入的技能加载回调逻辑。
   */
  private loadSkillCallback?: (name: string) => string | null;

  /**
   * 初始化技能加载工具。
   *
   * @param loadSkillCallback - 外部技能加载解析器回调
   */
  constructor(loadSkillCallback?: (name: string) => string | null) {
    this.loadSkillCallback = loadSkillCallback;
  }

  /**
   * 执行技能加载逻辑。
   *
   * @param args - 工具调用参数字典
   * @returns 拉取到的技能 Markdown 文本
   */
  execute(args: Record<string, unknown>): string {
    const name = args.name;
    if (typeof name !== 'string') {
      throw new Error("name 必须是字符串");
    }

    if (!this.loadSkillCallback) {
      throw new Error("当前系统未配置 loadSkill 解析器，无法执行 load_skill。");
    }

    const body = this.loadSkillCallback(name);
    if (!body) {
      throw new Error(`未找到名为 "${name}" 的技能，请检查名称是否在 <available_skills> 中。`);
    }

    return body;
  }

  /**
   * 审查技能加载调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(): SafetyCheckResult {
    return { status: 'pass', operation: { planSideEffect: 'read', riskReason: '', operationCategory: 'file-read' as const, summary: '加载技能规范', resources: [] } as SafetyOperation };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 技能加载是安全的只读操作。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'allow', decisionReason: '技能加载只读操作' };
  }
}
