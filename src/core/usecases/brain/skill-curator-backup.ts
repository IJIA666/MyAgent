import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** 单个 Curator 备份摘要。 */
export interface SkillCuratorBackupSummary {
  /** 备份目录标识。 */
  readonly id: string;
  /** 创建时间。 */
  readonly createdAt: string;
  /** 备份绝对路径。 */
  readonly path: string;
}

/** 备份仓储可测试选项。 */
export interface SkillCuratorBackupStoreOptions {
  /** 目录复制实现；测试可注入故障，生产默认使用安全递归复制。 */
  readonly copyDirectory?: (source: string, destination: string) => void;
}

/** 备份 manifest。 */
interface BackupManifest {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly archiveIncluded: boolean;
  readonly usageIncluded: boolean;
  readonly stateIncluded: boolean;
}

/**
 * Skill Curator 完整备份与回滚仓储。
 */
export class SkillCuratorBackupStore {
  private readonly copyDirectory: (source: string, destination: string) => void;

  /**
   * @param userSkillsDir - 活动用户 Skill 根目录
   * @param archiveDir - Skill 归档目录
   * @param usagePath - usage sidecar 路径
   * @param statePath - Curator 状态路径
   * @param backupsDir - Curator 备份根目录
   * @param keep - 最多保留的成功备份数量
   * @param options - 可测试选项
   */
  constructor(
    private readonly userSkillsDir: string,
    private readonly archiveDir: string,
    private readonly usagePath: string,
    private readonly statePath: string,
    private readonly backupsDir: string,
    private readonly keep: number,
    options: SkillCuratorBackupStoreOptions = {},
  ) {
    this.copyDirectory = options.copyDirectory ?? copyDirectorySafely;
  }

