import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { open as openFile, unlink as unlinkFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'path';
import type { ConfigPermissionMode } from './types.js';
import { logger } from '../utils/logger.js';

// ── Schema ──────────────────────────────────────────────────────────

/** Version 1 settings 结构中的权限段。 */
export interface PermissionSettings {
  defaultMode?: ConfigPermissionMode;
  allow?: PermissionRuleEntry[];
  ask?: PermissionRuleEntry[];
  deny?: PermissionRuleEntry[];
  /** 新会话可继承的明确额外目录。 */
  additionalDirectories?: string[];
}

/** 单条权限规则在 settings 中的持久化格式。 */
export interface PermissionRuleEntry {
  toolName: string;
  ruleContent?: string;
}

/** Version 1 settings 结构中的终端配置段。 */
export interface TerminalSettings {
  defaultShellFamily?: string;
}

/** Version 1 settings 结构中 Skill 学习与工具配置段。 */
export interface SkillSettings {
  /** 是否启用后台 Skill Review（主回复后异步复盘）。默认 true。 */
  backgroundReviewEnabled?: boolean;
  /** 累计多少次模型循环后触发一次后台 Review。默认 10。 */
  creationNudgeInterval?: number;
  /** 是否开启写入暂存批准模式。false 时直接写入，true 时暂存为 pending。默认 false。 */
  writeApproval?: boolean;
}

/** Version 1 settings 结构中 Curator 生命周期管理配置段。 */
export interface CuratorSettings {
  /** 是否启用 Curator 自动维护。默认 true。 */
  enabled?: boolean;
  /** 两次自动运行之间的最小间隔（小时）。默认 168（7天）。 */
  intervalHours?: number;
  /** 触发维护前距上次活动的最小空闲小时数。默认 2。 */
  minIdleHours?: number;
  /** 无活动多少天后标记为 stale。默认 30。 */
  staleAfterDays?: number;
  /** 无活动多少天后归档。默认 90。 */
  archiveAfterDays?: number;
  /** 是否启用 LLM umbrella 融合。默认 false。 */
  consolidate?: boolean;
  /** 备份配置。 */
  backup?: {
    /** 是否在变更前创建备份。默认 true。 */
    enabled?: boolean;
    /** 保留的备份数量。默认 5。 */
    keep?: number;
  };
}

/** Version 1 settings schema 的完整结构。 */
export interface SettingsDocumentV1 {
  /** schema 版本；缺失时空文档视为 version 1。 */
  version?: 1;
  /** 每次成功原子替换后单调递增的文档修订号。 */
  settingsRevision?: number;
  permission?: PermissionSettings;
  terminal?: TerminalSettings;
  /** Skill 学习与工具配置段。 */
  skills?: SkillSettings;
  /** Curator 生命周期管理配置段。 */
  curator?: CuratorSettings;
  /** 是否在会话启动时自动加载并投影长期记忆索引。 */
  autoMemoryEnabled?: boolean;
  /** 自定义长期记忆根；只有受信来源可以令其生效。 */
  autoMemoryDirectory?: string;
  /** 额外的未知字段将被保留但不保证语义。 */
  [key: string]: unknown;
}

/** 可写入 settings scope 的类型。 */
export type SettingsScope = 'user' | 'project' | 'local';

/** 已交付并允许从 settings 加载的权限模式。 */
const DELIVERED_PERMISSION_MODES = new Set<ConfigPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]);
/** 已移除且不得参与当前权限合成的顶层配置字段。 */
const LEGACY_TOP_LEVEL_PERMISSION_FIELDS = new Set([
  'workMode',
  'approvalPolicy',
  'approval',
  'whitelist',
  'toolWhitelist',
  ['temporary', 'Whitelist'].join(''),
  'autoClassifier',
]);
/** 已移除且不得参与当前 permission 段合成的字段。 */
const LEGACY_PERMISSION_FIELDS = new Set([
  'workMode',
  'approvalPolicy',
  'approval',
  'whitelist',
  'toolWhitelist',
  ['temporary', 'Whitelist'].join(''),
  'auto',
  'autoClassifier',
  'rules',
]);
/** 旧架构使用但当前 ToolCatalog 不存在的假想 PascalCase 工具身份。 */
const LEGACY_PASCAL_CASE_TOOL_NAMES = new Set([
  'Read',
  'Edit',
  'Write',
  'Create',
  'Delete',
  'Move',
  'Copy',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
]);

