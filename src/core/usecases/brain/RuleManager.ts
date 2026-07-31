import { resolve } from 'path';
import { existsSync, watch, type FSWatcher } from 'fs';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { SessionContext } from '../../domain/context.js';
import { logger } from '../../../utils/logger.js';
import {
  loadUserRules,
  loadProjectRules,
  scanSkills,
  readSkillContent,
  SkillMetadata,
} from './contextLoader.js';
import type { SkillLibrary } from './skill-library.js';

/**
 * RuleManager 构造选项。
 */
export interface RuleManagerOptions {
  /** 是否启用技能文件变更监听，默认 true（主会话启用，短生命周期实例禁用） */
  enableWatcher?: boolean;
}

/** 技能文件路径比较器，用于检测真实内容变化。 */
type ContentHash = string;

/** 计算文件内容的 SHA-256 摘要。 */
function computeFileHash(filePath: string): ContentHash | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/** 判断事件文件名是否属于候选 SKILL.md（相对路径模式）。 */
function isSkillCandidate(eventType: string, filename: string | null): boolean {
  if (!filename) return false;
  // filename 被视为 watcher 根下的相对路径
  const normalized = filename.replace(/\\/g, '/');
  // 拒绝绝对路径（某些平台可能在 filename 中返回完整路径）
  if (normalized.startsWith('/') || normalized.match(/^[a-zA-Z]:[\\/]/)) return false;
  // 拒绝 .. 越界
  if (normalized.includes('..')) return false;
  // 只接受 basename 为 SKILL.md（不检查目录前缀）
  const basename = normalized.split('/').pop() || '';
  return basename === 'SKILL.md';
}

/**
 * 负责全局规则、局部项目规则和技能列表的实例级热加载与生命周期管理。
 */
export class RuleManager {
  /** 缓存的用户规则内容 */
  private cachedUserRules: string | null = null;
  /** 缓存的项目规则内容 */
  private cachedProjectRules: string | null = null;
  /** 实例级私有技能缓存 */
  private skillsCache = new Map<string, SkillMetadata>();
  /** 监听状态标识 */
  private isWatching = false;
  /** 防抖定时器句柄 */
  private watchDebounceTimer: NodeJS.Timeout | null = null;
  /** 保存的 FSWatcher 句柄 */
  private watcher: FSWatcher | null = null;
  /** 候选技能主体路径集合（防抖期内暂存变更候选） */
  private candidateSkillPaths = new Set<string>();
  /** 当前技能内容摘要映射（path → hash），用于检测真实内容变化 */
  private skillContentHashes = new Map<string, ContentHash>();
  /** 是否启用 watcher */
  private enableWatcher: boolean;
  /** 是否已关闭 */
  private closed = false;
  /** 用户 skills 目录（用于全量重扫）。 */
  private readonly userSkillsDir: string;
  /** 项目 skills 目录（watcher 监听此目录）。 */
  private readonly projectSkillsDir: string;
  /** 可选的共享 SkillLibrary，提供统一扫描视图。 */
  private readonly skillLibrary?: SkillLibrary;
  /** SkillLibrary 变更订阅取消函数。 */
  private skillLibraryUnsubscribe?: () => void;

  /**
   * @param context - 会话上下文管理实例
   * @param userRulesDir - 用户 rules 目录绝对路径
   * @param projectRulesDir - 项目 rules 目录绝对路径
   * @param userSkillsDir - 用户 skills 目录绝对路径
   * @param projectSkillsDir - 项目 skills 目录绝对路径
   * @param options - 可选构造选项
   * @param skillLibrary - 可选的共享 SkillLibrary 实例
   */
  constructor(
    private context: SessionContext,
    private userRulesDir: string,
    private projectRulesDir: string,
    userSkillsDir: string,
    projectSkillsDir: string,
    options?: RuleManagerOptions,
    skillLibrary?: SkillLibrary,
  ) {
    this.enableWatcher = options?.enableWatcher ?? true;
    this.userSkillsDir = userSkillsDir;
    this.projectSkillsDir = projectSkillsDir;
    this.skillLibrary = skillLibrary;
    this.loadRulesToCache();
    this.refreshSkillsCache();

    this.context.updateSystemPrompt(
      this.cachedUserRules || undefined,
      this.cachedProjectRules || undefined,
      this.getSkills()
    );

    // 订阅 SkillLibrary 的变更通知（当 SkillLibrary 提供时）
    if (skillLibrary) {
      this.skillLibraryUnsubscribe = skillLibrary.subscribe(() => {
        if (this.closed) return;
        // 收到变更通知后刷新缓存并更新上下文
        this.refreshSkillsCache();
        this.context.updateSystemPrompt(
          this.cachedUserRules || undefined,
          this.cachedProjectRules || undefined,
          this.getSkills()
        );
      });
    }
  }

