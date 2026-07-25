import { join, resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, unlinkSync, rmSync } from 'fs';
import { logger } from '../../../utils/logger.js';

/**
 * 备份文件原始路径与快照备份路径的映射实体契约。
 */
export interface BackupFileMapping {
  /** 工作区中文件的原始绝对路径 */
  readonly originalPath: string;
  /** backups 目录下备份文件的物理绝对路径 */
  readonly backupPath: string;
}

/**
 * 单次快照在元数据清单中的记录实体契约。
 */
export interface SnapshotRecord {
  /** 唯一快照点标识 */
  readonly snapshotId: string;
  /** 快照创建的物理时间戳 */
  readonly timestamp: number;
  /** 快照点对应的内存消息历史长度基准 */
  readonly messageHistoryLength: number;
  /** 快照时已存在并执行物理冷备份的文件映射列表 */
  readonly backupFiles: BackupFileMapping[];
  /** 自该快照点后智能体即将新建的后增文件绝对路径列表 */
  readonly addedFiles: string[];
}

/**
 * 快照数据清单文件（JSON）的根结构契约。
 */
export interface SnapshotManifest {
  /** 历史快照记录列表 */
  snapshots: SnapshotRecord[];
}

/**
 * 全局物理文件快照与倒退管理器。
 * 负责智能体在大循环中执行敏感写操作前的物理冷备份记录、新增文件拦截、双轨倒退覆写还原与生命周期清理。
 */
export class FileBackupManager {
  /** 可选的显式备份目录覆盖（来自 ApplicationPaths.backupsDir）。 */
  private static _backupsDir: string | null = null;

  /**
   * 设置显式备份目录。由组合根注入 ApplicationPaths.backupsDir。
   * 设置后所有操作使用此目录而非从 workspacePath 推导。
   *
   * @param dir - 备份目录绝对路径
   */
  public static setBackupsDir(dir: string): void {
    FileBackupManager._backupsDir = dir;
  }

  private static getBackupsDir(workspacePath: string): string {
    if (!FileBackupManager._backupsDir) {
      throw new Error(`备份目录尚未通过 ApplicationPaths 注入，拒绝回退到 workspace: ${workspacePath}`);
    }
    return FileBackupManager._backupsDir;
  }

  private static getManifestPath(workspacePath: string): string {
    return join(this.getBackupsDir(workspacePath), 'snapshot_manifest.json');
  }

