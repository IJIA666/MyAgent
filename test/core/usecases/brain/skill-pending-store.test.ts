/**
 * @file Skill pending 仓储测试。
 * 覆盖持久化、diff、stale 检测、损坏记录降级和独立拒绝。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillLibrary } from '../../../../src/core/usecases/brain/skill-library.js';
import {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../../../src/core/usecases/brain/skill-pending-store.js';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';

describe('SkillPendingStore', () => {
  let tempDir: string;
  let pendingDir: string;
  let library: SkillLibrary;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const userSkills = resolve(tempDir, 'user');
    const projectSkills = resolve(tempDir, 'project');
    pendingDir = resolve(tempDir, 'pending');
    mkdirSync(userSkills, { recursive: true });
    mkdirSync(projectSkills, { recursive: true });
    library = new SkillLibrary(
      userSkills,
      projectSkills,
      resolve(userSkills, '.archive'),
      new SkillUsageStore(resolve(userSkills, '.usage.json')),
      { enableWatcher: false },
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('create 暂存为独立 JSON，重启仓储后仍可列举且不会修改 Skill', async () => {
    const store = new SkillPendingStore(pendingDir, library);
    const record = await store.stage({
      action: 'create',
      name: 'pending-create',
      content: skillContent('pending-create', '待批准'),
    }, 'background_review');

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(library.get('pending-create')).toBeUndefined();
    expect(new SkillPendingStore(pendingDir, library).list()).toHaveLength(1);
    expect(new SkillPendingStore(pendingDir, library).get(record.id)).toMatchObject({
      action: 'create',
      name: 'pending-create',
      origin: 'background_review',
    });
  });

  it('create/edit/write/remove/delete 预览生成对应 diff 或删除摘要', async () => {
    const store = new SkillPendingStore(pendingDir, library);
    const created = await store.stage({
      action: 'create',
      name: 'diff-create',
      content: skillContent('diff-create', '新增正文'),
    }, 'foreground');
    expect(await store.diff(created.id)).toMatchObject({
      status: 'ready',
      diff: expect.stringContaining('+++ diff-create/SKILL.md'),
    });

    await library.manage({
      action: 'create',
      name: 'existing',
      content: skillContent('existing', '旧正文'),
    }, 'foreground');
    await library.manage({
      action: 'write_file',
      name: 'existing',
      filePath: 'references/a.md',
      fileContent: '旧支持',
    }, 'foreground');

    const edited = await store.stage({
      action: 'edit',
      name: 'existing',
      content: skillContent('existing', '新正文'),
    }, 'foreground');
    expect(await store.diff(edited.id)).toMatchObject({
      status: 'ready',
      diff: expect.stringContaining('+新正文'),
    });

    const removed = await store.stage({
      action: 'remove_file',
      name: 'existing',
      filePath: 'references/a.md',
    }, 'foreground');
    expect(await store.diff(removed.id)).toMatchObject({
      status: 'ready',
      diff: expect.stringContaining('+++ /dev/null'),
    });

    const deleted = await store.stage({
      action: 'delete',
      name: 'existing',
    }, 'foreground');
    expect(await store.diff(deleted.id)).toMatchObject({
      status: 'ready',
      diff: expect.stringContaining('DELETE existing/'),
    });
  });

  it('目标内容在暂存后变化时 diff 与批准校验均返回 stale', async () => {
    await library.manage({
      action: 'create',
      name: 'stale-target',
      content: skillContent('stale-target', '初始正文'),
    }, 'foreground');
    const store = new SkillPendingStore(pendingDir, library);
    const record = await store.stage({
      action: 'edit',
      name: 'stale-target',
      content: skillContent('stale-target', '计划正文'),
    }, 'foreground');

    await library.manage({
      action: 'edit',
      name: 'stale-target',
      content: skillContent('stale-target', '外部新正文'),
    }, 'foreground');

    await expect(store.diff(record.id)).resolves.toMatchObject({ status: 'stale' });
    await expect(store.validateReplay(record.id, record.request))
      .resolves.toMatchObject({ status: 'stale' });
    expect(store.get(record.id)).toBeDefined();
  });

  it('重放参数不一致时拒绝，discard 只删除目标记录', async () => {
    const store = new SkillPendingStore(pendingDir, library);
    const first = await store.stage({
      action: 'create',
      name: 'first',
      content: skillContent('first', '一'),
    }, 'foreground');
    const second = await store.stage({
      action: 'create',
      name: 'second',
      content: skillContent('second', '二'),
    }, 'foreground');

    await expect(store.validateReplay(first.id, {
      action: 'create',
      name: 'first',
      content: skillContent('first', '被篡改'),
    })).resolves.toMatchObject({ status: 'error' });
    expect(store.discard(first.id)).toBe(true);
    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBeDefined();
  });

  it('损坏 pending 被跳过，不影响其他合法记录', async () => {
    const store = new SkillPendingStore(pendingDir, library);
    await store.stage({
      action: 'create',
      name: 'valid',
      content: skillContent('valid', '正文'),
    }, 'foreground');
    writeFileSync(resolve(pendingDir, 'broken.json'), '{"bad": ', 'utf8');

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.name).toBe('valid');
  });

  it('writeApproval 控制器只在显式 set 后改变', () => {
    const controller = new SkillWriteApprovalController(false);
    expect(controller.isEnabled()).toBe(false);
    controller.setEnabled(true);
    expect(controller.isEnabled()).toBe(true);
  });
});

/** 生成合法 Skill 正文。 */
function skillContent(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n${body}\n`;
}
