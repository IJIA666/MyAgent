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
  extractSafePrefix,
  checkWhitelist,
  saveAllowedCommands,
  loadAllowedCommands,
  setPermissionMode,
  savePermissionMode,
  loadPermissionMode
} from '../../../src/adapters/tools/impl/system/terminal.js';
import { analyzeShellCommand } from '../../../src/adapters/tools/impl/system/command-analysis/index.js';
import { validateCommand, validateCwd, unboxNestedCommand, isPlanSafeCommand, detectAdvisoryWarnings } from '../../../src/adapters/tools/impl/system/terminal-guard.js';
import type { ToolPermissionCheckResult } from '../../../src/core/domain/permissions/permission-types.js';

describe('Terminal Tool 单元测试', () => {
  const mockRootDir = mkdtempSync(join(tmpdir(), 'authorized-terminal-test-'));
  let executeCommandToolInstance: BashTool | PowerShellTool;

  beforeAll(() => {
    // 初始化测试工作区路径
    initWorkspace(mockRootDir);
  });

  afterAll(async () => {
    // 后台任务会在观察期返回后继续运行，等待其退出再删除 Windows 工作目录。
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // 清理当前测试专用工作区，避免在系统临时目录遗留配置和工具输出。
    rmSync(mockRootDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 每次测试前，将工作模式重置为 YOLO，防止测试由于人工交互阻断卡死
    setPermissionMode('bypassPermissions');
    savePermissionMode('bypassPermissions');

    // 清空白名单
    saveAllowedCommands([]);

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
  });

  test('4. 工作模式与白名单持久化配置测试', () => {
    // 工作模式存取测试
    savePermissionMode('default');
    expect(loadPermissionMode()).toBe('default');

    savePermissionMode('auto');
    expect(loadPermissionMode()).toBe('auto');

    // 白名单存取测试
    const mockRules = ['npm run:*', 'git add:*'];
    saveAllowedCommands(mockRules);

    const loaded = loadAllowedCommands();
    expect(loaded).toContain('npm run:*');
    expect(loaded).toContain('git add:*');

    // 白名单命中匹配校验
    expect(checkWhitelist('npm run build')).toBe(true);
    expect(checkWhitelist('powershell -Command "npm run build"')).toBe(true); // 剥壳后能够匹配
    expect(checkWhitelist('git add src/a.ts')).toBe(true);
    expect(checkWhitelist('npm publish')).toBe(false); // 没在白名单内
  });

  test('5. YOLO 模式下命令的执行及首尾截断防爆测试', async () => {
    // 设置模式为 YOLO 绕过人工确认
    setPermissionMode('bypassPermissions');

    // 执行一个简单的 echo 指令，由于在 Windows 环境下可能没有全局 echo，
    // 我们使用 node.exe 执行一段 JS 脚本作为跨平台的执行测试，确保子进程能正常跑起来
    const result = await executeCommandToolInstance.execute({ command: 'node -e "console.log(\'LineA\'); console.log(\'LineB\')"' });

    expect(result).toContain('LineA');
    expect(result).toContain('LineB');
    expect(result).toContain('<shell_metadata>');
    expect(result).toContain('<exit_code>0</exit_code>');
  });

  test('6. 启动观察期 200ms 后台驻留捕获测试', async () => {
    setPermissionMode('bypassPermissions');

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

  test('11. 自动初始化与剥壳前缀提取测试', () => {
    // A. 自动配置初始化测试：因为 beforeEach 把允许命令清空为空数组，
    // 调用 loadAllowedCommands 应自动触发配置初始化，写入并返回默认常用规则
    const defaultLoaded = loadAllowedCommands();
    expect(defaultLoaded).toContain('git status:*');
    expect(defaultLoaded).toContain('npm run test:*');

    // B. 剥壳前缀提取测试
    expect(extractSafePrefix('powershell -Command "npm run build"')).toBe('npm run');
    expect(extractSafePrefix('powershell -ExecutionPolicy Bypass -Command "git add src/index.ts"')).toBe('git add');

  });

  test('12. validateCommand 仅检测硬红线，结构安全性由 checkPermissions 负责', async () => {
    // 硬红线仍然拦截（运行时兜底）
    await expect(validateCommand('git commit -m "update"')).rejects.toThrow('严禁执行除只读查看外的任何 Git 变更操作');
    await expect(validateCommand('rm -rf /')).rejects.toThrow('命中硬红线');

    // 分号、管道等复合结构现在放行——结构分析已由 checkPermissions 在授权阶段完成
    await expect(validateCommand('echo 1; echo 2', 'posix')).resolves.toBeUndefined();
    await expect(validateCommand('cat file | grep text', 'posix')).resolves.toBeUndefined();

    // 引号感知路径校验保留不变
    const correctPath = validateCwd('src');
    expect(correctPath).toBe(join(mockRootDir, 'src'));
  });

  test('13. 终端 Git 写变更操作绝对硬阻断测试', async () => {
    // 工具级权限证据必须把 Git 写操作标记为不可降级的 hardline deny。
    const commitDecision = await executeCommandToolInstance.checkPermissions({ command: 'git commit -m "update"' });
    expect(commitDecision.kind).toBe('deny');
    expect(commitDecision.evidence?.sideEffect).toBe('hardline');

    const checkoutDecision = await executeCommandToolInstance.checkPermissions({ command: 'git checkout main' });
    expect(checkoutDecision.kind).toBe('deny');
    expect(checkoutDecision.evidence?.sideEffect).toBe('hardline');

    // validateCommand 物理执行阶段同样直接抛错阻断
    await expect(validateCommand('git commit -m "update"')).rejects.toThrow('严禁执行除只读查看外的任何 Git 变更操作');
    await expect(validateCommand('git checkout -b branch')).rejects.toThrow('严禁执行除只读查看外的任何 Git 变更操作');
    await expect(validateCommand('git add .')).rejects.toThrow('严禁执行除只读查看外的任何 Git 变更操作');

    // 只读 Git 查看命令不属于 hardline，并携带 read evidence。
    const logDecision = await executeCommandToolInstance.checkPermissions({ command: 'git log' });
    expect(logDecision.kind).toBe('allow');
    expect(logDecision.evidence?.sideEffect).toBe('read');
  });

  test('14. isPlanSafeCommand 统一安全判定函数测试', async () => {
    // A. 只读白名单命令无复合字符 → 返回 true
    expect(await isPlanSafeCommand('dir C:\\Windows\\Temp', 'cmd')).toBe(true);
    expect(await isPlanSafeCommand('type package.json', 'cmd')).toBe(true);
    expect(await isPlanSafeCommand('wmic logicaldisk where caption="C:" get caption,size,freespace /format:value', 'cmd')).toBe(true);
    expect(await isPlanSafeCommand('Get-PSDrive C', 'powershell')).toBe(true);
    expect(await isPlanSafeCommand('powershell Get-PSDrive C', 'powershell')).toBe(false);
    expect(await isPlanSafeCommand('git status', 'powershell')).toBe(true);
    expect(await isPlanSafeCommand('git diff', 'powershell')).toBe(true);
    expect(await isPlanSafeCommand('git log', 'powershell')).toBe(true);
    expect(await isPlanSafeCommand('ls', 'powershell')).toBe(true);
    expect(await isPlanSafeCommand('cat file.txt', 'posix')).toBe(true);
    expect(await isPlanSafeCommand('git log --grep="feat;fix"', 'powershell')).toBe(true);
    expect(await isPlanSafeCommand('echo ">"', 'posix')).toBe(true);

    // B. 复合命令按子命令聚合：纯读取可安全判定，重定向和未知命令不能放行
    expect(await isPlanSafeCommand('dir /-C | findstr "txt"', 'cmd')).toBe(false); // Cmd 复合语法未开放
    expect(await isPlanSafeCommand('type a.txt > b.txt', 'cmd')).toBe(false); // 文件重定向
    expect(await isPlanSafeCommand('git log; whoami', 'powershell')).toBe(false); // 未知子命令
    expect(await isPlanSafeCommand('cat file; echo done', 'posix')).toBe(true); // 两个只读子命令
    expect(await isPlanSafeCommand('cat file && echo done', 'posix')).toBe(true); // 支持短路连接符
    expect(await isPlanSafeCommand('cat file & echo done', 'posix')).toBe(true); // 已托管的只读后台结构
    expect(await isPlanSafeCommand('cat file; rm output.txt', 'posix')).toBe(false); // 写子命令

    // C. 非白名单命令 → 返回 false
    expect(await isPlanSafeCommand('wmic logicaldisk', 'cmd')).toBe(true);
    expect(await isPlanSafeCommand('wmic process', 'cmd')).toBe(false);
    expect(await isPlanSafeCommand('netstat -an', 'powershell')).toBe(false);
    expect(await isPlanSafeCommand('rm -rf /', 'posix')).toBe(false);           // 硬红线

    // D. 危险写命令 → 返回 false
    expect(await isPlanSafeCommand('del file.txt', 'cmd')).toBe(false);
    expect(await isPlanSafeCommand('rm file.txt', 'posix')).toBe(false);

    // E. shell family 约束：只在当前已决议 shell 下真实可执行的只读命令才允许进入审批
    expect(await isPlanSafeCommand('dir', 'cmd')).toBe(true);
    expect(await isPlanSafeCommand('dir', 'powershell')).toBe(true);
    expect(await isPlanSafeCommand('dir', 'posix')).toBe(false);
    expect(await isPlanSafeCommand('cat file.txt', 'cmd')).toBe(false);
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
  const tool = process.platform === 'win32'
    ? new PowerShellTool()
    : new BashTool();

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

  test('合法只读命令应返回 allow', async () => {
    const result = await tool.checkPermissions!({ command: 'git log' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('allow');
    expect(result.evidence?.sideEffect).toBe('read');
  });

  test('未分类命令应返回 ask 并携带 unknown evidence', async () => {
    const result = await tool.checkPermissions!({ command: 'npm run build' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('unknown');
  });

  test('未分类环境命令也应保守返回 ask', async () => {
    const result = await tool.checkPermissions!({ command: 'env' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('unknown');
  });

  test('危险命令应返回 deny', async () => {
    const result = await tool.checkPermissions!({ command: 'rm -rf /' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
    expect(result.evidence?.sideEffect).toBe('hardline');
  });

  test('空 command 应返回 deny', async () => {
    const result = await tool.checkPermissions!({}) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
  });

  test('checkPermissions 不应读取 PermissionMode（无 sessionContext 参数）', () => {
    // checkPermissions 的签名不包含 sessionContext，证明工具检查与模式转换相互独立。
    expect(tool.checkPermissions!.length).toBeLessThanOrEqual(1);
  });

  test('复合命令一次分析聚合 ask，不拆分多次询问', async () => {
    const bash = new BashTool({
      pipelines: true, conditionals: false,
      redirections: false, background: false, nested: false,
    });
    // 管道中混合只读和写命令，聚合为一次 ask
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
    // 重定向使整体提升为 write/ask
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('write');
    // 子命令证据携带重定向风险说明
    const sub = result.evidence?.subcommands?.[0];
    expect(sub?.sideEffect).toBeTruthy();
    expect(sub?.reason).toContain('重定向');
  });
});
