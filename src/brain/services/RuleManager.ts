import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { SessionContext } from '../context.js';

/**
 * 负责全局规则与局部项目规则的热加载和缓存管理。
 */
export class RuleManager {
  /** 缓存的全局规则内容 */
  private cachedGlobalRules: string | null = null;
  /** 缓存的局部项目规则内容 */
  private cachedLocalRules: string | null = null;

  /**
   * 实例初始化，并首次将规则加载到缓存中。
   *
   * @param context - 会话上下文管理实例
   */
  constructor(private context: SessionContext) {
    this.loadRulesToCache();
    this.context.updateSystemPrompt(this.cachedGlobalRules || undefined);
  }

  /**
   * 获取缓存的全局规则内容。
   *
   * @returns 全局规则字符串，若无则返回 null
   */
  public getGlobalRules(): string | null {
    return this.cachedGlobalRules;
  }

  /**
   * 获取缓存的局部项目规则内容。
   *
   * @returns 局部项目规则字符串，若无则返回 null
   */
  public getLocalRules(): string | null {
    return this.cachedLocalRules;
  }

  /**
   * 将规则文件探测并加载锁定至内存缓存中，防止哈希抖动。
   */
  private loadRulesToCache(): void {
    // 1. 加载全局级规则
    try {
      const globalRulesPath = join(process.cwd(), '.agent/global_rules.md');
      if (existsSync(globalRulesPath)) {
        this.cachedGlobalRules = readFileSync(globalRulesPath, 'utf-8').trim();
      } else {
        this.cachedGlobalRules = '';
      }
    } catch (e) {
      console.warn(`[RuleManager] 读取全局规则失败: ${e}`);
      this.cachedGlobalRules = '';
    }

    // 2. 自动探测并加载局部项目规则 (.myagent.md)
    try {
      const localRulesPath = join(process.cwd(), '.myagent.md');
      if (existsSync(localRulesPath)) {
        this.cachedLocalRules = readFileSync(localRulesPath, 'utf-8').trim();
        console.log(`[RuleManager] 已探测并锁定局部规则文件: ${localRulesPath}`);
      } else {
        this.cachedLocalRules = '';
      }
    } catch (e) {
      console.warn(`[RuleManager] 探测局部规则文件失败: ${e}`);
      this.cachedLocalRules = '';
    }
  }

  /**
   * 清除全局与局部规则的内存缓存，并重新从磁盘中加载。
   * 会在下一轮交互时强制生效最新的规则内容。
   */
  public reloadRules(): void {
    console.log('[RuleManager] 正在重载规则文件...');
    this.loadRulesToCache();
    this.context.updateSystemPrompt(this.cachedGlobalRules || undefined);
  }
}
