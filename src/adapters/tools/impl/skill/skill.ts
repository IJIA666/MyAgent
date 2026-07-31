import type { NativeTool } from '../../tool-types.js';
import type { SkillLibrary } from '../../../../core/usecases/brain/skill-library.js';

/**
 * 扩展技能拉取工具类。
 * 实现了 NativeTool 契约，支持动态按需加载系统提供的 Markdown 格式技能文档
 * 及其白名单支持文件。
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
      description: "当需要使用特定扩展技能时调用此工具拉取技能全文。技能名称需从 <available_skills> 中选取。可选提供 file_path 读取支持文件（references/templates/scripts/assets 下的文件）。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "需要加载的技能名称"
          },
          file_path: {
            type: "string",
            description: "可选的支持文件相对路径（如 scripts/deploy.sh），不提供时读取 SKILL.md"
          }
        },
        required: ["name"],
        additionalProperties: false
      }
    }
  };

  /** 技能加载回调（向后兼容）。 */
  private loadSkillCallback?: (name: string) => string | null;
  /** 可选注入的共享 SkillLibrary。 */
  private skillLibrary?: SkillLibrary;

  /**
   * 初始化技能加载工具。
   *
   * @param loadSkillCallback - 外部技能加载解析器回调（向后兼容）
   * @param skillLibrary - 可选注入的 SkillLibrary（优先使用）
   */
  constructor(loadSkillCallback?: (name: string) => string | null, skillLibrary?: SkillLibrary) {
    this.loadSkillCallback = loadSkillCallback;
    this.skillLibrary = skillLibrary;
  }

  /**
   * 执行技能加载逻辑。
   *
   * @param args - 工具调用参数字典，支持 name 和可选的 file_path
   * @returns 拉取到的技能或支持文件内容
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const name = args.name;
    if (typeof name !== 'string') {
      throw new Error("name 必须是字符串");
    }

    const filePath = args.file_path;
    if (filePath !== undefined && typeof filePath !== 'string') {
      throw new Error("file_path 必须是字符串");
    }

    // 优先使用 SkillLibrary
    if (this.skillLibrary) {
      const meta = this.skillLibrary.get(name);
      if (!meta) {
        throw new Error(`未找到名为 "${name}" 的技能，请检查名称是否在 <available_skills> 中。`);
      }
      if (filePath) {
        const pathError = this.skillLibrary.validateSupportPath(name, filePath);
        if (pathError) {
          throw new Error(`无法读取技能 "${name}" 的支持文件: ${pathError}`);
        }
      }

      const content = filePath
        ? this.skillLibrary.read(name, filePath)
        : this.skillLibrary.read(name);

      if (!content) {
        throw new Error(`技能 "${name}" 中未找到文件: ${filePath || 'SKILL.md'}`);
      }

      await this.skillLibrary.recordView(name);
      return content;
    }

    // 向后兼容：使用回调
    if (!this.loadSkillCallback) {
      throw new Error('当前系统未配置 loadSkill 解析器，无法执行 load_skill。');
    }

    const body = this.loadSkillCallback(name);
    if (!body) {
      throw new Error(`未找到名为 "${name}" 的技能，请检查名称是否在 <available_skills> 中。`);
    }

    return body;
  }

  /**
   * 执行工具级权限检查。
   * 技能加载是安全的只读操作。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'allow', decisionReason: '技能加载只读操作' };
  }
}
