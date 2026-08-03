/**
 * @file Agent-managed Skill 工具与包边界契约。
 * 固定工具注册、权限身份、六种动作、存储范围和单动作提交语义。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EFFECTFUL_ENTRYPOINTS } from '../../src/adapters/tools/effectful-entrypoints.js';
import { getSkillTools } from '../../src/adapters/tools/impl/skill/index.js';
import { LoadSkillTool } from '../../src/adapters/tools/impl/skill/skill.js';
import { SkillManageTool } from '../../src/adapters/tools/impl/skill/skill-manage.js';
import { SkillsListTool } from '../../src/adapters/tools/impl/skill/skills-list.js';
import { SkillManageAuthorizationAdapter } from '../../src/adapters/tools/permissions/skill-tool-authorization.js';
import { createTrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';
import type { SkillMutationPrecondition } from '../../src/core/domain/permissions/permission-types.js';
import type { ToolExecutionContext } from '../../src/core/usecases/plugins/plugin-types.js';
import { SkillLibrary } from '../../src/core/usecases/brain/skill-library.js';
import {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../src/core/usecases/brain/skill-pending-store.js';
import { SkillReviewReadLedger } from '../../src/core/usecases/brain/skill-review-read-ledger.js';
import type { SkillManageAction } from '../../src/core/usecases/brain/skill-types.js';
import { SkillUsageStore } from '../../src/core/usecases/brain/skill-usage-store.js';
import { createMockAppConfig } from '../helpers/mock-factory.js';

describe('Agent-managed Skill contract', () => {
  let tempDir: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;
  let archiveDir: string;
  let usageStore: SkillUsageStore;
  let library: SkillLibrary;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `agent-managed-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    userSkillsDir = resolve(tempDir, 'user-skills');
    projectSkillsDir = resolve(tempDir, 'project-skills');
    archiveDir = resolve(userSkillsDir, '.archive');
    mkdirSync(projectSkillsDir, { recursive: true });
    usageStore = new SkillUsageStore(resolve(userSkillsDir, '.usage.json'));
    library = new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      usageStore,
      { enableWatcher: false },
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('注册 skills_list/load_skill/skill_manage，schema 穷举六种 action 且不暴露 origin', () => {
    const tools = getSkillTools(library);
    // 三工具按「目录 → 读取 → 写入」的稳定顺序注册，同一 SkillLibrary 数据源。
    expect(tools.map(tool => tool.name)).toEqual(['skills_list', 'load_skill', 'skill_manage']);
    // 安全类别：目录与读取为 read，写入为 write。
    expect(tools.map(tool => tool.securityCategory)).toEqual(['read', 'read', 'write']);
    // 目录工具声明自限包络的 maxBytes，避免统一输出层截断。
    const listTool = tools.find(tool => tool.name === 'skills_list') as { maxBytes: number };
    expect(listTool.maxBytes).toBe(256 * 1024);
    const manage = tools.find(tool => tool.name === 'skill_manage') as SkillManageTool;
    const schema = manage.definition.function.parameters as {
      additionalProperties: boolean;
      properties: {
        action: { enum: string[] };
        [key: string]: unknown;
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty('origin');
    expect(schema.properties.action.enum).toEqual([
      'create',
      'patch',
      'edit',
      'delete',
      'write_file',
      'remove_file',
    ]);
  });

  it('skill_manage 使用 SkillManage 权限身份、effectful write manifest，delete 默认 ask 且非 ordinary edit', () => {
    const adapter = new SkillManageAuthorizationAdapter(library);
    const request = adapter.buildPermissionRequest({
      action: 'delete',
      name: 'target',
    }, {
      caller: createTrustedCallContext('contract-user', 'interactive'),
      toolResult: { kind: 'ask' },
    });
    const manifest = EFFECTFUL_ENTRYPOINTS.find(item => item.name === 'skill_manage');

    expect(adapter.permissionIdentity).toBe('SkillManage');
    expect(manifest).toMatchObject({
      kind: 'native-tool',
      sideEffect: 'write',
      adapterName: 'skillManageAuthorizationAdapter',
    });
    expect(new SkillManageTool(library).checkPermissions?.({
      action: 'delete',
      name: 'target',
    })).toMatchObject({ kind: 'ask' });
    expect(request.isEditOperation).toBe(false);
    expect(adapter.isOrdinaryEdit(request)).toBe(false);
  });

  it('首次创建用户根、项目同名覆盖、UTF-8 文本和大小边界稳定', async () => {
    expect(existsSync(userSkillsDir)).toBe(false);
    await expect(library.manage({
      action: 'create',
      name: 'utf8-skill',
      content: skillContent('utf8-skill', '中文正文'),
    }, 'foreground')).resolves.toMatchObject({ status: 'success' });
    expect(existsSync(resolve(userSkillsDir, 'utf8-skill', 'SKILL.md'))).toBe(true);

    writeSkill(projectSkillsDir, 'utf8-skill', '项目覆盖正文');
    library.reloadSkills();
    expect(library.get('utf8-skill')?.source).toBe('project');
    expect(library.read('utf8-skill')).toContain('项目覆盖正文');

    await expect(library.manage({
      action: 'write_file',
      name: 'utf8-skill',
      filePath: 'assets/too-large.txt',
      fileContent: '界'.repeat(400_000),
    }, 'foreground')).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('1048576'),
    });
  });

  it('后台只维护 managed 用户 Skill，且多次动作不存在跨调用事务', async () => {
    writeSkill(userSkillsDir, 'manual-skill', '手写正文');
    library.reloadSkills();
    const ledger = new SkillReviewReadLedger('bg-contract');
    // 读取凭证必须以文件真实全文（含 frontmatter）为准。
    ledger.recordLoad('manual-skill', undefined, skillContent('manual-skill', '手写正文'));
    // 未 adopt：即使读取凭证正确，所有权检查仍拒绝。
    await expect(library.manage({
      action: 'patch',
      name: 'manual-skill',
      oldString: '手写正文',
      newString: '后台修改',
    }, 'background_review', preconditionFor(ledger, 'patch', 'manual-skill')))
      .resolves.toMatchObject({ status: 'error' });

    await library.adopt('manual-skill');
    await expect(library.manage({
      action: 'patch',
      name: 'manual-skill',
      oldString: '手写正文',
      newString: '已验证正文',
    }, 'background_review', preconditionFor(ledger, 'patch', 'manual-skill')))
      .resolves.toMatchObject({ status: 'success' });
    // 越界支持文件路径：账本签发失败，后台写入 fail-closed。
    await expect(library.manage({
      action: 'write_file',
      name: 'manual-skill',
      filePath: '../outside.md',
      fileContent: '失败动作',
    }, 'background_review')).resolves.toMatchObject({ status: 'error' });
    expect(library.read('manual-skill')).toContain('已验证正文');
  });

  it('前台 delete 硬删除，后台 delete 只归档完整包并保留 absorbedInto', async () => {
    await library.manage({
      action: 'create',
      name: 'foreground-delete',
      content: skillContent('foreground-delete', '前台'),
    }, 'foreground');
    await library.manage({
      action: 'delete',
      name: 'foreground-delete',
    }, 'foreground');
    expect(existsSync(resolve(userSkillsDir, 'foreground-delete'))).toBe(false);

    const ledger = new SkillReviewReadLedger('bg-contract');
    await library.manage({
      action: 'create',
      name: 'source-skill',
      content: skillContent('source-skill', '来源'),
    }, 'background_review', preconditionFor(ledger, 'create', 'source-skill'));
    ledger.recordLoad('source-skill', undefined, library.read('source-skill') ?? '');
    await library.manage({
      action: 'write_file',
      name: 'source-skill',
      filePath: 'references/note.md',
      fileContent: '支持文件',
    }, 'background_review', preconditionFor(ledger, 'write_file', 'source-skill', 'references/note.md'));
    await library.manage({
      action: 'create',
      name: 'umbrella-skill',
      content: skillContent('umbrella-skill', '目标'),
    }, 'background_review', preconditionFor(ledger, 'create', 'umbrella-skill'));
    ledger.recordLoad('umbrella-skill', undefined, library.read('umbrella-skill') ?? '');
    await expect(library.manage({
      action: 'delete',
      name: 'source-skill',
      absorbedInto: 'umbrella-skill',
    }, 'background_review', preconditionFor(ledger, 'delete', 'source-skill', undefined, 'umbrella-skill')))
      .resolves.toMatchObject({ status: 'success' });

    expect(existsSync(resolve(archiveDir, 'source-skill', 'references', 'note.md'))).toBe(true);
    expect(usageStore.read('source-skill')).toMatchObject({
      state: 'archived',
      absorbedInto: 'umbrella-skill',
    });
  });

  it('后台修改必须先读取准确目标：盲写拒绝、读取后放行、读取后变化拒绝、前台不受影响', async () => {
    const ledger = new SkillReviewReadLedger('bg-contract');
    await library.manage({
      action: 'create',
      name: 'guard-skill',
      content: skillContent('guard-skill', 'v1'),
    }, 'background_review', preconditionFor(ledger, 'create', 'guard-skill'));

    // 盲写 patch：未读取目标，fail-closed 拒绝且不产生副作用。
    await expect(library.manage({
      action: 'patch',
      name: 'guard-skill',
      oldString: 'v1',
      newString: 'v2',
    }, 'background_review')).resolves.toMatchObject({
      status: 'error',
      errorCode: 'read_before_write_required',
    });
    expect(library.read('guard-skill')).toContain('v1');

    // 读取后 patch 放行。
    ledger.recordLoad('guard-skill', undefined, library.read('guard-skill') ?? '');
    const patchPrecondition = preconditionFor(ledger, 'patch', 'guard-skill');
    await expect(library.manage({
      action: 'patch',
      name: 'guard-skill',
      oldString: 'v1',
      newString: 'v2',
    }, 'background_review', patchPrecondition)).resolves.toMatchObject({ status: 'success' });

    // 读取后目标被另一写入更新：旧凭证重试返回 stale_skill_read。
    ledger.recordLoad('guard-skill', undefined, library.read('guard-skill') ?? '');
    await expect(library.manage({
      action: 'edit',
      name: 'guard-skill',
      content: skillContent('guard-skill', 'v3'),
    }, 'background_review', preconditionFor(ledger, 'edit', 'guard-skill')))
      .resolves.toMatchObject({ status: 'success' });
    await expect(library.manage({
      action: 'edit',
      name: 'guard-skill',
      content: skillContent('guard-skill', 'v4'),
    }, 'background_review', patchPrecondition)).resolves.toMatchObject({
      status: 'error',
      errorCode: 'stale_skill_read',
    });
    expect(library.read('guard-skill')).toContain('v3');

    // 前台不受读取账本约束。
    await expect(library.manage({
      action: 'edit',
      name: 'guard-skill',
      content: skillContent('guard-skill', 'v5'),
    }, 'foreground')).resolves.toMatchObject({ status: 'success' });
    expect(library.read('guard-skill')).toContain('v5');
  });

  it('pending 默认关闭并保持 Hermes 单动作直写基线', () => {
    const config = createMockAppConfig();
    expect(config.skills.writeApproval).toBe(false);
    expect(config.skills.creationNudgeInterval).toBe(10);
  });

  it('前台 create 成功后同一会话的 skills_list/load_skill 立即可见，pending/失败写入不提前出现', async () => {
    const tools = getSkillTools(library);
    const listTool = tools.find(tool => tool.name === 'skills_list') as SkillsListTool;
    const loadTool = tools.find(tool => tool.name === 'load_skill') as LoadSkillTool;
    const manageTool = tools.find(tool => tool.name === 'skill_manage') as SkillManageTool;

    // 前台成功创建：实时目录与结构化读取立即可见（不依赖任何提示词快照）。
    const created = JSON.parse(await manageTool.execute(
      { action: 'create', name: 'live-skill', content: skillContent('live-skill', '实时正文') },
      foregroundContext('create', 'live-skill'),
    )) as { status: string };
    expect(created).toMatchObject({ status: 'success' });

    const listed = JSON.parse(await listTool.execute({})) as {
      skills: Array<{ name: string }>;
    };
    expect(listed.skills.map(skill => skill.name)).toContain('live-skill');
    const loaded = JSON.parse(await loadTool.execute({ name: 'live-skill' })) as {
      content: string;
    };
    expect(loaded.content).toContain('实时正文');

    // writeApproval 开启时：pending 只暂存不写盘，目录不得提前出现该名称。
    const pendingStore = new SkillPendingStore(resolve(tempDir, 'pending'), library);
    const approvalTool = new SkillManageTool(
      library,
      pendingStore,
      new SkillWriteApprovalController(true),
    );
    const staged = JSON.parse(await approvalTool.execute(
      { action: 'create', name: 'pending-skill', content: skillContent('pending-skill', '待审批') },
      foregroundContext('create', 'pending-skill'),
    )) as { status: string; pendingId?: string };
    expect(staged.status).toBe('staged');
    const afterStage = JSON.parse(await listTool.execute({})) as {
      skills: Array<{ name: string }>;
    };
    expect(afterStage.skills.map(skill => skill.name)).not.toContain('pending-skill');

    // 失败写入（非法 frontmatter）不进入目录。
    const failed = JSON.parse(await manageTool.execute(
      { action: 'create', name: 'bad-skill', content: '没有 frontmatter' },
      foregroundContext('create', 'bad-skill'),
    )) as { status: string };
    expect(failed.status).toBe('error');
    const afterFailure = JSON.parse(await listTool.execute({})) as {
      skills: Array<{ name: string }>;
    };
    expect(afterFailure.skills.map(skill => skill.name)).not.toContain('bad-skill');
  });
});

/** 构造与参数绑定的前台权限分析上下文。 */
function foregroundContext(
  action: SkillManageAction,
  name: string,
): ToolExecutionContext {
  return {
    permissionAnalysis: {
      kind: 'skill-manage',
      action,
      name,
      origin: 'foreground',
      callerId: 'contract-user',
    },
  } as ToolExecutionContext;
}

/** 从读取账本签发后台动作的前置条件，签发失败时直接抛错。 */
function preconditionFor(
  ledger: SkillReviewReadLedger,
  action: SkillManageAction,
  name: string,
  filePath?: string,
  absorbedInto?: string,
): SkillMutationPrecondition {
  const precondition = ledger.buildPrecondition(
    'bg-contract', action, name, filePath, absorbedInto,
  );
  if (!precondition) {
    throw new Error(`前置条件签发失败: ${action} ${name}`);
  }
  return precondition;
}

/** 生成合法 Skill 正文。 */
function skillContent(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;
}

/** 写入完整测试 Skill。 */
function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(resolve(root, name), { recursive: true });
  writeFileSync(resolve(root, name, 'SKILL.md'), skillContent(name, body), 'utf8');
}
