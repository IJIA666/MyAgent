/**
 * @file Claude 默认 Auto Memory 文件权限测试。
 * 验证默认根读写免审批、父目录不继承以及显式 deny 仍可压制内置特例。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EditFileTool,
  ReadFileTool,
  WriteFileTool,
} from '../../../../src/adapters/tools/impl/filesystem/file-system.js';
import { ApplyPatchTool } from '../../../../src/adapters/tools/impl/filesystem/apply-patch.js';
import {
  CreateDirectoryTool,
  DeletePathTool,
} from '../../../../src/adapters/tools/impl/filesystem/directory-manager.js';
import { initWorkspace } from '../../../../src/adapters/tools/impl/base.js';
import { PermissionRuleStore } from '../../../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../../../src/core/domain/permissions/tool-permission-service.js';
import { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import { writeFileAdapter } from '../../../../src/adapters/tools/permissions/file-tool-authorization.js';
import { createTrustedCallContext } from '../../../../src/core/domain/permissions/trusted-call-context.js';
import { secureResolveReadPath } from '../../../../src/adapters/tools/impl/base.js';
import { ToolRegistry } from '../../../../src/adapters/tools/toolRegistry.js';
import { SessionContext } from '../../../../src/core/domain/context.js';

describe('默认 Auto Memory 权限', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** 创建互相隔离的工作区、项目数据根和默认记忆根。 */
  function createPaths(): { workspace: string; projectData: string; memory: string } {
    const root = mkdtempSync(join(tmpdir(), 'myagent-memory-permission-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const projectData = join(root, 'project-data');
    const memory = join(projectData, 'memory');
    initWorkspace(workspace, memory);
    return { workspace, projectData, memory };
  }

  it('默认根内 Read/Edit/Write/createDirectory/applyPatch 应直接 allow', async () => {
    const { memory } = createPaths();
    const cases = [
      [new ReadFileTool(), { targetPath: join(memory, 'MEMORY.md') }],
      [new WriteFileTool(), { targetPath: join(memory, 'MEMORY.md') }],
      [new EditFileTool(), { targetPath: join(memory, 'MEMORY.md') }],
      [new CreateDirectoryTool(), { directoryPath: join(memory, 'topics') }],
      [new ApplyPatchTool(), { targetPath: join(memory, 'MEMORY.md') }],
    ] as const;

    for (const [tool, args] of cases) {
      await expect(Promise.resolve(tool.checkPermissions?.(args))).resolves.toMatchObject({ kind: 'allow' });
    }
  });

  it('默认根的父目录和删除操作不得继承维护写特权', async () => {
    const { projectData, memory } = createPaths();

    expect(new WriteFileTool().checkPermissions({
      targetPath: join(projectData, 'settings.json'),
    })).toMatchObject({ kind: 'ask' });
    expect(new DeletePathTool().checkPermissions({
      targetPath: join(memory, 'MEMORY.md'),
    })).toMatchObject({ kind: 'ask' });
  });

  it('显式 deny 应先于默认记忆 allow 生效', async () => {
    const { memory } = createPaths();
    const tool = new WriteFileTool();
    const rules = new PermissionRuleStore();
    rules.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'writeFile' },
    });
    const state = new PermissionSessionState({ rules: rules.getAllRules() });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const args = { targetPath: join(memory, 'MEMORY.md') };

    const decision = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(args),
      state,
      {
        caller: createTrustedCallContext('memory-test', 'interactive'),
        toolResult: tool.checkPermissions(args),
      },
    );

    expect(decision).toMatchObject({
      kind: 'deny',
      matchedRule: { source: 'userSettings' },
    });
  });

  it('内部候选 provenance 暂存区不得继承默认 memory 写特例', async () => {
    const { memory } = createPaths();
    const state = new PermissionSessionState({ mode: 'bypassPermissions' });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const caller = createTrustedCallContext('candidate-protection', 'interactive');
    const targetPath = join(memory, '.candidates', 'forged.json');
    const request = writeFileAdapter.buildPermissionRequest(
      { targetPath, content: '{"forged":true}' },
      { caller },
    );

    const decision = await service.checkRequest(request, state, {
      caller,
      toolResult: new WriteFileTool().checkPermissions({ targetPath }),
    });

    expect(decision).toMatchObject({
      kind: 'deny',
      decisionSource: 'invariant',
      overridable: false,
    });
  });

  it('自定义根允许读取和路径访问，但维护写入仍返回 ask', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagent-custom-memory-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const customMemory = join(root, 'custom-memory');
    initWorkspace(workspace, customMemory, 'custom');

    const memoryFile = join(customMemory, 'MEMORY.md');
    expect(new ReadFileTool().checkPermissions({
      targetPath: memoryFile,
    })).toMatchObject({ kind: 'allow' });
    expect(secureResolveReadPath(memoryFile)).toBe(memoryFile);
    expect(new WriteFileTool().checkPermissions({
      targetPath: memoryFile,
    })).toMatchObject({ kind: 'ask' });
    expect(new CreateDirectoryTool().checkPermissions({
      directoryPath: join(customMemory, 'topics'),
    })).toMatchObject({ kind: 'ask' });
  });

  it('真实 Gateway 在 Manual 下维护默认根不弹审批且不切换模式', async () => {
    const { memory } = createPaths();
    const registry = new ToolRegistry();
    const session = new SessionContext('memory-default-gateway');
    const approvalHandler = vi.fn();
    session.approvalInteraction.registerApprovalHandler(approvalHandler);

    try {
      await registry.callTool(
        'createDirectory',
        { directoryPath: join(memory, 'topics') },
        session,
      );
      await registry.callTool(
        'writeFile',
        {
          targetPath: join(memory, 'topics', 'project.md'),
          content: '# 项目记忆',
        },
        session,
      );
      await registry.callTool(
        'writeFile',
        {
          targetPath: join(memory, 'MEMORY.md'),
          content: '- [项目](topics/project.md) — 项目记忆\n',
        },
        session,
      );

      expect(approvalHandler).not.toHaveBeenCalled();
      expect(session.getPermissionMode()).toBe('default');
    } finally {
      await registry.close();
    }
  });

  it('真实 Gateway 对自定义根写入仍要求审批', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myagent-custom-memory-gateway-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const customMemory = join(root, 'custom-memory');
    initWorkspace(workspace, customMemory, 'custom');
    const registry = new ToolRegistry();
    const session = new SessionContext('memory-custom-gateway');
    const approvalHandler = vi.fn((id: string) => {
      session.approvalInteraction.resolve(id, { action: 'deny' });
    });
    session.approvalInteraction.registerApprovalHandler(approvalHandler);

    try {
      await expect(registry.callTool(
        'writeFile',
        {
          targetPath: join(customMemory, 'MEMORY.md'),
          content: '# 不应写入',
        },
        session,
      )).rejects.toThrow('审批拒绝');
      expect(approvalHandler).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close();
    }
  });
});
