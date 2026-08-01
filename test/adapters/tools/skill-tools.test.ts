/**
 * @file load_skill 与 skill_manage 工具测试。
 * 覆盖模型 schema、执行期 origin 绑定、六种动作路由和查看遥测。
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoadSkillTool } from '../../../src/adapters/tools/impl/skill/skill.js';
import { SkillManageTool } from '../../../src/adapters/tools/impl/skill/skill-manage.js';
import { SkillLibrary } from '../../../src/core/usecases/brain/skill-library.js';
import { SkillUsageStore } from '../../../src/core/usecases/brain/skill-usage-store.js';
import type { SkillManageAction } from '../../../src/core/usecases/brain/skill-types.js';
import { SkillReviewReadLedger } from '../../../src/core/usecases/brain/skill-review-read-ledger.js';
import { SkillMutationLockManager } from '../../../src/core/usecases/brain/skill-mutation-lock.js';
import {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../../src/core/usecases/brain/skill-pending-store.js';
import type { SkillMutationPrecondition } from '../../../src/core/domain/permissions/permission-types.js';
import type { ToolExecutionContext } from '../../../src/core/usecases/plugins/plugin-types.js';

describe('Skill tools', () => {
  let tempDir: string;
  let usageStore: SkillUsageStore;
  let library: SkillLibrary;
  let manageTool: SkillManageTool;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const userSkills = resolve(tempDir, 'user');
    const projectSkills = resolve(tempDir, 'project');
    mkdirSync(userSkills, { recursive: true });
    mkdirSync(projectSkills, { recursive: true });
    usageStore = new SkillUsageStore(resolve(userSkills, '.usage.json'));
    library = new SkillLibrary(
      userSkills,
      projectSkills,
      resolve(userSkills, '.archive'),
      usageStore,
      { enableWatcher: false, skillLocksDir: resolve(tempDir, 'locks') },
    );
    manageTool = new SkillManageTool(library);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('schema 固定 additionalProperties=false 且不暴露 origin/caller', () => {
    const definition = manageTool.definition as {
      function: {
        parameters: {
          properties: Record<string, unknown>;
          additionalProperties: boolean;
        };
      };
    };

    expect(definition.function.parameters.additionalProperties).toBe(false);
    expect(definition.function.parameters.properties).not.toHaveProperty('origin');
    expect(definition.function.parameters.properties).not.toHaveProperty('caller');
  });

  it('缺少获批权限分析时 fail closed，不执行写入', async () => {
    const result = JSON.parse(await manageTool.execute({
      action: 'create',
      name: 'unbound',
      content: skillContent('unbound', '内容'),
    }));

    expect(result).toMatchObject({
      status: 'error',
      action: 'create',
      name: 'unbound',
    });
    expect(library.get('unbound')).toBeUndefined();
  });

  it('六种 action 均通过 NativeTool.execute 路由到 SkillLibrary', async () => {
    await expect(runManage('create', {
      content: skillContent('text-post', '第一版'),
    })).resolves.toMatchObject({ status: 'success', action: 'create' });
    await expect(runManage('write_file', {
      filePath: 'references/check.md',
      fileContent: '检查',
    })).resolves.toMatchObject({ status: 'success', action: 'write_file' });
    await expect(runManage('patch', {
      oldString: '第一版',
      newString: '第二版',
    })).resolves.toMatchObject({ status: 'success', action: 'patch' });
    await expect(runManage('edit', {
      content: skillContent('text-post', '第三版'),
    })).resolves.toMatchObject({ status: 'success', action: 'edit' });
    await expect(runManage('remove_file', {
      filePath: 'references/check.md',
    })).resolves.toMatchObject({ status: 'success', action: 'remove_file' });
    await expect(runManage('delete')).resolves.toMatchObject({
      status: 'success',
      action: 'delete',
    });
  });

  it('模型伪造 origin 不会覆盖权限分析绑定的 foreground', async () => {
    const result = await runManage('create', {
      content: skillContent('text-post', '内容'),
      origin: 'background_review',
    });

    expect(result).toMatchObject({
      status: 'success',
      agentCreated: false,
    });
    expect(usageStore.read('text-post')?.createdBy).toBeNull();
  });

  it('load_skill 成功读取主文件或支持文件后更新 view telemetry', async () => {
    await createBackgroundSkill('loadable', '主正文');
    const writeLedger = new SkillReviewReadLedger('bg-caller');
    writeLedger.recordLoad('loadable', undefined, library.read('loadable') ?? '');
    const writePrecondition = writeLedger.buildPrecondition(
      'bg-caller', 'write_file', 'loadable', 'references/detail.md',
    );
    await expect(manageTool.execute(
      {
        action: 'write_file',
        name: 'loadable',
        filePath: 'references/detail.md',
        fileContent: '支持正文',
      },
      backgroundAnalysis('write_file', 'loadable', writePrecondition),
    )).resolves.toContain('"status":"success"');
    const loadTool = new LoadSkillTool(undefined, library);
    expect(loadTool.maxBytes).toBeGreaterThan(600_000);

    await expect(loadTool.execute({ name: 'loadable' })).resolves.toContain('主正文');
    await expect(loadTool.execute({
      name: 'loadable',
      file_path: 'references/detail.md',
    })).resolves.toBe('支持正文');
    expect(usageStore.read('loadable')?.viewCount).toBe(2);
    await expect(loadTool.execute({
      name: 'loadable',
      file_path: '../../outside.txt',
    })).rejects.toThrow('无法读取');
  });

  it('后台盲写（未读取目标）直接 edit 返回 read_before_write_required', async () => {
    await library.manage({
      action: 'create',
      name: 'text-post',
      content: skillContent('text-post', '第一版'),
    }, 'foreground');

    const result = JSON.parse(await manageTool.execute(
      { action: 'edit', name: 'text-post', content: skillContent('text-post', '盲写版本') },
      backgroundAnalysis('edit', 'text-post'),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: 'error',
      errorCode: 'read_before_write_required',
    });
    expect(library.read('text-post')).toContain('第一版');
  });

  it('edit 不接受支持文件路径，支持文件读取不能覆盖 SKILL.md', async () => {
    await createBackgroundSkill('text-post', '受保护主文件');
    await library.manage({
      action: 'write_file',
      name: 'text-post',
      filePath: 'references/detail.md',
      fileContent: '已读取支持文件',
    }, 'foreground');
    const ledger = new SkillReviewReadLedger('bg-caller');
    ledger.recordLoad(
      'text-post',
      'references/detail.md',
      library.read('text-post', 'references/detail.md') ?? '',
    );

    // edit 的目标恒为 SKILL.md；支持文件凭证不能被签发成整文件替换凭证。
    expect(ledger.buildPrecondition(
      'bg-caller',
      'edit',
      'text-post',
      'references/detail.md',
    )).toBeNull();
    const result = JSON.parse(await manageTool.execute(
      {
        action: 'edit',
        name: 'text-post',
        filePath: 'references/detail.md',
        content: skillContent('text-post', '越权覆盖'),
      },
      backgroundAnalysis('edit', 'text-post'),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ status: 'error' });
    expect(String(result.error)).toContain('不接受 filePath');
    expect(library.read('text-post')).toContain('受保护主文件');
  });

  it('writeApproval 暂存前在写锁内复核读取版本，过期凭证不产生 pending', async () => {
    await createBackgroundSkill('text-post', '读取版本');
    const ledger = new SkillReviewReadLedger('bg-caller');
    ledger.recordLoad('text-post', undefined, library.read('text-post') ?? '');
    const precondition = ledger.buildPrecondition('bg-caller', 'edit', 'text-post');

    // 模拟模型读取后、工具进入暂存边界前，另一个前台调用已提交新版本。
    await library.manage({
      action: 'edit',
      name: 'text-post',
      content: skillContent('text-post', '并发新版本'),
    }, 'foreground');
    const pendingStore = new SkillPendingStore(resolve(tempDir, 'pending'), library);
    const approvalTool = new SkillManageTool(
      library,
      pendingStore,
      new SkillWriteApprovalController(true),
    );
    const result = JSON.parse(await approvalTool.execute(
      {
        action: 'edit',
        name: 'text-post',
        content: skillContent('text-post', '待审批版本'),
      },
      backgroundAnalysis('edit', 'text-post', precondition),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ status: 'error', errorCode: 'stale_skill_read' });
    expect(pendingStore.list()).toHaveLength(0);
    expect(library.read('text-post')).toContain('并发新版本');
  });

  it('取消等待中的 Skill 写锁后不会在释放锁时补写', async () => {
    await runManage('create', { content: skillContent('text-post', '取消前版本') });
    const blocker = new SkillMutationLockManager(resolve(tempDir, 'locks'));
    const releaseBlocker = await blocker.acquire(['text-post']);
    const controller = new AbortController();
    const execution = manageTool.execute(
      {
        action: 'edit',
        name: 'text-post',
        content: skillContent('text-post', '不应写入版本'),
      },
      {
        permissionAnalysis: {
          kind: 'skill-manage',
          action: 'edit',
          name: 'text-post',
          origin: 'foreground',
          callerId: 'local-test',
        },
      } as ToolExecutionContext,
      controller.signal,
    );

    controller.abort('background service closed');
    try {
      const result = JSON.parse(await execution) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'error' });
    } finally {
      await releaseBlocker();
    }
    await Promise.resolve();
    expect(library.read('text-post')).toContain('取消前版本');
    expect(library.read('text-post')).not.toContain('不应写入版本');
  });

  it('后台只读主文件后覆盖已有支持文件被拒绝', async () => {
    await library.manage({
      action: 'create',
      name: 'text-post',
      content: skillContent('text-post', '主正文'),
    }, 'foreground');
    await library.manage({
      action: 'write_file',
      name: 'text-post',
      filePath: 'references/detail.md',
      fileContent: '已有支持文件',
    }, 'foreground');

    // 只读取了主文件：账本按"新建支持文件"例外签发（要求目标仍不存在），
    // 但目标已存在，SkillLibrary 在锁内校验 requiredAbsent 时拒绝覆盖。
    const ledger = new SkillReviewReadLedger('bg-caller');
    ledger.recordLoad('text-post', undefined, library.read('text-post') ?? '');
    const precondition = ledger.buildPrecondition(
      'bg-caller', 'write_file', 'text-post', 'references/detail.md',
    );
    expect(precondition).not.toBeNull();
    expect(precondition?.requiredAbsent).toContain('text-post::references/detail.md');

    const result = JSON.parse(await manageTool.execute(
      {
        action: 'write_file',
        name: 'text-post',
        filePath: 'references/detail.md',
        fileContent: '覆盖版本',
      },
      backgroundAnalysis('write_file', 'text-post', precondition),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'error', errorCode: 'skill_target_changed' });
    expect(library.read('text-post', 'references/detail.md')).toContain('已有支持文件');
  });

  it('后台 create 与新建支持文件走新建例外', async () => {
    // create 不要求预读，账本只签发"目标仍不存在"约束。
    const createLedger = new SkillReviewReadLedger('bg-caller');
    const createPrecondition = createLedger.buildPrecondition(
      'bg-caller', 'create', 'fresh-skill',
    );
    expect(createPrecondition?.requiredAbsent).toContain('fresh-skill::<SKILL.md>');
    const createResult = JSON.parse(await manageTool.execute(
      { action: 'create', name: 'fresh-skill', content: skillContent('fresh-skill', '新建') },
      backgroundAnalysis('create', 'fresh-skill', createPrecondition),
    )) as Record<string, unknown>;
    expect(createResult).toMatchObject({ status: 'success', action: 'create' });

    // 新建支持文件要求所属主文件凭证；读取后放行。
    const ledger = new SkillReviewReadLedger('bg-caller');
    ledger.recordLoad('fresh-skill', undefined, library.read('fresh-skill') ?? '');
    const precondition = ledger.buildPrecondition(
      'bg-caller', 'write_file', 'fresh-skill', 'scripts/deploy.sh',
    );
    expect(precondition).not.toBeNull();
    expect(precondition?.requiredAbsent).toContain('fresh-skill::scripts/deploy.sh');

    const writeResult = JSON.parse(await manageTool.execute(
      {
        action: 'write_file',
        name: 'fresh-skill',
        filePath: 'scripts/deploy.sh',
        fileContent: 'echo ok',
      },
      backgroundAnalysis('write_file', 'fresh-skill', precondition),
    )) as Record<string, unknown>;
    expect(writeResult).toMatchObject({ status: 'success', action: 'write_file' });
  });

  it('后台 delete 合并归档要求来源与吸收目标双凭证', async () => {
    await createBackgroundSkill('legacy-skill', '待归档');
    await createBackgroundSkill('umbrella-skill', '吸收目标');

    // 只读取来源：前置条件签发失败。
    const partialLedger = new SkillReviewReadLedger('bg-caller');
    partialLedger.recordLoad('legacy-skill', undefined, library.read('legacy-skill') ?? '');
    expect(partialLedger.buildPrecondition(
      'bg-caller', 'delete', 'legacy-skill', undefined, 'umbrella-skill',
    )).toBeNull();

    // 来源与吸收目标都读取后签发成功并放行。
    const fullLedger = new SkillReviewReadLedger('bg-caller');
    fullLedger.recordLoad('legacy-skill', undefined, library.read('legacy-skill') ?? '');
    fullLedger.recordLoad('umbrella-skill', undefined, library.read('umbrella-skill') ?? '');
    const precondition = fullLedger.buildPrecondition(
      'bg-caller', 'delete', 'legacy-skill', undefined, 'umbrella-skill',
    );
    expect(precondition).not.toBeNull();

    const result = JSON.parse(await manageTool.execute(
      {
        action: 'delete',
        name: 'legacy-skill',
        absorbedInto: 'umbrella-skill',
      },
      backgroundAnalysis('delete', 'legacy-skill', precondition),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'success', action: 'delete' });
  });

  it('模型伪造 bypass 字段不能绕过读取凭证', async () => {
    await library.manage({
      action: 'create',
      name: 'text-post',
      content: skillContent('text-post', '受保护版本'),
    }, 'foreground');

    // 参数携带 fingerprint/bypass 字段：既不在 schema 中，也无法替代宿主前置条件。
    const result = JSON.parse(await manageTool.execute(
      {
        action: 'edit',
        name: 'text-post',
        content: skillContent('text-post', '伪造版本'),
        fingerprint: 'fake-hash',
        bypass: true,
      } as Record<string, unknown>,
      backgroundAnalysis('edit', 'text-post'),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ status: 'error', errorCode: 'read_before_write_required' });
    expect(library.read('text-post')).toContain('受保护版本');
  });

  it('后台凭证正确时 edit 放行，前台不受读取账本约束', async () => {
    await createBackgroundSkill('text-post', '第一版');

    // 后台：先读后写凭证匹配时放行。
    const ledger = new SkillReviewReadLedger('bg-caller');
    ledger.recordLoad('text-post', undefined, library.read('text-post') ?? '');
    const precondition = ledger.buildPrecondition('bg-caller', 'edit', 'text-post');
    const backgroundResult = JSON.parse(await manageTool.execute(
      { action: 'edit', name: 'text-post', content: skillContent('text-post', '后台版本') },
      backgroundAnalysis('edit', 'text-post', precondition),
    )) as Record<string, unknown>;
    expect(backgroundResult).toMatchObject({ status: 'success', action: 'edit' });

    // 前台：无账本、无前置条件仍可修改。
    await runManage('edit', { content: skillContent('text-post', '前台版本') });
    expect(library.read('text-post')).toContain('前台版本');
  });

  /** 使用与参数绑定的前台分析执行一次工具动作。 */
  async function runManage(
    action: SkillManageAction,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const args = {
      action,
      name: 'text-post',
      ...extra,
    };
    const context = {
      permissionAnalysis: {
        kind: 'skill-manage',
        action,
        name: 'text-post',
        origin: 'foreground',
        callerId: 'local-test',
      },
    } as ToolExecutionContext;
    return JSON.parse(await manageTool.execute(args, context)) as Record<string, unknown>;
  }

  /** 构造后台复盘的权限分析上下文，可附读取账本签发的前置条件。 */
  function backgroundAnalysis(
    action: SkillManageAction,
    name: string,
    precondition?: SkillMutationPrecondition | null,
  ): ToolExecutionContext {
    return {
      permissionAnalysis: {
        kind: 'skill-manage',
        action,
        name,
        origin: 'background_review',
        callerId: 'bg-caller',
        ...(precondition ? { mutationPrecondition: precondition } : {}),
      },
    } as ToolExecutionContext;
  }

  /** 以后台复盘身份创建 agent-created Skill（供所有权检查通过）。 */
  async function createBackgroundSkill(name: string, body: string): Promise<void> {
    const ledger = new SkillReviewReadLedger('bg-caller');
    const precondition = ledger.buildPrecondition('bg-caller', 'create', name);
    const result = JSON.parse(await manageTool.execute(
      { action: 'create', name, content: skillContent(name, body) },
      backgroundAnalysis('create', name, precondition),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'success', action: 'create' });
  }
});

/** 生成合法 Skill 正文。 */
function skillContent(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n${body}\n`;
}