  /**
   * 获取缓存的用户规则内容。
   *
   * @returns 用户规则字符串，若无则返回 null
   */
  public getUserRules(): string | null {
    return this.cachedUserRules;
  }

  /**
   * 获取缓存的项目规则内容。
   *
   * @returns 项目规则字符串，若无则返回 null
   */
  public getProjectRules(): string | null {
    return this.cachedProjectRules;
  }

  /**
   * 极速获取当前实例已缓存的技能列表。
   *
   * @returns 技能元数据数组
   */
  public getSkills(): SkillMetadata[] {
    if (!this.isWatching && this.enableWatcher && !this.closed) {
      this.initSkillsWatcher();
    }
    return Array.from(this.skillsCache.values());
  }

  /**
   * 惰性获取指定技能的完整 Markdown 内容。
   * 当注入 SkillLibrary 时复用其正文读取逻辑。
   *
   * @param name - 技能名称
   * @returns 技能正文内容，找不到则返回 null
   */
  public getSkillContent(name: string): string | null {
    const meta = this.skillsCache.get(name);
    if (!meta) return null;
    if (this.skillLibrary) {
      return this.skillLibrary.read(name);
    }
    return readSkillContent(meta.filePath);
  }

  /**
   * 手动重载缓存（包括 skills）。
   * 当注入 SkillLibrary 时调用其 reloadSkills() 刷新扫描视图，
   * 否则自行重新扫描。
   */
  public reloadSkills(): void {
    if (this.skillLibrary) {
      this.skillLibrary.reloadSkills();
    }
    this.refreshSkillsCache();
    this.context.updateSystemPrompt(
      this.cachedUserRules || undefined,
      this.cachedProjectRules || undefined,
      this.getSkills()
    );
  }

  /**
   * 初始化实例级技能文件变更监听服务。
   * 只监听项目 skills 目录，使用相对路径过滤；
   * `filename` 缺失时在同一防抖窗口安排一次全量摘要重扫。
   */
  private initSkillsWatcher(): void {
    if (this.isWatching || !this.enableWatcher) return;
    this.precomputeSkillHashes();

    try {
      if (existsSync(this.projectSkillsDir)) {
        this.watcher = watch(this.projectSkillsDir, { recursive: true }, (eventType, filename) => {
          if (this.closed) return;

          if (filename === null) {
            // filename 缺失：在当前防抖窗口安排全量摘要重扫
            this.candidateSkillPaths.clear();
          } else if (isSkillCandidate(eventType, filename)) {
            const fullPath = resolve(this.projectSkillsDir, filename);
            this.candidateSkillPaths.add(fullPath);
          }

          // 防抖合并：100ms 内多次变更只触发一次重扫
          clearTimeout(this.watchDebounceTimer ?? undefined);
          this.watchDebounceTimer = setTimeout(() => {
            if (this.closed) return;
            this.processSkillChanges();
          }, 100);
        });
        this.isWatching = true;
      }
    } catch (e) {
      logger.warn(`[RuleManager] 技能监听初始化失败: ${e}`);
    }
  }

  /**
   * 预先计算所有技能的当前内容摘要。
   */
  private precomputeSkillHashes(): void {
    this.skillContentHashes.clear();
    try {
      let list: SkillMetadata[];
      if (this.skillLibrary) {
        list = this.skillLibrary.list().map(item => ({
          name: item.name,
          description: item.description,
          filePath: item.filePath,
        }));
      } else {
        list = scanSkills(this.userSkillsDir, this.projectSkillsDir);
      }
      for (const item of list) {
        const hash = computeFileHash(item.filePath);
        if (hash) this.skillContentHashes.set(item.filePath, hash);
      }
    } catch {
      // 静默
    }
  }

