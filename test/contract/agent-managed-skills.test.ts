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
import { SkillManageTool } from '../../src/adapters/tools/impl/skill/skill-manage.js';
import { SkillManageAuthorizationAdapter } from '../../src/adapters/tools/permissions/skill-tool-authorization.js';
import { createTrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';
import { SkillLibrary } from '../../src/core/usecases/brain/skill-library.js';
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

  it('注册 load_skill/skill_manage，schema 穷举六种 action 且不暴露 origin', () => {
    const tools = getSkillTools(undefined, library);
    expect(tools.map(tool => tool.name)).toEqual(['load_skill', 'skill_manage']);
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
    await expect(library.manage({
      action: 'patch',
      name: 'manual-skill',
      oldString: '手写正文',
      newString: '后台修改',
    }, 'background_review')).resolves.toMatchObject({ status: 'error' });

    await library.adopt('manual-skill');
    await expect(library.manage({
      action: 'patch',
      name: 'manual-skill',
      oldString: '手写正文',
      newString: '已验证正文',
    }, 'background_review')).resolves.toMatchObject({ status: 'success' });
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

    await library.manage({
      action: 'create',
      name: 'source-skill',
      content: skillContent('source-skill', '来源'),
    }, 'background_review');
    await library.manage({
      action: 'write_file',
      name: 'source-skill',
      filePath: 'references/note.md',
      fileContent: '支持文件',
    }, 'background_review');
    await library.manage({
      action: 'create',
      name: 'umbrella-skill',
      content: skillContent('umbrella-skill', '目标'),
    }, 'background_review');
    await expect(library.manage({
      action: 'delete',
      name: 'source-skill',
      absorbedInto: 'umbrella-skill',
    }, 'background_review')).resolves.toMatchObject({ status: 'success' });

    expect(existsSync(resolve(archiveDir, 'source-skill', 'references', 'note.md'))).toBe(true);
    expect(usageStore.read('source-skill')).toMatchObject({
      state: 'archived',
      absorbedInto: 'umbrella-skill',
    });
  });

  it('pending 默认关闭并保持 Hermes 单动作直写基线', () => {
    const config = createMockAppConfig();
    expect(config.skills.writeApproval).toBe(false);
    expect(config.skills.creationNudgeInterval).toBe(10);
  });
});

/** 生成合法 Skill 正文。 */
function skillContent(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;
}

/** 写入完整测试 Skill。 */
function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(resolve(root, name), { recursive: true });
  writeFileSync(resolve(root, name, 'SKILL.md'), skillContent(name, body), 'utf8');
}
