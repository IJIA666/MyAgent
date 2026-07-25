/**
 * @fileoverview Vitest 测试全局沙箱隔离 setup 脚本。
 * 通过重定向环境变量和系统临时目录下的独立沙箱，隔离测试产生的物理文件读写，
 * 避免污染真实仓库或用户目录。
 */

import { afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

// 1. 在系统临时目录下创建专属的测试沙箱工作区（不再使用仓库内的 .myagent/temp）
const sandboxBaseDir = path.join(tmpdir(), 'myagent-test-sandbox');
if (!fs.existsSync(sandboxBaseDir)) {
  fs.mkdirSync(sandboxBaseDir, { recursive: true });
}
const tempWorkspaceDir = fs.mkdtempSync(path.join(sandboxBaseDir, 'test-sandbox-'));

// 2. 全局重定向环境变量，使所有持久化消费者在此临时目录下写盘
process.env.AUTHORIZED_WORKSPACE_DIR = tempWorkspaceDir;

// 3. 注册全局 cleanup 钩子，在测试执行完毕后自动清理临时文件
afterAll(() => {
  try {
    if (fs.existsSync(tempWorkspaceDir)) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
  } catch {
    // 单元测试 Teardown 阶段绝对不能调用 console.log/error，
    // 否则会因 RPC 通信管道关闭导致 Vitest 抛出致命错误。
  }
});
