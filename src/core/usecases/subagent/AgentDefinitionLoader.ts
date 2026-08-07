/**
 * @file 从 agents 目录加载 Markdown 子代理定义的加载器。
 * 对齐官方 `loadAgentsDir.ts` 的 frontmatter 解析语义：类型名取自必填 `name`、
 * `.md` 正文即系统提示、`tools/disallowedTools` 支持逗号分隔字符串或数组。
 * 按 MyAgent 形态适配：仅支持 user/project 两层目录，plugin 层留接口不实现；
 * 本阶段未启用字段（effort/color/skills/background/memory/mcpServers/hooks/isolation）
 * 解析但忽略并记录 warning，非法定义拒绝单文件且不影响其他文件。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import { BUILTIN_MODELS } from '../../../config/models.js';
import type { McpServerEntry } from '../../../config/types.js';
import type { PermissionMode } from '../../domain/permissions/permission-types.js';
import { logger } from '../../../utils/logger.js';

/** 本阶段解析但忽略的未启用字段（后续阶段启用，见 roadmap）。 */
const DEFERRED_FIELDS = [
  'effort',
  'color',
  'skills',
  'memory',
  'hooks',
  'isolation',
] as const;

/** 定义级 mcpServers 归一化声明元素：字符串（引用）或内联定义（单服务器）。 */
export type AgentMcpServerSpec = string | {
  readonly name: string;
  readonly config: McpServerEntry;
};

/** 从单个 `.md` 文件解析出的子代理定义。 */
export interface AgentFileDefinition {
  /** frontmatter `name`，必填且非空字符串。 */
  readonly type: string;
  /** frontmatter `description`，必填且非空字符串。 */
  readonly description: string;
  /** 定义来源目录层级。 */
  readonly sourceDir: 'user' | 'project';
  /** 文件名，仅作诊断信息（类型名以 name 为准）。 */
  readonly fileName: string;
  /** 显式工具允许名单；省略时保持默认池。 */
  readonly tools?: readonly string[];
  /** 工具剔除名单；与 tools 同时声明时先按允许名单过滤再剔除交集。 */
  readonly disallowedTools?: readonly string[];
  /** 定义级模型：`inherit` 或 `BUILTIN_MODELS` 已注册 profile ID。 */
  readonly model?: string;
  /** 定义级最大回合数，必须为正整数。 */
  readonly maxTurns?: number;
  /** 定义级权限模式，仅接受 `plan`（收窄）；其他值拒绝定义。 */
  readonly permissionMode?: PermissionMode;
  /** 为 true 时不加载 CLAUDE.md 规则投影。 */
  readonly omitClaudeMd?: boolean;
  /** 定义级 MCP 服务器声明（字符串引用或内联定义，见 `subagent-agent-mcp`）。 */
  readonly mcpServers?: ReadonlyArray<AgentMcpServerSpec>;
  /** 定义级首轮前缀（`--agent` 主会话模式与首条用户输入合并）。 */
  readonly initialPrompt?: string;
  /** 定义级强制后台：声明 true 时模型调用该类型一律后台执行。 */
  readonly background?: boolean;
  /** `.md` 正文，作为子代理系统提示的自定义部分。 */
  readonly systemPrompt: string;
}

/**
 * 同步扫描 user/project 两层 agents 目录并解析 `.md` 子代理定义。
 * 组合根单例使用：进程内首次 load() 后缓存结果（会话内快照，重启生效）。
 */
export class AgentDefinitionLoader {
  /** 首次加载缓存，避免重复扫描与重复解析。 */
  private cached?: readonly AgentFileDefinition[];

  /**
   * @param userAgentsDir - 用户层 agents 目录（`~/.myagent/agents`）
   * @param projectAgentsDir - 项目层 agents 目录（`<workspace>/.myagent/agents`）
   */
  constructor(
    private readonly userAgentsDir: string,
    private readonly projectAgentsDir: string,
  ) {}

  /**
   * 加载全部自定义定义；user 层在前、project 层在后（优先级合并由注册表完成）。
   *
   * @returns 解析成功的定义数组；目录不存在时对应层返回空
   */
  public load(): readonly AgentFileDefinition[] {
    if (this.cached) {
      return this.cached;
    }
    this.cached = Object.freeze([
      ...scanAgentsDir(this.userAgentsDir, 'user'),
      ...scanAgentsDir(this.projectAgentsDir, 'project'),
    ]);
    return this.cached;
  }
}

