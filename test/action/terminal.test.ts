/**
 * @file terminal.test.ts
 * @description 终端执行工具 terminal.ts 的功能性与安全性单元测试
 * @author wangjia
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { resolve } from 'path';
import { initWorkspace } from '../../src/action/tools.js';
import {
  executeCommandTool,
  extractSafePrefix,
  checkWhitelist,
  saveAllowedCommands,
  loadAllowedCommands,
  setWorkMode,
  saveWorkMode,
  loadWorkMode
} from '../../src/action/native-tools/terminal.js';

describe('Terminal Tool 单元测试', () => {
  const mockRootDir = resolve('D:\\authorized\\path_terminal_test');

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
    await expect(executeCommandTool('echo 1 & echo 2')).rejects.toThrow('拒绝执行');
    
    // 带管道符 | 的命令
    await expect(executeCommandTool('cat file | grep text')).rejects.toThrow('拒绝执行');
    
    // 带重定向符 > 的命令
    await expect(executeCommandTool('echo hello > output.txt')).rejects.toThrow('拒绝执行');
    
    // 带换行符的命令
    await expect(executeCommandTool('echo hello\necho world')).rejects.toThrow('拒绝执行');
  });

  test('3. 沙箱隔离边界路径校验', async () => {
    // 使用越界的 cwd 参数
    await expect(executeCommandTool('npm run build', '../../etc')).rejects.toThrow('Operation not permitted');
    await expect(executeCommandTool('npm run build', 'C:\\Windows')).rejects.toThrow('Operation not permitted');
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
    expect(checkWhitelist('git add src/a.ts')).toBe(true);
    expect(checkWhitelist('npm publish')).toBe(false); // 没在白名单内
  });

  test('5. YOLO 模式下命令的执行及首尾截断防爆测试', async () => {
    // 设置模式为 YOLO 绕过人工确认
    setWorkMode('YOLO');

    // 执行一个简单的 echo 指令，由于在 Windows 环境下可能没有全局 echo，
    // 我们使用 node.exe 执行一段 JS 脚本作为跨平台的执行测试，确保子进程能正常跑起来
    const result = await executeCommandTool('node -e "console.log(\'LineA\'); console.log(\'LineB\')"');
    
    expect(result).toContain('LineA');
    expect(result).toContain('LineB');
    expect(result).toContain('<shell_metadata>');
    expect(result).toContain('<exit_code>0</exit_code>');
  });

  test('6. 启动观察期 200ms 后台驻留捕获测试', async () => {
    setWorkMode('YOLO');
    
    // 场景 A: 在 200ms 内立即报错退出的命令，executeCommandTool 应同步返回错误结果，而不是后台 ID 提示
    const invalidCommand = 'node -e "process.exit(1)"';
    const resultInvalid = await executeCommandTool(invalidCommand, undefined, true);
    expect(resultInvalid).not.toContain('任务已在后台成功启动');
    expect(resultInvalid).toContain('退出码 1');

    // 场景 B: 存活时间超过 200ms 的后台任务，应该返回后台 ID 成功启动的提示
    const longRunningCommand = 'node -e "setTimeout(function(){}, 2000)"';
    const resultValid = await executeCommandTool(longRunningCommand, undefined, true);
    expect(resultValid).toContain('任务已在后台成功启动并存活超过 200ms');
  });
});
