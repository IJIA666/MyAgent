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
      { enableWatcher: false },
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
    await library.manage({
      action: 'create',
      name: 'loadable',
      content: skillContent('loadable', '主正文'),
    }, 'background_review');
    await library.manage({
      action: 'write_file',
      name: 'loadable',
      filePath: 'references/detail.md',
      fileContent: '支持正文',
    }, 'background_review');
    const loadTool = new LoadSkillTool(undefined, library);

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
});

/** 生成合法 Skill 正文。 */
function skillContent(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n${body}\n`;
}
