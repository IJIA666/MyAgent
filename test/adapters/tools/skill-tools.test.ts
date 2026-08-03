/**
 * @file load_skill、skills_list 与 skill_manage 工具测试。
 * 覆盖模型 schema、执行期 origin 绑定、六种动作路由、结构化读取结果、
 * 实时目录语义和查看遥测。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoadSkillTool } from '../../../src/adapters/tools/impl/skill/skill.js';
import { SkillsListTool } from '../../../src/adapters/tools/impl/skill/skills-list.js';
import { SkillManageTool } from '../../../src/adapters/tools/impl/skill/skill-manage.js';
import { SkillLibrary } from '../../../src/core/usecases/brain/skill-library.js';
import { SkillUsageStore } from '../../../src/core/usecases/brain/skill-usage-store.js';
import { serializeNativeToolTextResultForModel } from '../../../src/core/usecases/engine/ToolDispatcher.js';
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
    const loadTool = new LoadSkillTool(library);
    expect(loadTool.maxBytes).toBeGreaterThan(600_000);

    // 主文件读取返回结构化包络：元数据、SKILL.md 路径、完整正文与支持文件列表。
    const mainResult = JSON.parse(await loadTool.execute({ name: 'loadable' })) as {
      name: string;
      file: string;
      content: string;
      supportFiles: string[];
    };
    expect(mainResult).toMatchObject({
      name: 'loadable',
      file: 'SKILL.md',
    });
    expect(mainResult.content).toContain('主正文');
    expect(mainResult.supportFiles).toEqual(['references/detail.md']);
    // 结构化结果不暴露物理路径与所有权字段。
    expect(mainResult).not.toHaveProperty('filePath');
    expect(mainResult).not.toHaveProperty('skillDir');

    // 支持文件读取返回同一包络结构，file 为规范化相对路径。
    const supportResult = JSON.parse(await loadTool.execute({
      name: 'loadable',
      file_path: 'references/detail.md',
    })) as { file: string; content: string };
    expect(supportResult.file).toBe('references/detail.md');
    expect(supportResult.content).toBe('支持正文');
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

  /** 直接向项目 Skill 目录写入包并刷新合并视图（用于同名覆盖场景）。 */
  function writeProjectSkill(name: string, description: string): void {
    const dir = resolve(tempDir, 'project', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n项目正文\n`,
      'utf8',
    );
    library.reloadSkills();
  }

  /** 批量向用户 Skill 目录写入包，全部写入后一次性刷新合并视图。 */
  function writeUserSkills(entries: Array<[string, string]>): void {
    for (const [name, description] of entries) {
      const dir = resolve(tempDir, 'user', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'SKILL.md'),
        skillContentWithDescription(name, description),
        'utf8',
      );
    }
    library.reloadSkills();
  }

  describe('SkillsListTool 实时目录', () => {
    it('返回项目同名覆盖用户后的合并视图并按名称稳定排序', async () => {
      await library.manage({
        action: 'create',
        name: 'gamma',
        content: skillContent('gamma', '用户版'),
      }, 'foreground');
      await library.manage({
        action: 'create',
        name: 'alpha',
        content: skillContent('alpha', '用户版'),
      }, 'foreground');
      writeProjectSkill('alpha', '项目版');
      await library.manage({
        action: 'create',
        name: 'beta',
        content: skillContent('beta', '用户版'),
      }, 'foreground');

      const tool = new SkillsListTool(library);
      const result = JSON.parse(await tool.execute({})) as {
        skills: Array<{ name: string; description: string; source: string }>;
        totalCount: number;
        matchedCount: number;
        returnedCount: number;
        complete: boolean;
      };

      expect(result).toMatchObject({
        totalCount: 3,
        matchedCount: 3,
        returnedCount: 3,
        complete: true,
      });
      expect(result.skills.map(skill => skill.name)).toEqual(['alpha', 'beta', 'gamma']);
      expect(result.skills[0]).toMatchObject({
        name: 'alpha',
        description: '项目版',
        source: 'project',
      });
      // 条目只暴露白名单字段，不包含物理路径与所有权内部字段。
      expect(result.skills[0]).not.toHaveProperty('filePath');
      expect(result.skills[0]).not.toHaveProperty('skillDir');
    });

    it('分类精确匹配与大小写不敏感关键词取交集筛选', async () => {
      await library.manage({
        action: 'create',
        name: 'web-deploy',
        content: skillContent('web-deploy', '部署自动化', 'development'),
      }, 'foreground');
      await library.manage({
        action: 'create',
        name: 'data-clean',
        content: skillContent('data-clean', '数据清洗', 'data'),
      }, 'foreground');

      const tool = new SkillsListTool(library);
      // 分类去除首尾空白后精确匹配。
      const hit = JSON.parse(await tool.execute({ category: ' development ' })) as {
        skills: Array<{ name: string; category?: string }>;
        matchedCount: number;
        filters?: { category?: string; query?: string };
      };
      expect(hit.filters).toEqual({ category: 'development' });
      expect(hit.matchedCount).toBe(1);
      expect(hit.skills[0]).toMatchObject({
        name: 'web-deploy',
        category: 'development',
      });

      // query 对名称、描述与分类做大小写不敏感子串匹配。
      const queryHit = JSON.parse(await tool.execute({ query: 'DEPLOY' })) as {
        skills: Array<{ name: string }>;
        matchedCount: number;
        filters?: { query?: string };
      };
      expect(queryHit.filters).toEqual({ query: 'DEPLOY' });
      expect(queryHit.matchedCount).toBe(1);
      expect(queryHit.skills[0].name).toBe('web-deploy');

      // category 与 query 同时命中才返回（交集语义）。
      const intersection = JSON.parse(await tool.execute({
        category: 'data',
        query: 'clean',
      })) as { skills: Array<{ name: string }>; matchedCount: number };
      expect(intersection.matchedCount).toBe(1);
      expect(intersection.skills[0].name).toBe('data-clean');

      // 交集为空时返回合法空结果，不作为错误。
      const empty = JSON.parse(await tool.execute({
        category: 'development',
        query: 'clean',
      })) as { skills: unknown[]; totalCount: number; matchedCount: number; returnedCount: number; complete: boolean };
      expect(empty).toMatchObject({
        skills: [],
        totalCount: 2,
        matchedCount: 0,
        returnedCount: 0,
        complete: true,
      });
    });

    it('空值、超长与未知参数明确失败', async () => {
      const tool = new SkillsListTool(library);
      await expect(tool.execute({ category: '   ' })).rejects.toThrow('不能为空字符串');
      await expect(tool.execute({ query: '' })).rejects.toThrow('query 不能为空字符串');
      await expect(tool.execute({ category: 42 })).rejects.toThrow('category 必须是字符串');
      await expect(tool.execute({ category: 'x'.repeat(257) })).rejects.toThrow('不能超过 256 字符');
      await expect(tool.execute({ query: 'y'.repeat(257) })).rejects.toThrow('不能超过 256 字符');
      await expect(tool.execute({ limit: 10 })).rejects.toThrow('不支持参数');
    });

    it('长描述按 1024 字符摘要并标记 descriptionTruncated', async () => {
      writeUserSkills([['long-desc', '长'.repeat(2000)]]);

      const tool = new SkillsListTool(library);
      const result = JSON.parse(await tool.execute({})) as {
        skills: Array<{ name: string; description: string; descriptionTruncated?: boolean }>;
      };
      const item = result.skills.find(skill => skill.name === 'long-desc');
      expect(item?.description).toHaveLength(1024);
      expect(item?.descriptionTruncated).toBe(true);
    });

    it('超大目录仍返回配额内合法 JSON 与 complete=false/refineHint', async () => {
      // 300 个 1024 字符描述的 Skill：完整包络必然超过 240KB 预算。
      const entries: Array<[string, string]> = [];
      for (let i = 0; i < 300; i++) {
        entries.push([`bulk-${String(i).padStart(3, '0')}`, '字'.repeat(1024)]);
      }
      writeUserSkills(entries);

      const tool = new SkillsListTool(library);
      const raw = await tool.execute({});
      const modelOutput = serializeNativeToolTextResultForModel(raw);
      const result = JSON.parse(raw) as {
        skills: Array<{ name: string }>;
        totalCount: number;
        matchedCount: number;
        returnedCount: number;
        complete: boolean;
        refineHint?: string;
      };

      // 按真实 CallToolResult 包装和二次序列化后的模型回执仍在内部预算内。
      expect(Buffer.byteLength(modelOutput, 'utf8')).toBeLessThanOrEqual(240 * 1024);
      expect(result.totalCount).toBe(300);
      expect(result.matchedCount).toBe(300);
      expect(result.returnedCount).toBeLessThan(300);
      expect(result.complete).toBe(false);
      expect(result.refineHint).toContain('缩小范围');
      // 部分返回的条目仍按名称稳定排序。
      const names = result.skills.map(skill => skill.name);
      expect([...names].sort()).toEqual(names);
    });

    it('大量需 JSON 二次转义的描述仍不会突破最终模型回执预算', async () => {
      const quoteHeavySkills = Array.from({ length: 400 }, (_, index) => ({
        name: `quoted-${String(index).padStart(3, '0')}`,
        description: '"'.repeat(1024),
        source: 'user' as const,
      }));
      const quoteHeavyLibrary = {
        list: () => quoteHeavySkills,
      } as unknown as SkillLibrary;
      const tool = new SkillsListTool(quoteHeavyLibrary);

      const raw = await tool.execute({});
      const modelOutput = serializeNativeToolTextResultForModel(raw);
      const result = JSON.parse(raw) as {
        matchedCount: number;
        returnedCount: number;
        complete: boolean;
      };

      // 引号在内层和 CallToolResult 外层都会转义，必须按最终表示限制大小。
      expect(Buffer.byteLength(modelOutput, 'utf8')).toBeLessThanOrEqual(240 * 1024);
      expect(result.matchedCount).toBe(400);
      expect(result.returnedCount).toBeLessThan(400);
      expect(result.complete).toBe(false);
    });

    it('目录列举不产生查看遥测', async () => {
      await library.manage({
        action: 'create',
        name: 'no-view',
        content: skillContent('no-view', '正文'),
      }, 'foreground');

      const tool = new SkillsListTool(library);
      await tool.execute({});
      await tool.execute({ category: 'nonexistent' });

      expect(usageStore.read('no-view')?.viewCount ?? 0).toBe(0);
      expect(usageStore.read('no-view')?.lastViewedAt ?? null).toBeNull();
    });

    it('缺少 SkillLibrary 时明确失败，不返回伪造目录', async () => {
      await expect(new SkillsListTool().execute({})).rejects.toThrow('未注入 SkillLibrary');
    });

    it('schema 只接受可选 category/query 且不提供分页', () => {
      const definition = new SkillsListTool(library).definition as {
        function: {
          parameters: {
            properties: Record<string, { maxLength?: number }>;
            additionalProperties: boolean;
          };
        };
      };
      expect(definition.function.parameters.additionalProperties).toBe(false);
      expect(Object.keys(definition.function.parameters.properties)).toEqual(['category', 'query']);
      expect(definition.function.parameters.properties.category?.maxLength).toBe(256);
      expect(definition.function.parameters.properties.query?.maxLength).toBe(256);
    });

    it('load_skill 不提供 offset/limit 分页语义', () => {
      const definition = new LoadSkillTool(library).definition as {
        function: {
          parameters: {
            properties: Record<string, unknown>;
            additionalProperties: boolean;
          };
        };
      };
      expect(definition.function.parameters.additionalProperties).toBe(false);
      expect(definition.function.parameters.properties).not.toHaveProperty('offset');
      expect(definition.function.parameters.properties).not.toHaveProperty('limit');
    });
  });
});

/** 生成合法 Skill 正文，可附可选分类。 */
function skillContent(name: string, body: string, category?: string): string {
  const categoryLine = category ? `category: ${category}\n` : '';
  return `---\nname: ${name}\ndescription: ${name} 描述\n${categoryLine}---\n\n${body}\n`;
}

/** 生成描述可自定义的合法 Skill 正文。 */
function skillContentWithDescription(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;
}
