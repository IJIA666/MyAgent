/**
 * @file SkillLibrary 单元测试。
 * 覆盖合并索引、六种动作、包校验、路径边界、后台所有权和单动作回滚。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillLibrary } from '../../../../src/core/usecases/brain/skill-library.js';
import { SkillMutationLockManager } from '../../../../src/core/usecases/brain/skill-mutation-lock.js';
import { SkillReviewReadLedger } from '../../../../src/core/usecases/brain/skill-review-read-ledger.js';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';
import type { CrossProcessLockManager } from '../../../../src/utils/cross-process-lock.js';
import type { SkillMutationPrecondition } from '../../../../src/core/domain/permissions/permission-types.js';
import type { SkillManageAction, SkillManageRequest } from '../../../../src/core/usecases/brain/skill-types.js';

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
    // 后台调用携带本次任务的读取凭证，所有权检查独立于凭证校验。
    const ledger = new SkillReviewReadLedger('bg-lib');
    ledger.recordLoad('manual', undefined, skillContent('manual', '手工'));
    ledger.recordLoad('project-owned', undefined, skillContent('project-owned', '项目'));

    await expect(library.manage(
      patchRequest('manual'), 'background_review', preconditionFor(ledger, 'patch', 'manual'),
    )).resolves.toMatchObject({ status: 'error' });
    await usageStore.adopt('manual');
    await expect(library.manage(
      patchRequest('manual'), 'background_review', preconditionFor(ledger, 'patch', 'manual'),
    )).resolves.toMatchObject({ status: 'success' });
    await usageStore.pin('manual');
    // 重新读取更新凭证后，所有权（pinned）仍拒绝。
    ledger.recordLoad('manual', undefined, skillContent('manual', '已更新'));
    await expect(library.manage({
      ...patchRequest('manual'),
      oldString: '已更新',
      newString: '再次更新',
    }, 'background_review', preconditionFor(ledger, 'patch', 'manual')))
      .resolves.toMatchObject({ status: 'error' });
    await expect(library.manage(
      patchRequest('project-owned'), 'background_review', preconditionFor(ledger, 'patch', 'project-owned'),
    )).resolves.toMatchObject({ status: 'error' });
  });

  it('后台 delete 必须带有效 absorbedInto，并移动完整包到 archive', async () => {
    const usageStore = new SkillUsageStore(usagePath);
    const library = createLibrary(usageStore);
    const ledger = new SkillReviewReadLedger('bg-lib');
    await library.manage({
      action: 'create',
      name: 'source-skill',
      content: skillContent('source-skill', '待融合'),
    }, 'background_review', preconditionFor(ledger, 'create', 'source-skill'));
    ledger.recordLoad('source-skill', undefined, skillContent('source-skill', '待融合'));
    await library.manage({
      action: 'create',
      name: 'umbrella-skill',
      content: skillContent('umbrella-skill', '聚合知识'),
    }, 'background_review', preconditionFor(ledger, 'create', 'umbrella-skill'));
    ledger.recordLoad('umbrella-skill', undefined, skillContent('umbrella-skill', '聚合知识'));
    await library.manage({
      action: 'write_file',
      name: 'source-skill',
      filePath: 'scripts/check.js',
      fileContent: 'console.log("ok");',
    }, 'background_review', preconditionFor(ledger, 'write_file', 'source-skill', 'scripts/check.js'));

    await expect(library.manage({
      action: 'delete',
      name: 'source-skill',
    }, 'background_curator')).resolves.toMatchObject({ status: 'error' });
    await expect(library.manage({
      action: 'delete',
      name: 'source-skill',
      absorbedInto: 'umbrella-skill',
    }, 'background_curator', preconditionFor(ledger, 'delete', 'source-skill', undefined, 'umbrella-skill')))
      .resolves.toMatchObject({ status: 'success' });

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

  /** 使用当前测试目录构造统一 SkillLibrary（默认带协作锁目录）。 */
  function createLibrary(
    usageStore = new SkillUsageStore(usagePath),
  ): SkillLibrary {
    return new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      usageStore,
      { enableWatcher: false, skillLocksDir: resolve(tempDir, 'locks') },
    );
  }
});

