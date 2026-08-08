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
  ListFilesTool,
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
import {
  createDirectoryAdapter,
  deletePathAdapter,
  listFilesAdapter,
  readFileAdapter,
  readManyFilesAdapter,
  writeFileAdapter,
} from '../../../../src/adapters/tools/permissions/file-tool-authorization.js';
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
      [new CreateDirectoryTool(), { directoryPath: join(memory) }],
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

  it('保留名 memory.md 的写/建目标被拒绝，原形 MEMORY.md 保持放行', () => {
    const { memory } = createPaths();

    expect(new WriteFileTool().checkPermissions({
      targetPath: join(memory, 'memory.md'),
    })).toMatchObject({ kind: 'deny' });
    expect(new WriteFileTool().checkPermissions({
      targetPath: join(memory, 'Memory.md'),
    })).toMatchObject({ kind: 'deny' });
    expect(new CreateDirectoryTool().checkPermissions({
      directoryPath: join(memory, 'memory.md'),
    })).toMatchObject({ kind: 'deny' });
    // 索引更新的合法目标：原形 MEMORY.md 不受保留名保护影响。
    expect(new WriteFileTool().checkPermissions({
      targetPath: join(memory, 'MEMORY.md'),
    })).toMatchObject({ kind: 'allow' });
  });

  it('保留名保护不误伤记忆根外的工作区文件', () => {
    const { memory, workspace } = createPaths();

    // 工作区 docs/memory.md 走普通流程，不得因保留名 deny。
    expect(new WriteFileTool().checkPermissions({
      targetPath: join(workspace, 'docs', 'memory.md'),
    })).not.toMatchObject({ kind: 'deny' });
    expect(new CreateDirectoryTool().checkPermissions({
      directoryPath: join(workspace, 'docs'),
    })).not.toMatchObject({ kind: 'deny' });
    // 记忆根内 memory.md 仍被拒绝。
    expect(new WriteFileTool().checkPermissions({
      targetPath: join(memory, 'memory.md'),
    })).toMatchObject({ kind: 'deny' });
  });

  it('自定义记忆根内保留名同样拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagent-custom-reserved-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const customMemory = join(root, 'custom-memory');
    initWorkspace(workspace, customMemory, 'custom');

    expect(new WriteFileTool().checkPermissions({
      targetPath: join(customMemory, 'memory.md'),
    })).toMatchObject({ kind: 'deny' });
    expect(new WriteFileTool().checkPermissions({
      targetPath: join(customMemory, 'Memory.md'),
    })).toMatchObject({ kind: 'deny' });
    // 自定义根内普通文件仍走 ask，保留名保护不影响既有自定义根语义。
    expect(new WriteFileTool().checkPermissions({
      targetPath: join(customMemory, 'note.md'),
    })).toMatchObject({ kind: 'ask' });
  });

  it('未启用 Auto Memory 时保留名保护不生效', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagent-no-memory-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    initWorkspace(workspace);

    // 无记忆根（getAuthorizedMemoryDir 为 null）时，工作区 memory.md 不被保留名拦截。
    expect(new WriteFileTool().checkPermissions({
      targetPath: join(workspace, 'docs', 'memory.md'),
    })).not.toMatchObject({ kind: 'deny' });
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
      directoryPath: join(customMemory, 'notes'),
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
        { directoryPath: join(memory) },
        session,
      );
      await registry.callTool(
        'writeFile',
        {
          targetPath: join(memory, 'project.md'),
          content: '# 项目记忆',
        },
        session,
      );
      await registry.callTool(
        'writeFile',
        {
          targetPath: join(memory, 'MEMORY.md'),
          content: '- [项目](project.md) — 项目记忆\n',
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

describe('子代理持久记忆根权限（per-task 冻结）', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** 创建独立记忆根。 */
  function createMemoryDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'myagent-agent-mem-root-'));
    roots.push(root);
    return root;
  }

  it('冻结根内 read/write/createDirectory 直接 allow（decisionSource agentMemoryRoot）', async () => {
    const memoryDir = createMemoryDir();
    const state = new PermissionSessionState({ agentMemoryRoots: [memoryDir] });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const caller = createTrustedCallContext('agent-mem-root', 'interactive');

    const writeDecision = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, 'note.md'), content: 'x' },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new WriteFileTool().checkPermissions({ targetPath: join(memoryDir, 'note.md') }),
      },
    );
    expect(writeDecision).toMatchObject({ kind: 'allow', decisionSource: 'agentMemoryRoot' });

    const readDecision = await service.checkRequest(
      readFileAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, 'note.md') },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new ReadFileTool().checkPermissions({ targetPath: join(memoryDir, 'note.md') }),
      },
    );
    expect(readDecision).toMatchObject({ kind: 'allow', decisionSource: 'agentMemoryRoot' });

    const mkdirDecision = await service.checkRequest(
      createDirectoryAdapter.buildPermissionRequest(
        { directoryPath: join(memoryDir, 'sub') },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new CreateDirectoryTool().checkPermissions({ directoryPath: join(memoryDir, 'sub') }),
      },
    );
    expect(mkdirDecision).toMatchObject({ kind: 'allow', decisionSource: 'agentMemoryRoot' });
  });

  it('保留名 memory.md deny，原形 MEMORY.md 放行', async () => {
    const memoryDir = createMemoryDir();
    const state = new PermissionSessionState({ agentMemoryRoots: [memoryDir] });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const caller = createTrustedCallContext('agent-mem-reserved', 'interactive');

    const reserved = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, 'memory.md'), content: 'x' },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new WriteFileTool().checkPermissions({ targetPath: join(memoryDir, 'memory.md') }),
      },
    );
    expect(reserved).toMatchObject({ kind: 'deny', decisionSource: 'invariant' });

    const index = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, 'MEMORY.md'), content: '- [t](t.md) — d\n' },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new WriteFileTool().checkPermissions({ targetPath: join(memoryDir, 'MEMORY.md') }),
      },
    );
    expect(index).toMatchObject({ kind: 'allow', decisionSource: 'agentMemoryRoot' });
  });

  it('delete 不提升，根外目标零特例', async () => {
    const memoryDir = createMemoryDir();
    const state = new PermissionSessionState({ agentMemoryRoots: [memoryDir] });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const caller = createTrustedCallContext('agent-mem-delete', 'interactive');

    const deleteDecision = await service.checkRequest(
      deletePathAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, 'note.md') },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new DeletePathTool().checkPermissions({ targetPath: join(memoryDir, 'note.md') }),
      },
    );
    expect(deleteDecision).not.toMatchObject({ decisionSource: 'agentMemoryRoot' });

    const outside = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, '..', 'outside.md'), content: 'x' },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new WriteFileTool().checkPermissions({ targetPath: join(memoryDir, '..', 'outside.md') }),
      },
    );
    expect(outside).not.toMatchObject({ decisionSource: 'agentMemoryRoot' });
  });

  it('per-task 隔离：A 的冻结根不授权 B，state 销毁后不残留', async () => {
    const dirA = createMemoryDir();
    const dirB = createMemoryDir();
    const stateA = new PermissionSessionState({ agentMemoryRoots: [dirA] });
    const stateB = new PermissionSessionState({ agentMemoryRoots: [dirB] });
    const service = new ToolPermissionService({ ruleStore: stateA.getRuleStore() });
    const callerA = createTrustedCallContext('agent-a', 'interactive');
    const callerB = createTrustedCallContext('agent-b', 'interactive');

    // B 的 state 未冻结 A 根：B 写 A 根不提升。
    const bIntoA = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(
        { targetPath: join(dirA, 'note.md'), content: 'x' },
        { caller: callerB },
      ),
      stateB,
      {
        caller: callerB,
        toolResult: new WriteFileTool().checkPermissions({ targetPath: join(dirA, 'note.md') }),
      },
    );
    expect(bIntoA).not.toMatchObject({ decisionSource: 'agentMemoryRoot' });

    // A 自己的根正常提升。
    const aIntoA = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(
        { targetPath: join(dirA, 'note.md'), content: 'x' },
        { caller: callerA },
      ),
      stateA,
      {
        caller: callerA,
        toolResult: new WriteFileTool().checkPermissions({ targetPath: join(dirA, 'note.md') }),
      },
    );
    expect(aIntoA).toMatchObject({ decisionSource: 'agentMemoryRoot' });
  });

  it('plan 模式可继续收窄记忆根 allow（写类操作被拒绝）', async () => {
    const memoryDir = createMemoryDir();
    const state = new PermissionSessionState({
      mode: 'plan',
      agentMemoryRoots: [memoryDir],
    });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const caller = createTrustedCallContext('agent-mem-plan', 'interactive');

    const writeDecision = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, 'note.md'), content: 'x' },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new WriteFileTool().checkPermissions({ targetPath: join(memoryDir, 'note.md') }),
      },
    );
    // 记忆根 allow 可被模式收窄：plan 模式拒绝写类操作。
    expect(writeDecision).toMatchObject({ kind: 'deny', decisionSource: 'mode' });

    const readDecision = await service.checkRequest(
      readFileAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, 'note.md') },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new ReadFileTool().checkPermissions({ targetPath: join(memoryDir, 'note.md') }),
      },
    );
    // plan 模式放行 FileRead 身份。
    expect(readDecision).toMatchObject({ kind: 'allow' });
  });

  it('显式 allow 规则不得绕过记忆根保留名拒绝', async () => {
    const memoryDir = createMemoryDir();
    const rules = new PermissionRuleStore();
    rules.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'writeFile' },
    });
    const state = new PermissionSessionState({
      rules: rules.getAllRules(),
      agentMemoryRoots: [memoryDir],
    });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const caller = createTrustedCallContext('agent-mem-rule', 'interactive');

    const reserved = await service.checkRequest(
      writeFileAdapter.buildPermissionRequest(
        { targetPath: join(memoryDir, 'memory.md'), content: 'x' },
        { caller },
      ),
      state,
      {
        caller,
        toolResult: new WriteFileTool().checkPermissions({ targetPath: join(memoryDir, 'memory.md') }),
      },
    );
    // 保留名为确定性文件安全约束：先于显式规则，writeFile allow 规则不得绕过。
    expect(reserved).toMatchObject({ kind: 'deny', decisionSource: 'invariant' });
  });

  it('全部资源必须位于同一记忆根内（部分根外不提升）', async () => {
    const memoryDir = createMemoryDir();
    const state = new PermissionSessionState({ agentMemoryRoots: [memoryDir] });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const caller = createTrustedCallContext('agent-mem-multi', 'interactive');

    // readManyFiles 批量路径：一个在根内、一个在根外 → 全部资源判定不命中。
    const request = readManyFilesAdapter.buildPermissionRequest(
      { targetPaths: `${join(memoryDir, 'a.md')},${join(memoryDir, '..', 'outside.md')}` },
      { caller },
    );
    const decision = await service.checkRequest(request, state, {
      caller,
      toolResult: {
        kind: 'ask',
        message: '批量读取',
        evidence: {
          operationCategory: 'file-read',
          sideEffect: 'read',
          riskReason: '批量读取',
          resources: request.resourceEvidences,
        },
      },
    });
    expect(decision).not.toMatchObject({ decisionSource: 'agentMemoryRoot' });

    // 全部在根内 → 提升。
    const inside = readManyFilesAdapter.buildPermissionRequest(
      { targetPaths: `${join(memoryDir, 'a.md')},${join(memoryDir, 'b.md')}` },
      { caller },
    );
    const insideDecision = await service.checkRequest(inside, state, {
      caller,
      toolResult: {
        kind: 'ask',
        message: '批量读取',
        evidence: {
          operationCategory: 'file-read',
          sideEffect: 'read',
          riskReason: '批量读取',
          resources: inside.resourceEvidences,
        },
      },
    });
    expect(insideDecision).toMatchObject({ kind: 'allow', decisionSource: 'agentMemoryRoot' });
  });

  it('listFiles 经正式适配器进入记忆根提升', async () => {
    const memoryDir = createMemoryDir();
    const state = new PermissionSessionState({ agentMemoryRoots: [memoryDir] });
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const caller = createTrustedCallContext('agent-mem-list', 'interactive');

    const request = listFilesAdapter.buildPermissionRequest(
      { directoryPath: join(memoryDir) },
      { caller },
    );
    const decision = await service.checkRequest(request, state, {
      caller,
      toolResult: new ListFilesTool().checkPermissions({ targetPath: join(memoryDir) }),
    });
    expect(decision).toMatchObject({ kind: 'allow', decisionSource: 'agentMemoryRoot' });
  });
});
