/**
 * @file additionalDirectories 物理边界测试。
 * 覆盖显式增删、状态版本、子树/兄弟前缀、符号链接逃逸和 destructive 工具不扩权。
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  initWorkspace,
  secureResolveWritePath,
} from '../../../src/adapters/tools/impl/base.js';
import {
  deletePathAdapter,
  writeFileAdapter,
} from '../../../src/adapters/tools/permissions/file-tool-authorization.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import { ToolPermissionService } from '../../../src/core/domain/permissions/tool-permission-service.js';
import { createTrustedCallContext } from '../../../src/core/domain/permissions/trusted-call-context.js';
import type { SessionEventPort } from '../../../src/ports/driven/session/SessionEventPort.js';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'myagent-additional-directories-'));
const workspace = join(fixtureRoot, 'workspace');
const additionalRoot = join(fixtureRoot, 'shared');
const siblingRoot = join(fixtureRoot, 'shared-sibling');
const outsideRoot = join(fixtureRoot, 'outside');

/** 构造只暴露权限状态的最小会话端口。 */
function createSessionPort(state: PermissionSessionState): SessionEventPort {
  return {
    getPermissionSessionState: () => state,
  } as unknown as SessionEventPort;
}

describe('additionalDirectories', () => {
  beforeAll(() => {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(additionalRoot, { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    initWorkspace(workspace);
  });

  afterAll(() => {
    initWorkspace(process.cwd());
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('显式增删目录应规范化并逐次递增 stateVersion', () => {
    const state = new PermissionSessionState();
    expect(state.getStateVersion()).toBe(0);
    const added = state.applyUpdates([{
      type: 'addDirectories',
      target: 'session',
      directories: [additionalRoot],
    }]);
    expect(added.stateVersion).toBe(1);
    expect(added.additionalDirectories).toEqual([additionalRoot]);

    const removed = state.applyUpdates([{
      type: 'removeDirectories',
      target: 'session',
      directories: [additionalRoot],
    }]);
    expect(removed.stateVersion).toBe(2);
    expect(removed.additionalDirectories).toEqual([]);
  });

  it('授权目录子树可写，但同前缀兄弟目录不可写', () => {
    const state = new PermissionSessionState({
      additionalDirectories: [additionalRoot],
    });
    const session = createSessionPort(state);
    expect(secureResolveWritePath(join(additionalRoot, 'nested', 'file.ts'), session))
      .toBe(join(additionalRoot, 'nested', 'file.ts'));
    expect(() =>
      secureResolveWritePath(join(siblingRoot, 'file.ts'), session))
      .toThrow('溢出了授权工作区');
  });

  it('additional directory 内的链接不得逃逸到范围外物理目录', () => {
    const linkPath = join(additionalRoot, 'escape-link');
    symlinkSync(
      outsideRoot,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const state = new PermissionSessionState({
      additionalDirectories: [additionalRoot],
    });
    expect(() =>
      secureResolveWritePath(join(linkPath, 'escaped.ts'), createSessionPort(state)))
      .toThrow('溢出了授权工作区');
  });

  it('Accept edits 只自动放行已显式授权目录，外部兄弟仍询问', async () => {
    const state = new PermissionSessionState({
      mode: 'acceptEdits',
      additionalDirectories: [additionalRoot],
    });
    const caller = createTrustedCallContext('additional-directory-test', 'interactive');
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });

    const allowedRequest = writeFileAdapter.buildPermissionRequest(
      { targetPath: join(additionalRoot, 'allowed.ts') },
      { caller },
    );
    const siblingRequest = writeFileAdapter.buildPermissionRequest(
      { targetPath: join(siblingRoot, 'not-allowed.ts') },
      { caller },
    );

    expect((await service.checkRequest(allowedRequest, state, { caller })).kind).toBe('allow');
    expect((await service.checkRequest(siblingRequest, state, { caller })).kind).toBe('ask');
  });

  it('destructive 工具在额外目录内仍必须重新询问', async () => {
    const state = new PermissionSessionState({
      mode: 'acceptEdits',
      additionalDirectories: [additionalRoot],
    });
    const caller = createTrustedCallContext('additional-destructive-test', 'interactive');
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const request = deletePathAdapter.buildPermissionRequest(
      { targetPath: join(additionalRoot, 'remove-me') },
      { caller },
    );

    expect((await service.checkRequest(request, state, { caller })).kind).toBe('ask');
  });
});
