/**
 * @file 真实文件工具权限适配器覆盖测试。
 * 核对工厂装配、稳定身份、普通 Edit 与 destructive 分类，以及范围外目录动作。
 */

import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNativeTools } from '../../../src/adapters/tools/tool-factory.js';
import { initWorkspace } from '../../../src/adapters/tools/impl/base.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../../src/core/domain/permissions/trusted-call-context.js';
import { renderApprovalActionChoice } from '../../../src/adapters/tools/toolRegistry.js';

describe('真实文件工具权限适配器', () => {
  const expectedIdentities = new Map([
    ['readFile', 'FileRead'],
    ['writeFile', 'FileWrite'],
    ['editFile', 'FileEdit'],
    ['applyPatch', 'FileEdit'],
    ['createDirectory', 'FileCreate'],
    ['deletePath', 'FileDelete'],
    ['movePath', 'FileMove'],
    ['copyPath', 'FileCopy'],
  ]);

  it('文件工具工厂装配应逐一绑定稳定身份和运行时名称', () => {
    const tools = new Map(buildNativeTools().map(tool => [tool.name, tool]));
    for (const [toolName, identity] of expectedIdentities) {
      const adapter = tools.get(toolName)?.authorizationAdapter;
      expect(adapter?.runtimeToolName).toBe(toolName);
      expect(adapter?.permissionIdentity).toBe(identity);
    }
  });

  it('范围外普通编辑应提供显式目录加 Accept edits 组合动作', () => {
    initWorkspace(process.cwd());
    const caller = createTrustedCallContext('file-adapter-external', 'interactive');
    const adapter = buildNativeTools()
      .find(tool => tool.name === 'writeFile')!
      .authorizationAdapter!;
    const targetPath = resolve(process.cwd(), '..', 'external-edit', 'file.ts');
    const request = adapter.buildPermissionRequest({ targetPath }, { caller });
    const options = adapter.buildApprovalOptions(
      request,
      new PermissionSessionState({ mode: 'default' }),
    );

    expect(options.map(option => option.type)).toEqual([
      'allowOnce',
      'allowAndSetModeWithDirectories',
      'deny',
    ]);
    expect(options[1]).toMatchObject({
      type: 'allowAndSetModeWithDirectories',
      mode: 'acceptEdits',
      directories: [dirname(targetPath)],
    });
  });

  it('destructive 文件工具不得提供 Accept edits 或目录扩权动作', () => {
    const tools = new Map(buildNativeTools().map(tool => [tool.name, tool]));
    const state = new PermissionSessionState({ mode: 'default' });
    for (const toolName of ['deletePath', 'movePath', 'copyPath']) {
      const adapter = tools.get(toolName)!.authorizationAdapter!;
      const request = adapter.buildPermissionRequest(
        toolName === 'deletePath'
          ? { targetPath: 'target' }
          : { sourcePath: 'source', destinationPath: 'destination' },
      );
      const actionTypes = adapter.buildApprovalOptions(request, state)
        .map(option => option.type);
      expect(actionTypes).toEqual(['allowOnce', 'deny']);
    }
  });

  it('组合动作渲染必须使用用户模式标签并显示完整目录范围', () => {
    const choice = renderApprovalActionChoice({
      type: 'allowAndSetModeWithDirectories',
      mode: 'acceptEdits',
      directories: ['D:\\shared\\project'],
    });

    expect(choice.label).toContain('Accept edits on');
    expect(choice.description).toContain('Accept edits on');
    expect(choice.description).toContain('D:\\shared\\project');
    expect(choice.description).not.toContain('acceptEdits');
  });
});
