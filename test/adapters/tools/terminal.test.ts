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

  test('2. 只放开阶段 3 已支持的基础复合命令', () => {
    const supportedCases = [
      { command: 'cat a.txt; pwd', shellKind: 'posix' as const },
      { command: 'cat a.txt && pwd', shellKind: 'posix' as const },
      { command: 'cat a.txt || pwd', shellKind: 'posix' as const },
      { command: 'Get-Content a.txt; Get-Process', shellKind: 'powershell' as const },
    ];
    for (const { command, shellKind } of supportedCases) {
      expect(() => validateCommand(command, shellKind)).not.toThrow();
      expect(analyzeShellCommand(command, shellKind).parseStatus).toBe('parsed');
    }

    const unsupportedCases = [
      { command: 'cat a.txt | grep txt', shellKind: 'posix' as const },
      { command: 'echo hello > output.txt', shellKind: 'posix' as const },
      { command: 'Get-Content a.txt | Select-String txt', shellKind: 'powershell' as const },
    ];
    for (const { command, shellKind } of unsupportedCases) {
      expect(() => validateCommand(command, shellKind)).toThrow('拒绝执行');
      expect(analyzeShellCommand(command, shellKind).parseStatus).toBe('unsupported');
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

  test('7. 独立安全网关 terminal-guard.ts 细粒度校验测试', () => {
    // 已支持连接符进入统一分析，未支持复杂结构继续拒绝。
    expect(() => validateCommand('echo 1; echo 2', 'posix')).not.toThrow();
    expect(() => validateCommand('cat file | grep text', 'posix')).toThrow('拒绝执行');
    expect(() => validateCommand('ls')).not.toThrow();

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

  test('12. 新增防分号、反引号和命令替换注入测试（含引号感知放行）', () => {
    // A. 分号允许进入命令分析；反引号和命令替换仍保持注入阻断。
    expect(() => validateCommand('echo 1; echo 2', 'posix')).not.toThrow();
    expect(() => validateCommand('echo 1 `whoami`', 'posix')).toThrow('拒绝执行');
    expect(() => validateCommand('echo `feat;fix`', 'posix')).toThrow('拒绝执行');
    expect(() => validateCommand('echo $(whoami)', 'posix')).toThrow('拒绝执行');
    expect(() => validateCommand('echo \\(whoami)')).toThrow('拒绝执行');

    // B. 引号感知安全避让放行（只放行单引号与双引号包裹内的分号/安全元字符）
    expect(() => validateCommand('git log --grep="feat;fix"')).not.toThrow();
    expect(() => validateCommand("grep 'a;b'")).not.toThrow();

    // C. 引号失衡校验（防止不平衡闭合逃逸）
    expect(() => validateCommand('grep "a;b')).toThrow('不平衡的引号结构');
    expect(() => validateCommand("grep 'a;b")).toThrow('不平衡的引号结构');

    // D. 嵌套 Shell 会重新解释引号内命令，当前阶段明确拒绝。
    expect(() => validateCommand('powershell -Command "dir; whoami"', 'powershell')).toThrow('拒绝执行');
    expect(() => validateCommand('cmd /c "dir & whoami"', 'cmd')).toThrow('拒绝执行');
  });

  test('13. 终端 Git 写变更操作绝对硬阻断测试', () => {
    // 工具级权限证据必须把 Git 写操作标记为不可降级的 hardline deny。
    const commitDecision = executeCommandToolInstance.checkPermissions({ command: 'git commit -m "update"' });
    expect(commitDecision.kind).toBe('deny');
    expect(commitDecision.evidence?.sideEffect).toBe('hardline');

    const checkoutDecision = executeCommandToolInstance.checkPermissions({ command: 'git checkout main' });
    expect(checkoutDecision.kind).toBe('deny');
    expect(checkoutDecision.evidence?.sideEffect).toBe('hardline');

    // validateCommand 物理执行阶段同样直接抛错阻断
    expect(() => validateCommand('git commit -m "update"')).toThrow('严禁执行除只读查看外的任何 Git 变更操作');
    expect(() => validateCommand('git checkout -b branch')).toThrow('严禁执行除只读查看外的任何 Git 变更操作');
    expect(() => validateCommand('git add .')).toThrow('严禁执行除只读查看外的任何 Git 变更操作');

    // 只读 Git 查看命令不属于 hardline，并携带 read evidence。
    const logDecision = executeCommandToolInstance.checkPermissions({ command: 'git log' });
    expect(logDecision.kind).toBe('allow');
    expect(logDecision.evidence?.sideEffect).toBe('read');
  });

  test('14. isPlanSafeCommand 统一安全判定函数测试', () => {
    // A. 只读白名单命令无复合字符 → 返回 true
    expect(isPlanSafeCommand('dir C:\\Windows\\Temp', 'cmd')).toBe(true);
    expect(isPlanSafeCommand('type package.json', 'cmd')).toBe(true);
    expect(isPlanSafeCommand('wmic logicaldisk where caption="C:" get caption,size,freespace /format:value', 'cmd')).toBe(true);
    expect(isPlanSafeCommand('Get-PSDrive C', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('powershell Get-PSDrive C', 'powershell')).toBe(false);
    expect(isPlanSafeCommand('git status', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('git diff', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('git log', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('ls', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('cat file.txt', 'posix')).toBe(true);
    expect(isPlanSafeCommand('git log --grep="feat;fix"', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('echo ">"', 'posix')).toBe(true);

    // B. 复合命令按子命令聚合：纯读取可安全判定，重定向和未知命令不能放行
    expect(isPlanSafeCommand('dir /-C | findstr "txt"', 'cmd')).toBe(false); // Cmd 复合语法未开放
    expect(isPlanSafeCommand('type a.txt > b.txt', 'cmd')).toBe(false); // 文件重定向
    expect(isPlanSafeCommand('git log; whoami', 'powershell')).toBe(false); // 未知子命令
    expect(isPlanSafeCommand('cat file; echo done', 'posix')).toBe(true); // 两个只读子命令
    expect(isPlanSafeCommand('cat file && echo done', 'posix')).toBe(true); // 支持短路连接符
    expect(isPlanSafeCommand('cat file & echo done', 'posix')).toBe(false); // 单 & 未开放
    expect(isPlanSafeCommand('cat file; rm output.txt', 'posix')).toBe(false); // 写子命令

    // C. 非白名单命令 → 返回 false
    expect(isPlanSafeCommand('wmic logicaldisk', 'cmd')).toBe(true);
    expect(isPlanSafeCommand('wmic process', 'cmd')).toBe(false);
    expect(isPlanSafeCommand('netstat -an', 'powershell')).toBe(false);
    expect(isPlanSafeCommand('rm -rf /', 'posix')).toBe(false);           // 硬红线

    // D. 危险写命令 → 返回 false
    expect(isPlanSafeCommand('del file.txt', 'cmd')).toBe(false);
    expect(isPlanSafeCommand('rm file.txt', 'posix')).toBe(false);

    // E. shell family 约束：只在当前已决议 shell 下真实可执行的只读命令才允许进入审批
    expect(isPlanSafeCommand('dir', 'cmd')).toBe(true);
    expect(isPlanSafeCommand('dir', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('dir', 'posix')).toBe(false);
    expect(isPlanSafeCommand('cat file.txt', 'cmd')).toBe(false);
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

  test('合法只读命令应返回 allow', () => {
    const result = tool.checkPermissions!({ command: 'git log' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('allow');
    expect(result.evidence?.sideEffect).toBe('read');
  });

  test('未分类命令应返回 ask 并携带 unknown evidence', () => {
    const result = tool.checkPermissions!({ command: 'npm run build' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('unknown');
  });

  test('未分类环境命令也应保守返回 ask', () => {
    const result = tool.checkPermissions!({ command: 'env' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('unknown');
  });

  test('危险命令应返回 deny', () => {
    const result = tool.checkPermissions!({ command: 'rm -rf /' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
    expect(result.evidence?.sideEffect).toBe('hardline');
  });

  test('空 command 应返回 deny', () => {
    const result = tool.checkPermissions!({}) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
  });

  test('checkPermissions 不应读取 PermissionMode（无 sessionContext 参数）', () => {
    // checkPermissions 的签名不包含 sessionContext，证明工具检查与模式转换相互独立。
    expect(tool.checkPermissions!.length).toBeLessThanOrEqual(1);
  });
});
