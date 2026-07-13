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
import { validateCommand, validateCwd, unboxNestedCommand, isPlanSafeCommand, detectAdvisoryWarnings } from '../../../src/adapters/tools/impl/system/terminal-guard.js';
import { SessionContext } from '../../../src/core/domain/context.js';
import type { ToolPermissionCheckResult } from '../../../src/core/domain/permissions/permission-types.js';

// 根据当前公开 Shell 工具选择可用的原子只读命令，避免测试依赖旧的动态 shellKind 参数。
const platformReadCase = process.platform === 'win32'
  ? { command: 'Get-Content package.json', shellKind: 'powershell' as const }
  : { command: 'ls /tmp', shellKind: 'posix' as const };

// 为两个公开 Shell 提供等价的只读命令。
const platformReadVariantCase = process.platform === 'win32'
  ? { command: 'Get-PSDrive C', shellKind: 'powershell' as const }
  : { command: 'cat package.json', shellKind: 'posix' as const };

// 为显式 PowerShell 只读用例提供非 Windows 平台上的等价 Shell。
const platformPowerShellReadCase = process.platform === 'win32'
  ? { command: 'Get-PSDrive C', shellKind: 'powershell' as const }
  : { command: 'pwd', shellKind: 'posix' as const };

// 根据当前公开 Shell 选择复合命令，验证复合命令不能被识别为只读。
const platformCompositeCase = process.platform === 'win32'
  ? { command: 'Get-Content a.txt | Select-String "txt"', shellKind: 'powershell' as const }
  : { command: 'cat a.txt | grep "txt"', shellKind: 'posix' as const };

