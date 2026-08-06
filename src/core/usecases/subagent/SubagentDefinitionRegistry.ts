import type { SessionContext } from '../../domain/context.js';
import type {
  SubagentContextPolicy,
  SubagentToolPolicyKey,
} from '../../../ports/driving/SubagentExecutionPort.js';

/** 兼容现有运行器导入路径的上下文策略类型重导出。 */
export type { SubagentContextPolicy } from '../../../ports/driving/SubagentExecutionPort.js';

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
}

/**
 * 子代理定义注册表。
 * 第一阶段只内置 general-purpose，不扫描 Markdown 或隐式发现自定义 Agent。
 */
export class SubagentDefinitionRegistry {
  /** 按类型名保存定义，避免重复注册覆盖行为。 */
  private readonly definitions = new Map<string, SubagentDefinition>();

  /**
   * 创建只包含内置定义的注册表。
   *
   * @param subagentForkEnabled - 是否把省略类型解析为 exact-fork
   */
  constructor(private readonly subagentForkEnabled = false) {
    this.register({
      type: 'general-purpose',
      description: '在当前项目中独立完成通用任务的前台子代理。',
      contextPolicy: 'fresh',
      toolPolicyKey: 'freshForeground',
      buildSystemPrompt: context => context.getHistory()[0]?.content?.toString() ?? '',
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
