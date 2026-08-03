import type { NativeTool } from '../../tool-types.js';
import type { SkillLibrary } from '../../../../core/usecases/brain/skill-library.js';
import type {
  SkillListFilters,
  SkillListItem,
  SkillListResult,
} from '../../../../core/usecases/brain/skill-types.js';
import { serializeNativeToolTextResultForModel } from '../../../../core/usecases/engine/ToolDispatcher.js';

/** 目录筛选参数的最大字符数（去除首尾空白前）。 */
const MAX_FILTER_CHARS = 256;
/** 单条描述摘要的最大字符数。 */
const MAX_DESCRIPTION_CHARS = 1024;
/** 最终模型可见目录回执的自限预算（UTF-8 字节），低于工具声明的 256KB 配额。 */
const MAX_PAYLOAD_BYTES = 240 * 1024;

/**
 * 技能目录工具类。
 * 实现 NativeTool 契约，从注入的 SkillLibrary 实时合并活动视图返回只读元数据目录，
 * 支持分类精确匹配与关键词子串筛选，包络自限在固定字节预算内，
 * 不读取正文、不记录查看遥测。
 */
export class SkillsListTool implements NativeTool {
  /** 工具的安全类别（只读）。 */
  readonly securityCategory = 'read';

  /**
   * 工具名称。
   */
  readonly name = 'skills_list';

