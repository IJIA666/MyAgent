/**
 * @file 权限规则文件仓库 facade。
 * 负责权限规则与 settings permission 字段之间的转换，将文件读写委托给 {@link SettingsRepository}。
 * 不参与权限判断，不直接读写 JSON 文件。
 */

import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionUpdate,
} from '../../core/domain/permissions/permission-types.js';
import { PermissionRuleStore } from '../../core/domain/permissions/rule-store.js';
import { logger } from '../../utils/logger.js';
import type { SettingsRepository, SettingsScope } from '../../config/settings-repository.js';

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

/** 可由普通审批保存的权限设置来源。 */
type EditablePermissionSource = 'localSettings' | 'userSettings';

/** scope 映射：权限来源 → settings scope。 */
const SOURCE_TO_SCOPE: Record<EditablePermissionSource, SettingsScope> = {
  localSettings: 'local',
  userSettings: 'user',
};

/**
 * 权限规则文件仓库 facade。
 * 负责权限规则与 settings permission 字段之间的转换，
 * 所有文件读写委托给 {@link SettingsRepository}。
 */
export class PermissionSettingsStore {
  /**
   * @param repository - 统一 settings 文件仓储
   */
  constructor(private readonly repository: SettingsRepository) {}

  /**
   * 将 settings 中的权限段加载到内存规则仓库。
   *
   * @param ruleStore - 权限规则内存仓库
   */
  public loadInto(ruleStore: PermissionRuleStore): void {
    this.loadSource(ruleStore, 'userSettings');
    this.loadSource(ruleStore, 'localSettings');
  }

  /**
   * 将权限更新持久化到对应 settings 文件。
   * 会话规则不落盘；普通审批不允许写入项目共享或管理策略来源。
   *
   * @param update - 已由用户确认的权限规则更新
   */
  public async persist(update: PermissionUpdate): Promise<void> {
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
      await this.persistSource(source, rules, update.operation);
    }
  }

  /** 从单个来源加载规则。 */
  private loadSource(ruleStore: PermissionRuleStore, source: EditablePermissionSource): void {
    try {
      const scope = SOURCE_TO_SCOPE[source];
      const document = this.repository.readDocument(scope);
      const permissions = normalizeStoredPermissions(document.permission);
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
      logger.warn('[权限配置] 设置文件加载失败，已跳过该配置来源。', {
        component: 'permission_settings',
        event: 'permission_settings_load_failed',
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 将同一来源的一组规则持久化到 settings。 */
  private async persistSource(
    source: EditablePermissionSource,
    rules: PermissionRule[],
    operation: PermissionUpdate['operation'],
  ): Promise<void> {
    const scope = SOURCE_TO_SCOPE[source];
    const document = this.repository.readDocument(scope);
    const permissions = normalizeStoredPermissions(document.permission);

    for (const behavior of ['allow', 'ask', 'deny'] as const) {
      const affectedRules = rules.filter(rule => rule.ruleBehavior === behavior);
      if (operation === 'set') {
        permissions[behavior] = affectedRules.map(toStoredRule);
        continue;
      }
      const currentRules = permissions[behavior] ?? [];
      if (operation === 'remove') {
        permissions[behavior] = currentRules.filter(current =>
          !affectedRules.some(rule => isSameStoredRule(current, toStoredRule(rule)))
        );
        continue;
      }
      if (operation === 'replace') {
        permissions[behavior] = affectedRules.map(toStoredRule);
        continue;
      }
      // add
      for (const rule of affectedRules) {
        const storedRule = toStoredRule(rule);
        if (!currentRules.some(current => isSameStoredRule(current, storedRule))) {
          currentRules.push(storedRule);
        }
      }
      permissions[behavior] = currentRules;
    }

    document.permission = {
      ...document.permission,
      ...permissions,
    };
    document.version = 1;

    // 通过 repository 写回
    await this.repository.updateField(scope, {
      field: 'permission',
      value: document.permission,
    });
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

/** 验证从磁盘读取的单条规则。 */
function isStoredPermissionRule(value: unknown): value is StoredPermissionRule {
  return isRecord(value)
    && typeof value.toolName === 'string'
    && (value.ruleContent === undefined || typeof value.ruleContent === 'string');
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
