/**
 * @file dangerous-intercept.test.ts
 * @description 验证统一本地工具运行时中的高危写操作审批拦截行为。
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../../src/adapters/tools/toolRegistry.js';
import { SessionContext } from '../../../src/core/domain/context.js';
import { initWorkspace } from '../../../src/adapters/tools/impl/base.js';
import { ReadFileTool } from '../../../src/adapters/tools/impl/filesystem/file-system.js';

describe('高危操作安全硬拦截单元测试', () => {
  let toolRegistry: ToolRegistry;
  let sessionContext: SessionContext;
  const testWorkspace = mkdtempSync(join(tmpdir(), 'dangerous-intercept-'));

  afterAll(() => {
    // 清理测试工作区及其父目录中的临时白名单文件。
    rmSync(testWorkspace, { recursive: true, force: true });
    rmSync(join(testWorkspace, '..', 'test_temp_whitelist_write.txt'), { force: true });
  });

  /** 构建统一本地工具运行时，避免测试继续依赖 virtual-mcp 适配层。 */
  function createToolRegistry(): ToolRegistry {
    return new ToolRegistry();
  }

  beforeEach(() => {
    // 确保测试物理工作区目录在磁盘上真实存在
    if (!existsSync(testWorkspace)) {
      mkdirSync(testWorkspace, { recursive: true });
    }
    // 确保工作区正确初始化
    initWorkspace(testWorkspace);
    toolRegistry = createToolRegistry();
    sessionContext = new SessionContext('test-session-dangerous');
    ReadFileTool.readFileState.clear();
  });

  it('1. 调用 deletePath 工具时，应该触发审批挂起并在拒绝时被成功拦截', async () => {
    // 注册审批提问处理器
    const handler = vi.fn((id) => {
      // 使用 setTimeout 延迟 resolve，避免在 wait 还没存入 pendingApprovals 映射表时的时序冲突
      setTimeout(() => {
        sessionContext.approvalInteraction.resolve(id, { action: 'deny' });
      }, 0);
    });
    sessionContext.approvalInteraction.registerApprovalHandler(handler);

    await expect(toolRegistry.callTool(
      'deletePath',
      { targetPath: 'test_temp_delete_file.txt' },
      sessionContext
    )).rejects.toThrow('审批拒绝');

    // 验证审批提问回调被触发
    expect(handler).toHaveBeenCalled();
  });

  it('2. 调用 deletePath 工具时，如果审批放行则应该执行成功', async () => {
    const tempFilePath = resolve(testWorkspace, 'test_temp_delete_success.txt');
    writeFileSync(tempFilePath, 'temp_content', 'utf-8');

    // 注册审批提问处理器
    const handler = vi.fn((id) => {
      // 使用 setTimeout 延迟 resolve
      setTimeout(() => {
        sessionContext.approvalInteraction.resolve(id, { action: 'allowOnce' });
      }, 0);
    });
    sessionContext.approvalInteraction.registerApprovalHandler(handler);

    const callResult = await toolRegistry.callTool(
      'deletePath',
      { targetPath: 'test_temp_delete_success.txt' },
      sessionContext
    );

    // 验证审批通过后，文件被成功删除，返回成功
    expect(handler).toHaveBeenCalled();
    expect(callResult.value).toBeDefined();
    expect(existsSync(tempFilePath)).toBe(false);
  });

  it('3. 调用 writeFile 且文件已存在时，应该作为覆盖动作触发审批拦截并在拒绝时失败', async () => {
    const tempFilePath = resolve(testWorkspace, 'test_temp_overwrite.txt');
    writeFileSync(tempFilePath, 'original_content', 'utf-8');

    // 注册审批提问处理器，模拟用户拒绝
    const handler = vi.fn((id) => {
      setTimeout(() => {
        sessionContext.approvalInteraction.resolve(id, { action: 'deny' });
      }, 0);
    });
    sessionContext.approvalInteraction.registerApprovalHandler(handler);

    await expect(toolRegistry.callTool(
      'writeFile',
      { targetPath: 'test_temp_overwrite.txt', content: 'new_content' },
      sessionContext
    )).rejects.toThrow('审批拒绝');

    expect(handler).toHaveBeenCalled();

    // 验证文件内容未被修改
    expect(existsSync(tempFilePath)).toBe(true);
    // 清理临时文件
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }
  });

  it('4. 调用 writeFile 且文件不存在时，不应该触发审批，直接写入成功', async () => {
    sessionContext.setPermissionMode('bypassPermissions');
    const tempFilePath = resolve(testWorkspace, 'test_temp_new_write.txt');
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }

    const handler = vi.fn();
    sessionContext.approvalInteraction.registerApprovalHandler(handler);

    const callResult = await toolRegistry.callTool(
      'writeFile',
      { targetPath: 'test_temp_new_write.txt', content: 'fresh_content' },
      sessionContext
    );

    // 验证未触发审批提问
    expect(handler).not.toHaveBeenCalled();
    expect(callResult.value).toBeDefined();
    expect(existsSync(tempFilePath)).toBe(true);

    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }
  });

  it('5. bypass 模式的工作区外精确写入应由本次 ExecutionPlan 承载，不依赖临时白名单', async () => {
    sessionContext.setPermissionMode('bypassPermissions');
    const outsideFilePath = resolve(testWorkspace, '..', 'test_temp_whitelist_write.txt');
    writeFileSync(outsideFilePath, 'original_content', 'utf-8');
    ReadFileTool.readFileState.set(outsideFilePath, { mtimeMs: Date.now() });

    const handler = vi.fn();
    sessionContext.approvalInteraction.registerApprovalHandler(handler);

    const callResult = await toolRegistry.callTool(
      'writeFile',
      { targetPath: '../test_temp_whitelist_write.txt', content: 'updated_content' },
      sessionContext,
      undefined,
      undefined,
      'tool-call-whitelist'
    );

    expect(handler).not.toHaveBeenCalled();
    expect(callResult.value).toBeDefined();
    expect(callResult.value).toBeDefined();

    if (existsSync(outsideFilePath)) {
      unlinkSync(outsideFilePath);
    }
  });

  it('6. 选择“允许并开启 Accept edits on”后，本会话后续普通编辑应自动执行', async () => {
    const firstPath = resolve(testWorkspace, 'accept-edits-first.txt');
    const secondPath = resolve(testWorkspace, 'accept-edits-second.txt');
    const observedChoices: string[][] = [];
    const handler = vi.fn((
      id: string,
      _toolCall: unknown,
      _prefix: string | undefined,
      _message: string | undefined,
      choices: Array<{ choiceId: string }> | undefined,
    ) => {
      observedChoices.push(choices?.map(choice => choice.choiceId) ?? []);
      sessionContext.approvalInteraction.resolve(id, {
        action: 'allowAndSetMode',
      });
    });
    sessionContext.approvalInteraction.registerApprovalHandler(handler);

    try {
      await toolRegistry.callTool(
        'writeFile',
        { targetPath: 'accept-edits-first.txt', content: 'first' },
        sessionContext,
      );
      expect(sessionContext.getPermissionMode()).toBe('acceptEdits');
      expect(observedChoices[0]).toEqual([
        'allowOnce',
        'allowAndSetMode',
        'deny',
      ]);

      await toolRegistry.callTool(
        'writeFile',
        { targetPath: 'accept-edits-second.txt', content: 'second' },
        sessionContext,
      );
      expect(handler).toHaveBeenCalledTimes(1);
      expect(existsSync(secondPath)).toBe(true);
    } finally {
      rmSync(firstPath, { force: true });
      rmSync(secondPath, { force: true });
    }
  });
});
