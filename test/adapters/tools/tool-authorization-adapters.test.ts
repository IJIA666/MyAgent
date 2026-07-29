/**
 * @file 工具权限适配器测试。
 * 覆盖文件工具适配器的真实参数解析、PermissionRequest 构造和审批选项。
 */

import { describe, it, expect } from 'vitest';
import { ToolPermissionService } from '../../../src/core/domain/permissions/tool-permission-service.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../../src/core/domain/permissions/trusted-call-context.js';
import {
  readFileAdapter,
  writeFileAdapter,
  editFileAdapter,
  applyPatchAdapter,
  createDirectoryAdapter,
  deletePathAdapter,
  movePathAdapter,
  copyPathAdapter,
} from '../../../src/adapters/tools/permissions/file-tool-authorization.js';
import { BROWSER_TOOL_AUTHORIZATION_ADAPTERS } from '../../../src/adapters/tools/permissions/browser-tool-authorization.js';
import { setBrowserPaths } from '../../../src/adapters/tools/impl/browser/browser-action.js';
import { initWorkspace } from '../../../src/adapters/tools/impl/base.js';

describe('文件工具适配器', () => {
  describe('buildPermissionRequest', () => {
    it('writeFile 应解析 targetPath', () => {
      const req = writeFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      expect(req.runtimeToolName).toBe('writeFile');
      expect(req.permissionIdentity).toBe('FileWrite');
      expect(req.isEditOperation).toBe(true);
      expect(req.resourceEvidences).toHaveLength(1);
      expect(req.resourceEvidences[0].kind).toBe('file');
      if (req.resourceEvidences[0].kind === 'file') {
        expect(req.resourceEvidences[0].canonicalPath).toContain('file.ts');
      }
    });

    it('editFile 应标记为编辑操作', () => {
      const req = editFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      expect(req.permissionIdentity).toBe('FileEdit');
      expect(req.isEditOperation).toBe(true);
    });

    it('deletePath 不应标记为普通编辑', () => {
      const req = deletePathAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      expect(req.permissionIdentity).toBe('FileDelete');
      expect(req.isEditOperation).toBe(false);
    });

    it('readFile 的 permissionIdentity 为 FileRead', () => {
      const req = readFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      expect(req.permissionIdentity).toBe('FileRead');
      expect(req.isEditOperation).toBe(false);
    });

    it('movePath 应解析 sourcePath 和 destinationPath', () => {
      const req = movePathAdapter.buildPermissionRequest({
        sourcePath: '/workspace/a.ts',
        destinationPath: '/workspace/b.ts',
      });
      expect(req.permissionIdentity).toBe('FileMove');
      expect(req.resourceEvidences).toHaveLength(2);
    });

    it('copyPath 应解析源路径与目标路径', () => {
      const req = copyPathAdapter.buildPermissionRequest({
        sourcePath: '/workspace/a.ts',
        destinationPath: '/workspace/copy.ts',
      });
      expect(req.permissionIdentity).toBe('FileCopy');
      expect(req.resourceEvidences).toHaveLength(2);
    });

    it('createDirectory 应解析 directoryPath', () => {
      const req = createDirectoryAdapter.buildPermissionRequest({
        directoryPath: '/workspace/new-dir',
      });
      expect(req.permissionIdentity).toBe('FileCreate');
      expect(req.isEditOperation).toBe(true);
    });
  });

  describe('isOrdinaryEdit', () => {
    it('writeFile 为普通编辑', () => {
      const req = writeFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      expect(writeFileAdapter.isOrdinaryEdit(req)).toBe(true);
    });

    it('deletePath 不是普通编辑', () => {
      const req = deletePathAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      expect(deletePathAdapter.isOrdinaryEdit(req)).toBe(false);
    });

    it('applyPatch 为普通编辑', () => {
      const req = applyPatchAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      expect(applyPatchAdapter.isOrdinaryEdit(req)).toBe(true);
    });
  });

  describe('buildApprovalOptions', () => {
    it('writeFile 应提供三种选项', () => {
      const state = new PermissionSessionState({ mode: 'default' });
      const req = writeFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      const options = writeFileAdapter.buildApprovalOptions(req, state);
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.some(o => o.type === 'allowOnce')).toBe(true);
      expect(options.some(o => o.type === 'deny')).toBe(true);
    });

    it('deletePath 不应提供 acceptEdits 切换', () => {
      const state = new PermissionSessionState({ mode: 'default' });
      const req = deletePathAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
      const options = deletePathAdapter.buildApprovalOptions(req, state);
      expect(options.some(o => o.type === 'allowAndSetMode')).toBe(false);
    });
  });
});

