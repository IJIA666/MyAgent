/**
 * @file new-tools.test.ts
 * @description 新增的 9 个原生内置工具链的单元测试套件。
 * 覆盖目录创建、安全路径删除（带人机审核挂起）、复制、移动、批量多文件读取（包含体积熔断及拒签自适应返回）、双轨修补以及 Git 只读感知工具。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { initWorkspace } from '../../src/adapters/tools/tools.js';
import { CreateDirectoryTool, DeletePathTool, MovePathTool, CopyPathTool } from '../../src/adapters/tools/tools/filesystem/directory-manager.js';
import { ReadManyFilesTool } from '../../src/adapters/tools/tools/filesystem/read-many-files.js';
import { ApplyPatchTool } from '../../src/adapters/tools/tools/filesystem/apply-patch.js';
import { GitShowStatusTool } from '../../src/adapters/tools/tools/git/git-show-status.js';
import { GitShowDiffTool } from '../../src/adapters/tools/tools/git/git-show-diff.js';
import { GitShowLogTool } from '../../src/adapters/tools/tools/git/git-show-log.js';
import { ApprovalService } from '../../src/core/usecases/ApprovalService.js';
import { ReadFileTool } from '../../src/adapters/tools/tools/filesystem/file-system.js';

describe('新增原生内置工具单元测试', () => {
  const testDir = resolve('./test_action_new_tools_temp');
  let approvalService: ApprovalService;

  beforeAll(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    initWorkspace(testDir);
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    approvalService = new ApprovalService(false);
    // 重置 ReadFileState
    ReadFileTool.readFileState.clear();
  });

  // ==========================================
  // 1. CreateDirectoryTool
  // ==========================================
  test('CreateDirectoryTool - 递归创建目录与越权限制', () => {
    const tool = new CreateDirectoryTool();
    
    // 正常递归创建
    const res = tool.execute({ directoryPath: 'subdir/nested/dir' });
    expect(res).toContain('目录递归创建成功');
    expect(existsSync(join(testDir, 'subdir/nested/dir'))).toBe(true);

    // 重复创建提示
    const resDuplicate = tool.execute({ directoryPath: 'subdir/nested/dir' });
    expect(resDuplicate).toContain('目录已存在，无需重复创建');

    // 安全越权限制
    expect(() => tool.execute({ directoryPath: '../../outside_dir' })).toThrow('拒绝访问');
  });

  // ==========================================
  // 2. DeletePathTool
  // ==========================================
  test('DeletePathTool - 删除路径与安全越权/确权挂起拦截', async () => {
    const tool = new DeletePathTool();
    const filePath = join(testDir, 'delete_me.txt');
    writeFileSync(filePath, 'delete content');

    // 1. 越权拦截
    await expect(tool.execute({ targetPath: '../../outside.txt' })).rejects.toThrow('拒绝访问');

    // 2. 挂起放行 (once)
    const mockContext = {
      waitApproval: async (
        approvalId: string,
        actionInfo: { name: string; arguments?: Record<string, unknown> },
        options: unknown,
        warningMsg?: string
      ) => {
        return approvalService.wait(approvalId, actionInfo, options, warningMsg);
      }
    };
    const waitPromise = tool.execute({ targetPath: 'delete_me.txt' }, mockContext);
    
    // 挂起中，文件仍应该存在
    expect(existsSync(filePath)).toBe(true);

    // 模拟用户在控制台按下放行
    const pendingId = Array.from((approvalService as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals.keys())[0];
    expect(pendingId).toBeDefined();
    approvalService.resolve(pendingId, { action: 'once' });

    const deleteRes = await waitPromise;
    expect(deleteRes).toContain('路径删除成功');
    expect(existsSync(filePath)).toBe(false);

    // 3. 挂起拒绝 (deny)
    const filePath2 = join(testDir, 'delete_me_2.txt');
    writeFileSync(filePath2, 'delete content 2');
    const waitPromise2 = tool.execute({ targetPath: 'delete_me_2.txt' }, mockContext);

    const pendingId2 = Array.from((approvalService as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals.keys())[0];
    approvalService.resolve(pendingId2, { action: 'deny' });

    await expect(waitPromise2).rejects.toThrow('用户拒绝了删除路径的操作');
    expect(existsSync(filePath2)).toBe(true);
  });

  // ==========================================
  // 3. MovePathTool and CopyPathTool
  // ==========================================
  test('MovePathTool & CopyPathTool - 文件复制与转移', () => {
    const moveTool = new MovePathTool();
    const copyTool = new CopyPathTool();

    const srcFile = 'src_move.txt';
    const destFile = 'subdir/dest_move.txt';
    const srcAbs = join(testDir, srcFile);
    const destAbs = join(testDir, destFile);

    writeFileSync(srcAbs, 'hello transfer');

    // 1. 复制操作
    const copyRes = copyTool.execute({ sourcePath: srcFile, destinationPath: destFile });
    expect(copyRes).toContain('成功将');
    expect(readFileSync(destAbs, 'utf-8')).toBe('hello transfer');
    expect(existsSync(srcAbs)).toBe(true); // 复制后源文件应该还在

    // 2. 移动操作
    rmSync(destAbs);
    const moveRes = moveTool.execute({ sourcePath: srcFile, destinationPath: destFile });
    expect(moveRes).toContain('成功将');
    expect(readFileSync(destAbs, 'utf-8')).toBe('hello transfer');
    expect(existsSync(srcAbs)).toBe(false); // 移动后源文件应该不在了

    // 3. 越权报错
    expect(() => copyTool.execute({ sourcePath: srcFile, destinationPath: '../../outside_copy' })).toThrow('拒绝访问');
    expect(() => moveTool.execute({ sourcePath: srcFile, destinationPath: '../../outside_move' })).toThrow('拒绝访问');
  });

  // ==========================================
  // 4. ReadManyFilesTool
  // ==========================================
  test('ReadManyFilesTool - 批量多文件读取与前置熔断/拒签大纲机制', () => {
    const readManyTool = new ReadManyFilesTool();
    
    // 写入几个测试文件
    const file1 = 'f1.ts';
    const file2 = 'f2.txt';
    writeFileSync(join(testDir, file1), 'export class Worker {\n  work() {}\n}\n');
    writeFileSync(join(testDir, file2), 'just text content\n'.repeat(10));

    // 正常读取（未超 50,000 字符）
    const res = readManyTool.execute({ targetPaths: `${file1},${file2}` });
    expect(res).toContain('Worker');
    expect(res).toContain('just text content');

    // 超限熔断（这里模拟超限，我们把熔断字符门槛在测试里通过大体积文件触发）
    // 构造一个包含 55,000 字符的超大文件
    const largeFile = 'large.ts';
    const largeContent = 'export class HeavyObject {\n  // empty\n}\n' + 'A'.repeat(51000);
    writeFileSync(join(testDir, largeFile), largeContent);

    try {
      readManyTool.execute({ targetPaths: largeFile });
      expect.fail('应该触发 Size limit exceeded 熔断错误');
    } catch (err: unknown) {
      expect((err as Error).message).toContain('Size limit exceeded');
      const payload = JSON.parse((err as Error).message.replace('Size limit exceeded\n', ''));
      expect(payload.error).toBe('Size limit exceeded');
      expect(payload.files[0].relativePath).toBe(largeFile);
      expect(payload.files[0].outlineType).toBe('regex_outline');
      expect(payload.files[0].outline).toContain('class HeavyObject');
    }

    // 越权校验
    expect(() => readManyTool.execute({ targetPaths: '../../outside.txt' })).toThrow('拒绝访问');
  });

  // ==========================================
  // 5. ApplyPatchTool
  // ==========================================
  test('ApplyPatchTool - 双轨补丁与滑动窗口特征替换', () => {
    const patchTool = new ApplyPatchTool();
    const filePath = 'patch_test.ts';
    const absPath = join(testDir, filePath);
    const initialContent = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    writeFileSync(absPath, initialContent);

    // 1. 未读读取安全校验拦截
    expect(() => patchTool.execute({
      targetPath: filePath,
      patchMode: 'replace',
      patchContent: 'new line 3',
      expectedContent: 'line 3'
    })).toThrow('在修改已有文件前，必须先调用 readFile 工具阅读该文件的最新内容。');

    // 记录已读状态以通过安全前置拦截
    ReadFileTool.readFileState.set(absPath, { mtimeMs: 123 });

    // 2. 正常 replace 特征块匹配替换
    const replaceRes = patchTool.execute({
      targetPath: filePath,
      patchMode: 'replace',
      patchContent: 'line 2\n[replaced line 3]\nline 4',
      startLine: 2,
      endLine: 4,
      expectedContent: 'line 2\nline 3\nline 4'
    });
    expect(replaceRes).toContain('特征签名对齐块替换成功');
    expect(readFileSync(absPath, 'utf-8')).toBe('line 1\nline 2\n[replaced line 3]\nline 4\nline 5\n');

    // 3. 特征对齐有多处冲突时报错熔断
    writeFileSync(absPath, 'same line\nsame line\n');
    ReadFileTool.readFileState.set(absPath, { mtimeMs: 124 });
    expect(() => patchTool.execute({
      targetPath: filePath,
      patchMode: 'replace',
      patchContent: 'change same',
      startLine: 1,
      endLine: 2,
      expectedContent: 'same line'
    })).toThrow('匹配到了多于 1 处');

    // 4. 特征对齐未匹配到报错熔断
    expect(() => patchTool.execute({
      targetPath: filePath,
      patchMode: 'replace',
      patchContent: 'change',
      startLine: 1,
      endLine: 2,
      expectedContent: 'nonexistent line'
    })).toThrow('未匹配到 expectedContent 的特征签名行');

    // 5. strict 严格模式测试
    const fileToPatch = 'strict_patch_test.txt';
    const fileToPatchAbs = join(testDir, fileToPatch);
    writeFileSync(fileToPatchAbs, 'first line\nsecond line\nthird line\n');
    ReadFileTool.readFileState.set(fileToPatchAbs, { mtimeMs: 125 });

    const diffContent = 
`--- strict_patch_test.txt
+++ strict_patch_test.txt
@@ -1,3 +1,3 @@
 first line
-second line
+modified second line
 third line`;

    const strictRes = patchTool.execute({
      targetPath: fileToPatch,
      patchMode: 'strict',
      patchContent: diffContent
    });
    expect(strictRes).toContain('严格补丁应用成功');
    expect(readFileSync(fileToPatchAbs, 'utf-8')).toBe('first line\nmodified second line\nthird line\n');
  });

  // ==========================================
  // 6. 只读 Git 辅助工具
  // ==========================================
  test('GitShowStatusTool, GitShowDiffTool, GitShowLogTool - 只读感知测试', () => {
    // 实例化 Git 工具
    const statusTool = new GitShowStatusTool();
    const diffTool = new GitShowDiffTool();
    const logTool = new GitShowLogTool();

    // 在真实的 git 仓库环境下执行（当前工作区肯定有 git 仓库），直接运行不应抛出写指令
    const statusRes = statusTool.execute();
    expect(statusRes).toBeDefined();
    // 应当是 JSON 格式
    const parsedStatus = JSON.parse(statusRes);
    expect(parsedStatus.modified).toBeInstanceOf(Array);

    const logRes = logTool.execute({ limit: 2 });
    expect(logRes).toBeDefined();

    const diffRes = diffTool.execute({ staged: false });
    expect(diffRes).toBeDefined();
  });
});