  /**
   * 防抖到期后统一处理技能变更：重新扫描元数据、比较内容摘要，仅在有差异时更新缓存。
   */
  private processSkillChanges(): void {
    if (this.closed) return;

    // 扫描当前技能元数据
    let currentList: SkillMetadata[];
    try {
      if (this.skillLibrary) {
        currentList = this.skillLibrary.list().map(item => ({
          name: item.name,
          description: item.description,
          filePath: item.filePath,
        }));
      } else {
        currentList = scanSkills(this.userSkillsDir, this.projectSkillsDir);
      }
    } catch {
      return;
    }

    // 计算新摘要并与旧摘要比较
    const newHashes = new Map<string, ContentHash>();
    for (const item of currentList) {
      const hash = computeFileHash(item.filePath);
      if (hash) newHashes.set(item.filePath, hash);
    }

    let hasChanges = false;
    // 检查新增/修改
    for (const [path, hash] of newHashes) {
      const oldHash = this.skillContentHashes.get(path);
      if (oldHash !== hash) { hasChanges = true; break; }
    }
    // 检查删除
    if (!hasChanges) {
      for (const path of this.skillContentHashes.keys()) {
        if (!newHashes.has(path)) { hasChanges = true; break; }
      }
    }

    // 无差异时只清空候选状态，不调用 updateSystemPrompt
    this.candidateSkillPaths.clear();
    if (!hasChanges) {
      logger.debug('[RuleManager] 技能候选事件无内容差异，跳过刷新。', {
        component: 'rule_manager',
        event: 'skill_watch_no_change',
      });
      return;
    }

    // 有真实变化：原子替换缓存
    logger.info('[RuleManager] 检测到技能文件真实变化，正在刷新缓存...');
    this.refreshSkillsCache();
    this.skillContentHashes = newHashes;

    this.context.updateSystemPrompt(
      this.cachedUserRules || undefined,
      this.cachedProjectRules || undefined,
      this.getSkills()
    );
  }

  /**
   * 刷新当前实例的技能索引缓存（原子替换）。
   * 当注入 SkillLibrary 时复用其统一扫描视图，否则回退到 contextLoader 的独立扫描。
   */
  private refreshSkillsCache(): void {
    const newCache = new Map<string, SkillMetadata>();
    try {
      if (this.skillLibrary) {
        const list = this.skillLibrary.list();
        for (const item of list) {
          newCache.set(item.name, {
            name: item.name,
            description: item.description,
            filePath: item.filePath,
          });
        }
      } else {
        // 回退到独立扫描（测试场景）
        const list = scanSkills(this.userSkillsDir, this.projectSkillsDir);
        for (const item of list) {
          newCache.set(item.name, item);
        }
      }
    } catch (e) {
      logger.warn(`[RuleManager] 刷新技能缓存失败: ${e}`);
    }
    // 原子替换
    this.skillsCache = newCache;
  }

  /**
   * 从注入的规则目录加载规则到缓存。
   * 用户规则先加载，项目规则后加载。
   */
  private loadRulesToCache(): void {
    try {
      this.cachedUserRules = loadUserRules(this.userRulesDir);
    } catch (e) {
      logger.warn(`[RuleManager] 读取用户规则失败: ${e}`);
      this.cachedUserRules = '';
    }

    try {
      this.cachedProjectRules = loadProjectRules(this.projectRulesDir);
    } catch (e) {
      logger.warn(`[RuleManager] 读取项目规则失败: ${e}`);
      this.cachedProjectRules = '';
    }
  }

  /**
   * 手动重载规则和技能（完整读盘）。
   * 与 watcher 增量刷新分开实现，避免一次事件触发两次刷新。
   */
  public reloadRules(): void {
    logger.info('[RuleManager] 正在重载规则与技能文件...');
    this.loadRulesToCache();
    this.refreshSkillsCache();

    this.context.updateSystemPrompt(
      this.cachedUserRules || undefined,
      this.cachedProjectRules || undefined,
      this.getSkills()
    );
  }

  /**
   * 幂等地关闭 RuleManager：清理 timer、关闭 watcher、清空候选集。
   * 关闭后阻止 watcher 回调更新上下文。
   * 关闭异常只能记录诊断，不得阻塞会话关闭。
   */
  public close(): void {
    if (this.closed) return;
    this.closed = true;

    try {
      if (this.watchDebounceTimer) {
        clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = null;
      }
      if (this.watcher) {
        this.watcher.close();
        this.watcher = null;
      }
      // 取消 SkillLibrary 订阅
      if (this.skillLibraryUnsubscribe) {
        this.skillLibraryUnsubscribe();
        this.skillLibraryUnsubscribe = undefined;
      }
      this.candidateSkillPaths.clear();
      this.isWatching = false;
      logger.debug('[RuleManager] 已关闭 watcher 和清理资源。', {
        component: 'rule_manager',
        event: 'skill_watcher_closed',
      });
    } catch (e) {
      logger.warn(`[RuleManager] 关闭异常: ${e}`);
    }
  }
}
