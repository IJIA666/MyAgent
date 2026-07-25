/**
 * @file 统一 settings 文件仓储。
 * 定义 version 1 settings schema 与 {@link SettingsRepository}，
 * 作为 settings JSON 的解析、作用域合并、字段更新和原子文件替换的唯一所有者。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import type { ConfigPermissionMode } from './types.js';

// ── Schema ──────────────────────────────────────────────────────────

/** Version 1 settings 结构中的权限段。 */
export interface PermissionSettings {
  defaultMode?: ConfigPermissionMode;
  allow?: PermissionRuleEntry[];
  ask?: PermissionRuleEntry[];
  deny?: PermissionRuleEntry[];
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

/** Version 1 settings schema 的完整结构。 */
export interface SettingsDocumentV1 {
  /** schema 版本；缺失时空文档视为 version 1。 */
  version?: 1;
  permission?: PermissionSettings;
  terminal?: TerminalSettings;
  /** 额外的未知字段将被保留但不保证语义。 */
  [key: string]: unknown;
}

/** 可写入 settings scope 的类型。 */
export type SettingsScope = 'user' | 'project' | 'local';

/** 字段更新描述——只描述需要更新的字段，不涉及读改写外的元操作。 */
export interface SettingsFieldUpdate {
  /** 要更新的顶层字段路径，如 `permission.defaultMode`。 */
  field: string;
  /** 要设置的值。为 `undefined` 时表示删除该字段。 */
  value: unknown;
}

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
 *
 * 本类**不**提供跨进程并发合并保证。
 * 同一文件被多个进程同时更新时，"最后写入者胜出"，
 * 前一个进程基于旧快照的变更可能被覆盖。
 * 后续版本可增加文件锁或基于版本号的 CAS 以改善多进程场景。
 */
export class SettingsRepository {
  private readonly userSettingsPath: string;
  private readonly projectSettingsPath: string;
  private readonly projectLocalSettingsPath: string;

  /** 每 scope 的写入串行队列，resolve 上一个操作后才启动下一个。 */
  private writeQueues = new Map<string, Promise<void>>();

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
    const userDoc = this.readDocumentSafe(this.userSettingsPath);
    const projectDoc = this.readDocumentSafe(this.projectSettingsPath);
    const localDoc = this.readDocumentSafe(this.projectLocalSettingsPath);

    return this.mergeConfigs(userDoc, projectDoc, localDoc, sessionOverride);
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
    return this.readDocumentSafe(filePath);
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
    const filePath = this.getScopePath(scope);
    const queueKey = filePath;

    // 串行化同一文件的写入
    const previous = this.writeQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.then(
      () => this.doUpdateField(filePath, update),
      () => this.doUpdateField(filePath, update),
    );
    this.writeQueues.set(queueKey, current.then(() => undefined, () => undefined));
    return current;
  }

  // ── 内部实现 ────────────────────────────────────────────────────

  /** 实际执行字段更新（已在串行队列中）。 */
  private async doUpdateField(filePath: string, update: SettingsFieldUpdate): Promise<boolean> {
    try {
      const document = this.readDocumentSafe(filePath);
      this.applyFieldUpdate(document, update);
      this.writeDocument(filePath, document);
      return true;
    } catch {
      return false;
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
    const safeProjectMode = projectPerm.defaultMode === 'bypassPermissions'
      ? undefined
      : projectPerm.defaultMode;
    result.permission = {
      defaultMode: sessionPerm.defaultMode
        ?? localPerm.defaultMode
        ?? safeProjectMode
        ?? userPerm.defaultMode
        ?? 'default',
      allow: sessionPerm.allow ?? localPerm.allow ?? projectPerm.allow ?? userPerm.allow ?? [],
      ask: sessionPerm.ask ?? localPerm.ask ?? projectPerm.ask ?? userPerm.ask ?? [],
      deny: sessionPerm.deny ?? localPerm.deny ?? projectPerm.deny ?? userPerm.deny ?? [],
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

  /** 通过同目录唯一临时文件加 rename 原子写入文档。 */
  private writeDocument(filePath: string, document: SettingsDocumentV1): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmpPath, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
      renameSync(tmpPath, filePath);
    } finally {
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
