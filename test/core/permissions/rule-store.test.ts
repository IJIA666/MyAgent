/**
 * @file PermissionRuleStore 单元测试。
 * 覆盖工具级规则、内容规则、冲突优先级、MCP 规则、路径规则、
 * 来源生命周期和 PermissionUpdate 持久化结果。
 */

import { describe, it, expect } from 'vitest';
import {
  PermissionRuleStore,
  matchRuleContent,
  isMcpRule,
  isAgentRule,
  isPathTool,
  isSessionSource,
  isPersistentSource,
} from '../../../src/core/domain/permissions/rule-store.js';
import type {
  PermissionUpdate,
} from '../../../src/core/domain/permissions/permission-types.js';

describe('PermissionRuleStore', () => {
  // ── 工具级规则 ──

  describe('工具级规则', () => {
    it('应匹配工具名称的所有调用', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });

      const result = store.getEffectiveBehavior('Bash');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });

    it('应返回无匹配时 undefined', () => {
      const store = new PermissionRuleStore();
      const result = store.getEffectiveBehavior('NonExistentTool');
      expect(result).toBeUndefined();
    });
  });

  // ── 内容规则 ──

  describe('内容限定规则', () => {
    it('应匹配带 specifier 的规则', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'npm run *' },
      });

      const matched = store.getMatchingRules('Bash', 'npm run dev');
      expect(matched.length).toBe(1);
      expect(matched[0].ruleBehavior).toBe('allow');
    });

    it('不应匹配不匹配 specifier 的内容', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'npm run *' },
      });

      const matched = store.getMatchingRules('Bash', 'rm -rf /');
      expect(matched.length).toBe(0);
    });
  });

  // ── 冲突优先级（deny → ask → allow）──

  describe('冲突优先级', () => {
    it('deny 应优先于 allow', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });

      const result = store.getEffectiveBehavior('Bash');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });

    it('ask 应优先于 allow', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'Bash' },
      });

      const result = store.getEffectiveBehavior('Bash');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('ask');
    });

    it('deny 应优先于 ask', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'Bash' },
      });
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });

      const result = store.getEffectiveBehavior('Bash');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });

    it('规则具体程度不应覆盖行为优先级', () => {
      const store = new PermissionRuleStore();
      // 宽范围 deny
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });
      // 更具体的 allow
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'npm run *' },
      });

      // deny 优先于 allow，即使 allow 更具体
      const result = store.getEffectiveBehavior('Bash', 'npm run dev');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });
  });

  // ── MCP 规则 ──

  describe('MCP 规则', () => {
    it('应识别 MCP server 规则', () => {
      expect(isMcpRule('mcp__filesystem')).toBe(true);
      expect(isMcpRule('mcp__filesystem__read')).toBe(true);
      expect(isMcpRule('Bash')).toBe(false);
    });

    it('应匹配 MCP server 级规则', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'mcp__filesystem' },
      });

      const result = store.getEffectiveBehavior('mcp__filesystem');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('ask');
    });

    it('应匹配具体 MCP tool 规则', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'mcp__filesystem__readFile' },
      });

      const result = store.getEffectiveBehavior('mcp__filesystem__readFile');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });
  });

  // ── Agent 规则 ──

  describe('Agent 规则', () => {
    it('应识别 Agent 规则', () => {
      expect(isAgentRule('Agent')).toBe(true);
      expect(isAgentRule('agent')).toBe(false);
    });

    it('应匹配带 specifier 的 Agent 规则', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Agent', ruleContent: 'Explore' },
      });

      const result = store.getEffectiveBehavior('Agent', 'Explore');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });
  });

  // ── 路径规则 ──

  describe('路径规则', () => {
    it('应识别路径工具', () => {
      expect(isPathTool('Read')).toBe(true);
      expect(isPathTool('Write')).toBe(true);
      expect(isPathTool('Edit')).toBe(true);
      expect(isPathTool('Glob')).toBe(true);
      expect(isPathTool('Bash')).toBe(false);
    });

    it('应匹配路径规则的通配模式', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Read', ruleContent: './.env' },
      });

      const result = store.getEffectiveBehavior('Read', './.env');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });
  });

  // ── 来源生命周期 ──

  describe('来源生命周期', () => {
    it('应识别 session 来源', () => {
      expect(isSessionSource('session')).toBe(true);
      expect(isSessionSource('command')).toBe(true);
      expect(isSessionSource('userSettings')).toBe(false);
    });

    it('应识别 persistent 来源', () => {
      expect(isPersistentSource('userSettings')).toBe(true);
      expect(isPersistentSource('projectSettings')).toBe(true);
      expect(isPersistentSource('localSettings')).toBe(true);
      expect(isPersistentSource('policySettings')).toBe(true);
      expect(isPersistentSource('session')).toBe(false);
    });

    it('clearSessionRules 应只清除 session 生命周期来源', () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });
      store.addRule('session', {
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });

      store.clearSessionRules();

      // session 来源规则被清除
      expect(store.getRules('session').length).toBe(0);
      // persistent 来源规则保留
      expect(store.getRules('userSettings').length).toBe(1);
    });
  });

  // ── PermissionUpdate 操作 ──

  describe('PermissionUpdate 操作', () => {
    it('add 操作应新增规则', () => {
      const store = new PermissionRuleStore();
      const update: PermissionUpdate = {
        operation: 'add',
        rules: [{
          source: 'session',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'Bash', ruleContent: 'npm run *' },
        }],
      };

      store.applyUpdate(update);
      const matched = store.getMatchingRules('Bash', 'npm run test');
      expect(matched.length).toBe(1);
      expect(matched[0].ruleBehavior).toBe('allow');
    });

    it('remove 操作应删除匹配的规则', () => {
      const store = new PermissionRuleStore();
      store.addRule('session', {
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });

      const update: PermissionUpdate = {
        operation: 'remove',
        rules: [{
          source: 'session',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'Bash' },
        }],
      };

      store.applyUpdate(update);
      expect(store.getRules('session').length).toBe(0);
    });

    it('replace 操作应替换已存在的规则', () => {
      const store = new PermissionRuleStore();
      store.addRule('session', {
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });

      const update: PermissionUpdate = {
        operation: 'replace',
        rules: [{
          source: 'session',
          ruleBehavior: 'deny',
          ruleValue: { toolName: 'Bash' },
        }],
      };

      store.applyUpdate(update);
      const result = store.getEffectiveBehavior('Bash');
      expect(result).toBeDefined();
      expect(result!.behavior).toBe('deny');
    });

    it('set 操作应全量替换来源的规则', () => {
      const store = new PermissionRuleStore();
      store.addRule('session', {
        source: 'session',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });

      const update: PermissionUpdate = {
        operation: 'set',
        targetSource: 'session',
        rules: [{
          source: 'session',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'Read' },
        }],
      };

      store.applyUpdate(update);
      expect(store.getRules('session').length).toBe(1);
      expect(store.getRules('session')[0].ruleValue.toolName).toBe('Read');
    });

    it('once 授权不应产生持久规则', () => {
      // once 通过不创建 PermissionUpdate 实现，只影响当前调用
      const store = new PermissionRuleStore();
      const rulesBefore = store.getAllRules().length;

      // once 授权：不写入规则存储
      const update: PermissionUpdate = {
        operation: 'add',
        rules: [], // once 不产生规则
      };

      store.applyUpdate(update);
      expect(store.getAllRules().length).toBe(rulesBefore);
    });

    it('session 授权应写入 session 来源', () => {
      const store = new PermissionRuleStore();
      store.applyUpdate({
        operation: 'add',
        rules: [{
          source: 'session',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'Bash', ruleContent: 'npm run *' },
        }],
      });

      const sessionRules = store.getRules('session');
      expect(sessionRules.length).toBe(1);
      expect(sessionRules[0].source).toBe('session');
    });
  });

  // ── matchRuleContent ──

  describe('matchRuleContent', () => {
    it('精确匹配', () => {
      expect(matchRuleContent('Bash', 'npm run dev', 'npm run dev')).toBe(true);
      expect(matchRuleContent('Bash', 'npm run dev', 'npm run test')).toBe(false);
    });

    it('通配符匹配', () => {
      expect(matchRuleContent('Read', '*.env', '.env')).toBe(true);
      expect(matchRuleContent('Read', '*.env', 'config.env')).toBe(true);
      expect(matchRuleContent('Read', '*.env.local', '.env.local')).toBe(true);
      expect(matchRuleContent('Read', '*.ts', 'index.ts')).toBe(true);
      expect(matchRuleContent('Read', '*.ts', 'index.js')).toBe(false);
    });

    it('* 通配所有', () => {
      expect(matchRuleContent('Bash', '*', 'anything')).toBe(true);
      expect(matchRuleContent('Read', '*', '/any/path')).toBe(true);
    });

    it('路径前缀匹配', () => {
      expect(matchRuleContent('Read', '/workspace/project', '/workspace/project/src/index.ts')).toBe(true);
      expect(matchRuleContent('Read', '/workspace/project/', '/workspace/project/src/index.ts')).toBe(true);
      expect(matchRuleContent('Read', '/workspace/project', '/workspace/other/file.ts')).toBe(false);
    });
  });
});
