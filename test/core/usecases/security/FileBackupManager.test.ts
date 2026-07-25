/**
 * @fileoverview FileBackupManager 的单元测试，验证物理冷备份、后增文件追踪、回滚覆盖与 unlink 拔除以及自毁清理。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileBackupManager } from '../../../../src/core/usecases/security/FileBackupManager.js';

describe('FileBackupManager', () => {
  let tempWorkspace: string;
  let backupsDir: string;
  const snapshotId = 'test-snapshot-123';

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-manager-test-'));
    backupsDir = path.join(tempWorkspace, 'app-data', 'backups');
    FileBackupManager.setBackupsDir(backupsDir);
  });

  afterEach(() => {
    if (tempWorkspace && fs.existsSync(tempWorkspace)) {
      FileBackupManager.cleanup(tempWorkspace);
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  it('当目标物理文件存在时，应执行物理冷备份并记录在 backupFiles 清单中', () => {
    const targetFile = path.join(tempWorkspace, 'hello.txt');
    fs.writeFileSync(targetFile, 'original content', 'utf-8');

    // 捕获快照
    FileBackupManager.captureSnapshot(snapshotId, 'hello.txt', 5, tempWorkspace);

    // 校验备份目录和清单是否存在
    expect(fs.existsSync(backupsDir)).toBe(true);

    const manifestPath = path.join(backupsDir, 'snapshot_manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.snapshots.length).toBe(1);

    const record = manifest.snapshots[0];
    expect(record.snapshotId).toBe(snapshotId);
    expect(record.messageHistoryLength).toBe(5);
    expect(record.backupFiles.length).toBe(1);
    expect(record.addedFiles.length).toBe(0);

    const backupMapping = record.backupFiles[0];
    expect(backupMapping.originalPath).toBe(path.resolve(tempWorkspace, 'hello.txt'));
    expect(fs.existsSync(backupMapping.backupPath)).toBe(true);
    expect(fs.readFileSync(backupMapping.backupPath, 'utf-8')).toBe('original content');
  });

  it('当目标文件不存在时，应记录在 addedFiles 清单中', () => {
    const newFile = 'new_file.txt';

    // 捕获快照
    FileBackupManager.captureSnapshot(snapshotId, newFile, 8, tempWorkspace);

    const manifestPath = path.join(backupsDir, 'snapshot_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    const record = manifest.snapshots[0];
    expect(record.backupFiles.length).toBe(0);
    expect(record.addedFiles.length).toBe(1);
    expect(record.addedFiles[0]).toBe(path.resolve(tempWorkspace, newFile));
  });

  it('执行回滚时，应覆盖已修改的脏文件，物理拔除新增文件，并返回对应的历史长度基准', () => {
    const editFile = path.join(tempWorkspace, 'edit.txt');
    fs.writeFileSync(editFile, 'good original content', 'utf-8');

    const snapId = 'snap-checkpoint';

    // 1. 写操作前捕获快照
    FileBackupManager.captureSnapshot(snapId, 'edit.txt', 12, tempWorkspace);
    FileBackupManager.captureSnapshot(snapId, 'newly_created.txt', 12, tempWorkspace);

    // 2. 模拟工具执行写操作与新增文件
    fs.writeFileSync(editFile, 'dirty modified content', 'utf-8');
    const newlyCreatedFile = path.join(tempWorkspace, 'newly_created.txt');
    fs.writeFileSync(newlyCreatedFile, 'new file content', 'utf-8');

    // 确认现状是脏工作区
    expect(fs.readFileSync(editFile, 'utf-8')).toBe('dirty modified content');
    expect(fs.existsSync(newlyCreatedFile)).toBe(true);

    // 3. 物理回滚倒带
    const messageHistoryLength = FileBackupManager.rollbackToSnapshot(snapId, tempWorkspace);

    // 4. 验证一致性倒带结果
    expect(messageHistoryLength).toBe(12);
    // 脏改文件是否被覆盖恢复为原始内容
    expect(fs.readFileSync(editFile, 'utf-8')).toBe('good original content');
    // 新增文件是否被物理 unlink 拔除
    expect(fs.existsSync(newlyCreatedFile)).toBe(false);
  });

  it('当备份物理文件在回滚前被恶意损毁或删除时，应报错终止，不执行倒带覆盖', () => {
    const file = path.join(tempWorkspace, 'important.txt');
    fs.writeFileSync(file, 'original', 'utf-8');

    FileBackupManager.captureSnapshot(snapshotId, 'important.txt', 10, tempWorkspace);

    // 模拟物理删除备份文件
    const manifestPath = path.join(backupsDir, 'snapshot_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const backupPath = manifest.snapshots[0].backupFiles[0].backupPath;

    fs.unlinkSync(backupPath);

    // 触发回退，预期抛出异常
    expect(() => {
      FileBackupManager.rollbackToSnapshot(snapshotId, tempWorkspace);
    }).toThrow('备份文件损坏或不存在，终止回滚倒带');

    // 物理文件内容不应被还原覆盖（防备部分成功导致的脏状态）
    expect(fs.readFileSync(file, 'utf-8')).toBe('original');
  });

  it('调用 cleanup 时，应自毁清空 backups 临时沙箱目录', () => {
    const targetFile = path.join(tempWorkspace, 'test.txt');
    fs.writeFileSync(targetFile, 'data', 'utf-8');

    FileBackupManager.captureSnapshot(snapshotId, 'test.txt', 1, tempWorkspace);

    expect(fs.existsSync(backupsDir)).toBe(true);

    // 执行清理
    FileBackupManager.cleanup(tempWorkspace);
    expect(fs.existsSync(backupsDir)).toBe(false);
  });
});
