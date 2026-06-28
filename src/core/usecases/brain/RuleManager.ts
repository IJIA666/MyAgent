import { join } from 'path';
import { existsSync, watch } from 'fs';
import { SessionContext } from '../../domain/context.js';
import { logger } from '../../../utils/logger.js'; // 导入统一日志单例 logger
import {
  readAndLimitFile,
  scanSkills,
  readSkillContent,
  SkillMetadata
} from './contextLoader.js';

/**
 * 负责全局规则、局部项目规则和技能列表的实例级热加载与生命周期管理。
 */
export class RuleManager {
  /** 缓存的全局规则内容 */
  private cachedGlobalRules: string | null = null;
  /** 缓存的局部项目规则内容 */
  private cachedLocalRules: string | null = null;
  /** 实例级私有技能缓存 */
  private skillsCache = new Map<string, SkillMetadata>();
  /** 监听状态标识 */
  private isWatching = false;

  /**
   * 实例初始化，并首次将规则和技能加载到缓存中。
   *
   * @param context - 会话上下文管理实例
   */
  constructor(private context: SessionContext) {
    const workspacePath = this.context.appConfig?.workspace || process.cwd();
    this.loadRulesToCache(workspacePath);
    this.refreshSkillsCache(workspacePath);
    
    // 初始化时直接刷入完整的规则和技能列表，保证系统 Prompt 数据同步
    this.context.updateSystemPrompt(
      this.cachedGlobalRules || undefined,
      this.cachedLocalRules || undefined,
      this.getSkills()
    );
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
   * 极速获取当前实例已缓存的技能列表，支持惰性初始化 Watcher。
   * 
   * @returns 技能元数据数组
   */
  public getSkills(): SkillMetadata[] {
    const workspacePath = this.context.appConfig?.workspace || process.cwd();
    if (!this.isWatching) {
      this.initSkillsWatcher(workspacePath);
    }
    return Array.from(this.skillsCache.values());
  }

  /**
   * 惰性获取指定技能的完整 Markdown 内容。
   * 
   * @param name - 技能名称
   * @returns 技能正文内容，找不到则返回 null
   */
  public getSkillContent(name: string): string | null {
    const meta = this.skillsCache.get(name);
    if (!meta) return null;
    return readSkillContent(meta.filePath);
  }

  /**
   * 初始化实例级技能文件变更监听服务
   */
  private initSkillsWatcher(workspacePath: string): void {
    if (this.isWatching) return;
    this.refreshSkillsCache(workspacePath);
    
    try {
      const skillsDir = join(workspacePath, '.agent/skills');
      if (existsSync(skillsDir)) {
        watch(skillsDir, { recursive: true }, () => {
          logger.info('[RuleManager] 检测到技能文件变动，正在自动刷新缓存...');
          this.refreshSkillsCache(workspacePath);
          this.reloadRules();
        });
        this.isWatching = true;
      }
    } catch (e) {
      logger.warn(`[RuleManager] 技能监听初始化失败: ${e}`);
    }
  }

  /**
   * 刷新当前实例的技能索引缓存
   */
  private refreshSkillsCache(workspacePath: string): void {
    this.skillsCache.clear();
    try {
      const list = scanSkills(workspacePath);
      for (const item of list) {
        this.skillsCache.set(item.name, item);
      }
    } catch (e) {
      logger.warn(`[RuleManager] 刷新技能缓存失败: ${e}`);
    }
  }

  /**
   * 将规则文件探测并加载锁定至内存缓存中，统一路径约定。
   */
  private loadRulesToCache(workspacePath: string): void {
    // 1. 加载全局级规则
    try {
      const globalRulesPath = join(workspacePath, '.agent/global_rules.md');
      if (existsSync(globalRulesPath)) {
        this.cachedGlobalRules = readAndLimitFile(globalRulesPath);
      } else {
        this.cachedGlobalRules = '';
      }
    } catch (e) {
      logger.warn(`[RuleManager] 读取全局规则失败: ${e}`);
      this.cachedGlobalRules = '';
    }

    // 2. 自动探测并加载局部项目规则 (.agent/rules/guize.md)
    try {
      const localRulesPath = join(workspacePath, '.agent/rules/guize.md');
      if (existsSync(localRulesPath)) {
        this.cachedLocalRules = readAndLimitFile(localRulesPath);
        logger.info(`[RuleManager] 已探测并锁定局部规则文件: ${localRulesPath}`);
      } else {
        this.cachedLocalRules = '';
      }
    } catch (e) {
      logger.warn(`[RuleManager] 探测局部规则文件失败: ${e}`);
      this.cachedLocalRules = '';
    }
  }

  /**
   * 清除全局与局部规则的内存缓存，并重新从磁盘中加载。
   * 会在下一轮交互时强制生效最新的规则与技能内容。
   */
  public reloadRules(): void {
    logger.info('[RuleManager] 正在重载规则与技能文件...');
    const workspacePath = this.context.appConfig?.workspace || process.cwd();
    this.loadRulesToCache(workspacePath);
    this.refreshSkillsCache(workspacePath);
    
    // 更新系统提示词，支持技能与规则的热重载同步
    this.context.updateSystemPrompt(
      this.cachedGlobalRules || undefined,
      this.cachedLocalRules || undefined,
      this.getSkills()
    );
  }
}