describe('SkillLibrary 写入锁域与读取凭证', () => {
  let tempDir: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;
  let archiveDir: string;
  let usagePath: string;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  /** 使用同一锁目录构造第二个实例，模拟另一会话/进程的 SkillLibrary。 */
  function createInstance(): SkillLibrary {
    return new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      new SkillUsageStore(usagePath),
      { enableWatcher: false, skillLocksDir: resolve(tempDir, 'locks') },
    );
  }

  it('两个实例竞争同名 Skill 时按锁域串行，后进入者因摘要过期被拒绝', async () => {
    const libA = createInstance();
    const libB = createInstance();
    const creatorLedger = new SkillReviewReadLedger('bg-create');
    await libA.manage({
      action: 'create',
      name: 'contended',
      content: skillContent('contended', 'v1'),
    }, 'background_review', preconditionFor(creatorLedger, 'create', 'contended'));

    const ledgerA = new SkillReviewReadLedger('bg-a');
    ledgerA.recordLoad('contended', undefined, libA.read('contended') ?? '');
    const ledgerB = new SkillReviewReadLedger('bg-b');
    ledgerB.recordLoad('contended', undefined, libB.read('contended') ?? '');

    const [resultA, resultB] = await Promise.all([
      libA.manage({
        action: 'edit',
        name: 'contended',
        content: skillContent('contended', 'A 版'),
      }, 'background_review', preconditionFor(ledgerA, 'edit', 'contended')),
      libB.manage({
        action: 'edit',
        name: 'contended',
        content: skillContent('contended', 'B 版'),
      }, 'background_review', preconditionFor(ledgerB, 'edit', 'contended')),
    ]);

    const succeeded = [resultA, resultB].filter(result => result.status === 'success');
    const failed = [resultA, resultB].filter(result => result.status !== 'success');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ errorCode: 'stale_skill_read' });
  });

  it('主文件与支持文件归属同一 Skill 锁域，并发写入串行且都成功', async () => {
    const libA = createInstance();
    const libB = createInstance();
    const creatorLedger = new SkillReviewReadLedger('bg-create');
    await libA.manage({
      action: 'create',
      name: 'shared-domain',
      content: skillContent('shared-domain', '主正文'),
    }, 'background_review', preconditionFor(creatorLedger, 'create', 'shared-domain'));

    const ledgerA = new SkillReviewReadLedger('bg-a');
    ledgerA.recordLoad('shared-domain', undefined, libA.read('shared-domain') ?? '');
    const ledgerB = new SkillReviewReadLedger('bg-b');
    ledgerB.recordLoad('shared-domain', undefined, libB.read('shared-domain') ?? '');

    const [editResult, writeResult] = await Promise.all([
      libA.manage({
        action: 'edit',
        name: 'shared-domain',
        content: skillContent('shared-domain', '主文件新版'),
      }, 'background_review', preconditionFor(ledgerA, 'edit', 'shared-domain')),
      libB.manage({
        action: 'write_file',
        name: 'shared-domain',
        filePath: 'references/note.md',
        fileContent: '支持文件',
      }, 'background_review', preconditionFor(ledgerB, 'write_file', 'shared-domain', 'references/note.md')),
    ]);

    // 同一锁域串行：后进入者的主文件凭证已过期 → 被拒。
    // 这证明支持文件没有形成独立锁域绕过 Skill 级互斥。
    const succeeded = [editResult, writeResult].filter(result => result.status === 'success');
    const failed = [editResult, writeResult].filter(result => result.status !== 'success');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ errorCode: 'stale_skill_read' });
  });

  it('create 竞争时目标由缺失变为存在返回 skill_target_changed', async () => {
    const libA = createInstance();
    const libB = createInstance();
    const ledgerA = new SkillReviewReadLedger('bg-a');
    const ledgerB = new SkillReviewReadLedger('bg-b');

    const [resultA, resultB] = await Promise.all([
      libA.manage({
        action: 'create',
        name: 'race-skill',
        content: skillContent('race-skill', 'A'),
      }, 'background_review', preconditionFor(ledgerA, 'create', 'race-skill')),
      libB.manage({
        action: 'create',
        name: 'race-skill',
        content: skillContent('race-skill', 'B'),
      }, 'background_review', preconditionFor(ledgerB, 'create', 'race-skill')),
    ]);

    const succeeded = [resultA, resultB].filter(result => result.status === 'success');
    const failed = [resultA, resultB].filter(result => result.status !== 'success');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ errorCode: 'skill_target_changed' });
  });

  it('锁获取失败时返回错误且已获取的锁被释放', async () => {
    const firstRelease = vi.fn(() => true);
    const failingManager = {
      acquire: vi.fn()
        .mockResolvedValueOnce({
          release: firstRelease,
          token: 't1',
          path: resolve(tempDir, 'locks', 'x.lock'),
        })
        .mockRejectedValueOnce(new Error('获取锁超时: test.lock')),
    } as unknown as CrossProcessLockManager;
    const lib = new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      new SkillUsageStore(usagePath),
      {
        enableWatcher: false,
        mutationLock: new SkillMutationLockManager(resolve(tempDir, 'locks'), failingManager),
      },
    );

    // delete 需要来源与吸收目标两把锁：第二把获取失败 → 第一把必须被释放。
    const result = await lib.manage({
      action: 'delete',
      name: 'source-x',
      absorbedInto: 'target-y',
    }, 'foreground');

    expect(result).toMatchObject({ status: 'error' });
    expect(failingManager.acquire).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledTimes(1);
  });

  it('锁管理器对双目标去重排序，反向参数并发不死锁', async () => {
    const manager = new SkillMutationLockManager(resolve(tempDir, 'locks'));

    // 第一个获取全部锁；第二个以相反参数顺序排队（内部统一排序为字典序）。
    const releaseAB = await manager.acquire(['b-skill', 'a-skill']);
    const releaseBAPromise = manager.acquire(['a-skill', 'b-skill']);

    // 第一个完成操作并释放后，第二个必须能继续完成（不会因锁顺序而死锁）。
    await releaseAB();
    const releaseBA = await releaseBAPromise;
    await releaseBA();
  });

  it('相同内容 patch 两阶段幂等：预览允许 ready，直接提交与批准重放均返回 error 且不写盘、不通知、不计 telemetry', async () => {
    writeSkill(userSkillsDir, 'text-posting', '第一版流程');
    const usageStore = new SkillUsageStore(usagePath);
    // 后台 origin 只能修改 agent-created Skill：为测试包登记 agent 所有权。
    await usageStore.markAgentCreated('text-posting');
    const library = new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      usageStore,
      { enableWatcher: false, skillLocksDir: resolve(tempDir, 'locks') },
    );
    const listener = vi.fn();
    library.subscribe(listener);

    // 重复复盘上下文可能对同一 Skill 发出相同内容 patch：
    // 替换后内容未变化时必须返回 error，不得产生文件、通知或 telemetry churn。
    const noChangePatch: SkillManageRequest = {
      action: 'patch',
      name: 'text-posting',
      oldString: '第一版流程',
      newString: '第一版流程', // 替换后内容未变化
    };

    // 阶段一：预览阶段只做匹配与唯一性校验，允许 ready。
    const preview = await library.previewManage(noChangePatch, 'background_review');
    if (preview.status !== 'ready') {
      throw new Error(`预览应允许 ready，实际为 error: ${preview.error}`);
    }

    // 后台修改必须先读后写：登记本次读取凭证，再签发 patch 前置条件。
    const ledger = new SkillReviewReadLedger('bg-no-change');
    ledger.recordLoad('text-posting', undefined, skillContent('text-posting', '第一版流程'));
    const precondition = preconditionFor(ledger, 'patch', 'text-posting');

    // 阶段二：关闭审批后的直接 manage() 提交必须在 doPatch 返回现有的 error 结果。
    const beforeStat = statSync(library.get('text-posting')!.filePath);
    const direct = await library.manage(noChangePatch, 'background_review', precondition);
    expect(direct).toMatchObject({ status: 'error', error: '替换后内容未变化' });
    // 不写盘（文件时间与内容不变）、不发 updated 通知、不增加 patch telemetry。
    expect(statSync(library.get('text-posting')!.filePath).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(library.read('text-posting')).toBe(skillContent('text-posting', '第一版流程'));
    expect(listener).not.toHaveBeenCalled();
    expect(usageStore.read('text-posting')?.patchCount ?? 0).toBe(0);

    // 阶段三：批准重放路径（replayGuard）同样在 doPatch 返回 error，不产生任何变更。
    const replayPreview = await library.previewManage(noChangePatch, 'background_review');
    if (replayPreview.status !== 'ready') {
      throw new Error(`重放预览应允许 ready，实际为 error: ${replayPreview.error}`);
    }
    const replayGuard = {
      id: 'pending-1',
      baseFingerprint: replayPreview.preview.baseFingerprint,
    };
    const replayed = await library.manage(
      noChangePatch,
      'background_review',
      precondition,
      replayGuard,
    );
    expect(replayed).toMatchObject({ status: 'error', error: '替换后内容未变化' });
    expect(statSync(library.get('text-posting')!.filePath).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(library.read('text-posting')).toBe(skillContent('text-posting', '第一版流程'));
    expect(listener).not.toHaveBeenCalled();
    expect(usageStore.read('text-posting')?.patchCount ?? 0).toBe(0);
  });
});

/** 从读取账本签发后台动作前置条件，签发失败时直接抛错。 */
function preconditionFor(
  ledger: SkillReviewReadLedger,
  action: SkillManageAction,
  name: string,
  filePath?: string,
  absorbedInto?: string,
): SkillMutationPrecondition {
  const precondition = ledger.buildPrecondition(
    ledger.boundCallerId, action, name, filePath, absorbedInto,
  );
  if (!precondition) {
    throw new Error(`前置条件签发失败: ${action} ${name}`);
  }
  return precondition;
}

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
