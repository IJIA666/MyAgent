/**
 * @file SkillLibrary 单元测试。
 * 覆盖合并索引、六种动作、包校验、路径边界、后台所有权和单动作回滚。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillLibrary } from '../../../../src/core/usecases/brain/skill-library.js';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';
import type { SkillManageRequest } from '../../../../src/core/usecases/brain/skill-types.js';

describe('SkillLibrary', () => {
  let tempDir: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;
  let archiveDir: string;
  let usagePath: string;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-library-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    userSkillsDir = resolve(tempDir, 'user-skills');
    projectSkillsDir = resolve(tempDir, 'project-skills');
    archiveDir = resolve(userSkillsDir, '.archive');
    usagePath = resolve(userSkillsDir, '.usage.json');
    mkdirSync(userSkillsDir, { recursive: true });
    mkdirSync(projectSkillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('项目 Skill 同名覆盖用户 Skill，并过滤 archive、点目录和不完整包', () => {
    writeSkill(userSkillsDir, 'shared', '用户版本');
    writeSkill(projectSkillsDir, 'shared', '项目版本');
    writeSkill(userSkillsDir, 'user-only', '用户独有');
    writeSkill(archiveDir, 'archived', '已归档');
    writeSkill(resolve(userSkillsDir, '.temporary'), 'hidden', '临时内容');
    mkdirSync(resolve(userSkillsDir, 'incomplete'), { recursive: true });

    const library = createLibrary();

    expect(library.list().map(item => item.name).sort()).toEqual(['shared', 'user-only']);
    expect(library.get('shared')?.source).toBe('project');
    expect(library.read('shared')).toContain('项目版本');
  });

  it('create/patch/edit/write_file/remove_file/delete 六种动作独立提交并通知', async () => {
    const usageStore = new SkillUsageStore(usagePath);
    const library = createLibrary(usageStore);
    const listener = vi.fn();
    library.subscribe(listener);

    await expect(library.manage({
      action: 'create',
      name: 'text-posting',
      content: skillContent('text-posting', '第一版流程'),
    }, 'foreground')).resolves.toMatchObject({
      status: 'success',
      action: 'create',
      agentCreated: false,
    });
    expect(usageStore.read('text-posting')?.createdBy).toBeNull();

    await expect(library.manage({
      action: 'write_file',
      name: 'text-posting',
      filePath: 'references/checklist.md',
      fileContent: '检查标题',
    }, 'foreground')).resolves.toMatchObject({ status: 'success' });
    expect(library.read('text-posting', 'references/checklist.md')).toBe('检查标题');

    await expect(library.manage({
      action: 'patch',
      name: 'text-posting',
      filePath: 'references/checklist.md',
      oldString: '标题',
      newString: '正文',
    }, 'foreground')).resolves.toMatchObject({ status: 'success' });
    expect(library.read('text-posting', 'references/checklist.md')).toBe('检查正文');

    await expect(library.manage({
      action: 'edit',
      name: 'text-posting',
      content: skillContent('text-posting', '第二版流程'),
    }, 'foreground')).resolves.toMatchObject({ status: 'success' });
    expect(library.read('text-posting')).toContain('第二版流程');

    await expect(library.manage({
      action: 'remove_file',
      name: 'text-posting',
      filePath: 'references/checklist.md',
    }, 'foreground')).resolves.toMatchObject({ status: 'success' });
    expect(library.read('text-posting', 'references/checklist.md')).toBeNull();

    await expect(library.manage({
      action: 'delete',
      name: 'text-posting',
    }, 'foreground')).resolves.toMatchObject({ status: 'success' });
    expect(library.get('text-posting')).toBeUndefined();
    expect(existsSync(resolve(userSkillsDir, 'text-posting'))).toBe(false);
    expect(listener.mock.calls.map(call => call[0])).toEqual([
      'created',
      'updated',
      'updated',
      'updated',
      'updated',
      'deleted',
    ]);
  });

  it('patch 默认要求唯一匹配，失败不得改变原文件', async () => {
    writeSkill(userSkillsDir, 'duplicate-text', '重复 重复');
    const library = createLibrary();
    const before = library.read('duplicate-text');

    const result = await library.manage({
      action: 'patch',
      name: 'duplicate-text',
      oldString: '重复',
      newString: '替换',
    }, 'foreground');

    expect(result).toMatchObject({ status: 'error' });
    expect(library.read('duplicate-text')).toBe(before);
  });

  it('后台只能修改 agent-created/adopt 且未 pinned 的用户 Skill', async () => {
    writeSkill(userSkillsDir, 'manual', '手工');
    writeSkill(projectSkillsDir, 'project-owned', '项目');
    const usageStore = new SkillUsageStore(usagePath);
    await usageStore.markUnmanaged('manual');
    const library = createLibrary(usageStore);

    await expect(library.manage(patchRequest('manual'), 'background_review'))
      .resolves.toMatchObject({ status: 'error' });
    await usageStore.adopt('manual');
    await expect(library.manage(patchRequest('manual'), 'background_review'))
      .resolves.toMatchObject({ status: 'success' });
    await usageStore.pin('manual');
    await expect(library.manage({
      ...patchRequest('manual'),
      oldString: '已更新',
      newString: '再次更新',
    }, 'background_review')).resolves.toMatchObject({ status: 'error' });
    await expect(library.manage(patchRequest('project-owned'), 'background_review'))
      .resolves.toMatchObject({ status: 'error' });
  });

  it('后台 delete 必须带有效 absorbedInto，并移动完整包到 archive', async () => {
    const usageStore = new SkillUsageStore(usagePath);
    const library = createLibrary(usageStore);
    await library.manage({
      action: 'create',
      name: 'source-skill',
      content: skillContent('source-skill', '待融合'),
    }, 'background_review');
    await library.manage({
      action: 'create',
      name: 'umbrella-skill',
      content: skillContent('umbrella-skill', '聚合知识'),
    }, 'background_review');
    await library.manage({
      action: 'write_file',
      name: 'source-skill',
      filePath: 'scripts/check.js',
      fileContent: 'console.log("ok");',
    }, 'background_review');

    await expect(library.manage({
      action: 'delete',
      name: 'source-skill',
    }, 'background_curator')).resolves.toMatchObject({ status: 'error' });
    await expect(library.manage({
      action: 'delete',
      name: 'source-skill',
      absorbedInto: 'umbrella-skill',
    }, 'background_curator')).resolves.toMatchObject({ status: 'success' });

    expect(library.get('source-skill')).toBeUndefined();
    expect(readFileSync(resolve(archiveDir, 'source-skill', 'scripts', 'check.js'), 'utf8'))
      .toContain('ok');
    expect(usageStore.read('source-skill')).toMatchObject({
      state: 'archived',
      absorbedInto: 'umbrella-skill',
    });
  });

  it('支持文件仅允许白名单 UTF-8 文本并拒绝路径逃逸与链接父目录', async () => {
    writeSkill(userSkillsDir, 'safe-skill', '安全');
    const library = createLibrary();

    await expect(library.manage({
      action: 'write_file',
      name: 'safe-skill',
      filePath: '../outside.txt',
      fileContent: 'escape',
    }, 'foreground')).resolves.toMatchObject({ status: 'error' });
    await expect(library.manage({
      action: 'write_file',
      name: 'safe-skill',
      filePath: 'other/file.txt',
      fileContent: 'escape',
    }, 'foreground')).resolves.toMatchObject({ status: 'error' });
    await expect(library.manage({
      action: 'write_file',
      name: 'safe-skill',
      filePath: 'assets/raw.bin',
      fileContent: Buffer.from([0, 1, 2]),
    } as unknown as SkillManageRequest, 'foreground')).resolves.toMatchObject({ status: 'error' });
    expect(library.read('safe-skill', '../../outside.txt')).toBeNull();

    const externalDir = resolve(tempDir, 'external');
    mkdirSync(externalDir, { recursive: true });
    const scriptsLink = resolve(userSkillsDir, 'safe-skill', 'scripts');
    symlinkSync(externalDir, scriptsLink, 'junction');
    await expect(library.manage({
      action: 'write_file',
      name: 'safe-skill',
      filePath: 'scripts/escaped.txt',
      fileContent: 'escape',
    }, 'foreground')).resolves.toMatchObject({ status: 'error' });
    expect(existsSync(resolve(externalDir, 'escaped.txt'))).toBe(false);
  });

  it('严格执行 SKILL.md 字符上限与支持文件 UTF-8 字节上限', async () => {
    const library = createLibrary();
    const oversizedSkill = skillContent('oversized', 'x'.repeat(100_001));
    await expect(library.manage({
      action: 'create',
      name: 'oversized',
      content: oversizedSkill,
    }, 'foreground')).resolves.toMatchObject({ status: 'error' });

    await library.manage({
      action: 'create',
      name: 'byte-limit',
      content: skillContent('byte-limit', '正文'),
    }, 'foreground');
    await expect(library.manage({
      action: 'write_file',
      name: 'byte-limit',
      filePath: 'assets/too-large.txt',
      fileContent: '你'.repeat(350_000),
    }, 'foreground')).resolves.toMatchObject({ status: 'error' });
  });

  it('usage 提交失败时 create 回滚刚创建的包', async () => {
    mkdirSync(dirname(usagePath), { recursive: true });
    writeFileSync(usagePath, '{"broken": ', 'utf8');
    const library = createLibrary(new SkillUsageStore(usagePath));

    const result = await library.manage({
      action: 'create',
      name: 'rollback-me',
      content: skillContent('rollback-me', '不会残留'),
    }, 'background_review');

    expect(result).toMatchObject({ status: 'error' });
    expect(existsSync(resolve(userSkillsDir, 'rollback-me'))).toBe(false);
    expect(library.get('rollback-me')).toBeUndefined();
  });

  /** 使用当前测试目录构造统一 SkillLibrary。 */
  function createLibrary(
    usageStore = new SkillUsageStore(usagePath),
  ): SkillLibrary {
    return new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      usageStore,
      { enableWatcher: false },
    );
  }
});

/** 生成合法 SKILL.md。 */
function skillContent(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n${body}\n`;
}

/** 写入一个完整 Skill 包。 */
function writeSkill(root: string, name: string, body: string): void {
  const skillDir = resolve(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(resolve(skillDir, 'SKILL.md'), skillContent(name, body), 'utf8');
}

/** 构造修改正文的后台 patch 请求。 */
function patchRequest(name: string): SkillManageRequest {
  return {
    action: 'patch',
    name,
    oldString: name === 'project-owned' ? '项目' : '手工',
    newString: '已更新',
  };
}
