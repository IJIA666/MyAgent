/**
 * @file Claude Code 行为夹具加载与校验测试。
 * 从外部独立 fixture JSON 读取预期行为，不调用 MyAgent 自己的 service 生成 expected。
 * 拒绝缺少来源引用或使用假想 PascalCase 工具名的 fixture。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../../src/core/domain/permissions/tool-permission-service.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import type {
  PermissionMode,
  PermissionRule,
} from '../../../src/core/domain/permissions/permission-types.js';

/** 当前交付的三种普通模式。 */
const VALID_MODES: readonly string[] = ['default', 'acceptEdits', 'plan'];

/** 已知的假想 PascalCase 工具名（应被 fixture 拒绝）。 */
const PASCAL_CASE_PSEUDO_TOOLS = new Set([
  'Write', 'Edit', 'Read', 'Create', 'ApplyPatch', 'ReadManyFiles',
]);

/** 测试文件所在目录。 */
const __testDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

/** Fixture 文件路径（编译后在 dist 外，直接引用源 JSON）。 */
const FIXTURE_PATH = resolve(__testDir, '../../fixtures/permissions/claude/index.json');

// ── Fixture 类型 ──

interface ClaudePermissionFixture {
  readonly id: string;
  readonly scenario: string;
  readonly description: string;
  readonly input: {
    readonly runtimeToolName: string;
    readonly params: Record<string, unknown>;
    readonly session: {
      readonly mode: PermissionMode;
      readonly rules?: readonly PermissionRule[];
      readonly additionalDirectories?: readonly string[];
      readonly memoryDir?: string;
    };
  };
  readonly expectedOutput: {
    readonly decision: 'allow' | 'ask' | 'deny';
    readonly decisionReason?: string;
    readonly actions: readonly string[];
  };
  readonly source: string;
  readonly intentionalDifference?: string;
}

/** 加载并校验所有 fixture。 */
function loadFixtures(): ClaudePermissionFixture[] {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture 文件不存在: ${FIXTURE_PATH}`);
  }
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
  if (!Array.isArray(raw.fixtures)) {
    throw new Error('Fixture 索引必须包含 fixtures 数组');
  }
  return raw.fixtures as ClaudePermissionFixture[];
}

/** 模块级加载一次（同步）。 */
const ALL_FIXTURES = loadFixtures();

describe('Claude 权限行为夹具', () => {
  // ── Fixture 结构完整性校验（不依赖 MyAgent service）──

  describe('Fixture 结构校验', () => {
    for (const fixture of ALL_FIXTURES) {
      it(`${fixture.id}: 必须包含 source 引用`, () => {
        expect(fixture.source).toBeTruthy();
        expect(
          fixture.source.startsWith('url:') || fixture.source.startsWith('src:'),
        ).toBe(true);
      });

      it(`${fixture.id}: runtimeToolName 不能是假想 PascalCase 名称`, () => {
        expect(PASCAL_CASE_PSEUDO_TOOLS.has(fixture.input.runtimeToolName)).toBe(false);
      });

      it(`${fixture.id}: mode 必须是有效值`, () => {
        expect(VALID_MODES).toContain(fixture.input.session.mode);
      });

      it(`${fixture.id}: 必须有 expectedOutput`, () => {
        expect(['allow', 'ask', 'deny']).toContain(fixture.expectedOutput.decision);
      });

      it(`${fixture.id}: 必须有 params`, () => {
        expect(fixture.input.params).toBeTruthy();
      });
    }
  });

  // ── 对所有 fixture 执行行为等价验证 ──

  describe('行为等价验证', () => {
    for (const fixture of ALL_FIXTURES) {
      it(`${fixture.id}: ${fixture.description}`, async () => {
        const sessionState = new PermissionSessionState({
          mode: fixture.input.session.mode,
          rules: fixture.input.session.rules,
          additionalDirectories: fixture.input.session.additionalDirectories,
        });
        // 构造与 fixture mode 匹配的规则存储
        const ruleStore = new PermissionRuleStore();
        if (fixture.input.session.rules) {
          for (const rule of fixture.input.session.rules) {
            ruleStore.addRule(rule.source, rule);
          }
        }

        const svc = new ToolPermissionService({ ruleStore: sessionState.getRuleStore() });
        const result = await svc.checkPermissions(
          fixture.input.runtimeToolName,
          fixture.input.params,
          fixture.input.session.mode,
        );

        // 仅非 intentionalDifference 的 fixture 校验决策
        if (!fixture.intentionalDifference) {
          expect(result.kind).toBe(fixture.expectedOutput.decision);
          // 如果 fixture 有预期 decisionReason，校验原因包含该关键词
          if (fixture.expectedOutput.decisionReason) {
            expect(result.decisionReason ?? '').toContain(fixture.expectedOutput.decisionReason);
          }
        }
      });
    }
  });

  // ── 覆盖率校验 ──

  describe('Fixture 覆盖率', () => {
    it('至少包含 Manual/Accept edits on/Plan 三种模式的 fixture', () => {
      const modes = new Set(ALL_FIXTURES.map(f => f.input.session.mode));
      expect(modes.has('default')).toBe(true);
      expect(modes.has('acceptEdits')).toBe(true);
      expect(modes.has('plan')).toBe(true);
    });

    it('至少包含 writeFile、editFile、createDirectory、deletePath 四种工具的 fixture', () => {
      const tools = new Set(ALL_FIXTURES.map(f => f.input.runtimeToolName));
      expect(tools.has('writeFile')).toBe(true);
      expect(tools.has('editFile')).toBe(true);
      expect(tools.has('createDirectory')).toBe(true);
      expect(tools.has('deletePath')).toBe(true);
    });

    it('所有 fixture 都有唯一的 id', () => {
      const ids = ALL_FIXTURES.map(f => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('所有 fixture 都有 scenario 和 description', () => {
      for (const f of ALL_FIXTURES) {
        expect(f.scenario).toBeTruthy();
        expect(f.description).toBeTruthy();
      }
    });
  });
});
