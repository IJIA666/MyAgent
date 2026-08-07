import type { SessionContext } from '../../domain/context.js';
import type { PermissionMode } from '../../domain/permissions/permission-types.js';
import type {
  SubagentContextPolicy,
  SubagentToolPolicyKey,
} from '../../../ports/driving/SubagentExecutionPort.js';
import type { AgentDefinitionLoader } from './AgentDefinitionLoader.js';
import { logger } from '../../../utils/logger.js';

/** 兼容现有运行器导入路径的上下文策略类型重导出。 */
export type { SubagentContextPolicy } from '../../../ports/driving/SubagentExecutionPort.js';

/** Explore/Plan 只读允许名单：MyAgent 实际注册名（以 effectful-entrypoints.ts 为唯一事实源）。 */
const READONLY_TOOL_ALLOW_LIST = Object.freeze([
  'readFile',
  'readManyFiles',
  'listFiles',
  'globSearch',
  'grepSearch',
  'gitShowStatus',
  'gitShowLog',
  'gitShowDiff',
  'Bash',
  'PowerShell',
  'skills_list',
  'load_skill',
]);

/** 内置 Explore：只读搜索专家系统提示（本地化对齐官方 exploreAgent.ts）。 */
const EXPLORE_SYSTEM_PROMPT = [
  '你是 MyAgent 的文件搜索专家，擅长快速、全面地搜索与阅读代码库。',
  '',
  '=== 强制只读模式：禁止任何文件修改 ===',
  '本次任务严格只读，禁止：',
  '- 创建、修改或删除任何文件',
  '- 移动或复制文件，禁止重定向（>、>>）或 heredoc 写文件',
  '- 执行任何改变系统状态的命令',
  '',
  '你的职责仅限于搜索与分析既有代码：',
  '- 用 globSearch 按模式查找文件，用 grepSearch 按正则搜索文件内容',
  '- 已知具体路径时用 readFile / readManyFiles 读取文件',
  '- Bash/PowerShell 仅用于只读操作（ls、cat、head、tail、git status、git log、git diff、find）',
  '- 尽量并行发起多个搜索与读取调用以提升效率',
  '',
  '直接以普通消息报告搜索结论，不要尝试创建任何文件。',
].join('\n');

/** 内置 Plan：只读架构规划师系统提示（本地化对齐官方 planAgent.ts）。 */
const PLAN_SYSTEM_PROMPT = [
  '你是 MyAgent 的软件架构师与规划专家，职责是探索代码库并设计实施方案。',
  '',
  '=== 强制只读模式：禁止任何文件修改 ===',
  '本次任务严格只读，禁止创建、修改、删除、移动或复制任何文件，',
  '禁止重定向或 heredoc 写文件，禁止执行任何改变系统状态的命令。',
  '',
  '你的流程：',
  '1. 理解需求：聚焦提供的需求并贯穿你的设计视角',
  '2. 充分探索：用 globSearch/grepSearch/readFile 找到既有模式与实现，理解当前架构',
  '3. 设计方案：基于探索结论给出实现方案，权衡取舍',
  '4. 细化计划：给出分步实施策略、依赖顺序与潜在风险',
  '',
  '最终输出必须以「关键实现文件」结尾，列出 3-5 个对实施最关键的源文件路径。',
  '你只能探索与规划，绝不能写、改或编辑任何文件。',
].join('\n');

/** 已注册的子代理定义。 */
export interface SubagentDefinition {
  /** 模型传入的类型名。 */
  readonly type: string;
  /** 面向模型的简短描述。 */
  readonly description: string;
  /** 上下文装载策略。 */
  readonly contextPolicy: SubagentContextPolicy;
  /** 工具作用域策略键。 */
  readonly toolPolicyKey: SubagentToolPolicyKey;
  /** 为隔离上下文提供额外系统说明的构造器。 */
  readonly buildSystemPrompt: (context: SessionContext) => string;
  /** 显式工具允许名单；省略时保持默认池。 */
  readonly tools?: readonly string[];
  /** 工具剔除名单；与 tools 同时声明时先按允许名单过滤再剔除交集（只收窄不放开）。 */
  readonly disallowedTools?: readonly string[];
  /** 定义级模型：`inherit` 或 `BUILTIN_MODELS` 已注册 profile ID。 */
  readonly model?: string;
  /** 定义级最大回合数，覆盖提交点冻结的 `runtimeLimits.maxIterations`。 */
  readonly maxTurns?: number;
  /** 定义级权限模式；仅允许收窄到 `plan` 或保持父模式，不得提升。 */
  readonly permissionMode?: PermissionMode;
  /** 为 true 时不加载 CLAUDE.md 规则投影（Skill 元数据快照保留）。 */
  readonly omitClaudeMd?: boolean;
  /** `.md` 正文形式的系统提示（自定义定义专用；内置定义用 buildSystemPrompt）。 */
  readonly systemPrompt?: string;
}