// 根据当前公开 Shell 选择非只读命令，验证安全分类会降级为 write 或 unknown。
const platformWriteCommands = process.platform === 'win32'
  ? ['Remove-Item file.txt', 'New-Item -ItemType Directory newdir']
  : ['rm file.txt', 'mkdir newdir'];

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

  test('2. 安全硬编码正则阻断拦截复合指令', async () => {
    // 带拼接符 & 的命令
    await expect(executeCommandToolInstance.execute({ command: 'echo 1 & echo 2' })).rejects.toThrow('拒绝执行');

    // 带管道符 | 的命令
    await expect(executeCommandToolInstance.execute({ command: 'cat file | grep text' })).rejects.toThrow('拒绝执行');

    // 带重定向符 > 的命令
    await expect(executeCommandToolInstance.execute({ command: 'echo hello > output.txt' })).rejects.toThrow('拒绝执行');

    // 带换行符的命令
    await expect(executeCommandToolInstance.execute({ command: 'echo hello\necho world' })).rejects.toThrow('拒绝执行');
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
    // 独立测试正则拦截
    expect(() => validateCommand('echo 1 & echo 2')).toThrow('拒绝执行');
    expect(() => validateCommand('cat file | grep text')).toThrow('拒绝执行');
    expect(() => validateCommand('ls')).not.toThrow();

    // 独立测试 cwd 沙箱边界
    expect(() => validateCwd('../../etc')).toThrow('Operation not permitted');
    const maliciousCwd = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    expect(() => validateCwd(maliciousCwd)).toThrow('Operation not permitted');

    // 正确路径不报错
    const correctPath = validateCwd('src');
    expect(correctPath).toBe(join(mockRootDir, 'src'));
  });

  test('8. 终端命令副作用分类与底线黑名单拦截测试', () => {
    const mockSession = new SessionContext();

    // A. 测试未知副作用计划的命令应返回 planSideEffect='unknown' 而非 'read'
    mockSession.setPermissionMode('plan');
    // 'npm run dev' 不在只读白名单，非危险写，应分类为 'unknown'
    const safetyDev = executeCommandToolInstance.checkSafety({ command: 'npm run dev' }, mockSession);
    expect(safetyDev.operation?.planSideEffect).toBe('unknown');
    // Plan 策略由 HumanApprovalPlugin 统一决策，终端只报告分类
    expect(safetyDev.status).toBe('suspend');

    // 只读白名单指令（如 git log），应返回 planSideEffect='read'
    const safetyLog = executeCommandToolInstance.checkSafety({ command: 'git log' }, mockSession);
    expect(safetyLog.operation?.planSideEffect).toBe('read');

    // B. 测试底线拦截黑名单 rm -rf /，无论在 YOLO 还是其他模式下都应被绝对拒绝
    mockSession.setPermissionMode('bypassPermissions');
    const safetyRm = executeCommandToolInstance.checkSafety({ command: 'rm -rf /' }, mockSession);
    expect(safetyRm.status).toBe('deny');
    expect(safetyRm.message).toContain('BLOCKED (Hardline Blocklist)');

    // 即使在没有 SessionContext（退化为全局配置 YOLO）时，也应绝对拦截
    setPermissionMode('bypassPermissions');
    const safetyRmGlobal = executeCommandToolInstance.checkSafety({ command: 'rm -rf /' });
    expect(safetyRmGlobal.status).toBe('deny');
    expect(safetyRmGlobal.message).toContain('BLOCKED (Hardline Blocklist)');
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

  test('11. 自动初始化、剥壳前缀提取、Auto匹配与挂起弹窗披露测试', () => {
    // A. 自动配置初始化测试：因为 beforeEach 把允许命令清空为空数组，
    // 调用 loadAllowedCommands 应自动触发配置初始化，写入并返回默认常用规则
    const defaultLoaded = loadAllowedCommands();
    expect(defaultLoaded).toContain('git status:*');
    expect(defaultLoaded).toContain('npm run test:*');

    // B. 剥壳前缀提取测试
    expect(extractSafePrefix('powershell -Command "npm run build"')).toBe('npm run');
    expect(extractSafePrefix('powershell -ExecutionPolicy Bypass -Command "git add src/index.ts"')).toBe('git add');

    // C. Auto 模式剥壳匹配与放行测试
    saveAllowedCommands(['git status:*', 'npm run:*']);
    setPermissionMode('auto');

    const safetyAllowed = executeCommandToolInstance.checkSafety({ command: 'npm run test' });
    // Auto 分类器尚未接入生产装配，当前仍保留人工审批。
    expect(safetyAllowed.status).toBe('suspend');

    // D. 审批挂起时的披露信息与对比测试
    const safetyUnallowed = executeCommandToolInstance.checkSafety({ command: 'npm test' });
    expect(safetyUnallowed.status).toBe('suspend');
    expect(safetyUnallowed.message).toContain("npm test");

    // E. 负向场景测试：解包后未命中白名单的拦截与告知行为
    saveAllowedCommands(['git status:*']); // 只授权 git status
    const safetyNegative = executeCommandToolInstance.checkSafety({ command: 'npm run lint' });
    expect(safetyNegative.status).toBe('suspend');
    expect(safetyNegative.message).toContain("npm run lint");
  });

  test('12. 新增防分号、反引号和命令替换注入测试（含引号感知放行）', () => {
    // A. 基础分号与反引号拼接及命令替换注入拦截（反引号在非单引号下视为命令替换强力阻断）
    expect(() => validateCommand('echo 1; echo 2')).toThrow('拒绝执行');
    expect(() => validateCommand('echo 1 `whoami`')).toThrow('拒绝执行');
    expect(() => validateCommand('echo `feat;fix`')).toThrow('检测到非法的反引号命令替换符');
    expect(() => validateCommand('echo $(whoami)')).toThrow('拒绝执行');
    expect(() => validateCommand('echo \\(whoami)')).toThrow('拒绝执行');

    // B. 引号感知安全避让放行（只放行单引号与双引号包裹内的分号/安全元字符）
    expect(() => validateCommand('git log --grep="feat;fix"')).not.toThrow();
    expect(() => validateCommand("grep 'a;b'")).not.toThrow();

    // C. 引号失衡校验（防止不平衡闭合逃逸）
    expect(() => validateCommand('grep "a;b')).toThrow('不平衡的引号结构');
    expect(() => validateCommand("grep 'a;b")).toThrow('不平衡的引号结构');

    // D. 外壳包装下的分号注入（解包后发现 unquoted 分号，应当抛错）
    expect(() => validateCommand('powershell -Command "dir; whoami"')).toThrow('拒绝执行');
    expect(() => validateCommand('cmd /c "dir; whoami"')).toThrow('拒绝执行');
  });

  test('13. 终端 Git 写变更操作绝对硬阻断测试', () => {
    const mockSession = new SessionContext();

    // 无论在 YOLO 模式还是其它模式下，git commit 等写操作均应在 checkSafety 中被直接 deny 拦截
    mockSession.setPermissionMode('bypassPermissions');
    const safetyCommitYolo = executeCommandToolInstance.checkSafety({ command: 'git commit -m "update"' }, mockSession);
    expect(safetyCommitYolo.status).toBe('deny');
    expect(safetyCommitYolo.message).toContain('BLOCKED (Hardline Blocklist)');

    // 在 Auto 模式下也应被绝对拦截
    mockSession.setPermissionMode('auto');
    const safetyCheckoutAuto = executeCommandToolInstance.checkSafety({ command: 'git checkout main' }, mockSession);
    expect(safetyCheckoutAuto.status).toBe('deny');
    expect(safetyCheckoutAuto.message).toContain('BLOCKED (Hardline Blocklist)');

    // validateCommand 物理执行阶段同样直接抛错阻断
    expect(() => validateCommand('git commit -m "update"')).toThrow('严禁执行除只读查看外的任何 Git 变更操作');
    expect(() => validateCommand('git checkout -b branch')).toThrow('严禁执行除只读查看外的任何 Git 变更操作');
    expect(() => validateCommand('git add .')).toThrow('严禁执行除只读查看外的任何 Git 变更操作');

    // 只读的 Git 查看命令应该被安全放行（不属于 Hardline 黑名单，在 YOLO 模式下直接 pass，在 Auto/Plan 模式下按常规则处理）
    mockSession.setPermissionMode('bypassPermissions');
    const safetyLogYolo = executeCommandToolInstance.checkSafety({ command: 'git log' }, mockSession);
    expect(safetyLogYolo.status).toBe('pass'); // YOLO 下只读 git 命令直接通过
  });

  test('14. isPlanSafeCommand 统一安全判定函数测试', () => {
    // A. 只读白名单命令无复合字符 → 返回 true
    expect(isPlanSafeCommand('dir C:\\Windows\\Temp', 'cmd')).toBe(true);
    expect(isPlanSafeCommand('type package.json', 'cmd')).toBe(true);
    expect(isPlanSafeCommand('wmic logicaldisk where caption="C:" get caption,size,freespace /format:value', 'cmd')).toBe(true);
    expect(isPlanSafeCommand('Get-PSDrive C', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('powershell Get-PSDrive C', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('git status', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('git diff', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('git log', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('ls', 'powershell')).toBe(true);
    expect(isPlanSafeCommand('cat file.txt', 'posix')).toBe(true);
    expect(isPlanSafeCommand('git log --grep="feat;fix"', 'powershell')).toBe(true);

    // B. 只读白名单命令含复合字符 → 返回 false
    expect(isPlanSafeCommand('dir /-C | find "txt"', 'cmd')).toBe(false); // 管道符 |
    expect(isPlanSafeCommand('type a.txt > b.txt', 'cmd')).toBe(false); // 重定向 >
    expect(isPlanSafeCommand('git log; whoami', 'powershell')).toBe(false);    // 分号 ;
    expect(isPlanSafeCommand('cat file & echo done', 'posix')).toBe(false); // 拼接符 &

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

  test('15. 终端 checkSafety 副作用分类测试（planSideEffect 驱动）', () => {
    const mockSession = new SessionContext();

    // A. 计划模式 + 安全只读命令 → planSideEffect='read'
    mockSession.setPermissionMode('plan');
    const safetyDir = executeCommandToolInstance.checkSafety(platformReadCase, mockSession);
    expect(safetyDir.operation?.planSideEffect).toBe('read');

    const safetyType = executeCommandToolInstance.checkSafety(
      process.platform === 'win32'
        ? { command: 'Get-Content package.json', shellKind: 'powershell' }
        : { command: 'cat package.json', shellKind: 'posix' },
      mockSession,
    );
    expect(safetyType.operation?.planSideEffect).toBe('read');

    const safetyGitStatus = executeCommandToolInstance.checkSafety({ command: 'git status' }, mockSession);
    expect(safetyGitStatus.operation?.planSideEffect).toBe('read');

    const safetyGetPsDrive = executeCommandToolInstance.checkSafety(
      process.platform === 'win32'
        ? { command: 'Get-PSDrive C', shellKind: 'powershell' }
        : { command: 'ls /tmp', shellKind: 'posix' },
      mockSession,
    );
    expect(safetyGetPsDrive.operation?.planSideEffect).toBe('read');

    // B. 计划模式 + 含复合字符命令 → planSideEffect='unknown'（终端不再内嵌 Plan 策略）
    const safetyComposite = executeCommandToolInstance.checkSafety({ command: process.platform === 'win32' ? 'Get-ChildItem | Select-String "txt"' : 'ls | grep "txt"' }, mockSession);
    expect(safetyComposite.operation?.planSideEffect).toBe('unknown');
    expect(safetyComposite.status).toBe('suspend');

    const safetyRedirect = executeCommandToolInstance.checkSafety(
      process.platform === 'win32'
        ? { command: 'Get-Content a.txt > b.txt', shellKind: 'powershell' }
        : { command: 'cat a.txt > b.txt', shellKind: 'posix' },
      mockSession,
    );
    expect(safetyRedirect.operation?.planSideEffect).toBe('unknown');
    expect(safetyRedirect.status).toBe('suspend');

    // C. 计划模式 + 平台可用只读命令 → planSideEffect='read'
    const safetyPlatformRead = executeCommandToolInstance.checkSafety(platformReadCase, mockSession);
    expect(safetyPlatformRead.operation?.planSideEffect).toBe('read');
    expect(safetyPlatformRead.status).toBe('suspend');

    const safetyPlatformReadVariant = executeCommandToolInstance.checkSafety(platformReadVariantCase, mockSession);
    expect(safetyPlatformReadVariant.operation?.planSideEffect).toBe('read');
    expect(safetyPlatformReadVariant.status).toBe('suspend');

    // 平台 shell 中未加入只读白名单的命令 → unknown
    const safetyUnknownCommand = executeCommandToolInstance.checkSafety(
      process.platform === 'win32'
        ? { command: 'wmic process', shellKind: 'cmd' }
        : { command: 'ps aux', shellKind: 'posix' },
      mockSession,
    );
    expect(safetyUnknownCommand.operation?.planSideEffect).not.toBe('read');

    // D. 计划模式 + 危险写命令 → planSideEffect='write'
    const safetyWrite = executeCommandToolInstance.checkSafety({ command: platformWriteCommands[0] }, mockSession);
    expect(safetyWrite.operation?.planSideEffect).toBe('write');

    // E. Auto/Safe 模式回归：不受本次变更影响
    mockSession.setPermissionMode('auto');
    saveAllowedCommands([]); // 无白名单
    const safetyAuto = executeCommandToolInstance.checkSafety(platformReadCase, mockSession);
    expect(safetyAuto.status).toBe('suspend'); // Auto 下未授权命令进入审批

    mockSession.setPermissionMode('default');
    const safetySafe = executeCommandToolInstance.checkSafety(platformReadCase, mockSession);
    expect(safetySafe.status).toBe('suspend'); // Safe 下始终审批

    // YOLO 模式回归
    mockSession.setPermissionMode('bypassPermissions');
    const safetyYolo = executeCommandToolInstance.checkSafety({ command: 'dir C:\\Windows\\Temp' }, mockSession);
    expect(safetyYolo.status).toBe('pass'); // YOLO 下直接放行
  });

  test('16. 终端命令副作用分类与 Plan 同构回归测试', () => {
    const mockSession = new SessionContext();
    mockSession.setPermissionMode('plan');

    // A. 任何包含复合字符的命令，checkSafety 必须返回 planSideEffect='unknown' 而非 'read'
    const compositeCases = [
      'dir C:\\ | find "txt"',    // 白名单命中但有管道
      'type a.txt > b.txt',       // 白名单命中但有重定向
      'git status; whoami',       // 白名单命中但有分号
      'cat file | grep text',     // 白名单命中但有管道
      'echo hello & echo world',  // 非白名单且有拼接
    ];
    for (const cmd of compositeCases) {
      const safety = executeCommandToolInstance.checkSafety({ command: cmd }, mockSession);
      // 终端不再内嵌 Plan 拒绝逻辑；由 HumanApprovalPlugin 中央策略基于 planSideEffect 决策
      expect(safety.operation?.planSideEffect).toBe('unknown');
      expect(safety.status).toBe('suspend');
    }

    // B. Plan 下通过的命令（safe），在审批放行后 execute 阶段的 validateCommand 不能因复合字符拒绝
    // 验证：isPlanSafeCommand 返回 true 的命令同时传递 validateCommand
    const safeCases: Array<{ command: string; shellKind: 'powershell' | 'cmd' | 'posix' }> = process.platform === 'win32'
      ? [
        { command: 'Get-Content package.json', shellKind: 'powershell' },
        { command: 'Get-Content package.json', shellKind: 'powershell' },
        { command: 'git status', shellKind: 'powershell' },
        { command: 'git diff', shellKind: 'powershell' },
        { command: 'git log', shellKind: 'powershell' },
        { command: 'git log --grep="feat;fix"', shellKind: 'powershell' },
      ]
      : [
        { command: 'ls /tmp', shellKind: 'posix' },
        { command: 'cat package.json', shellKind: 'posix' },
        { command: 'git status', shellKind: 'posix' },
        { command: 'git diff', shellKind: 'posix' },
        { command: 'git log', shellKind: 'posix' },
        { command: 'git log --grep="feat;fix"', shellKind: 'posix' },
      ];
    for (const { command, shellKind } of safeCases) {
      // isPlanSafeCommand 断言为 true
      expect(isPlanSafeCommand(command, shellKind)).toBe(true);
      // validateCommand 断言不抛错（同构保证）
      expect(() => validateCommand(command, shellKind)).not.toThrow();
    }

    // C. 安全的只读命令返回 planSideEffect='read'
    for (const { command, shellKind } of safeCases) {
      const safety = executeCommandToolInstance.checkSafety({ command, shellKind }, mockSession);
      expect(safety.operation?.planSideEffect).toBe('read');
    }

    // D. 写倾向命令返回 planSideEffect='write'
    const writeCases = platformWriteCommands;
    for (const cmd of writeCases) {
      const safety = executeCommandToolInstance.checkSafety({ command: cmd }, mockSession);
      expect(safety.operation?.planSideEffect).toBe('write');
    }

    // E. Auto/Safe 模式回归：不受本次变更影响
    mockSession.setPermissionMode('auto');
    saveAllowedCommands([]); // 无白名单
    const safetyAuto = executeCommandToolInstance.checkSafety(platformReadCase, mockSession);
    expect(safetyAuto.status).toBe('suspend'); // Auto 下未授权命令进入审批

    mockSession.setPermissionMode('default');
    const safetySafe = executeCommandToolInstance.checkSafety(platformReadCase, mockSession);
    expect(safetySafe.status).toBe('suspend'); // Safe 下始终审批

    // YOLO 模式回归
    mockSession.setPermissionMode('bypassPermissions');
    const safetyYolo = executeCommandToolInstance.checkSafety({ command: platformReadCase.command }, mockSession);
    expect(safetyYolo.status).toBe('pass'); // YOLO 下直接放行

    // F. 同构性：复合命令在 isPlanSafeCommand 和 validateCommand 中均被拒绝
    const denyCases = [
      'dir /-C | find "txt"',
      'type a.txt > b.txt',
      'git log; whoami',
    ];
    for (const cmd of denyCases) {
      expect(isPlanSafeCommand(cmd, 'powershell')).toBe(false);
      expect(() => validateCommand(cmd, 'powershell')).toThrow('拒绝执行');
    }

    // G. shell family 错配：isPlanSafeCommand 不得跨壳放行
    expect(isPlanSafeCommand('cat file.txt', 'cmd')).toBe(false);
    expect(isPlanSafeCommand('dir C:\\Windows\\Temp', 'posix')).toBe(false);
  });

  test('17. advisory warning 解析应跳过当前 shell 的命令开关', () => {
    expect(detectAdvisoryWarnings('dir /A:H /W', 'cmd')).toHaveLength(0);

    if (process.platform === 'win32') {
      const warnings = detectAdvisoryWarnings('dir C:\\Windows', 'cmd');
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  describe('BashTool resolveExecutionEffect 测试', () => {
    const tool = process.platform === 'win32'
      ? new PowerShellTool()
      : new BashTool();

    test('2.4 Plan 安全只读命令返回 read effect', () => {
      // isPlanSafeCommand 判定的原子只读命令
      const effect1 = tool.resolveExecutionEffect!(platformReadCase)!;
      expect(effect1.kind).toBe('read');
      expect(effect1.reason).toBe('plan_safe_command');

      const effect2 = tool.resolveExecutionEffect!(platformReadVariantCase)!;
      expect(effect2.kind).toBe('read');
      expect(effect2.reason).toBe('plan_safe_command');

      const effect3 = tool.resolveExecutionEffect!(platformPowerShellReadCase)!;
      expect(effect3.kind).toBe('read');
      expect(effect3.reason).toBe('plan_safe_command');
    });

    test('2.5 管道/重定向/复合命令无法被 Plan 判定，Bash 不可达，resolveExecutionEffect 不会返回 read', () => {
      // 这些命令会被 checkSafety 在 Plan 模式下拒绝，但没有执行，resolveExecutionEffect 不会返回 pre_execution_abort
      // 验证 effect 为 unknown（因为安全判定未命中只读规则，按 legacy_fallback 保守处理）
      const effect1 = tool.resolveExecutionEffect!(platformCompositeCase)!;
      expect(effect1.kind).toBe('unknown');
      expect(effect1.reason).toBe('legacy_fallback');
    });

    test('2.6 非只读但获准执行的命令返回 unknown', () => {
      const effect1 = tool.resolveExecutionEffect!({ command: 'npm run build' })!;
      expect(effect1.kind).toBe('unknown');
      expect(effect1.reason).toBe('legacy_fallback');

      const effect2 = tool.resolveExecutionEffect!({ command: 'node scripts/build.js' })!;
      expect(effect2.kind).toBe('unknown');
      expect(effect2.reason).toBe('legacy_fallback');
    });

    test('执行失败但仍为 Plan 安全命令时 effect 为 read', () => {
      const effect = tool.resolveExecutionEffect!(platformReadCase, undefined, new Error('执行失败'))!;
      expect(effect.kind).toBe('read');
      expect(effect.completed).toBe(false);
      expect(effect.reason).toBe('plan_safe_command');
    });
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
  });

  test('未识别的写倾向命令应返回 passthrough（由 ToolPermissionService 决策）', () => {
    const result = tool.checkPermissions!({ command: 'npm run build' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('passthrough');
  });

  test('未识别的命令应返回 passthrough（由 ToolPermissionService 决策）', () => {
    const result = tool.checkPermissions!({ command: 'env' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('passthrough');
  });

  test('危险命令应返回 deny', () => {
    const result = tool.checkPermissions!({ command: 'rm -rf /' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
  });

  test('空 command 应返回 deny', () => {
    const result = tool.checkPermissions!({}) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
  });

  test('checkPermissions 不应读取 WorkMode（无 sessionContext 参数）', () => {
    // checkPermissions 的签名不包含 sessionContext，证明其不依赖 WorkMode
    expect(tool.checkPermissions!.length).toBeLessThanOrEqual(1);
  });
});