/**
 * 规范化某个 settings 来源中的权限模式。
 *
 * @param mode - 未经信任的持久化值
 * @param scope - 值所属的 settings 来源
 * @returns 可参与合并的模式；不可信 bypass 返回 undefined
 */
function normalizePermissionMode(
  mode: unknown,
  scope: SettingsScope | 'session',
): ConfigPermissionMode | undefined {
  if (mode === undefined) {
    return undefined;
  }
  if (mode === 'auto') {
    logger.warn(`[配置迁移] ${scope} settings 中的 Auto 尚未交付，已回退到 Manual。`);
    return 'default';
  }
  if ((scope === 'project' || scope === 'local') && mode === 'bypassPermissions') {
    logger.warn(`[权限配置] 已忽略 ${scope} settings 中不可信的 bypassPermissions。`);
    return undefined;
  }
  return typeof mode === 'string' && DELIVERED_PERMISSION_MODES.has(mode as ConfigPermissionMode)
    ? mode as ConfigPermissionMode
    : undefined;
}

/** 字段更新描述——只描述需要更新的字段，不涉及读改写外的元操作。 */
export interface SettingsFieldUpdate {
  /** 要更新的顶层字段路径，如 `permission.defaultMode`。 */
  field: string;
  /** 要设置的值。为 `undefined` 时表示删除该字段。 */
  value: unknown;
}

/** 在仓储串行临界区内执行的 settings 文档更新函数。 */
export type SettingsDocumentUpdater = (
  current: SettingsDocumentV1,
) => SettingsDocumentV1;

/** 一个 settings 文件在读取时的 CAS 身份。 */
export interface SettingsDocumentVersion {
  /** 文档内持久化的单调修订号。 */
  readonly revision: number;
  /** 原始文件字节的 SHA-256 摘要。 */
  readonly digest: string;
}

/** 带版本身份的 settings 文档快照。 */
export interface VersionedSettingsDocument {
  /** 当前解析后的完整文档。 */
  readonly document: SettingsDocumentV1;
  /** 当前 CAS 身份。 */
  readonly version: SettingsDocumentVersion;
}

/** CAS 更新的穷尽结果。 */
export type SettingsUpdateOutcome =
  | {
      readonly status: 'updated';
      readonly version: SettingsDocumentVersion;
    }
  | {
      readonly status: 'conflict';
      readonly currentVersion: SettingsDocumentVersion;
    }
  | {
      readonly status: 'failed';
      readonly reason: string;
    };

// ── Repository ──────────────────────────────────────────────────────

/**
 * SettingsRepository 构造选项。
 */
export interface SettingsRepositoryOptions {
  /**
   * 用户 settings 文件路径。默认由 `userSettingsDir` 与 `settings.json` 拼接。
   * 主要用于测试注入。
   */
  userSettingsPath?: string;
  /**
   * 项目 settings 文件路径。主要用于测试注入。
   */
  projectSettingsPath?: string;
  /**
   * 项目本机 settings 文件路径。主要用于测试注入。
   */
  projectLocalSettingsPath?: string;
}

/**
 * 统一 settings 文件仓储。
 *
 * 职责：
 * - 按用户 → 项目 → 项目本机 → 会话覆盖的优先级确定性合并有效配置。
 * - 提供指定 scope 的原始文档读取。
 * - 提供指定 scope 的字段级更新。
 * - 所有文件写入使用同目录唯一临时文件 + rename 原子替换。
 * - 单进程内串行执行同一目标文件的读改写。
 * - 跨进程使用同目录排他锁，并以 revision + digest 执行 CAS。
 * - 临时文件落盘后再原子替换，失败时保留原文件。
 */