  /**
   * 保证目录包络（自限 240KB）不被统一输出层截断，维持「完整或明确提示收敛」语义。
   */
  readonly maxBytes = 256 * 1024;

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'skills_list',
      description: "查看当前实时 Skill 目录（元数据）。目录反映最新新增、删除与项目覆盖；不会改变系统提示词中的 <available_skills> 快照。可用 category 精确筛选分类，或用 query 对名称、描述、分类做大小写不敏感的关键词筛选；结果不完整时会返回 refineHint，请据此收敛后再决策。需要读取某个 Skill 的完整内容时请使用 load_skill。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            maxLength: 256,
            description: "可选的精确分类筛选（去除首尾空白后与元数据分类精确匹配）"
          },
          query: {
            type: "string",
            maxLength: 256,
            description: "可选的关键词筛选（对名称、描述与分类做大小写不敏感子串匹配）"
          }
        },
        additionalProperties: false
      }
    }
  };

  /**
   * 初始化目录工具。
   *
   * @param skillLibrary - 必选的共享 SkillLibrary（未注入时执行返回明确错误，不生成伪造目录）
   */
  constructor(private readonly skillLibrary?: SkillLibrary) {}

  /**
   * 执行目录列举。
   *
   * @param args - 工具参数字典，只接受可选 category 与 query
   * @returns 预算内合法 JSON 字符串（完整目录或带 refineHint 的部分目录）
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    // 未知参数直接拒绝：schema 已禁止，执行层同样防御模型侧越权传参。
    for (const key of Object.keys(args)) {
      if (key !== 'category' && key !== 'query') {
        throw new Error(`skills_list 不支持参数: ${key}`);
      }
    }

    // 筛选参数必须是字符串且去除首尾空白后非空，长度受限。
    let category: string | undefined;
    if (args.category !== undefined) {
      if (typeof args.category !== 'string') {
        throw new Error('category 必须是字符串');
      }
      category = args.category.trim();
      if (category === '') {
        throw new Error('category 不能为空字符串');
      }
      if (category.length > MAX_FILTER_CHARS) {
        throw new Error(`category 不能超过 ${MAX_FILTER_CHARS} 字符`);
      }
    }
    let query: string | undefined;
    if (args.query !== undefined) {
      if (typeof args.query !== 'string') {
        throw new Error('query 必须是字符串');
      }
      query = args.query.trim();
      if (query === '') {
        throw new Error('query 不能为空字符串');
      }
      if (query.length > MAX_FILTER_CHARS) {
        throw new Error(`query 不能超过 ${MAX_FILTER_CHARS} 字符`);
      }
    }
    // 只回显实际应用的筛选条件；未提供的字段省略。
    const filters: SkillListFilters = {
      ...(category !== undefined ? { category } : {}),
      ...(query !== undefined ? { query } : {}),
    };

    if (!this.skillLibrary) {
      throw new Error('skills_list 未注入 SkillLibrary，无法执行');
    }

    const all = this.skillLibrary.list();
    const lowerQuery = filters.query?.toLowerCase();

    // 只映射白名单字段：名称、描述、来源与可选分类；
    // 物理路径、usage 与所有权内部字段一律不进入工具结果。
    const matched: SkillListItem[] = all
      .filter(skill => this.matches(skill, filters, lowerQuery))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(skill => this.toListItem(skill));

    // 按最终 CallToolResult 包络计算预算：超出时丢弃尾部条目并提示模型收敛。
    const emitted: SkillListItem[] = [];
    for (const item of matched) {
      const candidate = [...emitted, item];
      const candidateResult = this.buildResult(
        candidate,
        filters,
        all.length,
        matched.length,
      );
      if (this.payloadBytes(candidateResult) > MAX_PAYLOAD_BYTES) {
        break;
      }
      emitted.push(item);
    }
    const result = this.buildResult(emitted, filters, all.length, matched.length);
    return JSON.stringify(result);
  }

  /**
   * 判断一个 Skill 是否同时满足分类与关键词筛选。
   *
   * @param skill - SkillLibrary 元数据
   * @param filters - 应用中的筛选条件
   * @param lowerQuery - 已小写化的关键词；未提供时为 undefined
   * @returns 全部生效条件均命中返回 true
   */
  private matches(
    skill: { name: string; description: string; category?: string },
    filters: SkillListFilters,
    lowerQuery: string | undefined,
  ): boolean {
    if (filters.category !== undefined && skill.category !== filters.category) {
      return false;
    }
    if (lowerQuery !== undefined) {
      const haystacks = [
        skill.name.toLowerCase(),
        skill.description.toLowerCase(),
        ...(skill.category !== undefined ? [skill.category.toLowerCase()] : []),
      ];
      if (!haystacks.some(haystack => haystack.includes(lowerQuery))) {
        return false;
      }
    }
    return true;
  }

  /**
   * 将 SkillLibrary 元数据映射为目录条目，描述超长时截断并标记。
   *
   * @param skill - SkillLibrary 元数据
   * @returns 目录条目
   */
  private toListItem(skill: {
    name: string;
    description: string;
    source: 'user' | 'project';
    category?: string;
  }): SkillListItem {
    const truncated = skill.description.length > MAX_DESCRIPTION_CHARS;
    return {
      name: skill.name,
      description: truncated
        ? skill.description.slice(0, MAX_DESCRIPTION_CHARS)
        : skill.description,
      ...(truncated ? { descriptionTruncated: true } : {}),
      source: skill.source,
      ...(skill.category !== undefined ? { category: skill.category } : {}),
    };
  }

  /** 根据实际条目、计数和筛选条件构造最终目录结果。 */
  private buildResult(
    items: readonly SkillListItem[],
    filters: SkillListFilters,
    totalCount: number,
    matchedCount: number,
  ): SkillListResult {
    const complete = items.length === matchedCount;
    const hasFilters = filters.category !== undefined || filters.query !== undefined;
    return {
      skills: items,
      totalCount,
      matchedCount,
      returnedCount: items.length,
      complete,
      ...(hasFilters ? { filters } : {}),
      ...(complete ? {} : {
        refineHint: `目录结果不完整（已返回 ${items.length}/${matchedCount} 条匹配项），请使用 category 或 query 缩小范围后重新查询。`,
      }),
    };
  }

  /**
   * 计算目录结果经过 ToolGateway 包装和工具编排器序列化后的真实 UTF-8 字节数。
   *
   * @param result - 待返回的完整目录结果
   * @returns 最终模型可见 CallToolResult JSON 的 UTF-8 字节数
   */
  private payloadBytes(result: SkillListResult): number {
    const toolText = JSON.stringify(result);
    return Buffer.byteLength(
      serializeNativeToolTextResultForModel(toolText),
      'utf8',
    );
  }

  /**
   * 执行工具级权限检查。
   * 目录列举是安全的只读操作。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'allow', decisionReason: '技能目录列举只读操作' };
  }
}
