/**
 * @fileoverview Vitest 测试全局沙箱隔离 setup 脚本。
 * 该脚本在测试执行前被载入，通过重定向环境变量和动态建立项目内部的临时工作目录，
 * 隔离测试执行期间产生的物理文件读写（如长期记忆库重建、会话落盘等），避免污染物理开发区。
 */

import { afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// 1. 在项目内已被 Git 忽略的 .myagent/temp 目录下创建专属的测试沙箱工作区
const sandboxBaseDir = path.resolve(process.cwd(), '.myagent/temp');
if (!fs.existsSync(sandboxBaseDir)) {
  fs.mkdirSync(sandboxBaseDir, { recursive: true });
}
const tempWorkspaceDir = fs.mkdtempSync(path.join(sandboxBaseDir, 'test-sandbox-'));

// 2. 建立虚拟的 .agent 目录，并在其中写入固定的测试 facts 数据，确保测试结果跨机器可复现
const virtualAgentDir = path.join(tempWorkspaceDir, '.agent');
fs.mkdirSync(virtualAgentDir, { recursive: true });

const virtualMemoryPath = path.join(virtualAgentDir, 'MEMORY.md');

const testFacts = `
- **SessionManager**：这是会话管理的控制中枢，它负责插件的生命周期和洋葱模型的构建。
- **TypeScript**：这是项目的核心开发语言，所有的插件和驱动都必须使用 TypeScript 编写。
- **状态管理规范**：在智能体框架里，上下文修改是通过 Immer Proxy 来保证并发写入时的安全忙锁。
`;

fs.writeFileSync(virtualMemoryPath, testFacts.trim() + '\n', 'utf-8');

// 3. 全局重定向环境变量，使所有的 UseCases 和 Plugins 等在此临时目录下写盘
/* eslint-disable-next-line n/no-process-env */
process.env.AUTHORIZED_WORKSPACE_DIR = tempWorkspaceDir;

// 4. 注册全局 cleanup 钩子，在测试执行完毕后自动清理临时文件
afterAll(() => {
  try {
    if (fs.existsSync(tempWorkspaceDir)) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
  } catch {
    // 单元测试 Teardown 阶段绝对不能调用 console.log/error，
    // 否则会因 RPC 通信管道关闭导致 Vitest 抛出 [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending 致命 Unhandled 错误。
  }
});