export class SettingsRepository {
  private readonly userSettingsPath: string;
  private readonly projectSettingsPath: string;
  private readonly projectLocalSettingsPath: string;

  /** 每 scope 的写入串行队列，resolve 上一个操作后才启动下一个。 */
  private writeQueues = new Map<string, Promise<void>>();
  /** 同一仓储实例内已输出的去敏迁移告警，避免重复读取刷屏。 */
  private readonly emittedMigrationWarnings = new Set<string>();

  /**
   * @param userConfigDir - 用户配置目录（如 `~/.myagent`）
   * @param projectConfigDir - 项目配置目录（如 `<workspace>/.myagent`）
   * @param options - 可选构造选项
   */
  constructor(
    private readonly userConfigDir: string,
    private readonly projectConfigDir: string,
    options: SettingsRepositoryOptions = {},
  ) {
    this.userSettingsPath = options.userSettingsPath ?? resolve(userConfigDir, 'settings.json');
    this.projectSettingsPath = options.projectSettingsPath ?? resolve(projectConfigDir, 'settings.json');
    this.projectLocalSettingsPath = options.projectLocalSettingsPath ?? resolve(projectConfigDir, 'settings.local.json');
  }

  // ── 公开 API ────────────────────────────────────────────────────

  /**
   * 读取有效配置，按用户 → 项目 → 项目本机的优先级合并。
   * 标量字段按优先级选择最高值，数组字段替换而非拼接。
   * 缺失字段继承低优先级值；全部缺失时使用内建默认值。
   *
   * @returns 合并后的 SettingsDocumentV1
   */
  public readEffectiveConfig(sessionOverride: SettingsDocumentV1 = {}): SettingsDocumentV1 {
    const userDoc = this.sanitizeSettingsDocument(
      this.readDocumentSafe(this.userSettingsPath),
      'user',
    );
    const projectDoc = this.sanitizeSettingsDocument(
      this.readDocumentSafe(this.projectSettingsPath),
      'project',
    );
    const localDoc = this.sanitizeSettingsDocument(
      this.readDocumentSafe(this.projectLocalSettingsPath),
      'local',
    );
    const safeSessionOverride = this.sanitizeSettingsDocument(sessionOverride, 'session');

    return this.mergeConfigs(userDoc, projectDoc, localDoc, safeSessionOverride);
  }

  /**
   * 读取指定 scope 的原始文档内容。
   * 文件不存在或解析失败返回空文档。
   *
   * @param scope - 目标设置范围
   * @returns 该 scope 的设置文档对象
   */
  public readDocument(scope: SettingsScope): SettingsDocumentV1 {
    const filePath = this.getScopePath(scope);
    return this.sanitizeSettingsDocument(this.readDocumentSafe(filePath), scope);
  }

  /**
   * 读取指定 scope 的文档和 CAS 身份。
   *
   * @param scope - 目标设置范围
   * @returns 不共享可变引用的文档与 revision/digest
   */
  public readVersionedDocument(scope: SettingsScope): VersionedSettingsDocument {
    return this.readVersionedDocumentFromPath(this.getScopePath(scope), false);
  }

  /**
   * 更新指定 scope 的字段。读取目标 scope 的完整文档，
   * 只修改调用方指定的字段，通过同目录临时文件加 rename 原子替换。
   * 单进程内串行处理同一文件的写入。
   *
   * @param scope - 目标设置范围
   * @param update - 字段更新描述
   * @returns 更新成功时返回 true，写入或替换失败时返回 false
   *           （原文件不受影响）
   */
  public async updateField(scope: SettingsScope, update: SettingsFieldUpdate): Promise<boolean> {
    return this.updateDocument(scope, current => {
      this.applyFieldUpdate(current, update);
      return current;
    });
  }