  /**
   * 创建一次完整维护前备份。
   * 任何复制或保留策略失败都会抛错，调用方必须 fail closed。
   *
   * @param now - 备份创建时间
   * @returns 成功备份摘要
   */
  public create(now: Date = new Date()): SkillCuratorBackupSummary {
    mkdirSync(this.backupsDir, { recursive: true });
    const createdAt = now.toISOString();
    const id = `${formatTimestamp(now)}-${randomUUID()}`;
    const finalPath = join(this.backupsDir, id);
    const temporaryPath = join(this.backupsDir, `.tmp-${id}`);
    const activeSnapshotPath = join(temporaryPath, 'skills');

    try {
      mkdirSync(activeSnapshotPath, { recursive: true });
      for (const name of listActiveSkillDirectories(this.userSkillsDir)) {
        this.copyDirectory(
          join(this.userSkillsDir, name),
          join(activeSnapshotPath, name),
        );
      }

      const archiveIncluded = existsSync(this.archiveDir);
      if (archiveIncluded) {
        this.copyDirectory(this.archiveDir, join(temporaryPath, 'archive'));
      }

      const usageIncluded = existsSync(this.usagePath);
      if (usageIncluded) {
        copyRegularFile(this.usagePath, join(temporaryPath, 'usage.json'));
      }

      const stateIncluded = existsSync(this.statePath);
      if (stateIncluded) {
        copyRegularFile(this.statePath, join(temporaryPath, 'curator-state.json'));
      }

      const manifest: BackupManifest = {
        version: 1,
        id,
        createdAt,
        archiveIncluded,
        usageIncluded,
        stateIncluded,
      };
      writeFileSync(
        join(temporaryPath, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      renameSync(temporaryPath, finalPath);
      this.prune();
      return { id, createdAt, path: finalPath };
    } catch (error) {
      try {
        if (existsSync(temporaryPath)) {
          rmSync(temporaryPath, { recursive: true, force: true });
        }
      } catch {
        // 临时目录清理失败不覆盖备份的原始失败原因。
      }
      throw error;
    }
  }

  /**
   * 按创建时间倒序列出有效备份。
   *
   * @returns 备份摘要数组
   */
  public list(): SkillCuratorBackupSummary[] {
    if (!existsSync(this.backupsDir)) {
      return [];
    }
    const summaries: SkillCuratorBackupSummary[] = [];
    for (const entry of readdirSync(this.backupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) {
        continue;
      }
      const backupPath = join(this.backupsDir, entry.name);
      try {
        const manifest = readManifest(backupPath);
        summaries.push({
          id: manifest.id,
          createdAt: manifest.createdAt,
          path: backupPath,
        });
      } catch {
        // 损坏或未知目录不作为可回滚备份暴露。
      }
    }
    return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * 回滚到指定备份；不传 id 时使用最新备份。
   *
   * @param id - 可选备份标识
   * @returns 被恢复的备份摘要
   */
  public rollback(id?: string): SkillCuratorBackupSummary {
    const selected = id
      ? this.list().find(backup => backup.id === id)
      : this.list()[0];
    if (!selected) {
      throw new Error(id ? `Curator 备份 "${id}" 不存在` : '没有可用的 Curator 备份');
    }

    const manifest = readManifest(selected.path);
    const stagingPath = join(
      dirname(this.userSkillsDir),
      `.curator-rollback-${randomUUID()}`,
    );
    try {
      mkdirSync(stagingPath, { recursive: true });
      this.copyDirectory(join(selected.path, 'skills'), join(stagingPath, 'skills'));
      if (manifest.archiveIncluded) {
        this.copyDirectory(join(selected.path, 'archive'), join(stagingPath, 'archive'));
      }
      if (manifest.usageIncluded) {
        copyRegularFile(join(selected.path, 'usage.json'), join(stagingPath, 'usage.json'));
      }
      if (manifest.stateIncluded) {
        copyRegularFile(
          join(selected.path, 'curator-state.json'),
          join(stagingPath, 'curator-state.json'),
        );
      }

      mkdirSync(this.userSkillsDir, { recursive: true });
      for (const name of listActiveSkillDirectories(this.userSkillsDir)) {
        rmSync(join(this.userSkillsDir, name), { recursive: true, force: true });
      }
      for (const name of listActiveSkillDirectories(join(stagingPath, 'skills'))) {
        renameSync(
          join(stagingPath, 'skills', name),
          join(this.userSkillsDir, name),
        );
      }

      replaceDirectoryFromStaging(
        this.archiveDir,
        join(stagingPath, 'archive'),
        manifest.archiveIncluded,
      );
      replaceFileFromStaging(
        this.usagePath,
        join(stagingPath, 'usage.json'),
        manifest.usageIncluded,
      );
      replaceFileFromStaging(
        this.statePath,
        join(stagingPath, 'curator-state.json'),
        manifest.stateIncluded,
      );
      return selected;
    } finally {
      if (existsSync(stagingPath)) {
        rmSync(stagingPath, { recursive: true, force: true });
      }
    }
  }

  /** 删除超出保留数量的最旧备份。 */
  private prune(): void {
    const backups = this.list();
    for (const backup of backups.slice(Math.max(0, this.keep))) {
      rmSync(backup.path, { recursive: true, force: true });
    }
  }
}

/** 把日期格式化成 Windows 文件名安全的稳定前缀。 */
function formatTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** 只列出活动根中的非点目录，天然排除 archive、backup 和临时设施。 */
function listActiveSkillDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/** 递归复制目录并拒绝符号链接或 junction。 */
function copyDirectorySafely(source: string, destination: string): void {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`备份源不是安全目录: ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`备份拒绝符号链接: ${sourcePath}`);
    }
    if (stat.isDirectory()) {
      copyDirectorySafely(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      copyFileSync(sourcePath, destinationPath);
    } else {
      throw new Error(`备份拒绝非常规文件: ${sourcePath}`);
    }
  }
}

/** 复制单个常规文件并拒绝链接。 */
function copyRegularFile(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`备份源不是安全文件: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

/** 严格读取备份 manifest。 */
function readManifest(backupPath: string): BackupManifest {
  const raw: unknown = JSON.parse(readFileSync(join(backupPath, 'manifest.json'), 'utf8'));
  if (
    typeof raw !== 'object'
    || raw === null
    || Array.isArray(raw)
  ) {
    throw new Error('备份 manifest 根必须是对象');
  }
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1
    || typeof value.id !== 'string'
    || basename(backupPath) !== value.id
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.archiveIncluded !== 'boolean'
    || typeof value.usageIncluded !== 'boolean'
    || typeof value.stateIncluded !== 'boolean'
  ) {
    throw new Error('备份 manifest 结构非法');
  }
  return {
    version: 1,
    id: value.id,
    createdAt: value.createdAt,
    archiveIncluded: value.archiveIncluded,
    usageIncluded: value.usageIncluded,
    stateIncluded: value.stateIncluded,
  };
}

/** 用暂存目录替换目标目录，manifest 声明缺失时删除当前目录。 */
function replaceDirectoryFromStaging(
  target: string,
  staging: string,
  included: boolean,
): void {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  if (included) {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
  }
}

/** 用暂存文件替换目标文件，manifest 声明缺失时删除当前文件。 */
function replaceFileFromStaging(
  target: string,
  staging: string,
  included: boolean,
): void {
  if (existsSync(target)) {
    rmSync(target, { force: true });
  }
  if (included) {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
  }
}
