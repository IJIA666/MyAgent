/**
 * 终端执行工具 terminal.ts 的功能性与安全性单元测试。
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { resolve } from 'path';
import { initWorkspace } from '../../src/adapters/tools/tools.js';
import {
  ExecuteCommandTool,
  extractSafePrefix,
  checkWhitelist,
  saveAllowedCommands,
  loadAllowedCommands,
  setWorkMode,
  saveWorkMode,
  loadWorkMode
} from '../../src/adapters/tools/tools/system/terminal.js';
import { validateCommand, validateCwd, unboxNestedCommand } from '../../src/adapters/tools/tools/system/terminal-guard.js';
import { SessionContext } from '../../src/core/domain/context.js';

describe('Terminal Tool 单元测试', () => {
  const mockRootDir = resolve('D:\\authorized\\path_terminal_test');
  let executeCommandToolInstance: ExecuteCommandTool;

  beforeAll(() => {
    // 初始化测试工作区路径
    initWorkspace(mockRootDir);
  });

  beforeEach(() => {
    // 每次测试前，将工作模式重置为 YOLO，防止测试由于人工交互阻断卡死
    setWorkMode('YOLO');
    saveWorkMode('YOLO');
    
    // 清空白名单
    saveAllowedCommands([]);

    // 实例化终端执行工具类
    executeCommandToolInstance = new ExecuteCommandTool();
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
    await expect(executeCommandToolInstance.execute({ command: 'npm run build', cwd: 'C:\\Windows' })).rejects.toThrow('Operation not permitted');
  });

  test('4. 工作模式与白名单持久化配置测试', () => {
    // 工作模式存取测试
    saveWorkMode('Safe');
    expect(loadWorkMode()).toBe('Safe');
    
    saveWorkMode('Auto');
    expect(loadWorkMode()).toBe('Auto');

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
    setWorkMode('YOLO');

    // 执行一个简单的 echo 指令，由于在 Windows 环境下可能没有全局 echo，
    // 我们使用 node.exe 执行一段 JS 脚本作为跨平台的执行测试，确保子进程能正常跑起来
    const result = await executeCommandToolInstance.execute({ command: 'node -e "console.log(\'LineA\'); console.log(\'LineB\')"' });
    
    expect(result).toContain('LineA');
    expect(result).toContain('LineB');
    expect(result).toContain('<shell_metadata>');
    expect(result).toContain('<exit_code>0</exit_code>');
  });

  test('6. 启动观察期 200ms 后台驻留捕获测试', async () => {
    setWorkMode('YOLO');
    
    // 场景 A: 在 200ms 内立即报错退出的命令，executeCommandTool 应同步返回错误结果，而不是后台 ID 提示
    const invalidCommand = 'non_existent_command_xxxx';
    const resultInvalid = await executeCommandToolInstance.execute({ command: invalidCommand, isBackground: true });
    expect(resultInvalid).not.toContain('任务已在后台成功启动');
    expect(resultInvalid).toContain('错误');

    // 场景 B: 存活时间超过 200ms 的后台任务，应该返回后台 ID 成功启动的提示
    const longRunningCommand = 'node -e "setTimeout(function(){}, 2000)"';
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
    expect(() => validateCwd('C:\\Windows')).toThrow('Operation not permitted');
    
    // 正确路径不报错
    const correctPath = validateCwd('src');
    expect(correctPath).toContain('path_terminal_test');
  });

  test('8. Plan 模式写指令拦截与底线黑名单拦截测试', () => {
    // A. 测试 Plan 模式下拒绝写倾向指令
    const mockSession = new SessionContext();
    mockSession.setWorkMode('Plan');

    // 写倾向指令，应被 deny 拦截
    const safetyDev = executeCommandToolInstance.checkSafety({ command: 'npm run dev' }, mockSession);
    expect(safetyDev.status).toBe('deny');
    expect(safetyDev.message).toContain('BLOCKED (Plan Mode Only)');

    // 只读白名单指令（如 git log），应返回 suspend 挂起人工审批
    const safetyLog = executeCommandToolInstance.checkSafety({ command: 'git log' }, mockSession);
    expect(safetyLog.status).toBe('suspend');

    // B. 测试底线拦截黑名单 rm -rf /，无论在 YOLO 还是其他模式下都应被绝对拒绝
    mockSession.setWorkMode('YOLO');
    const safetyRm = executeCommandToolInstance.checkSafety({ command: 'rm -rf /' }, mockSession);
    expect(safetyRm.status).toBe('deny');
    expect(safetyRm.message).toContain('BLOCKED (Hardline Blocklist)');

    // 即使在没有 SessionContext（退化为全局配置 YOLO）时，也应绝对拦截
    setWorkMode('YOLO');
    const safetyRmGlobal = executeCommandToolInstance.checkSafety({ command: 'rm -rf /' });
    expect(safetyRmGlobal.status).toBe('deny');
    expect(safetyRmGlobal.message).toContain('BLOCKED (Hardline Blocklist)');
  });

  test('9. unboxNestedCommand 核心功能及 flags 容忍单元测试', () => {
    // A. 多层嵌套解包测试
    expect(unboxNestedCommand('powershell -Command "cmd /c \'npm run build\'"')).toBe('npm run build');

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
    setWorkMode('Auto');

    const safetyAllowed = executeCommandToolInstance.checkSafety({ command: 'powershell -Command "npm run test"' });
    expect(safetyAllowed.status).toBe('pass'); // 剥壳还原 npm run test 匹配白名单自动放行

    // D. 审批挂起时的披露信息与对比测试
    const safetyUnallowed = executeCommandToolInstance.checkSafety({ command: 'powershell -Command "npm test"' });
    expect(safetyUnallowed.status).toBe('suspend');
    expect(safetyUnallowed.message).toContain("外壳包装: 'powershell -Command \"npm test\"'");
    expect(safetyUnallowed.message).toContain("实际执行的核心命令为: 'npm test'");

    // E. 负向场景测试：解包后未命中白名单的拦截与告知行为
    saveAllowedCommands(['git status:*']); // 只授权 git status
    const safetyNegative = executeCommandToolInstance.checkSafety({ command: 'powershell -Command "npm run lint"' });
    expect(safetyNegative.status).toBe('suspend');
    expect(safetyNegative.message).toContain("外壳包装: 'powershell -Command \"npm run lint\"'");
    expect(safetyNegative.message).toContain("实际执行的核心命令为: 'npm run lint'");
  });
});
