import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, lstatSync, renameSync, unlinkSync,
  openSync, closeSync, fsyncSync, rmdirSync,
} from 'node:fs';
import { resolve, dirname, join, isAbsolute, normalize, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import type {
  SkillSource,
  SkillPackageMetadata,
  SkillManageRequest,
  SkillManageResult,
  SkillManagePreviewResult,
  SkillWriteOrigin,
  SkillLifecycleState,
  SkillUsageRecord,
} from './skill-types.js';
import { SkillUsageStore } from './skill-usage-store.js';
import { logger } from '../../../utils/logger.js';

/** SKILL.md 最大字符数。 */
const SKILL_FILE_MAX_CHARS = 100_000;
/** 支持文件最大字节数（UTF-8 编码后）。 */
const SUPPORT_FILE_MAX_BYTES = 1 * 1024 * 1024;
/** 白名单支持文件目录。 */
const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets']);

/** 变更监听器。 */
export type SkillChangeListener = (event: 'created' | 'updated' | 'deleted', name: string) => void;

/**
 * Skill 库构造选项。
 */
export interface SkillLibraryOptions {
  /** 是否启用 watcher（后台/Curator 实例为 false）。 */
  enableWatcher?: boolean;
}

/** Curator 生命周期复核函数。 */
export type SkillLifecycleEligibility = (
  record: Readonly<SkillUsageRecord>,
) => boolean;

/** 单次 Skill 生命周期操作结果。 */
export type SkillLifecycleOperationResult =
  | {
      readonly status: 'changed';
      readonly name: string;
      readonly state: SkillLifecycleState;
    }
  | {
      readonly status: 'skipped';
      readonly name: string;
      readonly reason: string;
    };

/** 单个已归档 Skill 摘要。 */
export interface ArchivedSkillSummary {
  /** Skill 名称。 */
  readonly name: string;
  /** 完整归档包路径。 */
  readonly archivePath: string;
  /** usage 中记录的归档时间。 */
  readonly archivedAt: string | null;
  /** 可选的 umbrella 吸收目标。 */
  readonly absorbedInto: string | null;
}

/**
 * 统一 Skill 库，整合发现、读取和修改操作。
 */
export class SkillLibrary {
  private readonly usageStore: SkillUsageStore;
  private readonly listeners: SkillChangeListener[] = [];
  /** 缓存：名称 → 元数据。 */
  private cache = new Map<string, SkillPackageMetadata>();
  /** 是否已关闭。 */
  private closed = false;

  /**
   * @param userSkillsDir - 用户 skills 目录（~/.myagent/skills）
   * @param projectSkillsDir - 项目 skills 目录（workspace/.myagent/skills）
   * @param skillArchiveDir - 归档目录
   * @param usageStore - 使用记录仓储
   * @param _options - 可选构造选项；保留 watcher 装配契约
   */
  constructor(
    private readonly userSkillsDir: string,
    private readonly projectSkillsDir: string,
    private readonly skillArchiveDir: string,
    usageStore: SkillUsageStore,
    _options: SkillLibraryOptions = {},
  ) {
    this.usageStore = usageStore;
    this.refreshCache();
  }

  /**
   * 订阅变更通知。
   *
   * @param listener - 回调函数
   * @returns 取消订阅函数
   */
  public subscribe(listener: SkillChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * 获取当前所有活跃 Skill 的合并列表。
   * 项目 Skill 同名覆盖用户 Skill。
   *
   * @returns 技能包元数据数组
   */
  public list(): SkillPackageMetadata[] {
    return Array.from(this.cache.values());
  }

  /**
   * 按名称查找 Skill。
   *
   * @param name - Skill 名称
   * @returns 元数据或 undefined
   */
  public get(name: string): SkillPackageMetadata | undefined {
    return this.cache.get(name);
  }

  /**
   * 读取 SKILL.md 或白名单支持文件内容。
   *
   * @param name - Skill 名称
   * @param filePath - 可选的支持文件相对路径（不传时读取 SKILL.md）
   * @returns 文件内容，不存在时返回 null
   */
  public read(name: string, filePath?: string): string | null {
    const meta = this.cache.get(name);
    if (!meta) return null;

    if (filePath) {
      const pathError = this.validateSupportFilePath(meta.skillDir, filePath);
      if (pathError) {
        return null;
      }
    }

    const targetPath = filePath
      ? resolve(meta.skillDir, filePath)
      : meta.filePath;

    try {
      if (!existsSync(targetPath)) return null;
      const targetStat = lstatSync(targetPath);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        return null;
      }
      return readFileSync(targetPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * 列出 Skill 包中的安全支持文件相对路径。
   * 只遍历白名单顶级目录并拒绝符号链接。
   *
   * @param name - Skill 名称
   * @returns 排序后的相对路径数组
   */
  public listSupportFiles(name: string): readonly string[] {
    const meta = this.cache.get(name);
    if (!meta) {
      return [];
    }
    const files: string[] = [];
    for (const topDir of [...ALLOWED_SUBDIRS].sort()) {
      const root = join(meta.skillDir, topDir);
      this.collectSupportFiles(meta.skillDir, root, files);
    }
    return files.sort((left, right) => left.localeCompare(right));
  }

  /**
   * 校验某个 Skill 的支持文件相对路径。
   *
   * @param name - Skill 名称
   * @param filePath - 支持文件相对路径
   * @returns 合法时返回 null，否则返回稳定错误说明
   */
  public validateSupportPath(name: string, filePath: string): string | null {
    const meta = this.cache.get(name);
    if (!meta) {
      return `Skill "${name}" 不存在`;
    }
    return this.validateSupportFilePath(meta.skillDir, filePath);
  }

  /**
   * 解析权限证据使用的 Skill 目标绝对路径。
   * 已存在 Skill 使用实际覆盖后的包目录；create 等未存在目标使用用户 Skill 根。
   *
   * @param name - Skill 名称
   * @param filePath - 可选支持文件相对路径
   * @returns 目标规范绝对路径
   */
  public resolveTargetPath(name: string, filePath?: string): string {
    const skillDir = this.cache.get(name)?.skillDir ?? resolve(this.userSkillsDir, name);
    return filePath ? resolve(skillDir, filePath) : resolve(skillDir);
  }

  /**
   * 记录一次成功的显式 Skill 查看。
   *
   * @param name - Skill 名称
   */
  public async recordView(name: string): Promise<void> {
    await this.usageStore.recordView(name);
  }

  /**
   * 记录一次 Skill 正文实际用于任务。
   *
   * @param name - Skill 名称
   */
  public async recordUse(name: string): Promise<void> {
    await this.usageStore.recordUse(name);
  }

  /**
   * 在 usage 跨进程锁内复核并执行确定性生命周期迁移。
   * 迁移前重新扫描活动 Skill，避免使用候选快照执行破坏性动作。
   *
   * @param name - Skill 名称
   * @param targetState - 目标状态，仅允许 stale 或 archived
   * @param isEligible - 基于锁内最新 usage 记录的资格判断
   * @param now - 迁移时间
   * @param absorbedInto - 融合归档时的 umbrella 名称
   * @returns 迁移或跳过结果
   */
  public async transitionLifecycle(
    name: string,
    targetState: 'stale' | 'archived',
    isEligible: SkillLifecycleEligibility,
    now: Date = new Date(),
    absorbedInto: string | null = null,
  ): Promise<SkillLifecycleOperationResult> {
    const result = await this.usageStore.withLockedRecord<SkillLifecycleOperationResult>(
      name,
      (record) => {
        this.refreshCache();
        const meta = this.cache.get(name);
        const validationError = this.validateManagedActiveTarget(name, meta, record);
        if (validationError) {
          return {
            write: false,
            result: { status: 'skipped', name, reason: validationError } as const,
          };
        }
        if (
          targetState === 'stale'
          && record!.state !== 'active'
        ) {
          return {
            write: false,
            result: {
              status: 'skipped',
              name,
              reason: `当前状态 ${record!.state} 不能迁移为 stale`,
            } as const,
          };
        }
        if (
          targetState === 'archived'
          && record!.state !== 'active'
          && record!.state !== 'stale'
        ) {
          return {
            write: false,
            result: {
              status: 'skipped',
              name,
              reason: `当前状态 ${record!.state} 不能归档`,
            } as const,
          };
        }
        if (!isEligible(record!)) {
          return {
            write: false,
            result: {
              status: 'skipped',
              name,
              reason: '锁内复核发现活动时间或策略状态已变化',
            } as const,
          };
        }

        const nextRecord: SkillUsageRecord = {
          ...record!,
          state: targetState,
          archivedAt: targetState === 'archived' ? now.toISOString() : null,
          absorbedInto: targetState === 'archived' ? absorbedInto : record!.absorbedInto,
        };
        if (targetState === 'stale') {
          return {
            write: true,
            nextRecord,
            result: { status: 'changed', name, state: targetState } as const,
          };
        }

        const archivePath = join(this.skillArchiveDir, name);
        if (existsSync(archivePath)) {
          return {
            write: false,
            result: {
              status: 'skipped',
              name,
              reason: '归档目录已存在同名 Skill，拒绝覆盖',
            } as const,
          };
        }
        const sourcePath = meta!.skillDir;
        return {
          write: true,
          nextRecord,
          result: { status: 'changed', name, state: targetState } as const,
          prepare: () => {
            this.moveDir(sourcePath, archivePath);
            return () => {
              if (existsSync(archivePath) && !existsSync(sourcePath)) {
                this.moveDir(archivePath, sourcePath);
              }
            };
          },
        };
      },
    );

    if (result.status === 'changed') {
      this.refreshCache();
      this.notify(targetState === 'archived' ? 'deleted' : 'updated', name);
    }
    return result;
  }

  /**
   * 列出可恢复的完整归档 Skill 包。
   *
   * @returns 归档摘要数组
   */
  public listArchived(): ArchivedSkillSummary[] {
    if (!existsSync(this.skillArchiveDir)) {
      return [];
    }
    const usage = this.usageStore.readAll();
    return this.listSkillDirs(this.skillArchiveDir)
      .filter(name => (
        usage[name]?.state === 'archived'
        && this.isValidSkillPackage(join(this.skillArchiveDir, name), name)
      ))
      .map(name => ({
        name,
        archivePath: join(this.skillArchiveDir, name),
        archivedAt: usage[name]?.archivedAt ?? null,
        absorbedInto: usage[name]?.absorbedInto ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * 恢复一个完整归档 Skill 包。
   * 活动用户根或项目合并视图存在同名目标时 fail closed。
   *
   * @param name - Skill 名称
   * @returns 恢复或跳过结果
   */
  public async restoreArchived(name: string): Promise<SkillLifecycleOperationResult> {
    const result = await this.usageStore.withLockedRecord<SkillLifecycleOperationResult>(
      name,
      (record) => {
      this.refreshCache();
      const archivePath = join(this.skillArchiveDir, name);
      const activePath = join(this.userSkillsDir, name);
      if (!record || record.createdBy !== 'agent' || record.state !== 'archived') {
        return {
          write: false,
          result: {
            status: 'skipped',
            name,
            reason: '目标不是 curator-managed 归档 Skill',
          } as const,
        };
      }
      if (!this.isValidSkillPackage(archivePath, name)) {
        return {
          write: false,
          result: {
            status: 'skipped',
            name,
            reason: '归档包缺失、不完整或 SKILL.md 非法',
          } as const,
        };
      }
      if (existsSync(activePath) || this.cache.has(name)) {
        return {
          write: false,
          result: {
            status: 'skipped',
            name,
            reason: '活动用户根或项目合并视图存在同名 Skill',
          } as const,
        };
      }

      const nextRecord: SkillUsageRecord = {
        ...record,
        state: 'active',
        archivedAt: null,
        absorbedInto: null,
      };
      return {
        write: true,
        nextRecord,
        result: { status: 'changed', name, state: 'active' } as const,
        prepare: () => {
          this.moveDir(archivePath, activePath);
          return () => {
            if (existsSync(activePath) && !existsSync(archivePath)) {
              this.moveDir(activePath, archivePath);
            }
          };
        },
      };
      },
    );

    if (result.status === 'changed') {
      this.refreshCache();
      this.notify('created', name);
    }
    return result;
  }

  /**
   * 显式接管一个未管理的活动用户 Skill。
   * createdBy 只表示后续策略所有权，不声明历史作者身份。
   *
   * @param name - Skill 名称
   * @param now - 首次建立 usage 记录的时间
   * @returns 接管或跳过结果
   */
  public async adopt(name: string, now: Date = new Date()): Promise<SkillLifecycleOperationResult> {
    const result = await this.usageStore.withLockedRecord<SkillLifecycleOperationResult>(
      name,
      (record) => {
      this.refreshCache();
      const meta = this.cache.get(name);
      const targetError = this.validateActiveUserTarget(name, meta);
      if (targetError) {
        return {
          write: false,
          result: { status: 'skipped', name, reason: targetError } as const,
        };
      }
      if (record?.state === 'archived') {
        return {
          write: false,
          result: {
            status: 'skipped',
            name,
            reason: '已归档 Skill 不能 adopt，请先 restore',
          } as const,
        };
      }
      if (record?.createdBy === 'agent') {
        return {
          write: false,
          result: {
            status: 'skipped',
            name,
            reason: 'Skill 已由 Curator 管理',
          } as const,
        };
      }
      const nextRecord = record
        ? { ...record, createdBy: 'agent' as const }
        : createAdoptedUsageRecord(now);
      return {
        write: true,
        nextRecord,
        result: {
          status: 'changed',
          name,
          state: nextRecord.state,
        } as const,
      };
      },
    );
    if (result.status === 'changed') {
      this.notify('updated', name);
    }
    return result;
  }

  /**
   * 固定一个 curator-managed 活动用户 Skill。
   *
   * @param name - Skill 名称
   * @returns 固定或跳过结果
   */
  public async pin(name: string): Promise<SkillLifecycleOperationResult> {
    return this.setPinned(name, true);
  }

  /**
   * 取消固定一个 curator-managed 活动用户 Skill。
   *
   * @param name - Skill 名称
   * @returns 取消固定或跳过结果
   */
  public async unpin(name: string): Promise<SkillLifecycleOperationResult> {
    return this.setPinned(name, false);
  }

  /**
   * 执行一次 Skill 管理动作。
   * 不提供跨多次调用的事务保证；每次调用独立提交并返回该次结果。
   * origin 由调用者根据上下文传入（前台/后台/Curator）。
   *
   * @param request - 管理请求参数
   * @param origin - 写入来源（foreground/background_review/background_curator）
   * @returns 操作结果
   */
  public async manage(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillManageResult> {
    const { action, name } = request;

    switch (action) {
      case 'create':
        return this.doCreate(request, origin);
      case 'patch':
        return this.doPatch(request, origin);
      case 'edit':
        return this.doEdit(request, origin);
      case 'delete':
        return this.doDelete(request, origin);
      case 'write_file':
        return this.doWriteFile(request, origin);
      case 'remove_file':
        return this.doRemoveFile(request, origin);
      default:
        return {
          status: 'error',
          action,
          name,
          error: `未知动作: ${action}`,
        };
    }
  }

  /**
   * 在不写入文件和遥测的情况下预览一次管理动作。
   * pending 暂存和批准前 stale 检查复用该入口，避免另写一套动作语义。
   *
   * @param request - 管理请求参数
   * @param origin - 原始写入来源
   * @returns 可持久化预览或明确错误
   */
  public async previewManage(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillManagePreviewResult> {
    const nameError = this.validateName(request.name);
    if (nameError) {
      return { status: 'error', error: nameError };
    }

    if (request.action === 'create') {
      const targetDir = resolve(this.userSkillsDir, request.name);
      if (this.cache.has(request.name) || existsSync(targetDir)) {
        return { status: 'error', error: `Skill "${request.name}" 已存在` };
      }
      if (typeof request.content !== 'string' || request.content.length === 0) {
        return { status: 'error', error: 'create 需要提供 content' };
      }
      const validationError = this.validateContentSize(request.content)
        ?? this.validateFrontmatter(request.content, request.name);
      if (validationError) {
        return { status: 'error', error: validationError };
      }
      return {
        status: 'ready',
        preview: {
          target: `${request.name}/SKILL.md`,
          beforeContent: null,
          afterContent: request.content,
          baseFingerprint: 'missing',
          summary: `创建 Skill "${request.name}"`,
        },
      };
    }

    const meta = this.cache.get(request.name);
    if (!meta) {
      return { status: 'error', error: `Skill "${request.name}" 不存在` };
    }
    if (origin !== 'foreground') {
      const ownershipError = await this.checkBackgroundOwnership(request.name, meta);
      if (ownershipError) {
        return { status: 'error', error: ownershipError };
      }
    }

    if (request.action === 'delete') {
      if (origin !== 'foreground') {
        if (!request.absorbedInto) {
          return { status: 'error', error: '后台 delete 必须提供 absorbedInto（吸收目标 umbrella）' };
        }
        if (!this.cache.has(request.absorbedInto)) {
          return { status: 'error', error: `吸收目标 "${request.absorbedInto}" 不存在` };
        }
      }
      return {
        status: 'ready',
        preview: {
          target: `${request.name}/`,
          beforeContent: null,
          afterContent: null,
          baseFingerprint: this.fingerprintPackage(meta.skillDir),
          summary: origin === 'foreground'
            ? `删除 Skill "${request.name}"`
            : `归档 Skill "${request.name}" 到 "${request.absorbedInto}"`,
        },
      };
    }

    const supportPath = request.filePath;
    const targetPath = supportPath
      ? resolve(meta.skillDir, supportPath)
      : meta.filePath;
    if (supportPath) {
      const pathError = this.validateSupportFilePath(meta.skillDir, supportPath);
      if (pathError) {
        return { status: 'error', error: pathError };
      }
    }
    const beforeContent = existsSync(targetPath)
      ? this.read(request.name, supportPath)
      : null;
    const baseFingerprint = fingerprintText(beforeContent);

    switch (request.action) {
      case 'patch': {
        if (
          typeof request.oldString !== 'string'
          || request.oldString.length === 0
          || typeof request.newString !== 'string'
        ) {
          return { status: 'error', error: 'patch 需要 oldString 和 newString' };
        }
        if (beforeContent === null) {
          return { status: 'error', error: '目标文件不存在' };
        }
        const firstIndex = beforeContent.indexOf(request.oldString);
        if (firstIndex < 0) {
          return { status: 'error', error: '未找到匹配文本' };
        }
        if (
          !request.replaceAll
          && beforeContent.indexOf(request.oldString, firstIndex + 1) >= 0
        ) {
          return { status: 'error', error: '文本不唯一；若需多处替换请设置 replaceAll=true' };
        }
        const afterContent = request.replaceAll
          ? beforeContent.split(request.oldString).join(request.newString)
          : beforeContent.replace(request.oldString, request.newString);
        const contentError = supportPath
          ? validateSupportContentSize(afterContent)
          : this.validateContentSize(afterContent)
            ?? this.validateFrontmatter(afterContent, request.name);
        if (contentError) {
          return { status: 'error', error: contentError };
        }
        return {
          status: 'ready',
          preview: {
            target: `${request.name}/${supportPath ?? 'SKILL.md'}`,
            beforeContent,
            afterContent,
            baseFingerprint,
            summary: `patch "${request.name}/${supportPath ?? 'SKILL.md'}"`,
          },
        };
      }
      case 'edit': {
        if (typeof request.content !== 'string' || request.content.length === 0) {
          return { status: 'error', error: 'edit 需要提供 content' };
        }
        const contentError = this.validateContentSize(request.content)
          ?? this.validateFrontmatter(request.content, request.name);
        if (contentError) {
          return { status: 'error', error: contentError };
        }
        return {
          status: 'ready',
          preview: {
            target: `${request.name}/SKILL.md`,
            beforeContent,
            afterContent: request.content,
            baseFingerprint,
            summary: `更新 Skill "${request.name}"`,
          },
        };
      }
      case 'write_file': {
        if (
          typeof supportPath !== 'string'
          || typeof request.fileContent !== 'string'
        ) {
          return { status: 'error', error: 'write_file 需要 filePath 和 fileContent' };
        }
        const sizeError = validateSupportContentSize(request.fileContent);
        if (sizeError) {
          return { status: 'error', error: sizeError };
        }
        return {
          status: 'ready',
          preview: {
            target: `${request.name}/${supportPath}`,
            beforeContent,
            afterContent: request.fileContent,
            baseFingerprint,
            summary: `写入 "${request.name}/${supportPath}"`,
          },
        };
      }
      case 'remove_file': {
        if (typeof supportPath !== 'string') {
          return { status: 'error', error: 'remove_file 需要 filePath' };
        }
        if (beforeContent === null) {
          return { status: 'error', error: '目标文件不存在' };
        }
        return {
          status: 'ready',
          preview: {
            target: `${request.name}/${supportPath}`,
            beforeContent,
            afterContent: null,
            baseFingerprint,
            summary: `删除 "${request.name}/${supportPath}"`,
          },
        };
      }
      default:
        return { status: 'error', error: `未知动作: ${request.action}` };
    }
  }

  /**
   * 从磁盘重新扫描 Skill 元数据，刷新缓存。
   */
  public reloadSkills(): void {
    this.refreshCache();
  }

  /**
   * 关闭 Skill 库，清理资源。
   */
  public close(): void {
    this.closed = true;
    this.listeners.length = 0;
    this.cache.clear();
  }

  /** 在 usage 锁内设置 pinned，并复核目标仍是活动用户 Skill。 */
  private async setPinned(
    name: string,
    pinned: boolean,
  ): Promise<SkillLifecycleOperationResult> {
    const result = await this.usageStore.withLockedRecord<SkillLifecycleOperationResult>(
      name,
      (record) => {
      this.refreshCache();
      const meta = this.cache.get(name);
      const targetError = this.validateManagedActiveTarget(name, meta, record);
      if (targetError) {
        return {
          write: false,
          result: { status: 'skipped', name, reason: targetError } as const,
        };
      }
      if (record!.pinned === pinned) {
        return {
          write: false,
          result: {
            status: 'skipped',
            name,
            reason: pinned ? 'Skill 已固定' : 'Skill 当前未固定',
          } as const,
        };
      }
      const nextRecord: SkillUsageRecord = { ...record!, pinned };
      return {
        write: true,
        nextRecord,
        result: {
          status: 'changed',
          name,
          state: nextRecord.state,
        } as const,
      };
      },
    );
    if (result.status === 'changed') {
      this.notify('updated', name);
    }
    return result;
  }

  /** 校验目标仍是合并视图中未被项目遮蔽的活动用户 Skill。 */
  private validateActiveUserTarget(
    name: string,
    meta: SkillPackageMetadata | undefined,
  ): string | null {
    if (!meta) {
      return `活动 Skill "${name}" 不存在或包不完整`;
    }
    if (meta.source !== 'user') {
      return '项目 Skill 或同名项目遮蔽目标不能由 Curator 管理';
    }
    if (resolve(meta.skillDir) !== resolve(this.userSkillsDir, name)) {
      return 'Skill 不位于受信用户 Skill 根';
    }
    return null;
  }

  /** 校验目标的最新 usage 所有权、固定状态和活动包。 */
  private validateManagedActiveTarget(
    name: string,
    meta: SkillPackageMetadata | undefined,
    record: Readonly<SkillUsageRecord> | undefined,
  ): string | null {
    const targetError = this.validateActiveUserTarget(name, meta);
    if (targetError) {
      return targetError;
    }
    if (!record || record.createdBy !== 'agent') {
      return 'Skill 没有 curator-managed 所有权记录';
    }
    if (record.pinned) {
      return 'Skill 已固定';
    }
    if (record.state === 'archived') {
      return 'Skill 已归档';
    }
    return null;
  }

  /** 严格验证指定目录是名称匹配的完整 Skill 包。 */
  private isValidSkillPackage(skillDir: string, name: string): boolean {
    const skillPath = join(skillDir, 'SKILL.md');
    try {
      if (!existsSync(skillDir) || !existsSync(skillPath)) {
        return false;
      }
      const directoryStat = lstatSync(skillDir);
      const fileStat = lstatSync(skillPath);
      if (
        !directoryStat.isDirectory()
        || directoryStat.isSymbolicLink()
        || !fileStat.isFile()
        || fileStat.isSymbolicLink()
      ) {
        return false;
      }
      const content = readFileSync(skillPath, 'utf8');
      return (
        this.validateContentSize(content) === null
        && this.validateFrontmatter(content, name) === null
      );
    } catch {
      return false;
    }
  }

  /** 递归收集常规支持文件，不跟随链接或非常规文件。 */
  private collectSupportFiles(
    skillDir: string,
    directory: string,
    files: string[],
  ): void {
    if (!existsSync(directory)) {
      return;
    }
    try {
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        return;
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          this.collectSupportFiles(skillDir, fullPath, files);
        } else if (stat.isFile()) {
          files.push(relative(skillDir, fullPath).replace(/\\/g, '/'));
        }
      }
    } catch {
      // 并发修改导致单个目录不可读时安全跳过，由 load_skill 再次验证。
    }
  }

  // ── 通知 ──

  private notify(event: 'created' | 'updated' | 'deleted', name: string): void {
    for (const listener of this.listeners) {
      try {
        listener(event, name);
      } catch (error) {
        logger.warn('[SkillLibrary] 变更通知异常', {
          component: 'skill_library',
          event: 'notification_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ── 缓存刷新 ──

  /** 从磁盘扫描并重建缓存。 */
  private refreshCache(): void {
    const newCache = new Map<string, SkillPackageMetadata>();

    // 先扫描用户，再扫描项目（项目同名覆盖）
    this.scanDir(this.userSkillsDir, 'user', newCache);
    this.scanDir(this.projectSkillsDir, 'project', newCache);

    this.cache = newCache;
  }

  /** 扫描单个目录下的所有 SKILL.md。 */
  private scanDir(
    dir: string,
    source: SkillSource,
    result: Map<string, SkillPackageMetadata>,
  ): void {
    if (!existsSync(dir)) return;

    const entries = this.listSkillDirs(dir);
    for (const skillDir of entries) {
      const skillFilePath = join(dir, skillDir, 'SKILL.md');
      if (!existsSync(skillFilePath)) continue;

      try {
        const packageStat = lstatSync(join(dir, skillDir));
        const fileStat = lstatSync(skillFilePath);
        if (
          packageStat.isSymbolicLink()
          || !packageStat.isDirectory()
          || fileStat.isSymbolicLink()
          || !fileStat.isFile()
        ) {
          continue;
        }
        const content = readFileSync(skillFilePath, 'utf-8');
        const parsed = matter(content);
        const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
        const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
        const category = typeof parsed.data.category === 'string' ? parsed.data.category.trim() : undefined;

        if (
          !name
          || !description
          || name !== skillDir
          || this.validateName(name)
          || this.validateContentSize(content)
        ) {
          continue;
        }

        result.set(name, {
          name,
          source,
          filePath: skillFilePath,
          skillDir: join(dir, skillDir),
          description,
          category,
        });
      } catch {
        // 跳过解析失败的 Skill
      }
    }
  }

  /** 列出给定根目录下的一级 Skill 目录（跳过 .archive/ 等点目录）。 */
  private listSkillDirs(rootDir: string): string[] {
    try {
      const entries = readdirSync(rootDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  // ── 校验 ──

  /**
   * 校验 Skill 名称是否为安全小写 slug。
   * 只允许小写字母、数字、连字符，长度 1-64。
   */
  private validateName(name: string): string | null {
    if (!name || typeof name !== 'string') {
      return 'Skill 名称不能为空';
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      return 'Skill 名称必须是小写字母、数字、连字符组成，长度 1-64';
    }
    return null;
  }

  /**
   * 校验 frontmatter：必须是合法 YAML，包含 name 和 description，
   * 且 frontmatter 的 name 必须与请求一致。
   */
  private validateFrontmatter(
    content: string,
    expectedName: string,
  ): string | null {
    try {
      const parsed = matter(content);
      const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
      const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';

      if (!name) return 'frontmatter 缺少 name 字段';
      if (!description) return 'frontmatter 缺少 description 字段';
      if (name !== expectedName) {
        return `frontmatter name "${name}" 与请求名称 "${expectedName}" 不一致`;
      }
      return null;
    } catch {
      return 'frontmatter YAML 解析失败';
    }
  }

  /**
   * 校验支持文件路径是否在允许的白名单目录内。
   * 拒绝绝对路径、`..`、符号链接逃逸和嵌套穿越。
   */
  private validateSupportFilePath(skillDir: string, filePath: string): string | null {
    if (!filePath) return '支持文件路径不能为空';
    if (isAbsolute(filePath)) return '支持文件路径不能是绝对路径';
    if (filePath.includes('..')) return '支持文件路径不能包含 ".."';

    const normalized = normalize(filePath).replace(/\\/g, '/');
    const topDir = normalized.split('/')[0];

    if (!ALLOWED_SUBDIRS.has(topDir)) {
      return `支持文件目录必须为 references/templates/scripts/assets 之一，收到: ${topDir}`;
    }

    const resolvedSkillDir = resolve(skillDir);
    const resolved = resolve(resolvedSkillDir, normalized);
    // 验证解析路径仍在 skillDir 内
    if (!resolved.startsWith(resolvedSkillDir + sep)) {
      return '支持文件路径不能逃逸出 Skill 根目录';
    }

    // 从 Skill 根到目标逐段拒绝符号链接/junction，避免不存在目标借由链接父目录逃逸。
    try {
      const segments = normalized.split('/').filter(Boolean);
      let currentPath = resolvedSkillDir;
      for (const segment of segments) {
        currentPath = resolve(currentPath, segment);
        if (!existsSync(currentPath)) {
          continue;
        }
        if (lstatSync(currentPath).isSymbolicLink()) {
          return '支持文件路径不能经过符号链接或 junction';
        }
      }
    } catch {
      return '支持文件物理路径校验失败';
    }

    return null;
  }

  /**
   * 校验 SKILL.md 内容大小。
   */
  private validateContentSize(content: string): string | null {
    if (content.length > SKILL_FILE_MAX_CHARS) {
      return `SKILL.md 内容超过 ${SKILL_FILE_MAX_CHARS} 字符限制`;
    }
    return null;
  }

  /**
   * 校验后台操作的所有权。
   * 只允许操作用户根内 createdBy=agent 或已 adopt 的活跃未归档 Skill。
   */
  private async checkBackgroundOwnership(
    name: string,
    meta: SkillPackageMetadata | undefined,
  ): Promise<string | null> {
    if (!meta) {
      return `Skill "${name}" 不存在`;
    }
    if (meta.source === 'project') {
      return '后台操作不支持项目 Skill';
    }
    // 检查 usage store 中的所有权
    const record = this.usageStore.read(name);
    if (!record) {
      return `Skill "${name}" 没有使用记录，需要先通过 /curator adopt 移交给 Curator`;
    }
    if (record.createdBy !== 'agent') {
      return `Skill "${name}" 不是 agent-created，需要先通过 /curator adopt 移交给 Curator`;
    }
    if (record.pinned) {
      return `Skill "${name}" 已被固定（pinned），后台操作不可修改`;
    }
    if (record.state === 'archived') {
      return `Skill "${name}" 已归档，后台操作不可修改`;
    }
    return null;
  }

  // ── 六个动作 ──

  /** Create：在用户根创建新 Skill。 */
  private async doCreate(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillManageResult> {
    const nameError = this.validateName(request.name);
    if (nameError) {
      return { status: 'error', action: 'create', name: request.name, error: nameError };
    }

    // 检查重名（全局范围和磁盘范围，避免缓存外目录被覆盖）
    const skillDir = join(this.userSkillsDir, request.name);
    if (this.cache.has(request.name) || existsSync(skillDir)) {
      return { status: 'error', action: 'create', name: request.name, error: `Skill "${request.name}" 已存在` };
    }

    if (typeof request.content !== 'string' || request.content.length === 0) {
      return { status: 'error', action: 'create', name: request.name, error: 'create 需要提供 content' };
    }

    // 校验内容大小
    const sizeError = this.validateContentSize(request.content);
    if (sizeError) {
      return { status: 'error', action: 'create', name: request.name, error: sizeError };
    }

    // 校验 frontmatter
    const fmError = this.validateFrontmatter(request.content, request.name);
    if (fmError) {
      return { status: 'error', action: 'create', name: request.name, error: fmError };
    }

    // 写入用户根
    const skillFilePath = join(skillDir, 'SKILL.md');
    let createdDir = false;

    try {
      // 首次使用时应用数据根目录可能尚未建立，创建完整受信父路径。
      mkdirSync(skillDir, { recursive: true });
      createdDir = true;
      this.atomicWrite(skillFilePath, request.content);

      // 后台创建自动标记 agent-created
      if (origin === 'background_review' || origin === 'background_curator') {
        await this.usageStore.markAgentCreated(request.name);
      } else {
        await this.usageStore.markUnmanaged(request.name);
      }

      this.refreshCache();
      this.notify('created', request.name);

      return {
        status: 'success',
        action: 'create',
        name: request.name,
        summary: `创建 Skill "${request.name}"`,
        agentCreated: origin === 'background_review' || origin === 'background_curator',
      };
    } catch (error) {
      // create 是单动作原子边界：usage 或文件提交失败时回滚刚创建的包。
      if (createdDir && existsSync(skillDir)) {
        try {
          this.removeDir(skillDir);
        } catch {
          logger.warn('[SkillLibrary] create 回滚失败', {
            component: 'skill_library',
            event: 'create_rollback_failed',
            skill: request.name,
          });
        }
      }
      return {
        status: 'error',
        action: 'create',
        name: request.name,
        error: `创建失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Patch：在文件内定点替换文本。 */
  private async doPatch(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillManageResult> {
    const meta = this.cache.get(request.name);
    if (!meta) {
      return { status: 'error', action: 'patch', name: request.name, error: `Skill "${request.name}" 不存在` };
    }

    if (origin !== 'foreground') {
      const ownError = await this.checkBackgroundOwnership(request.name, meta);
      if (ownError) {
        return { status: 'error', action: 'patch', name: request.name, error: ownError };
      }
    }

    if (
      typeof request.oldString !== 'string'
      || request.oldString.length === 0
      || typeof request.newString !== 'string'
    ) {
      return { status: 'error', action: 'patch', name: request.name, error: 'patch 需要 oldString 和 newString' };
    }

    const targetPath = request.filePath
      ? resolve(meta.skillDir, request.filePath)
      : meta.filePath;

    // 支持文件路径校验
    if (request.filePath) {
      const pathError = this.validateSupportFilePath(meta.skillDir, request.filePath);
      if (pathError) {
        return { status: 'error', action: 'patch', name: request.name, error: pathError };
      }
    }

    try {
      if (!existsSync(targetPath)) {
        return { status: 'error', action: 'patch', name: request.name, error: '目标文件不存在' };
      }

      const currentContent = readFileSync(targetPath, 'utf-8');
      const replaceAll = request.replaceAll ?? false;

      if (!replaceAll) {
        // 默认：要求唯一匹配
        const firstIdx = currentContent.indexOf(request.oldString);
        if (firstIdx === -1) {
          return { status: 'error', action: 'patch', name: request.name, error: '未找到匹配文本' };
        }
        const secondIdx = currentContent.indexOf(request.oldString, firstIdx + 1);
        if (secondIdx !== -1) {
          return { status: 'error', action: 'patch', name: request.name, error: '文本不唯一；若需多处替换请设置 replaceAll=true' };
        }
      }

      const newContent = replaceAll
        ? currentContent.split(request.oldString).join(request.newString)
        : currentContent.replace(request.oldString, request.newString);

      if (newContent === currentContent) {
        return { status: 'error', action: 'patch', name: request.name, error: '替换后内容未变化' };
      }

      // 如果是 SKILL.md，修改后重新校验 frontmatter
      if (!request.filePath) {
        const fmError = this.validateFrontmatter(newContent, request.name);
        if (fmError) {
          return { status: 'error', action: 'patch', name: request.name, error: `patch 破坏了 frontmatter: ${fmError}` };
        }
        const sizeError = this.validateContentSize(newContent);
        if (sizeError) {
          return { status: 'error', action: 'patch', name: request.name, error: sizeError };
        }
      } else {
        const sizeError = validateSupportContentSize(newContent);
        if (sizeError) {
          return { status: 'error', action: 'patch', name: request.name, error: sizeError };
        }
      }

      // 临时文件替换
      this.atomicWrite(targetPath, newContent);

      await this.usageStore.recordPatch(request.name);
      this.refreshCache();
      this.notify('updated', request.name);

      return {
        status: 'success',
        action: 'patch',
        name: request.name,
        summary: request.filePath
          ? `patch "${request.name}/${request.filePath}"`
          : `patch "${request.name}/SKILL.md"`,
      };
    } catch (error) {
      return {
        status: 'error',
        action: 'patch',
        name: request.name,
        error: `patch 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Edit：完整替换 SKILL.md。 */
  private async doEdit(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillManageResult> {
    const meta = this.cache.get(request.name);
    if (!meta) {
      return { status: 'error', action: 'edit', name: request.name, error: `Skill "${request.name}" 不存在` };
    }

    if (origin !== 'foreground') {
      const ownError = await this.checkBackgroundOwnership(request.name, meta);
      if (ownError) {
        return { status: 'error', action: 'edit', name: request.name, error: ownError };
      }
    }

    if (typeof request.content !== 'string' || request.content.length === 0) {
      return { status: 'error', action: 'edit', name: request.name, error: 'edit 需要提供 content' };
    }

    const sizeError = this.validateContentSize(request.content);
    if (sizeError) {
      return { status: 'error', action: 'edit', name: request.name, error: sizeError };
    }

    const fmError = this.validateFrontmatter(request.content, request.name);
    if (fmError) {
      return { status: 'error', action: 'edit', name: request.name, error: fmError };
    }

    try {
      this.atomicWrite(meta.filePath, request.content);
      await this.usageStore.recordPatch(request.name);
      this.refreshCache();
      this.notify('updated', request.name);

      return {
        status: 'success',
        action: 'edit',
        name: request.name,
        summary: `更新 Skill "${request.name}"`,
      };
    } catch (error) {
      return {
        status: 'error',
        action: 'edit',
        name: request.name,
        error: `edit 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Delete：前台删除解析目标，后台归档。 */
  private async doDelete(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillManageResult> {
    const meta = this.cache.get(request.name);
    if (!meta) {
      return { status: 'error', action: 'delete', name: request.name, error: `Skill "${request.name}" 不存在` };
    }

    if (origin !== 'foreground') {
      // 后台 delete 必须提供 absorbedInto
      if (!request.absorbedInto) {
        return {
          status: 'error',
          action: 'delete',
          name: request.name,
          error: '后台 delete 必须提供 absorbedInto（吸收目标 umbrella）',
        };
      }
      // 验证吸收目标存在
      const targetMeta = this.cache.get(request.absorbedInto);
      if (!targetMeta) {
        return {
          status: 'error',
          action: 'delete',
          name: request.name,
          error: `吸收目标 "${request.absorbedInto}" 不存在`,
        };
      }

      const ownError = await this.checkBackgroundOwnership(request.name, meta);
      if (ownError) {
        return { status: 'error', action: 'delete', name: request.name, error: ownError };
      }
    }

    try {
      if (origin !== 'foreground') {
        const transition = await this.transitionLifecycle(
          request.name,
          'archived',
          () => true,
          new Date(),
          request.absorbedInto!,
        );
        if (transition.status === 'skipped') {
          return {
            status: 'error',
            action: 'delete',
            name: request.name,
            error: transition.reason,
          };
        }

        return {
          status: 'success',
          action: 'delete',
          name: request.name,
          summary: `归档 Skill "${request.name}" 到 "${request.absorbedInto}"`,
        };
      } else {
        // 前台：直接删除物理文件
        if (existsSync(meta.skillDir)) {
          this.removeDir(meta.skillDir);
        } else if (existsSync(meta.filePath)) {
          unlinkSync(meta.filePath);
        }

        this.refreshCache();
        this.notify('deleted', request.name);

        return {
          status: 'success',
          action: 'delete',
          name: request.name,
          summary: `删除 Skill "${request.name}"`,
        };
      }
    } catch (error) {
      return {
        status: 'error',
        action: 'delete',
        name: request.name,
        error: `删除失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Write file：写入支持文件。 */
  private async doWriteFile(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillManageResult> {
    const meta = this.cache.get(request.name);
    if (!meta) {
      return { status: 'error', action: 'write_file', name: request.name, error: `Skill "${request.name}" 不存在` };
    }

    if (origin !== 'foreground') {
      const ownError = await this.checkBackgroundOwnership(request.name, meta);
      if (ownError) {
        return { status: 'error', action: 'write_file', name: request.name, error: ownError };
      }
    }

    if (
      typeof request.filePath !== 'string'
      || request.filePath.length === 0
      || typeof request.fileContent !== 'string'
    ) {
      return { status: 'error', action: 'write_file', name: request.name, error: 'write_file 需要 filePath 和 fileContent' };
    }

    const pathError = this.validateSupportFilePath(meta.skillDir, request.filePath);
    if (pathError) {
      return { status: 'error', action: 'write_file', name: request.name, error: pathError };
    }

    // 校验文件大小（UTF-8 编码后）
    const encodedBytes = Buffer.byteLength(request.fileContent, 'utf-8');
    if (encodedBytes > SUPPORT_FILE_MAX_BYTES) {
      return {
        status: 'error',
        action: 'write_file',
        name: request.name,
        error: `支持文件超过 ${SUPPORT_FILE_MAX_BYTES} 字节限制`,
      };
    }

    try {
      const targetPath = resolve(meta.skillDir, request.filePath);
      mkdirSync(dirname(targetPath), { recursive: true });
      this.atomicWrite(targetPath, request.fileContent);

      await this.usageStore.recordPatch(request.name);
      this.notify('updated', request.name);

      return {
        status: 'success',
        action: 'write_file',
        name: request.name,
        summary: `写入 "${request.name}/${request.filePath}"`,
      };
    } catch (error) {
      return {
        status: 'error',
        action: 'write_file',
        name: request.name,
        error: `写入文件失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Remove file：删除支持文件。 */
  private async doRemoveFile(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillManageResult> {
    const meta = this.cache.get(request.name);
    if (!meta) {
      return { status: 'error', action: 'remove_file', name: request.name, error: `Skill "${request.name}" 不存在` };
    }

    if (origin !== 'foreground') {
      const ownError = await this.checkBackgroundOwnership(request.name, meta);
      if (ownError) {
        return { status: 'error', action: 'remove_file', name: request.name, error: ownError };
      }
    }

    if (typeof request.filePath !== 'string' || request.filePath.length === 0) {
      return { status: 'error', action: 'remove_file', name: request.name, error: 'remove_file 需要 filePath' };
    }

    const pathError = this.validateSupportFilePath(meta.skillDir, request.filePath);
    if (pathError) {
      return { status: 'error', action: 'remove_file', name: request.name, error: pathError };
    }

    try {
      const targetPath = resolve(meta.skillDir, request.filePath);
      if (!existsSync(targetPath)) {
        return { status: 'error', action: 'remove_file', name: request.name, error: '目标文件不存在' };
      }

      unlinkSync(targetPath);
      await this.usageStore.recordPatch(request.name);
      this.notify('updated', request.name);

      return {
        status: 'success',
        action: 'remove_file',
        name: request.name,
        summary: `删除 "${request.name}/${request.filePath}"`,
      };
    } catch (error) {
      return {
        status: 'error',
        action: 'remove_file',
        name: request.name,
        error: `删除文件失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ── 文件操作实用工具 ──

  /** 原子写入：临时文件 + rename。 */
  private atomicWrite(targetPath: string, content: string): void {
    const dir = dirname(targetPath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmpPath, 'wx');
      writeFileSync(fd, content, 'utf-8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, targetPath);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* 清理 */ }
      }
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* 清理 */ }
    }
  }

  /** 递归删除目录（用于前台 delete）。 */
  private removeDir(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.removeDir(fullPath);
      } else {
        unlinkSync(fullPath);
      }
    }
    rmdirSync(dir);
  }

  /** 在同一用户 Skill 根内原子移动完整目录。 */
  private moveDir(src: string, dest: string): void {
    if (existsSync(dest)) {
      throw new Error(`目标目录已存在: ${dest}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
  }

  /** 计算完整 Skill 包的稳定内容摘要，不跟随符号链接。 */
  private fingerprintPackage(skillDir: string): string {
    const hash = createHash('sha256');
    const visit = (directory: string): void => {
      const entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) {
          throw new Error('Skill 包包含符号链接，无法生成安全预览');
        }
        const packagePath = relative(skillDir, fullPath).replace(/\\/g, '/');
        hash.update(packagePath);
        hash.update('\0');
        if (stat.isDirectory()) {
          visit(fullPath);
        } else if (stat.isFile()) {
          hash.update(readFileSync(fullPath));
        }
        hash.update('\0');
      }
    };
    visit(skillDir);
    return hash.digest('hex');
  }
}

/** 计算可空文本的稳定 fingerprint。 */
function fingerprintText(content: string | null): string {
  if (content === null) {
    return 'missing';
  }
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 校验支持文件 UTF-8 编码大小。 */
function validateSupportContentSize(content: string): string | null {
  return Buffer.byteLength(content, 'utf8') > SUPPORT_FILE_MAX_BYTES
    ? `支持文件超过 ${SUPPORT_FILE_MAX_BYTES} 字节限制`
    : null;
}

/** 为首次 adopt 的手写 Skill 建立策略所有权记录。 */
function createAdoptedUsageRecord(now: Date): SkillUsageRecord {
  return {
    createdBy: 'agent',
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    lastViewedAt: null,
    lastPatchedAt: null,
    state: 'active',
    pinned: false,
    archivedAt: null,
    absorbedInto: null,
  };
}
