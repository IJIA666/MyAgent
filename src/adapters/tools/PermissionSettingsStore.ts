/**
 * @file 权限规则文件仓库 facade。
 * 负责权限规则与 settings permission 字段之间的转换，将文件读写委托给 {@link SettingsRepository}。
 * 不参与权限判断，不直接读写 JSON 文件。
 */

import type {
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionRuleUpdate,
  PermissionUpdate,
} from '../../core/domain/permissions/permission-types.js';
import {
  getRuleSourceForUpdateTarget,
} from '../../core/domain/permissions/rule-store.js';
import { logger } from '../../utils/logger.js';
import type { SettingsRepository, SettingsScope } from '../../config/settings-repository.js';
import type { PermissionSessionState } from '../../core/domain/permissions/permission-session-state.js';

/** 磁盘中不重复保存来源与行为的规则值。 */
interface StoredPermissionRule {
  /** 工具名称。 */
  toolName: string;
  /** 可选的命令、路径或其它规则限定内容。 */
  ruleContent?: string;
}

/** MyAgent 权限设置文件中的权限段。 */
interface StoredPermissions {
  /** 未来新会话使用的默认模式。 */
  defaultMode?: PermissionMode;
  /** 自动允许规则。 */
  allow?: StoredPermissionRule[];
  /** 始终询问规则。 */
  ask?: StoredPermissionRule[];
  /** 自动拒绝规则。 */
  deny?: StoredPermissionRule[];
  /** 明确授权的额外目录。 */
  additionalDirectories?: string[];
}

/** 可由普通审批保存的权限设置来源。 */
type EditablePermissionSource = 'localSettings' | 'projectSettings' | 'userSettings';

/** scope 映射：权限来源 → settings scope。 */
const SOURCE_TO_SCOPE: Record<EditablePermissionSource, SettingsScope> = {
  localSettings: 'local',
  projectSettings: 'project',
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
  public loadInto(state: PermissionSessionState): void {
    const updates: PermissionUpdate[] = [
      {
        type: 'replaceRules',
        target: 'user',
        rules: this.loadSource('userSettings'),
      },
      {
        type: 'replaceRules',
        target: 'project',
        rules: this.loadSource('projectSettings'),
      },
      {
        type: 'replaceRules',
        target: 'projectLocal',
        rules: this.loadSource('localSettings'),
      },
    ];
    const effective = this.repository.readEffectiveConfig();
    const directories = effective.permission?.additionalDirectories;
    if (Array.isArray(directories) && directories.length > 0) {
      updates.push({
        type: 'addDirectories',
        target: 'session',
        directories,
      });
    }
    state.applyUpdates(updates);
  }

  /**
   * 将权限更新持久化到对应 settings 文件。
   * 会话规则不落盘；普通审批不允许写入项目共享或管理策略来源。
   *
   * @param update - 已由用户确认的权限规则更新
   */
  public async persist(update: PermissionUpdate): Promise<void> {
    await this.persistAll([update]);
  }

  /**
   * 将一组持久更新按目标 settings 文件一次读改写提交。
   *
   * @param updates - 已通过审批的持久更新
   */
  public async persistAll(updates: readonly PermissionUpdate[]): Promise<void> {
    const updatesByScope = new Map<SettingsScope, PermissionUpdate[]>();
    for (const update of updates) {
      const scope = getScopeForTarget(update.target);
      if (!scope) {
        continue;
      }
      const scopeUpdates = updatesByScope.get(scope) ?? [];
      scopeUpdates.push(update);
      updatesByScope.set(scope, scopeUpdates);
    }

    if (updatesByScope.size > 1) {
      throw new Error('单次权限动作不能跨多个 settings scope，已拒绝可能的部分提交');
    }

    for (const [scope, scopeUpdates] of updatesByScope) {
      // 读取与合并必须在 SettingsRepository 的串行临界区内发生，避免并发读旧值后互相覆盖。
      const updated = await this.repository.updateDocument(scope, document => {
        const permissions = normalizeStoredPermissions(document.permission);
        for (const update of scopeUpdates) {
          applyStoredPermissionUpdate(permissions, update);
        }
        return {
          ...document,
          version: 1,
          permission: permissions,
        };
      });
      if (!updated) {
        throw new Error(`权限设置写入失败: ${scope}`);
      }
    }
  }

  /** 从单个来源加载规则。 */
  private loadSource(source: EditablePermissionSource): PermissionRule[] {
    try {
      const scope = SOURCE_TO_SCOPE[source];
      const document = this.repository.readDocument(scope);
      const permissions = normalizeStoredPermissions(document.permission);
      const rules: PermissionRule[] = [];
      for (const behavior of ['allow', 'ask', 'deny'] as const) {
        for (const storedRule of permissions[behavior] ?? []) {
          rules.push({
            source,
            ruleBehavior: behavior,
            ruleValue: {
              toolName: storedRule.toolName,
              ruleContent: storedRule.ruleContent,
            },
          });
        }
      }
      return rules;
    } catch (error: unknown) {
      logger.warn('[权限配置] 设置文件加载失败，已跳过该配置来源。', {
        component: 'permission_settings',
        event: 'permission_settings_load_failed',
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

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
  if (typeof permissions?.defaultMode === 'string') {
    normalized.defaultMode = permissions.defaultMode as PermissionMode;
  }
  normalized.additionalDirectories = Array.isArray(permissions?.additionalDirectories)
    ? permissions.additionalDirectories.filter(
      (directory): directory is string => typeof directory === 'string' && directory.trim().length > 0,
    )
    : [];
  return normalized;
}

/** 将 PermissionUpdate 合并进单个 settings 权限段。 */
function applyStoredPermissionUpdate(
  permissions: StoredPermissions,
  update: PermissionUpdate,
): void {
  if (update.type === 'setMode') {
    permissions.defaultMode = update.mode;
    return;
  }
  if (update.type === 'addDirectories') {
    permissions.additionalDirectories = [
      ...new Set([...(permissions.additionalDirectories ?? []), ...update.directories]),
    ];
    return;
  }
  if (update.type === 'removeDirectories') {
    const removals = new Set(update.directories);
    permissions.additionalDirectories = (permissions.additionalDirectories ?? [])
      .filter(directory => !removals.has(directory));
    return;
  }

  applyStoredRuleUpdate(permissions, update);
}

/** 将一项规则动作合并进磁盘权限段。 */
function applyStoredRuleUpdate(
  permissions: StoredPermissions,
  update: PermissionRuleUpdate,
): void {
  const source = getRuleSourceForUpdateTarget(update.target);
  const rules = update.rules.map(rule => ({ ...rule, source }));
  for (const behavior of ['allow', 'ask', 'deny'] as const) {
    const affectedRules = rules.filter(rule => rule.ruleBehavior === behavior);
    if (update.type === 'replaceRules') {
      permissions[behavior] = affectedRules.map(toStoredRule);
      continue;
    }
    const currentRules = permissions[behavior] ?? [];
    if (update.type === 'removeRules') {
      permissions[behavior] = currentRules.filter(current =>
        !affectedRules.some(rule => isSameStoredRule(current, toStoredRule(rule)))
      );
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
}

/** 将更新目标映射为可写 settings scope。 */
function getScopeForTarget(target: PermissionUpdate['target']): SettingsScope | undefined {
  switch (target) {
    case 'projectLocal': return 'local';
    case 'project': return 'project';
    case 'user': return 'user';
    case 'session': return undefined;
  }
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
