/**
 * ApprovalPolicy 中央策略服务单元测试。
 * 覆盖 choice 生成规则、mapChoiceToEffect 映射、提取器交叉校验。
 */

import { describe, it, expect } from 'vitest';
import { ApprovalPolicy } from '../../../../src/core/usecases/security/ApprovalPolicy.js';
import type { SafetyOperation, ApprovalChoiceId } from '../../../../src/core/usecases/plugins/plugin-types.js';
import { extractSafePrefix } from '../../../../src/adapters/tools/impl/system/terminal.js';

/** 构造一个文件读操作描述 */
function readOp(path: string, summary?: string): SafetyOperation {
  return {
    resources: [{ kind: 'path', access: 'read', normalizedPath: path }],
    riskReason: '文件读操作',
    operationCategory: 'file-read',
    summary: summary ?? `读取文件 ${path}`,
  };
}

/** 构造一个文件写操作描述 */
function writeOp(path: string, summary?: string): SafetyOperation {
  return {
    resources: [{ kind: 'path', access: 'write', normalizedPath: path }],
    riskReason: '文件写操作',
    operationCategory: 'file-write',
    summary: summary ?? `写入文件 ${path}`,
  };
}

/** 构造一个命令操作描述 */
function commandOp(prefix: string): SafetyOperation {
  return {
    resources: [{ kind: 'command-prefix', prefix }],
    riskReason: '命令执行',
    operationCategory: 'command-execute',
    summary: `执行命令: ${prefix}`,
  };
}

/** 提取 choiceId 列表 */
function choiceIds(request: { choices: { choiceId: ApprovalChoiceId }[] }): ApprovalChoiceId[] {
  return request.choices.map(c => c.choiceId);
}

