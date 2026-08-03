import { normalize } from 'node:path';
import type { NativeTool } from '../../tool-types.js';
import type { SkillLibrary } from '../../../../core/usecases/brain/skill-library.js';
import type { SkillReadResult } from '../../../../core/usecases/brain/skill-types.js';

/**
 * 扩展技能拉取工具类。
 * 实现了 NativeTool 契约，支持动态按需加载系统提供的 Markdown 格式技能文档
 * 及其白名单支持文件，并以结构化 JSON 返回元数据、实际读取文件与包内支持文件列表。
 */
export class LoadSkillTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /**
   * 工具的名称.
   */
  readonly name = 'load_skill';

  /**
   * 为完整 Skill 内容提供高于默认值的输出配额。
   * 仍然超限的主文件或支持文件由统一输出层折叠；后台读取账本按最终模型回执
   * fail-closed，不为模型未完整看到的内容签发写入凭证。
   */
  readonly maxBytes = 640 * 1024;

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'load_skill',
      description: "读取一个 Skill 的完整内容，返回结构化 JSON（name/description/source/category/file/content/supportFiles）。技能名称可从 <available_skills> 快照或 skills_list 实时目录中选取。可选提供 file_path 读取支持文件（references/templates/scripts/assets 下的文件）。",
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

  /**
   * 初始化技能加载工具。
   *
   * @param skillLibrary - 必选的共享 SkillLibrary（未注入时执行返回明确错误）
   */
  constructor(private readonly skillLibrary?: SkillLibrary) {}

  /**
   * 执行技能加载逻辑。
   *
   * @param args - 工具调用参数字典，支持 name 和可选的 file_path
   * @returns 结构化 SkillReadResult JSON 字符串
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

    if (!this.skillLibrary) {
      throw new Error('当前系统未配置 SkillLibrary，无法执行 load_skill。');
    }

    const meta = this.skillLibrary.get(name);
    if (!meta) {
      throw new Error(`未找到名为 "${name}" 的技能，请检查名称是否在 <available_skills> 或 skills_list 目录中。`);
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

    // 只在成功读取后记录一次查看遥测，失败路径不计数。
    await this.skillLibrary.recordView(name);

    // file 使用与路径校验一致的规范化相对路径，不暴露磁盘绝对路径。
    const normalizedFilePath = filePath
      ? normalize(filePath).replace(/\\/g, '/')
      : undefined;
    const result: SkillReadResult = {
      name: meta.name,
      description: meta.description,
      source: meta.source,
      ...(meta.category !== undefined ? { category: meta.category } : {}),
      file: normalizedFilePath ?? 'SKILL.md',
      content,
      supportFiles: this.skillLibrary.listSupportFiles(name),
    };
    return JSON.stringify(result);
  }

  /**
   * 执行工具级权限检查。
   * 技能加载是安全的只读操作。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'allow', decisionReason: '技能加载只读操作' };
  }
}