/**
 * 子代理定义注册表。
 * 注册内置定义（general-purpose / Explore / Plan / 可选 exact-fork），
 * 并可注入 {@link AgentDefinitionLoader} 注册 user/project 两层的自定义 Markdown 定义。
 */
export class SubagentDefinitionRegistry {
  /** 按类型名保存定义，避免重复注册覆盖行为。 */
  private readonly definitions = new Map<string, SubagentDefinition>();

  /**
   * 创建注册表：先注册内置定义，再按优先级注册自定义定义。
   *
   * @param subagentForkEnabled - 是否把省略类型解析为 exact-fork
   * @param loader - 自定义定义加载器；缺省时不加载 Markdown 定义（兼容旧宿主与测试）
   */
  constructor(
    private readonly subagentForkEnabled = false,
    private readonly loader?: AgentDefinitionLoader,
  ) {
    this.register({
      type: 'general-purpose',
      description: '在当前项目中独立完成通用任务的前台子代理。',
      contextPolicy: 'fresh',
      toolPolicyKey: 'freshForeground',
      // 基础 system（RuleManager 生成）即完整提示，附加正文必须为空，避免重复注入。
      buildSystemPrompt: () => '',
    });
    // Explore/Plan：只读允许名单 + 固定 plan 权限（权限网关级强制只读）+ 不加载 CLAUDE.md。
    this.register({
      type: 'Explore',
      description: '快速搜索与阅读代码库的只读探索子代理。',
      contextPolicy: 'fresh',
      toolPolicyKey: 'freshForeground',
      buildSystemPrompt: () => EXPLORE_SYSTEM_PROMPT,
      tools: READONLY_TOOL_ALLOW_LIST,
      permissionMode: 'plan',
      omitClaudeMd: true,
    });
    this.register({
      type: 'Plan',
      description: '设计实现方案的只读架构规划子代理。',
      contextPolicy: 'fresh',
      toolPolicyKey: 'freshForeground',
      buildSystemPrompt: () => PLAN_SYSTEM_PROMPT,
      tools: READONLY_TOOL_ALLOW_LIST,
      permissionMode: 'plan',
      omitClaudeMd: true,
    });
    if (subagentForkEnabled) {
      this.register({
        type: 'exact-fork',
        description: '在当前会话快照中后台执行任务的 exact-fork 子代理。',
        contextPolicy: 'exact-fork',
        toolPolicyKey: 'fork',
        buildSystemPrompt: context => context.getHistory()[0]?.content?.toString() ?? '',
      });
    }
    this.registerCustomDefinitions();
  }

  /**
   * 按优先级注册自定义定义：built-in > user > project。
   * loader 返回顺序即 user 在前 project 在后；已存在同名（内置或用户层）时跳过并记录日志。
   */
  private registerCustomDefinitions(): void {
    if (!this.loader) {
      return;
    }
    for (const definition of this.loader.load()) {
      if (this.definitions.has(definition.type)) {
        logger.warn('[SubagentDefinitionRegistry] 跳过低优先级同名定义', {
          component: 'subagent_definition_registry',
          event: 'custom_agent_skipped',
          agentType: definition.type,
          file: definition.fileName,
          sourceDir: definition.sourceDir,
        });
        continue;
      }
      this.register({
        type: definition.type,
        description: definition.description,
        contextPolicy: 'fresh',
        toolPolicyKey: 'freshForeground',
        buildSystemPrompt: () => definition.systemPrompt,
        ...(definition.tools ? { tools: definition.tools } : {}),
        ...(definition.disallowedTools ? { disallowedTools: definition.disallowedTools } : {}),
        ...(definition.model !== undefined ? { model: definition.model } : {}),
        ...(definition.maxTurns !== undefined ? { maxTurns: definition.maxTurns } : {}),
        ...(definition.permissionMode ? { permissionMode: definition.permissionMode } : {}),
        ...(definition.omitClaudeMd ? { omitClaudeMd: true as const } : {}),
        systemPrompt: definition.systemPrompt,
      });
    }
  }

  /**
   * 注册一个新定义。
   *
   * @param definition - 待注册的完整定义
   * @throws 类型名为空或重复时抛出错误
   */
  public register(definition: SubagentDefinition): void {
    if (!definition.type.trim()) {
      throw new Error('子代理类型名不能为空');
    }
    if (this.definitions.has(definition.type)) {
      throw new Error(`子代理类型重复注册: ${definition.type}`);
    }
    this.definitions.set(definition.type, Object.freeze({ ...definition }));
  }

  /**
   * 按类型解析定义。
   *
   * @param type - 模型请求的子代理类型
   * @returns 定义；未知类型返回 undefined
   */
  public resolve(type?: string): SubagentDefinition | undefined {
    if (type === undefined && this.subagentForkEnabled) {
      return this.definitions.get('exact-fork');
    }
    return this.definitions.get(type ?? 'general-purpose');
  }

  /**
   * 获取当前注册的定义清单。
   *
   * @returns 不可变定义数组
   */
  public list(): readonly SubagentDefinition[] {
    return Object.freeze(Array.from(this.definitions.values()));
  }
}
