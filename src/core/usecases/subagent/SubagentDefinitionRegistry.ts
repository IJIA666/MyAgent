import type { SessionContext } from '../../domain/context.js';

/** 子代理上下文装载策略。 */
export type SubagentContextPolicy = 'fresh' | 'history-replay';

/** 已注册的子代理定义。 */
export interface SubagentDefinition {
  /** 模型传入的类型名。 */
  readonly type: string;
  /** 面向模型的简短描述。 */
  readonly description: string;
  /** 上下文装载策略。 */
  readonly contextPolicy: SubagentContextPolicy;
  /** 工具作用域策略键。 */
  readonly toolPolicyKey: string;
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

  /** 创建只包含第一阶段内置定义的注册表。 */
  constructor() {
    this.register({
      type: 'general-purpose',
      description: '在当前项目中独立完成通用任务的前台子代理。',
      contextPolicy: 'fresh',
      toolPolicyKey: 'general-purpose',
      buildSystemPrompt: context => context.getHistory()[0]?.content?.toString() ?? '',
    });
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
  public resolve(type: string): SubagentDefinition | undefined {
    return this.definitions.get(type);
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
