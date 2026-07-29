/**
 * 终端执行工具 terminal.ts 的功能性与安全性单元测试。
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { initWorkspace } from '../../../src/adapters/tools/tools.js';
import {
  BashTool,
  PowerShellTool,
  extractSafePrefix
} from '../../../src/adapters/tools/impl/system/terminal.js';
import { analyzeShellCommand } from '../../../src/adapters/tools/impl/system/command-analysis/index.js';
import { validateCommand, validateCwd, unboxNestedCommand, detectAdvisoryWarnings } from '../../../src/adapters/tools/impl/system/terminal-guard.js';
import type { ToolPermissionCheckResult } from '../../../src/core/domain/permissions/permission-types.js';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../../src/core/domain/permissions/tool-permission-service.js';

describe('Terminal Tool 单元测试', () => {
  const mockRootDir = mkdtempSync(join(tmpdir(), 'authorized-terminal-test-'));
  const mockMemoryDir = mkdtempSync(join(tmpdir(), 'authorized-memory-test-'));
  let executeCommandToolInstance: BashTool | PowerShellTool;

  beforeAll(() => {
    // 初始化测试工作区路径与独立的文件工具记忆根。
    initWorkspace(mockRootDir, mockMemoryDir);
  });

  afterAll(async () => {
    // 后台任务会在观察期返回后继续运行，等待其退出再删除 Windows 工作目录。
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // 清理当前测试专用工作区，避免在系统临时目录遗留配置和工具输出。
    rmSync(mockRootDir, { recursive: true, force: true });
    rmSync(mockMemoryDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 按当前平台实例化对应的公开 Shell 工具
    executeCommandToolInstance = process.platform === 'win32'
      ? new PowerShellTool()
      : new BashTool();
  });

  test('1. 静态前缀安全提取算法测试', () => {
    // 正常命令提取 Root + Subcommand
    expect(extractSafePrefix('npm run build')).toBe('npm run');
    expect(extractSafePrefix('git add src/index.ts')).toBe('git add');

    // 带有特殊符号或参数的 Subcommand 应无法提取前缀
    expect(extractSafePrefix('python -m pip install')).toBeNull(); // "-m" 含有特殊符号 -
    expect(extractSafePrefix('node ./src/index.js')).toBeNull(); // "./src/index.js" 含有路径斜杠
    expect(extractSafePrefix('ls')).toBeNull(); // 仅有 Root，无 Subcommand
  });

  test('2. 命令分析按阶段识别结构，validateCommand 仅检查硬红线', async () => {
    // 分析器仍正确识别已支持结构
    const supportedCases = [
      { command: 'cat a.txt; pwd', shellKind: 'posix' as const },
      { command: 'cat a.txt && pwd', shellKind: 'posix' as const },
      { command: 'cat a.txt || pwd', shellKind: 'posix' as const },
      { command: 'Get-Content a.txt; Get-Process', shellKind: 'powershell' as const },
    ];
    for (const { command, shellKind } of supportedCases) {
      expect((await analyzeShellCommand(command, shellKind)).parseStatus).toBe('parsed');
    }

    // 分析器正确识别未支持结构（validateCommand 已解除结构约束，此处只验证分析器）
    const newlySupportedCases = [
      { command: 'cat a.txt | grep txt', shellKind: 'posix' as const },
      { command: 'echo hello > output.txt', shellKind: 'posix' as const },
      { command: 'Get-Content a.txt | Select-String txt', shellKind: 'powershell' as const },
    ];
    for (const { command, shellKind } of newlySupportedCases) {
      expect((await analyzeShellCommand(command, shellKind)).parseStatus).toBe('parsed');
    }
  });

  test('3. 沙箱隔离边界路径校验', async () => {
    // 使用越界的 cwd 参数
    await expect(executeCommandToolInstance.execute({ command: 'npm run build', cwd: '../../etc' })).rejects.toThrow('Operation not permitted');
    const maliciousCwd = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    await expect(executeCommandToolInstance.execute({ command: 'npm run build', cwd: maliciousCwd })).rejects.toThrow('Operation not permitted');
    // 文件工具可访问的 memoryDir 不得扩张为终端 cwd。
    expect(() => validateCwd(mockMemoryDir)).toThrow('Operation not permitted');
  });

  test('5. YOLO 模式下命令的执行及首尾截断防爆测试', async () => {
    // 执行一个简单的 echo 指令，由于在 Windows 环境下可能没有全局 echo，
    // 我们使用 node.exe 执行一段 JS 脚本作为跨平台的执行测试，确保子进程能正常跑起来
    const result = await executeCommandToolInstance.execute({ command: 'node -e "console.log(\'LineA\'); console.log(\'LineB\')"' });

    expect(result).toContain('LineA');
    expect(result).toContain('LineB');
    expect(result).toContain('<shell_metadata>');
    expect(result).toContain('<exit_code>0</exit_code>');
  });

  test('6. 启动观察期 200ms 后台驻留捕获测试', async () => {

    // 场景 A: 在 200ms 内立即报错退出的命令，executeCommandTool 应同步返回错误结果，而不是后台 ID 提示
    // 使用确定性非零退出进程的同步路径，等待真实退出后断言失败，避免固定观察窗口受平台负载影响。
    const invalidCommand = 'node -e "console.error(\'intentional failure\'); process.exit(1)"';
    const resultInvalid = await executeCommandToolInstance.execute({
      command: invalidCommand,
      shellKind: process.platform === 'win32' ? 'cmd' : 'posix',
    });
    expect(resultInvalid).not.toContain('任务已在后台成功启动');
    expect(resultInvalid).toContain('错误');

    // 场景 B: 存活时间超过 200ms 的后台任务，应该返回后台 ID 成功启动的提示
    const longRunningCommand = 'node -e "setTimeout(function(){}, 1000)"';
    const resultValid = await executeCommandToolInstance.execute({ command: longRunningCommand, isBackground: true });
    expect(resultValid).toContain('任务已在后台成功启动并存活超过 200ms');
  });

  test('7. 独立安全网关 terminal-guard.ts 细粒度校验测试', async () => {
    // validateCommand 仅做硬红线检测，不再拦截复合结构
    await expect(validateCommand('echo 1; echo 2', 'posix')).resolves.toBeUndefined();
    await expect(validateCommand('cat file | grep text', 'posix')).resolves.toBeUndefined();
    await expect(validateCommand('ls')).resolves.toBeUndefined();

    // 独立测试 cwd 沙箱边界
    expect(() => validateCwd('../../etc')).toThrow('Operation not permitted');
    const maliciousCwd = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    expect(() => validateCwd(maliciousCwd)).toThrow('Operation not permitted');

    // 正确路径不报错
    const correctPath = validateCwd('src');
    expect(correctPath).toBe(join(mockRootDir, 'src'));
  });

  test('9. unboxNestedCommand 核心功能及 flags 容忍单元测试', () => {
    // A. 多层嵌套解包测试
    expect(unboxNestedCommand('powershell -Command "cmd /c \'npm run build\'"')).toBe('npm run build');
    expect(unboxNestedCommand('powershell Get-PSDrive C', 'powershell')).toBe('Get-PSDrive C');

    // B. 带中间 CLI 选项 flags 容忍测试
    expect(unboxNestedCommand('powershell -ExecutionPolicy Bypass -Command "npm run build"')).toBe('npm run build');
    expect(unboxNestedCommand('powershell -NoProfile -ExecutionPolicy Bypass -Command "npm run test"')).toBe('npm run test');
    expect(unboxNestedCommand('bash -c "npm run test"')).toBe('npm run test');
  });

  test('10. unboxNestedCommand 引号与 PowerShell 脚本块边界测试', () => {
    // A. 嵌套引号切片防截断测试
    expect(unboxNestedCommand('powershell -Command "npm run build -- --filter=\'src/**\'"')).toBe("npm run build -- --filter='src/**'");

    // B. 多组引号首尾误判测试（防误删）
    const multiQuoteCmd = '"npm run build" --option "some args"';
    expect(unboxNestedCommand(multiQuoteCmd)).toBe(multiQuoteCmd);

    // C. PowerShell 脚本块清洗
    expect(unboxNestedCommand('powershell -Command "& { npm run build }"')).toBe('npm run build');
    expect(unboxNestedCommand('& { npm run test }')).toBe('npm run test');

    // D. 防花括号传参误伤
    const withBraceParamsCmd = '& npm run build --config={tsconfig.json}';
    expect(unboxNestedCommand(withBraceParamsCmd)).toBe(withBraceParamsCmd);
  });

  test('11. 剥壳前缀提取测试', () => {
    expect(extractSafePrefix('powershell -Command "npm run build"')).toBe('npm run');
    expect(extractSafePrefix('powershell -ExecutionPolicy Bypass -Command "git add src/index.ts"')).toBe('git add');

  });

  test('12. validateCommand 仅检测硬红线，结构安全性由 checkPermissions 负责', async () => {
    // 普通写操作交给权限候选处理，执行期只保留毁灭级硬红线兜底。
    await expect(validateCommand('git commit -m "update"')).resolves.toBeUndefined();
    await expect(validateCommand('rm -rf /')).rejects.toThrow('命中硬红线');

    // 分号、管道等复合结构现在放行——结构分析已由 checkPermissions 在授权阶段完成
    await expect(validateCommand('echo 1; echo 2', 'posix')).resolves.toBeUndefined();
    await expect(validateCommand('cat file | grep text', 'posix')).resolves.toBeUndefined();

    // 引号感知路径校验保留不变
    const correctPath = validateCwd('src');
    expect(correctPath).toBe(join(mockRootDir, 'src'));
  });

  test('13. Git 写操作请求授权且执行守卫不再二次拒绝', async () => {
    // Git 写操作由 Shell 专用权限管线请求用户确认。
    const commitDecision = await executeCommandToolInstance.checkPermissions({ command: 'git commit -m "update"' });
    expect(commitDecision.kind).toBe('ask');

    const checkoutDecision = await executeCommandToolInstance.checkPermissions({ command: 'git checkout main' });
    expect(checkoutDecision.kind).toBe('ask');

    // 获得授权后，物理执行守卫不得再次拒绝普通 Git 写操作。
    await expect(validateCommand('git commit -m "update"')).resolves.toBeUndefined();
    await expect(validateCommand('git checkout -b branch')).resolves.toBeUndefined();
    await expect(validateCommand('git add .')).resolves.toBeUndefined();

    // 只读 Git 查看命令由专用目录直接放行。
    const logDecision = await executeCommandToolInstance.checkPermissions({ command: 'git log' });
    expect(logDecision.kind).toBe('allow');
    expect(logDecision.evidence?.sideEffect).toBe('read');
  });

  test('17. advisory warning 解析应跳过当前 shell 的命令开关', () => {
    expect(detectAdvisoryWarnings('dir /A:H /W', 'cmd')).toHaveLength(0);

    if (process.platform === 'win32') {
      const warnings = detectAdvisoryWarnings('dir C:\\Windows', 'cmd');
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

});

// ── checkPermissions 测试（5.5 工具迁移测试）──

describe('ShellTool.checkPermissions', () => {
  const permissionRootDir = mkdtempSync(join(tmpdir(), 'permission-terminal-test-'));
  const tool = process.platform === 'win32'
    ? new PowerShellTool()
    : new BashTool();

  beforeAll(() => {
    // 该测试组独立初始化工作区，避免依赖前一个 describe 的全局副作用。
    initWorkspace(permissionRootDir);
  });

  afterAll(() => {
    // 清理本组专用目录，保持筛选运行与全量运行行为一致。
    rmSync(permissionRootDir, { recursive: true, force: true });
  });

  const pipelineFeatures = {
    pipelines: true,
    conditionals: false,
    redirections: false,
    background: false,
    nested: false,
  } as const;

  const disabledFeatures = {
    pipelines: false,
    conditionals: false,
    redirections: false,
    background: false,
    nested: false,
  } as const;

  test('管道开关开启后按全部子命令风险映射权限', async () => {
    const bash = new BashTool(pipelineFeatures);
    const powershell = new PowerShellTool(pipelineFeatures);

    await expect(bash.checkPermissions({ command: 'cat a.txt | grep x' }))
      .resolves.toMatchObject({ kind: 'allow', evidence: { sideEffect: 'read' } });
    await expect(bash.checkPermissions({ command: 'cat a.txt | rm output.txt' }))
      .resolves.toMatchObject({ kind: 'ask', evidence: { sideEffect: 'write' } });
    await expect(powershell.checkPermissions({ command: 'Get-Content a.txt | Select-String x' }))
      .resolves.toMatchObject({ kind: 'allow', evidence: { sideEffect: 'read' } });
    await expect(new BashTool(disabledFeatures).checkPermissions({ command: 'cat a.txt | grep x' }))
      .resolves.toMatchObject({ kind: 'ask', evidence: { parseStatus: 'unsupported' } });
  });

  test('PowerShell 只读管道经统一权限服务后应直接 allow', async () => {
    const powershell = new PowerShellTool(pipelineFeatures);
    const service = new ToolPermissionService({ ruleStore: new PermissionRuleStore() });

    const result = await service.checkPermissions(
      'PowerShell',
      { command: 'Get-Content package.json | Select-String "scripts"' },
      'default',
      { checkPermissions: (input) => powershell.checkPermissions(input.args) },
    );

    expect(result).toMatchObject({
      kind: 'allow',
      decisionSource: 'builtInBaseline',
      evidence: { sideEffect: 'read' },
    });
  });

  test('合法只读命令应返回 allow 和 read evidence', async () => {
    const result = await tool.checkPermissions!({ command: 'git log' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('allow');
    expect(result.evidence?.sideEffect).toBe('read');
    expect(result.evidence?.resources).toContainEqual(expect.objectContaining({
      kind: 'directory-scope',
      operation: 'read',
      scope: 'workspace',
      provenance: 'tool-analyzed',
    }));
  });

  test('未分类命令应返回 ask 并携带 unknown evidence', async () => {
    const result = await tool.checkPermissions!({ command: 'npm run build' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('unknown');
  });

  test('未分类环境命令应由专用管线请求确认', async () => {
    const result = await tool.checkPermissions!({ command: 'env' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('unknown');
  });

  test('Shell 语法错误应请求确认而不是直接 deny', async () => {
    const bash = new BashTool();
    const result = await bash.checkPermissions({ command: 'grep "unfinished' });

    // passthrough 分支没有原因字段，失败消息只在候选实际携带原因时展示。
    const decisionReason = 'decisionReason' in result ? result.decisionReason : undefined;
    expect(result.kind, decisionReason).toBe('ask');
    expect(result).toMatchObject({
      evidence: { parseStatus: 'invalid', sideEffect: 'unknown' },
    });
  });

  test('危险命令应返回 deny', async () => {
    const result = await new BashTool().checkPermissions({ command: 'rm -rf /' });
    expect(result.kind).toBe('deny');
  });

  test('空 command 应返回 deny', async () => {
    const result = await tool.checkPermissions!({}) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
  });

  test('复合命令一次分析并由工具层返回完整候选', async () => {
    const bash = new BashTool({
      pipelines: true, conditionals: false,
      redirections: false, background: false, nested: false,
    });
    // 管道中混合只读和写命令，专用管线聚合为一次 ask 候选。
    const mixed = await bash.checkPermissions({ command: 'cat a.txt | rm output.txt' });
    expect(mixed.kind).toBe('ask');
    expect(mixed.evidence?.parseStatus).toBe('parsed');
    expect(mixed.evidence?.subcommands).toHaveLength(2);
    // 每个子命令独立评估
    expect(mixed.evidence?.subcommands![0]).toMatchObject({ sideEffect: 'read', permission: 'allow' });
    expect(mixed.evidence?.subcommands![1]).toMatchObject({ sideEffect: 'write', permission: 'ask' });
  });

  test('重定向写证据与子命令风险一致不漂移', async () => {
    const bash = new BashTool({
      pipelines: false, conditionals: false,
      redirections: true, background: false, nested: false,
    });
    const result = await bash.checkPermissions({ command: 'cat package.json > backup.json' });
    // 重定向使整体提升为 write，并由专用管线直接请求确认。
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('write');
    // 子命令证据携带重定向风险说明
    const sub = result.evidence?.subcommands?.[0];
    expect(sub?.sideEffect).toBeTruthy();
    expect(sub?.reason).toContain('重定向');
    expect(result.evidence?.resources).toContainEqual(expect.objectContaining({
      kind: 'file',
      operation: 'write',
      rawExpression: 'backup.json',
      scope: 'workspace',
    }));
  });
});
