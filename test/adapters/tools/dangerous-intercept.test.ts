import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { LocalFileSystemMcpServer } from '../../../src/adapters/tools/virtual-mcp.js';
import { SessionContext } from '../../../src/core/domain/context.js';
import { initWorkspace } from '../../../src/adapters/tools/impl/base.js';

describe('高危操作安全硬拦截单元测试', () => {
  let mcpServer: LocalFileSystemMcpServer;
  let sessionContext: SessionContext;
  const testWorkspace = resolve('d:\\Projects\\MyAgent');

  beforeEach(() => {
    // 确保工作区正确初始化
    initWorkspace(testWorkspace);
    mcpServer = new LocalFileSystemMcpServer();
    sessionContext = new SessionContext('test-session-dangerous');
    // 强制关闭 bypass 模式以验证拦截挂起机制
    sessionContext.approvalService.setBypassMode(false);
  });

  it('1. 调用 deletePath 工具时，应该触发审批挂起并在拒绝时被成功拦截', async () => {
    // 注册审批提问处理器
    const handler = vi.fn((id) => {
      // 使用 setTimeout 延迟 resolve，避免在 wait 还没存入 pendingApprovals 映射表时的时序冲突
      setTimeout(() => {
        sessionContext.approvalService.resolve(id, { action: 'deny' });
      }, 0);
    });
    sessionContext.approvalService.registerApprovalHandler(handler);

    const callResult = await mcpServer.callTool({
      name: 'deletePath',
      arguments: { targetPath: 'test_temp_delete_file.txt' }
    }, sessionContext);

    // 验证审批提问回调被触发
    expect(handler).toHaveBeenCalled();
    // 验证返回结果是错误，且包含用户拒绝信息
    expect(callResult.isError).toBe(true);
    expect(callResult.content[0].text).toContain('用户拒绝了高危操作');
  });

  it('2. 调用 deletePath 工具时，如果审批放行则应该执行成功', async () => {
    const tempFilePath = resolve(testWorkspace, 'test_temp_delete_success.txt');
    writeFileSync(tempFilePath, 'temp_content', 'utf-8');

    // 注册审批提问处理器
    const handler = vi.fn((id) => {
      // 使用 setTimeout 延迟 resolve
      setTimeout(() => {
        sessionContext.approvalService.resolve(id, { action: 'once' });
      }, 0);
    });
    sessionContext.approvalService.registerApprovalHandler(handler);

    const callResult = await mcpServer.callTool({
      name: 'deletePath',
      arguments: { targetPath: 'test_temp_delete_success.txt' }
    }, sessionContext);

    // 验证审批通过后，文件被成功删除，返回成功
    expect(handler).toHaveBeenCalled();
    expect(callResult.isError).toBeUndefined();
    expect(existsSync(tempFilePath)).toBe(false);
  });

  it('3. 调用 writeFile 且文件已存在时，应该作为覆盖动作触发审批拦截并在拒绝时失败', async () => {
    const tempFilePath = resolve(testWorkspace, 'test_temp_overwrite.txt');
    writeFileSync(tempFilePath, 'original_content', 'utf-8');

    // 注册审批提问处理器，模拟用户拒绝
    const handler = vi.fn((id) => {
      setTimeout(() => {
        sessionContext.approvalService.resolve(id, { action: 'deny' });
      }, 0);
    });
    sessionContext.approvalService.registerApprovalHandler(handler);

    const callResult = await mcpServer.callTool({
      name: 'writeFile',
      arguments: { targetPath: 'test_temp_overwrite.txt', content: 'new_content' }
    }, sessionContext);

    expect(handler).toHaveBeenCalled();
    expect(callResult.isError).toBe(true);
    expect(callResult.content[0].text).toContain('用户拒绝了高危操作');

    // 验证文件内容未被修改
    expect(existsSync(tempFilePath)).toBe(true);
    // 清理临时文件
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }
  });

  it('4. 调用 writeFile 且文件不存在时，不应该触发审批，直接写入成功', async () => {
    const tempFilePath = resolve(testWorkspace, 'test_temp_new_write.txt');
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }

    const handler = vi.fn();
    sessionContext.approvalService.registerApprovalHandler(handler);

    const callResult = await mcpServer.callTool({
      name: 'writeFile',
      arguments: { targetPath: 'test_temp_new_write.txt', content: 'fresh_content' }
    }, sessionContext);

    // 验证未触发审批提问
    expect(handler).not.toHaveBeenCalled();
    expect(callResult.isError).toBeUndefined();
    expect(existsSync(tempFilePath)).toBe(true);

    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }
  });
});
