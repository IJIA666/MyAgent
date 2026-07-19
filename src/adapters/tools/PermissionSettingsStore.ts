import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionUpdate,
} from '../../core/domain/permissions/permission-types.js';
import { PermissionRuleStore } from '../../core/domain/permissions/rule-store.js';
import { logger } from '../../utils/logger.js';

/** 磁盘中不重复保存来源与行为的规则值。 */
interface StoredPermissionRule {
  /** 工具名称。 */
  toolName: string;
  /** 可选的命令、路径或其它规则限定内容。 */
  ruleContent?: string;
}

/** MyAgent 权限设置文件中的权限段。 */
interface StoredPermissions {
  /** 自动允许规则。 */
  allow?: StoredPermissionRule[];
  /** 始终询问规则。 */
  ask?: StoredPermissionRule[];
  /** 自动拒绝规则。 */
  deny?: StoredPermissionRule[];
}

/** MyAgent 设置文件的最小已知结构；其它字段读取后原样保留。 */
interface PermissionSettingsDocument extends Record<string, unknown> {
  /** 配置格式版本。 */
  version?: number;
  /** 权限规则集合。 */
  permissions?: StoredPermissions;
}

/** 可由普通审批保存的权限设置来源。 */
type EditablePermissionSource = 'localSettings' | 'userSettings';

/**
 * 权限规则文件仓库。
 * 负责加载和保存项目本机、用户全局两类规则，不参与权限判断。
 */
export class PermissionSettingsStore {
  private readonly projectSettingsPath: string;
  private readonly userSettingsPath: string;

  /**
   * 创建权限规则文件仓库。
   *
   * @param workspaceRoot - 当前项目根目录
   * @param userHome - 当前用户主目录，测试可覆盖
   */
  constructor(workspaceRoot: string, userHome: string = homedir()) {
    this.projectSettingsPath = join(workspaceRoot, '.myagent', 'settings.local.json');
    this.userSettingsPath = join(userHome, '.myagent', 'settings.json');
  }

  /**
   * 将磁盘中的项目本机与用户全局规则加载到内存规则仓库。
   *
   * @param ruleStore - 权限规则内存仓库
   */
  public loadInto(ruleStore: PermissionRuleStore): void {
    this.loadSource(ruleStore, 'userSettings', this.userSettingsPath);
    this.loadSource(ruleStore, 'localSettings', this.projectSettingsPath);
  }

  /**
   * 将权限更新保存到对应设置文件。
   * 会话规则不落盘；普通审批不允许写入项目共享或管理策略来源。
   *
   * @param update - 已由用户确认的权限规则更新
   */
  public persist(update: PermissionUpdate): void {
    const updatesBySource = new Map<EditablePermissionSource, PermissionRule[]>();
    for (const rule of update.rules) {
      const source = update.targetSource ?? rule.source;
      if (!isEditablePersistentSource(source)) {
        continue;
      }
      const sourceRules = updatesBySource.get(source) ?? [];
      sourceRules.push({ ...rule, source });
      updatesBySource.set(source, sourceRules);
    }

    for (const [source, rules] of updatesBySource) {
      this.persistSource(source, rules, update.operation);
    }
  }