  /**
   * 在同一 settings 文件的串行临界区内完成读取、变换与原子替换。
   * 调用方不得在进入队列前读取旧文档，否则并发更新可能发生丢失。
   *
   * @param scope - 目标设置范围
   * @param updater - 基于临界区内最新文档生成下一版本的纯同步函数
   * @returns 更新成功时返回 true
   */
  public async updateDocument(
    scope: SettingsScope,
    updater: SettingsDocumentUpdater,
  ): Promise<boolean> {
    const outcome = await this.enqueueUpdate(scope, undefined, updater);
    return outcome.status === 'updated';
  }

  /**
   * 仅当目标文档仍与调用者读取的 revision/digest 一致时更新。
   *
   * @param scope - 目标设置范围
   * @param expectedVersion - 调用者基于的文档身份
   * @param updater - 基于最新文档生成下一版本的同步函数
   * @returns updated、conflict 或 failed
   */
  public async updateDocumentCas(
    scope: SettingsScope,
    expectedVersion: SettingsDocumentVersion,
    updater: SettingsDocumentUpdater,
  ): Promise<SettingsUpdateOutcome> {
    return this.enqueueUpdate(scope, expectedVersion, updater);
  }

  /** 将一次更新加入进程内队列，再进入跨进程锁。 */
  private async enqueueUpdate(
    scope: SettingsScope,
    expectedVersion: SettingsDocumentVersion | undefined,
    updater: SettingsDocumentUpdater,
  ): Promise<SettingsUpdateOutcome> {
    const filePath = this.getScopePath(scope);
    const queueKey = filePath;

    // 串行化同一文件的写入
    const previous = this.writeQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.then(
      () => this.doUpdateDocument(filePath, expectedVersion, updater),
      () => this.doUpdateDocument(filePath, expectedVersion, updater),
    );
    this.writeQueues.set(queueKey, current.then(() => undefined, () => undefined));
    return current;
  }

  // ── 内部实现 ────────────────────────────────────────────────────