describe('checkRequest（适配器感知权限检查）', () => {
  const caller = createTrustedCallContext('tool-authorization-adapter-test', 'interactive');

  it('FileRead + default 应 allow', async () => {
    const state = new PermissionSessionState({ mode: 'default' });
    const svc = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const req = readFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
    const result = await svc.checkRequest(req, state, { caller });
    expect(result.kind).toBe('allow');
  });

  it('FileWrite + default 应 ask', async () => {
    const state = new PermissionSessionState({ mode: 'default' });
    const svc = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const req = writeFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
    const result = await svc.checkRequest(req, state, { caller });
    expect(result.kind).toBe('ask');
  });

  it('FileWrite + acceptEdits 应 allow（isEditOperation=true）', async () => {
    initWorkspace(process.cwd());
    const state = new PermissionSessionState({ mode: 'acceptEdits' });
    const svc = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const req = writeFileAdapter.buildPermissionRequest({ targetPath: 'src/file.ts' });
    const result = await svc.checkRequest(req, state, { caller });
    expect(result.kind).toBe('allow');
  });

  it('FileDelete + acceptEdits 应 ask（非普通编辑）', async () => {
    const state = new PermissionSessionState({ mode: 'acceptEdits' });
    const svc = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const req = deletePathAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
    const result = await svc.checkRequest(req, state, { caller });
    expect(result.kind).toBe('ask');
  });

  it('FileWrite + plan 应 deny', async () => {
    const state = new PermissionSessionState({ mode: 'plan' });
    const svc = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const req = writeFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
    const result = await svc.checkRequest(req, state, { caller });
    expect(result.kind).toBe('deny');
  });

  it('FileRead + plan 应 allow', async () => {
    const state = new PermissionSessionState({ mode: 'plan' });
    const svc = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const req = readFileAdapter.buildPermissionRequest({ targetPath: '/workspace/file.ts' });
    const result = await svc.checkRequest(req, state, { caller });
    expect(result.kind).toBe('allow');
  });
});

describe('浏览器工具适配器', () => {
  const caller = createTrustedCallContext('browser-adapter-test', 'interactive');

  it('应覆盖全部 9 个真实浏览器工具名', () => {
    expect([...BROWSER_TOOL_AUTHORIZATION_ADAPTERS.keys()].sort()).toEqual([
      'browser_back',
      'browser_click',
      'browser_ensure_login',
      'browser_get_text',
      'browser_navigate',
      'browser_press',
      'browser_scroll',
      'browser_type',
      'browser_vision',
    ]);
  });

  it('导航应绑定 URL 与 CDP 网络范围并识别 metadata', () => {
    const adapter = BROWSER_TOOL_AUTHORIZATION_ADAPTERS.get('browser_navigate');
    expect(adapter).toBeDefined();
    const request = adapter!.buildPermissionRequest({
      url: 'http://169.254.169.254/latest/meta-data',
      cdpUrl: 'http://127.0.0.1:9222',
    }, { caller });

    expect(request.resourceEvidences).toHaveLength(2);
    expect(request.resourceEvidences[0]).toMatchObject({
      kind: 'network',
      scope: 'cloud-metadata',
      protected: true,
      channelTrust: 'interactive',
    });
    expect(request.resourceEvidences[1]).toMatchObject({
      kind: 'network',
      scope: 'loopback',
      protected: true,
    });
  });

  it('无法绑定远端页面状态的交互必须显式产出 unknown', () => {
    const adapter = BROWSER_TOOL_AUTHORIZATION_ADAPTERS.get('browser_click');
    const request = adapter!.buildPermissionRequest({ ref: '@e1' }, { caller });
    expect(request.resourceEvidences).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        operation: 'unknown',
        sourceNodeId: 'browser:browser_click',
      }),
    ]);
    expect(request.approvalOptions.map(option => option.type)).toEqual([
      'allowOnce',
      'deny',
    ]);
  });

  it('截图应绑定宿主注入的真实目录而不是旧宽泛记录', () => {
    initWorkspace(process.cwd());
    setBrowserPaths(
      `${process.cwd()}/.myagent/browser`,
      `${process.cwd()}/.myagent/screenshots`,
    );
    const adapter = BROWSER_TOOL_AUTHORIZATION_ADAPTERS.get('browser_vision');
    const request = adapter!.buildPermissionRequest({}, { caller });
    expect(request.resourceEvidences[0]).toMatchObject({
      kind: 'directory-scope',
      operation: 'write',
      scope: 'workspace',
      provenance: 'host-verified',
    });
  });
});