  /** 从单个配置文件加载规则。 */
  private loadSource(
    ruleStore: PermissionRuleStore,
    source: EditablePermissionSource,
    filePath: string,
  ): void {
    try {
      const document = this.readDocument(filePath);
      const permissions = normalizeStoredPermissions(document.permissions);
      for (const behavior of ['allow', 'ask', 'deny'] as const) {
        for (const storedRule of permissions[behavior] ?? []) {
          ruleStore.addRule(source, {
            source,
            ruleBehavior: behavior,
            ruleValue: {
              toolName: storedRule.toolName,
              ruleContent: storedRule.ruleContent,
            },
          });
        }
      }
    } catch (error: unknown) {
      // 权限设置是可选层；单个来源损坏时保留其它来源与内置默认权限。
      logger.warn('[权限配置] 设置文件加载失败，已跳过该配置来源。', {
        component: 'permission_settings',
        event: 'permission_settings_load_failed',
        source,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 将同一来源的一组规则合并进对应配置文件。 */
  private persistSource(
    source: EditablePermissionSource,
    rules: PermissionRule[],
    operation: PermissionUpdate['operation'],
  ): void {
    const filePath = source === 'localSettings' ? this.projectSettingsPath : this.userSettingsPath;
    const document = this.readDocument(filePath);
    const permissions = normalizeStoredPermissions(document.permissions);

    for (const behavior of ['allow', 'ask', 'deny'] as const) {
      const affectedRules = rules.filter(rule => rule.ruleBehavior === behavior);
      if (operation === 'set') {
        permissions[behavior] = affectedRules.map(toStoredRule);
        continue;
      }
      const currentRules = permissions[behavior] ?? [];
      if (operation === 'remove') {
        permissions[behavior] = currentRules.filter(current => (
          !affectedRules.some(rule => isSameStoredRule(current, toStoredRule(rule)))
        ));
        continue;
      }
      if (operation === 'replace') {
        permissions[behavior] = affectedRules.map(toStoredRule);
        continue;
      }
      for (const rule of affectedRules) {
        const storedRule = toStoredRule(rule);
        if (!currentRules.some(current => isSameStoredRule(current, storedRule))) {
          currentRules.push(storedRule);
        }
      }
      permissions[behavior] = currentRules;
    }

    document.version = 1;
    document.permissions = permissions;
    this.writeDocument(filePath, document);
  }

  /** 读取设置文档；文件不存在时返回空文档。 */
  private readDocument(filePath: string): PermissionSettingsDocument {
    if (!existsSync(filePath)) {
      return {};
    }
    const content = readFileSync(filePath, 'utf8');
    // 空白设置文件等同于尚未配置，避免占位文件阻断整个会话初始化。
    if (content.trim().length === 0) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`权限设置文件不是有效 JSON，未读取：${filePath}（${reason}）`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) {
      throw new Error(`权限设置文件格式无效：${filePath}`);
    }
    return parsed;
  }

  /** 通过同目录临时文件原子替换设置文档。 */
  private writeDocument(filePath: string, document: PermissionSettingsDocument): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      renameSync(temporaryPath, filePath);
    } finally {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }
}

/** 判断来源是否允许由普通审批持久化。 */
function isEditablePersistentSource(source: PermissionRuleSource): source is EditablePermissionSource {
  return source === 'localSettings' || source === 'userSettings';
}

/** 将内存规则转换为磁盘规则。 */
function toStoredRule(rule: PermissionRule): StoredPermissionRule {
  return {
    toolName: rule.ruleValue.toolName,
    ruleContent: rule.ruleValue.ruleContent,
  };
}

/** 判断两个磁盘规则是否完全相同。 */
function isSameStoredRule(left: StoredPermissionRule, right: StoredPermissionRule): boolean {
  return left.toolName === right.toolName && left.ruleContent === right.ruleContent;
}

/** 验证从磁盘读取的单条规则。 */
function isStoredPermissionRule(value: unknown): value is StoredPermissionRule {
  return isRecord(value)
    && typeof value.toolName === 'string'
    && (value.ruleContent === undefined || typeof value.ruleContent === 'string');
}

/** 将未知权限段收敛为可安全更新的结构。 */
function normalizeStoredPermissions(value: unknown): StoredPermissions {
  const normalized: StoredPermissions = {};
  const permissions = isRecord(value) ? value : undefined;
  for (const behavior of ['allow', 'ask', 'deny'] as PermissionBehavior[]) {
    const candidates = permissions?.[behavior];
    normalized[behavior] = Array.isArray(candidates)
      ? candidates.filter(isStoredPermissionRule)
      : [];
  }
  return normalized;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