  private static readManifest(workspacePath: string): SnapshotManifest {
    const manifestPath = this.getManifestPath(workspacePath);
    if (!existsSync(manifestPath)) {
      return { snapshots: [] };
    }
    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      return JSON.parse(raw) as SnapshotManifest;
    } catch {
      return { snapshots: [] };
    }
  }

  private static writeManifest(workspacePath: string, manifest: SnapshotManifest): void {
    const backupsDir = this.getBackupsDir(workspacePath);
    if (!existsSync(backupsDir)) {
      mkdirSync(backupsDir, { recursive: true });
    }
    const manifestPath = this.getManifestPath(workspacePath);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  /**
   * 在工具物理写入前捕获并记录物理快照。
   * 
   * @param snapshotId - 本次快照的唯一标识
   * @param targetPath - 被操作的目标相对或绝对路径
   * @param messageHistoryLength - 触发快照时的内存消息历史长度
   * @param workspacePath - 工作区根路径
   */
  public static captureSnapshot(
    snapshotId: string,
    targetPath: string,
    messageHistoryLength: number,
    workspacePath: string
  ): void {
    const backupsDir = this.getBackupsDir(workspacePath);
    if (!existsSync(backupsDir)) {
      mkdirSync(backupsDir, { recursive: true });
    }

    const manifest = this.readManifest(workspacePath);
    let record = manifest.snapshots.find(s => s.snapshotId === snapshotId);
    if (!record) {
      record = {
        snapshotId,
        timestamp: Date.now(),
        messageHistoryLength,
        backupFiles: [],
        addedFiles: []
      };
      manifest.snapshots.push(record);
    }

    const absoluteTargetPath = resolve(workspacePath, targetPath);

    if (existsSync(absoluteTargetPath)) {
      // 目标文件已存在：执行冷备份
      const alreadyBackedUp = record.backupFiles.some(b => b.originalPath === absoluteTargetPath);
      if (!alreadyBackedUp) {
        const randomId = Math.random().toString(36).substring(2, 10);
        const backupFileName = `backup_${snapshotId}_${randomId}.bak`;
        const absoluteBackupPath = join(backupsDir, backupFileName);
        
        try {
          copyFileSync(absoluteTargetPath, absoluteBackupPath);
          (record.backupFiles as BackupFileMapping[]).push({
            originalPath: absoluteTargetPath,
            backupPath: absoluteBackupPath
          });
          logger.info(`[Backup] 物理文件已备份: ${targetPath} -> ${backupFileName}`);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[Backup] 物理文件备份失败: ${targetPath}, 原因: ${errMsg}`);
        }
      }
    } else {
      // 目标文件不存在：视为即将新建的后增文件，录入清单中以供回退时精确 unlink
      const alreadyAdded = record.addedFiles.includes(absoluteTargetPath);
      if (!alreadyAdded) {
        (record.addedFiles as string[]).push(absoluteTargetPath);
        logger.info(`[Backup] 记录即将新建的后增文件: ${targetPath}`);
      }
    }

    this.writeManifest(workspacePath, manifest);
  }

  /**
   * 将系统回退到指定的快照点，执行物理倒带还原。
   * 
   * @param snapshotId - 目标快照点的 ID
   * @param workspacePath - 工作区根路径
   * @returns 目标快照记录的 messageHistoryLength（即需要截断的内存历史长度水位）
   */
  public static rollbackToSnapshot(snapshotId: string, workspacePath: string): number {
    const manifest = this.readManifest(workspacePath);
    const targetIndex = manifest.snapshots.findIndex(s => s.snapshotId === snapshotId);
    if (targetIndex === -1) {
      throw new Error(`找不到指定的快照记录: ${snapshotId}`);
    }

    const targetRecord = manifest.snapshots[targetIndex];

    // 1. 物理安全检查：回退前检验所有备份物理文件完整性，若损坏则立刻中断，保护最坏可恢复底线
    for (const mapping of targetRecord.backupFiles) {
      if (!existsSync(mapping.backupPath)) {
        throw new Error(`备份文件损坏或不存在，终止回滚倒带: ${mapping.backupPath}`);
      }
    }

    // 2. 物理还原：将备份写回覆盖脏文件
    for (const mapping of targetRecord.backupFiles) {
      try {
        copyFileSync(mapping.backupPath, mapping.originalPath);
        logger.info(`[Backup] 已物理写回恢复文件: ${mapping.originalPath}`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`回滚写回文件失败: ${mapping.originalPath}, 原因: ${errMsg}`, { cause: err });
      }
    }

    // 3. 物理拔除：收集在该快照点之后所有后续快照记录中被记录为 addedFiles 的后增文件，执行 unlink
    const addedFilesToUnlink = new Set<string>();
    for (let i = targetIndex; i < manifest.snapshots.length; i++) {
      const snap = manifest.snapshots[i];
      for (const addedPath of snap.addedFiles) {
        addedFilesToUnlink.add(addedPath);
      }
    }

    // 排除当前已还原恢复的文件
    for (const mapping of targetRecord.backupFiles) {
      addedFilesToUnlink.delete(mapping.originalPath);
    }

    for (const pathToDelete of addedFilesToUnlink) {
      if (existsSync(pathToDelete)) {
        try {
          unlinkSync(pathToDelete);
          logger.info(`[Backup] 已物理 unlink 拔除新增文件: ${pathToDelete}`);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn(`[Backup] 物理删除新增文件失败: ${pathToDelete}, 原因: ${errMsg}`);
        }
      }
    }

    // 4. 清理配置清单中此快照之后的记录
    manifest.snapshots = manifest.snapshots.slice(0, targetIndex + 1);
    this.writeManifest(workspacePath, manifest);

    return targetRecord.messageHistoryLength;
  }

  /**
   * 优雅清理自毁：彻底物理销毁备份目录，防范磁盘膨胀。
   * 
   * @param workspacePath - 工作区根路径
   */
  public static cleanup(workspacePath: string): void {
    const backupsDir = this.getBackupsDir(workspacePath);
    if (existsSync(backupsDir)) {
      try {
        rmSync(backupsDir, { recursive: true, force: true });
        logger.info('[Backup] 备份临时沙箱目录已安全物理销毁自毁。');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`[Backup] 自毁备份临时沙箱目录失败: ${errMsg}`);
      }
    }
  }
}