describe('ApprovalPolicy — resolve() choice 生成', () => {
  const policy = new ApprovalPolicy();

  // 注册内置工具的提取器，使 resolve() 能正确识别内置工具
  policy.registerExtractor('readFile', (args) => {
    const path = args.targetPath as string;
    return path ? [{ kind: 'path', access: 'read', normalizedPath: path }] : [];
  });
  policy.registerExtractor('writeFile', (args) => {
    const path = args.targetPath as string;
    return path ? [{ kind: 'path', access: 'write', normalizedPath: path }] : [];
  });
  policy.registerExtractor('editFile', (args) => {
    const path = args.targetPath as string;
    return path ? [{ kind: 'path', access: 'write', normalizedPath: path }] : [];
  });
  policy.registerExtractor('execute_command', (args) => {
    const command = args.command as string;
    if (command) {
      const prefix = extractSafePrefix(command);
      return prefix ? [{ kind: 'command-prefix', prefix }] : [];
    }
    return [];
  });

  it('7.1 文件读操作 → choices 为 [call, session, deny]', () => {
    const result = policy.resolve({
      toolName: 'readFile',
      toolArgs: { targetPath: '/workspace/readme.md' },
      operation: readOp('/workspace/readme.md'),
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'session', 'deny']);
  });

  it('7.1 文件写操作 → choices 为 [call, session, deny]', () => {
    const result = policy.resolve({
      toolName: 'writeFile',
      toolArgs: { targetPath: '/workspace/output.txt' },
      operation: writeOp('/workspace/output.txt'),
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'session', 'deny']);
  });

  it('7.1 命令操作 → choices 为 [call, persistent, deny]', () => {
    const result = policy.resolve({
      toolName: 'execute_command',
      toolArgs: { command: 'git status' },
      operation: commandOp('git status'),
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'persistent', 'deny']);
  });

  it('7.1 旧格式命令操作缺少 resources 时，使用提取器补全后仍生成 [call, persistent, deny]', () => {
    const result = policy.resolve({
      toolName: 'execute_command',
      toolArgs: { command: 'git status' },
      operation: {
        resources: [],
        riskReason: '命令执行',
        operationCategory: 'command-execute',
        summary: '执行命令: git status',
      },
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'persistent', 'deny']);
    expect(result.operation?.resources).toEqual([{ kind: 'command-prefix', prefix: 'git status' }]);
  });

  it('7.1 旧格式文件写操作缺少 resources 时，使用提取器补全后仍生成 [call, session, deny]', () => {
    const result = policy.resolve({
      toolName: 'writeFile',
      toolArgs: { targetPath: '/workspace/output.txt' },
      operation: {
        resources: [],
        riskReason: '文件写操作',
        operationCategory: 'file-write',
        summary: '写入文件 /workspace/output.txt',
      },
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'session', 'deny']);
    expect(result.operation?.resources).toEqual([{ kind: 'path', access: 'write', normalizedPath: '/workspace/output.txt' }]);
  });

  it('7.1 无可持久化前缀的命令 → choices 为 [call, deny]', () => {
    const result = policy.resolve({
      toolName: 'execute_command',
      toolArgs: { command: 'python script.py' },
      operation: {
        resources: [],
        riskReason: '命令执行',
        operationCategory: 'command-execute',
        summary: '执行命令: python script.py',
      },
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'deny']);
  });

  it('7.1 hardline 命令 → choices 仅为 [deny]', () => {
    const result = policy.resolve({
      toolName: 'execute_command',
      toolArgs: { command: 'rm -rf /' },
      operation: commandOp('rm'),
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['deny']);
  });

  it('7.1 敏感文件（.env）→ choices 为 [call, deny]', () => {
    const result = policy.resolve({
      toolName: 'readFile',
      toolArgs: { targetPath: '/workspace/.env' },
      operation: readOp('/workspace/.env'),
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'deny']);
  });

  it('7.1 第三方工具（无提取器）→ choices 为 [call, deny]', () => {
    const result = policy.resolve({
      toolName: 'some-remote-mcp-tool',
      toolArgs: { someArg: 'value' },
      operation: readOp('/some/path'),
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'deny']);
  });

  it('7.1 deny 始终出现在 choice 列表中', () => {
    const result = policy.resolve({
      toolName: 'readFile',
      toolArgs: { targetPath: '/workspace/file.txt' },
      operation: readOp('/workspace/file.txt'),
      workMode: 'Safe',
    });
    const ids = choiceIds(result);
    expect(ids[ids.length - 1]).toBe('deny');
  });
});

describe('ApprovalPolicy — mapChoiceToEffect() 映射', () => {
  const toolName = 'writeFile';

  it('7.2 call → 返回 type=call 的 PendingGrant', () => {
    const op = writeOp('/tmp/test.txt');
    const effect = ApprovalPolicy.mapChoiceToEffect('call', op, toolName);
    expect(effect.type).toBe('call');
    if (effect.type === 'call' && effect.payload && 'toolName' in effect.payload) {
      expect(effect.payload.type).toBe('call');
      expect((effect.payload as { toolName: string }).toolName).toBe(toolName);
    }
  });

  it('7.2 session → 返回 type=session 的 PendingGrant，resources 按 access 分类', () => {
    const op = writeOp('/tmp/session-test.txt');
    const effect = ApprovalPolicy.mapChoiceToEffect('session', op, toolName);
    expect(effect.type).toBe('session');
    if (effect.type === 'session' && effect.payload) {
      expect(effect.payload.type).toBe('session');
      const sessionPayload = effect.payload as { type: 'session'; resources: { access: string; normalizedPath: string }[] };
      expect(sessionPayload.resources[0].access).toBe('write');
    }
  });

  it('7.2 persistent → 返回 type=persistent 的 PersistentRuleEffect', () => {
    const op = commandOp('npm');
    const effect = ApprovalPolicy.mapChoiceToEffect('persistent', op, 'execute_command');
    expect(effect.type).toBe('persistent');
    if (effect.type === 'persistent' && effect.payload) {
      expect(effect.payload.type).toBe('persistent');
      expect((effect.payload as { prefix: string }).prefix).toBe('npm');
    }
  });

  it('7.2 persistent 用于非命令资源 → 降级为 deny', () => {
    const op = writeOp('/tmp/file.txt');
    const effect = ApprovalPolicy.mapChoiceToEffect('persistent', op, toolName);
    expect(effect.type).toBe('deny');
  });

  it('7.2 deny → 返回 type=deny，无 payload', () => {
    const op = writeOp('/tmp/deny-test.txt');
    const effect = ApprovalPolicy.mapChoiceToEffect('deny', op, toolName);
    expect(effect.type).toBe('deny');
  });
});

describe('ApprovalPolicy — 提取器交叉校验', () => {
  it('7.4 有注册的提取器且匹配 → 正常产出 choices', () => {
    const policy = new ApprovalPolicy();
    // 注册一个简单的文件路径提取器
    policy.registerExtractor('myTool', (args) => {
      const path = args.targetPath as string;
      return path ? [{ kind: 'path', access: 'write', normalizedPath: path }] : [];
    });

    const result = policy.resolve({
      toolName: 'myTool',
      toolArgs: { targetPath: '/workspace/file.txt' },
      operation: writeOp('/workspace/file.txt'),
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toContain('call');
  });

  it('7.4 有注册的提取器但不匹配 → 仅返回 [deny]', () => {
    const policy = new ApprovalPolicy();
    policy.registerExtractor('myTool', (args) => {
      const path = args.targetPath as string;
      return path ? [{ kind: 'path', access: 'write', normalizedPath: path }] : [];
    });

    // 操作报告了一个不同的路径
    const result = policy.resolve({
      toolName: 'myTool',
      toolArgs: { targetPath: '/workspace/file.txt' },
      // 工具报告的路径比提取器少一个
      operation: {
        resources: [{ kind: 'path', access: 'write', normalizedPath: '/workspace/other.txt' }],
        riskReason: '写入',
        operationCategory: 'file-write',
        summary: '写入 other.txt',
      },
      workMode: 'Safe',
    });
    // 不匹配 → 仅 deny
    expect(choiceIds(result)).toEqual(['deny']);
  });

  it('7.4 无提取器 → 按 untrusted 处理，仅 [call, deny]', () => {
    const policy = new ApprovalPolicy();
    const result = policy.resolve({
      toolName: 'unregisteredTool',
      toolArgs: { targetPath: '/workspace/file.txt' },
      operation: writeOp('/workspace/file.txt'),
      workMode: 'Safe',
    });
    expect(choiceIds(result)).toEqual(['call', 'deny']);
  });

  describe('ApprovalPolicy — Plan 模式 choice 过滤', () => {
    it('Plan 模式下不应出现 session/persistent 选项', () => {
      const policy = new ApprovalPolicy();
      // 注册一个路径提取器，使 path+read 资源被正常校验
      policy.registerExtractor('readFile', (args) => {
        const path = args.targetPath as string;
        return path ? [{ kind: 'path', access: 'read', normalizedPath: path }] : [];
      });

      // path+read 资源在 Safe 模式下产生 [call, session, deny]
      const safeResult = policy.resolve({
        toolName: 'readFile',
        toolArgs: { targetPath: '/workspace/file.txt' },
        operation: readOp('/workspace/file.txt'),
        workMode: 'Safe',
      });
      const safeChoices = choiceIds(safeResult);
      expect(safeChoices).toContain('session');

      // Plan 模式下 session 和 persistent 应被过滤
      const planResult = policy.resolve({
        toolName: 'readFile',
        toolArgs: { targetPath: '/workspace/file.txt' },
        operation: readOp('/workspace/file.txt'),
        workMode: 'Plan',
      });
      const planChoices = choiceIds(planResult);
      expect(planChoices).not.toContain('session');
      expect(planChoices).not.toContain('persistent');
      expect(planChoices).toContain('call');
      expect(planChoices).toContain('deny');
    });
  });

  describe('ApprovalPolicy — command-operation 资源', () => {
    it('command-operation 资源产生 [call, persistent, deny] 选项', () => {
      const policy = new ApprovalPolicy();
      // 注册一个命令操作提取器，使 command-operation 资源被正常校验
      policy.registerExtractor('execute_command', (args) => {
        const cmd = args.command as string;
        if (!cmd) return [];
        const rootCmd = cmd.split(/\s+/)[0] || '';
        return [{ kind: 'command-operation', shellKind: 'powershell', rootCommand: rootCmd, paramPattern: cmd }];
      });

      const result = policy.resolve({
        toolName: 'execute_command',
        toolArgs: { command: 'git status' },
        operation: {
          resources: [{ kind: 'command-operation', shellKind: 'powershell', rootCommand: 'git', paramPattern: 'git status' }],
          riskReason: 'Git 状态查询',
          operationCategory: 'command-execute',
          summary: '执行 git status',
        },
        workMode: 'Safe',
      });
      const ids = choiceIds(result);
      expect(ids).toContain('call');
      expect(ids).toContain('persistent');
      expect(ids).toContain('deny');
    });

    it('command-operation 资源持久化映射产生 persistent 效果', () => {
      const op: SafetyOperation = {
        resources: [{ kind: 'command-operation', shellKind: 'powershell', rootCommand: 'git', paramPattern: 'git status' }],
        riskReason: 'Git 状态查询',
        operationCategory: 'command-execute',
        summary: '执行 git status',
      };
      const effect = ApprovalPolicy.mapChoiceToEffect('persistent', op, 'execute_command');
      expect(effect.type).toBe('persistent');
      // 强制类型断言以访问 PersistentRuleEffect 的 prefix 属性
      const payload = (effect as { type: 'persistent'; payload: { type: 'persistent'; prefix: string } }).payload;
      expect(payload.prefix).toBe('git');
    });
  });
});