/** 扫描单个 agents 目录中的全部 `.md` 文件，按文件名稳定排序后逐个解析。 */
function scanAgentsDir(
  dir: string,
  sourceDir: 'user' | 'project',
): readonly AgentFileDefinition[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .sort();
  } catch (error: unknown) {
    // 目录不存在视为空结果；其他 IO 错误记录后按空处理，不影响另一层。
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('[AgentDefinitionLoader] agents 目录读取失败', {
        component: 'agent_definition_loader',
        event: 'agents_dir_read_failed',
        dir,
        reason: String(error),
      });
    }
    return [];
  }
  return fileNames.map(fileName => parseAgentFile(join(dir, fileName), fileName, sourceDir))
    .filter((definition): definition is AgentFileDefinition => definition !== null);
}

/** 解析单个定义文件；非法定义返回 null 并记录可诊断日志。 */
function parseAgentFile(
  filePath: string,
  fileName: string,
  sourceDir: 'user' | 'project',
): AgentFileDefinition | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error: unknown) {
    logger.warn('[AgentDefinitionLoader] 定义文件读取失败', {
      component: 'agent_definition_loader',
      event: 'agent_file_read_failed',
      file: filePath,
      reason: String(error),
    });
    return null;
  }
  let data: Record<string, unknown>;
  let content: string;
  try {
    const parsed = matter(raw);
    data = parsed.data;
    content = parsed.content;
  } catch (error: unknown) {
    // YAML 语法错误等解析失败按非法定义处理，拒绝单文件。
    logger.warn('[AgentDefinitionLoader] frontmatter 解析失败，拒绝注册', {
      component: 'agent_definition_loader',
      event: 'agent_frontmatter_parse_failed',
      file: filePath,
      reason: String(error),
    });
    return null;
  }

  // 类型名必须取自 frontmatter name（对齐官方 parseAgentFromFile），文件名仅诊断。
  const type = typeof data.name === 'string' ? data.name.trim() : '';
  if (!type) {
    logger.warn('[AgentDefinitionLoader] 缺少必填 name，拒绝注册', {
      component: 'agent_definition_loader',
      event: 'agent_missing_name',
      file: filePath,
    });
    return null;
  }
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) {
    logger.warn('[AgentDefinitionLoader] 缺少必填 description，拒绝注册', {
      component: 'agent_definition_loader',
      event: 'agent_missing_description',
      file: filePath,
      agentType: type,
    });
    return null;
  }

  // 未启用字段：解析但忽略，每条记录 warning 指明后续阶段。
  for (const field of DEFERRED_FIELDS) {
    if (data[field] !== undefined) {
      logger.warn('[AgentDefinitionLoader] 字段已解析但本阶段未启用', {
        component: 'agent_definition_loader',
        event: 'agent_deferred_field_ignored',
        file: filePath,
        agentType: type,
        field,
      });
    }
  }

  // 通配 '*' 语义 = 默认池（tools 恰好 ['*'] 归一化为 undefined；disallowedTools 不支持通配，同样归一化避免静默失效）。
  const tools = parseToolList(data.tools, true);
  const disallowedTools = parseToolList(data.disallowedTools, true);

  const model = typeof data.model === 'string' ? data.model.trim() : undefined;
  if (model !== undefined && model !== 'inherit' && !Object.hasOwn(BUILTIN_MODELS, model)) {
    logger.warn('[AgentDefinitionLoader] 未知模型 ID，拒绝注册', {
      component: 'agent_definition_loader',
      event: 'agent_invalid_model',
      file: filePath,
      agentType: type,
      model,
    });
    return null;
  }

  let maxTurns: number | undefined;
  if (data.maxTurns !== undefined) {
    maxTurns = typeof data.maxTurns === 'number' ? data.maxTurns : Number(data.maxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      logger.warn('[AgentDefinitionLoader] maxTurns 必须为正整数，拒绝注册', {
        component: 'agent_definition_loader',
        event: 'agent_invalid_max_turns',
        file: filePath,
        agentType: type,
      });
      return null;
    }
  }

  // 定义级权限模式仅接受 plan（收窄）；声明其他模式视为试图改变权限边界，fail-closed 拒绝。
  let permissionMode: PermissionMode | undefined;
  if (data.permissionMode !== undefined) {
    if (data.permissionMode === 'plan') {
      permissionMode = 'plan';
    } else {
      logger.warn('[AgentDefinitionLoader] permissionMode 仅支持 plan，拒绝注册', {
        component: 'agent_definition_loader',
        event: 'agent_invalid_permission_mode',
        file: filePath,
        agentType: type,
      });
      return null;
    }
  }

  const mcpServers = parseMcpServers(data.mcpServers, type, filePath);
  const initialPrompt = typeof data.initialPrompt === 'string' ? data.initialPrompt.trim() : undefined;

  // 定义级强制后台：仅接受布尔；非布尔值 fail-closed 拒绝（不静默忽略，对齐 tools/model/maxTurns 风格）。
  let background: boolean | undefined;
  if (data.background !== undefined) {
    if (typeof data.background === 'boolean') {
      background = data.background;
    } else {
      logger.warn('[AgentDefinitionLoader] background 必须为布尔值，拒绝注册', {
        component: 'agent_definition_loader',
        event: 'agent_invalid_background',
        file: filePath,
        agentType: type,
      });
      return null;
    }
  }

  return Object.freeze({
    type,
    description,
    sourceDir,
    fileName: basename(fileName),
    ...(tools ? { tools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(data.omitClaudeMd === true ? { omitClaudeMd: true as const } : {}),
    ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(background ? { background: true as const } : {}),
    systemPrompt: content.trim(),
  });
}

/**
 * 解析 mcpServers 声明：数组元素为字符串（引用全局清单服务器名）或
 * 对象（内联定义，单键 `{ name: { command, args?, env? } }`）；非法项拒绝并记录日志，
 * 不影响定义其余字段。
 */
function parseMcpServers(
  value: unknown,
  agentType: string,
  filePath: string,
): ReadonlyArray<AgentMcpServerSpec> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    logger.warn('[AgentDefinitionLoader] mcpServers 必须为数组，忽略该字段', {
      component: 'agent_definition_loader',
      event: 'agent_invalid_mcp_servers',
      file: filePath,
      agentType,
    });
    return undefined;
  }
  const specs: AgentMcpServerSpec[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) {
        specs.push(name);
        continue;
      }
      logger.warn('[AgentDefinitionLoader] mcpServers 引用名为空，拒绝该项', {
        component: 'agent_definition_loader',
        event: 'agent_invalid_mcp_reference',
        file: filePath,
        agentType,
      });
      continue;
    }
    if (isRecord(item)) {
      const entries = Object.entries(item);
      if (entries.length === 1) {
        const [name, config] = entries[0];
        if (typeof name === 'string' && name.trim() && isRecord(config) && typeof config.command === 'string') {
          specs.push({
            name: name.trim(),
            config: {
              command: config.command,
              ...(Array.isArray(config.args)
                ? { args: config.args.filter((arg): arg is string => typeof arg === 'string') }
                : {}),
              ...(isRecord(config.env)
                ? {
                  env: Object.fromEntries(
                    Object.entries(config.env).filter(([, v]) => typeof v === 'string'),
                  ) as Record<string, string>,
                }
                : {}),
              ...(typeof config.enabled === 'boolean' ? { enabled: config.enabled } : {}),
            },
          });
          continue;
        }
      }
    }
    logger.warn('[AgentDefinitionLoader] mcpServers 非法项，拒绝', {
      component: 'agent_definition_loader',
      event: 'agent_invalid_mcp_entry',
      file: filePath,
      agentType,
    });
  }
  return specs.length > 0 ? Object.freeze(specs) : undefined;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 归一化 tools/disallowedTools 声明：支持数组或逗号分隔字符串，trim、去空、去重。
 * fail-closed 语义：显式声明但结果为空时返回空数组（允许名单为空 = 无工具可见），
 * 绝不回退为 undefined（默认全池），防止 `tools: []` 意外恢复默认工具面。
 * 通配符语义：恰好 `['*']` 时归一化为 undefined（默认池），避免 `Set(['*'])` 过滤掉全部工具。
 */
function parseToolList(value: unknown, wildcardAsDefault: boolean): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const rawList = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const tools = [...new Set(rawList.map(item => item.trim()).filter(Boolean))];
  // 恰好一个通配符：语义为默认池（未声明名单）。
  if (wildcardAsDefault && tools.length === 1 && tools[0] === '*') {
    return undefined;
  }
  // 显式声明过（含空声明）时返回冻结数组；完全未声明才返回 undefined。
  return Object.freeze(tools);
}