  /** 实际执行文档更新（已在串行队列中）。 */
  private async doUpdateDocument(
    filePath: string,
    expectedVersion: SettingsDocumentVersion | undefined,
    updater: SettingsDocumentUpdater,
  ): Promise<SettingsUpdateOutcome> {
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await this.acquireFileLock(filePath);
      const currentSnapshot = this.readVersionedDocumentFromPath(filePath, true);
      if (
        expectedVersion
        && (
          expectedVersion.revision !== currentSnapshot.version.revision
          || expectedVersion.digest !== currentSnapshot.version.digest
        )
      ) {
        return {
          status: 'conflict',
          currentVersion: currentSnapshot.version,
        };
      }
      const next = updater(currentSnapshot.document);
      if (typeof next !== 'object' || next === null) {
        throw new Error('settings updater 必须返回文档对象');
      }
      if (!next.version) {
        next.version = 1;
      }
      next.settingsRevision = currentSnapshot.version.revision + 1;
      this.writeDocument(filePath, next);
      return {
        status: 'updated',
        version: this.readVersionedDocumentFromPath(filePath, true).version,
      };
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await releaseLock?.();
    }
  }

  /** 将字段更新应用到文档对象。 */
  private applyFieldUpdate(document: SettingsDocumentV1, update: SettingsFieldUpdate): void {
    const parts = update.field.split('.');
    let current: Record<string, unknown> = document as unknown as Record<string, unknown>;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    const lastPart = parts[parts.length - 1];
    if (update.value === undefined) {
      delete current[lastPart];
    } else {
      current[lastPart] = update.value;
    }

    // 确保 version 字段存在
    if (!document.version) {
      document.version = 1;
    }
  }

  /**
   * 将运行时未知 JSON 收敛为当前 settings 契约。
   * 旧字符串/PascalCase 规则和 approval/whitelist 字段只输出去敏告警并忽略，
   * 不建立别名，也不删除原文件中的未知字段。
   */
  private sanitizeSettingsDocument(
    document: SettingsDocumentV1,
    scope: SettingsScope | 'session',
  ): SettingsDocumentV1 {
    const rawDocument = document as Record<string, unknown>;
    for (const field of LEGACY_TOP_LEVEL_PERMISSION_FIELDS) {
      if (field in rawDocument) {
        this.warnLegacyPermissionConfig(scope, 'legacy-field');
      }
    }

    const rawPermission = isRecord(rawDocument.permission)
      ? rawDocument.permission
      : undefined;
    if (rawDocument.permission !== undefined && !rawPermission) {
      this.warnLegacyPermissionConfig(scope, 'invalid-permission-section');
    }
    if (!rawPermission) {
      return {
        ...document,
        permission: undefined,
      };
    }

    for (const field of LEGACY_PERMISSION_FIELDS) {
      if (field in rawPermission) {
        this.warnLegacyPermissionConfig(scope, 'legacy-field');
      }
    }

    const permission: PermissionSettings = {
      defaultMode: rawPermission.defaultMode as ConfigPermissionMode | undefined,
      allow: this.sanitizePermissionRuleEntries(rawPermission.allow, scope),
      ask: this.sanitizePermissionRuleEntries(rawPermission.ask, scope),
      deny: this.sanitizePermissionRuleEntries(rawPermission.deny, scope),
      additionalDirectories: Array.isArray(rawPermission.additionalDirectories)
        ? rawPermission.additionalDirectories.filter(
          (directory): directory is string =>
            typeof directory === 'string' && directory.trim().length > 0,
        )
        : undefined,
    };
    return {
      ...document,
      permission,
    };
  }

  /** 过滤旧字符串规则和已知假想 PascalCase 工具身份。 */
  private sanitizePermissionRuleEntries(
    value: unknown,
    scope: SettingsScope | 'session',
  ): PermissionRuleEntry[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.warnLegacyPermissionConfig(scope, 'invalid-rule-list');
      return [];
    }

    const rules: PermissionRuleEntry[] = [];
    for (const candidate of value) {
      if (typeof candidate === 'string') {
        this.warnLegacyPermissionConfig(scope, 'legacy-string-rule');
        continue;
      }
      if (
        !isRecord(candidate)
        || typeof candidate.toolName !== 'string'
        || candidate.toolName.trim().length === 0
        || (candidate.ruleContent !== undefined
          && typeof candidate.ruleContent !== 'string')
      ) {
        this.warnLegacyPermissionConfig(scope, 'invalid-rule-entry');
        continue;
      }
      if (LEGACY_PASCAL_CASE_TOOL_NAMES.has(candidate.toolName)) {
        this.warnLegacyPermissionConfig(scope, 'legacy-pascal-rule');
        continue;
      }
      rules.push({
        toolName: candidate.toolName,
        ...(typeof candidate.ruleContent === 'string'
          ? { ruleContent: candidate.ruleContent }
          : {}),
      });
    }
    return rules;
  }

  /** 输出一次不含原始规则、路径或命令内容的可操作迁移告警。 */
  private warnLegacyPermissionConfig(
    scope: SettingsScope | 'session',
    code: string,
  ): void {
    const key = `${scope}:${code}`;
    if (this.emittedMigrationWarnings.has(key)) {
      return;
    }
    this.emittedMigrationWarnings.add(key);
    logger.warn(
      `[配置迁移] 已忽略 ${scope} settings 中的旧权限配置；`
      + '请使用 /permissions 按真实 runtime tool 名重新建立规则。',
      {
        component: 'settings_repository',
        event: 'legacy_permission_config_ignored',
        scope,
        code,
      },
    );
  }

  /** 合并用户、项目、项目本机三层配置，严格按优先级覆盖。 */
  private mergeConfigs(
    user: SettingsDocumentV1,
    project: SettingsDocumentV1,
    local: SettingsDocumentV1,
    session: SettingsDocumentV1,
  ): SettingsDocumentV1 {
    const result: SettingsDocumentV1 = {
      version: session.version ?? local.version ?? project.version ?? user.version ?? 1,
    };

    // permission 段：session > local > project > user > 默认。
    // 仓库可提交的 project scope 不得静默启用 bypassPermissions。
    const userPerm = user.permission ?? {};
    const projectPerm = project.permission ?? {};
    const localPerm = local.permission ?? {};
    const sessionPerm = session.permission ?? {};
    // 每层先独立校验，避免低信任配置扩权或旧 Auto 重新进入生产状态。
    const safeUserMode = normalizePermissionMode(userPerm.defaultMode, 'user');
    const safeProjectMode = normalizePermissionMode(projectPerm.defaultMode, 'project');
    const safeLocalMode = normalizePermissionMode(localPerm.defaultMode, 'local');
    const safeSessionMode = normalizePermissionMode(sessionPerm.defaultMode, 'session');
    result.permission = {
      defaultMode: safeSessionMode
        ?? safeLocalMode
        ?? safeProjectMode
        ?? safeUserMode
        ?? 'default',
      allow: sessionPerm.allow ?? localPerm.allow ?? projectPerm.allow ?? userPerm.allow ?? [],
      ask: sessionPerm.ask ?? localPerm.ask ?? projectPerm.ask ?? userPerm.ask ?? [],
      deny: sessionPerm.deny ?? localPerm.deny ?? projectPerm.deny ?? userPerm.deny ?? [],
      additionalDirectories: sessionPerm.additionalDirectories
        ?? localPerm.additionalDirectories
        ?? projectPerm.additionalDirectories
        ?? userPerm.additionalDirectories
        ?? [],
    };

    // terminal 段：session > local > project > user > 默认
    const userTerm = user.terminal ?? {};
    const projectTerm = project.terminal ?? {};
    const localTerm = local.terminal ?? {};
    const sessionTerm = session.terminal ?? {};
    result.terminal = {
      defaultShellFamily: sessionTerm.defaultShellFamily
        ?? localTerm.defaultShellFamily
        ?? projectTerm.defaultShellFamily
        ?? userTerm.defaultShellFamily
        ?? 'auto',
    };

    // skills 段：session > local > project > user > 默认。
    // 各字段按优先级逐字段合并；非法高优先级值被忽略，继续寻找较低层合法值。
    const userSkills = user.skills ?? {};
    const projectSkills = project.skills ?? {};
    const localSkills = local.skills ?? {};
    const sessionSkills = session.skills ?? {};
    result.skills = {
      backgroundReviewEnabled: selectBooleanSetting(
        [
          sessionSkills.backgroundReviewEnabled,
          localSkills.backgroundReviewEnabled,
          projectSkills.backgroundReviewEnabled,
          userSkills.backgroundReviewEnabled,
        ],
        true,
        'skills.backgroundReviewEnabled',
      ),
      creationNudgeInterval: selectPositiveIntegerSetting(
        [
          sessionSkills.creationNudgeInterval,
          localSkills.creationNudgeInterval,
          projectSkills.creationNudgeInterval,
          userSkills.creationNudgeInterval,
        ],
        10,
        'skills.creationNudgeInterval',
      ),
      writeApproval: selectBooleanSetting(
        [
          sessionSkills.writeApproval,
          localSkills.writeApproval,
          projectSkills.writeApproval,
          userSkills.writeApproval,
        ],
        false,
        'skills.writeApproval',
      ),
    };

    // curator 段：session > local > project > user > 默认。
    const userCurator = user.curator ?? {};
    const projectCurator = project.curator ?? {};
    const localCurator = local.curator ?? {};
    const sessionCurator = session.curator ?? {};
    const userBackup = userCurator.backup ?? {};
    const projectBackup = projectCurator.backup ?? {};
    const localBackup = localCurator.backup ?? {};
    const sessionBackup = sessionCurator.backup ?? {};
    result.curator = {
      enabled: selectBooleanSetting(
        [
          sessionCurator.enabled,
          localCurator.enabled,
          projectCurator.enabled,
          userCurator.enabled,
        ],
        true,
        'curator.enabled',
      ),
      intervalHours: selectPositiveIntegerSetting(
        [
          sessionCurator.intervalHours,
          localCurator.intervalHours,
          projectCurator.intervalHours,
          userCurator.intervalHours,
        ],
        168,
        'curator.intervalHours',
      ),
      minIdleHours: selectPositiveIntegerSetting(
        [
          sessionCurator.minIdleHours,
          localCurator.minIdleHours,
          projectCurator.minIdleHours,
          userCurator.minIdleHours,
        ],
        2,
        'curator.minIdleHours',
      ),
      staleAfterDays: selectPositiveIntegerSetting(
        [
          sessionCurator.staleAfterDays,
          localCurator.staleAfterDays,
          projectCurator.staleAfterDays,
          userCurator.staleAfterDays,
        ],
        30,
        'curator.staleAfterDays',
      ),
      archiveAfterDays: selectPositiveIntegerSetting(
        [
          sessionCurator.archiveAfterDays,
          localCurator.archiveAfterDays,
          projectCurator.archiveAfterDays,
          userCurator.archiveAfterDays,
        ],
        90,
        'curator.archiveAfterDays',
      ),
      consolidate: selectBooleanSetting(
        [
          sessionCurator.consolidate,
          localCurator.consolidate,
          projectCurator.consolidate,
          userCurator.consolidate,
        ],
        false,
        'curator.consolidate',
      ),
      backup: {
        enabled: selectBooleanSetting(
          [
            sessionBackup.enabled,
            localBackup.enabled,
            projectBackup.enabled,
            userBackup.enabled,
          ],
          true,
          'curator.backup.enabled',
        ),
        keep: selectPositiveIntegerSetting(
          [
            sessionBackup.keep,
            localBackup.keep,
            projectBackup.keep,
            userBackup.keep,
          ],
          5,
          'curator.backup.keep',
        ),
      },
    };

    // 校验 curator 阈值有效性：staleAfterDays 必须小于 archiveAfterDays。
    const curatorOut = result.curator!;
    if (curatorOut.staleAfterDays! >= curatorOut.archiveAfterDays!) {
      logger.warn('[配置] curator.staleAfterDays 必须小于 archiveAfterDays，已回退到默认值。', {
        component: 'settings_repository',
        event: 'curator_threshold_invalid',
      });
      curatorOut.staleAfterDays = 30;
      curatorOut.archiveAfterDays = 90;
    }

    // Auto Memory 开关可由普通 settings 收紧或开启；自定义目录只能来自受信 session/user。
    result.autoMemoryEnabled = session.autoMemoryEnabled
      ?? local.autoMemoryEnabled
      ?? project.autoMemoryEnabled
      ?? user.autoMemoryEnabled
      ?? true;
    result.autoMemoryDirectory = session.autoMemoryDirectory
      ?? user.autoMemoryDirectory;

    return result;
  }

  /** 安全读取 JSON 文档，解析失败时返回空文档。 */
  private readDocumentSafe(filePath: string): SettingsDocumentV1 {
    try {
      if (!existsSync(filePath)) {
        return {};
      }
      const content = readFileSync(filePath, 'utf-8').trim();
      if (!content) {
        return {};
      }
      const parsed = JSON.parse(content) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return {};
      }
      return parsed as SettingsDocumentV1;
    } catch {
      return {};
    }
  }

  /** 读取文件原始字节、解析文档并生成 revision/digest。 */
  private readVersionedDocumentFromPath(
    filePath: string,
    strict: boolean,
  ): VersionedSettingsDocument {
    if (!existsSync(filePath)) {
      return {
        document: {},
        version: { revision: 0, digest: digestSettingsContent('') },
      };
    }
    try {
      const content = readFileSync(filePath, 'utf-8');
      const trimmed = content.trim();
      if (!trimmed) {
        return {
          document: {},
          version: { revision: 0, digest: digestSettingsContent(content) },
        };
      }
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('settings 根节点必须是 JSON 对象');
      }
      const document = parsed as SettingsDocumentV1;
      const revision = Number.isSafeInteger(document.settingsRevision)
        && (document.settingsRevision ?? 0) >= 0
        ? document.settingsRevision!
        : 0;
      return {
        document,
        version: {
          revision,
          digest: digestSettingsContent(content),
        },
      };
    } catch (error) {
      if (strict) {
        throw new Error(
          `settings 文件无法安全更新: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return {
        document: {},
        version: { revision: 0, digest: digestSettingsContent('') },
      };
    }
  }

  /** 通过同目录唯一临时文件加 rename 原子写入文档。 */
  private writeDocument(filePath: string, document: SettingsDocumentV1): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(tmpPath, 'wx');
      writeFileSync(fileDescriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(tmpPath, filePath);
    } finally {
      if (fileDescriptor !== undefined) {
        try {
          closeSync(fileDescriptor);
        } catch {
          // 文件描述符清理失败不得掩盖原始写入错误。
        }
      }
      // 清理可能残留的临时文件
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // 清理失败不抛异常
      }
    }
  }

  /** 获取同目录排他锁；陈旧锁会在安全窗口后回收。 */
  private async acquireFileLock(filePath: string): Promise<() => Promise<void>> {
    const lockPath = `${filePath}.lock`;
    mkdirSync(dirname(filePath), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const handle = await openFile(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
          }));
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlinkFile(lockPath).catch(() => undefined);
          throw error;
        }
        return async () => {
          await handle.close();
          try {
            await unlinkFile(lockPath);
          } catch {
            // 锁文件已被外部清理时无需二次失败。
          }
        };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : undefined;
        if (code !== 'EEXIST') {
          throw error;
        }
        if (this.isStaleLock(lockPath)) {
          try {
            unlinkSync(lockPath);
            continue;
          } catch {
            // 其他进程可能已接管清理，继续正常等待。
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`等待 settings 排他锁超时: ${lockPath}`, {
            cause: error,
          });
        }
        await new Promise<void>(resolveWait => setTimeout(resolveWait, 10));
      }
    }
  }

  /** 判断锁文件是否超过崩溃恢复窗口。 */
  private isStaleLock(lockPath: string): boolean {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > 30_000;
    } catch {
      return false;
    }
  }

  /** 根据 scope 返回对应文件路径。 */
  private getScopePath(scope: SettingsScope): string {
    switch (scope) {
      case 'user':
        return this.userSettingsPath;
      case 'project':
        return this.projectSettingsPath;
      case 'local':
        return this.projectLocalSettingsPath;
    }
  }
}

/** 计算 settings 原始字节的稳定 SHA-256 摘要。 */
function digestSettingsContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 判断未知 JSON 值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 按 settings 优先级选择首个合法布尔值。
 * 非法高优先级值只产生去敏诊断，不得遮蔽较低层的合法配置。
 */
function selectBooleanSetting(
  values: readonly unknown[],
  defaultValue: boolean,
  field: string,
): boolean {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    warnInvalidSkillSetting(field);
  }
  return defaultValue;
}

/**
 * 按 settings 优先级选择首个合法正整数。
 * 非法高优先级值只产生去敏诊断，不得遮蔽较低层的合法配置。
 */
function selectPositiveIntegerSetting(
  values: readonly unknown[],
  defaultValue: number,
  field: string,
): number {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }
    warnInvalidSkillSetting(field);
  }
  return defaultValue;
}

/** 记录不包含原始配置值的 Skill/Curator 配置告警。 */
function warnInvalidSkillSetting(field: string): void {
  logger.warn('[配置] Skill/Curator settings 字段类型或范围非法，已忽略。', {
    component: 'settings_repository',
    event: 'skill_setting_invalid',
    field,
  });
}
