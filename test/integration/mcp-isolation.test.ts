/**
 * @file mcp-isolation.spec.ts
 * @description MCP 子进程环境变量物理隔离集成测试。
 * 本测试真实 spawn 启动 Dummy Node.js 子进程并捕获其输出，
 * 物理校验大模型 API 凭证及敏感信息未意外泄露到子进程，且白名单变量与自定义配置正常透传。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { buildSubprocessEnv } from '../../src/config/mcp-env.js';

describe('MCP Subprocess Env Isolation Integration Tests', () => {
  const tempWorkspaceDir = resolve(process.cwd(), 'test-temp-mcp-workspace');
  const dummyScriptPath = resolve(tempWorkspaceDir, 'dummy-mcp.js');

  beforeEach(() => {
    if (!existsSync(tempWorkspaceDir)) {
      mkdirSync(tempWorkspaceDir);
    }
    // 写入一个只执行一次的 Dummy 自检进程脚本，直接输出接收到的全部 env 字典并安全退出
    const scriptContent = `
console.log(JSON.stringify(process.env));
process.exit(0);
`;
    writeFileSync(dummyScriptPath, scriptContent, 'utf-8');
  });

  afterEach(() => {
    if (existsSync(tempWorkspaceDir)) {
      rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
  });

  it('Requirement: MCP 子进程环境隔离机制 - 物理子进程白名单透传与 API 密钥阻断拦截审计', () => {
    // 1. 模拟宿主机 process.env 环境，注入敏感大模型密钥及不相干的自定义变量
    process.env.AGENT_LLM_API_KEY = 'leak-sensitive-api-token-999';
    process.env.AGENT_LLM_MODEL = 'deepseek-v4-pro';
    process.env.SOME_UNAUTHORIZED_ENV = 'should-be-blocked';

    // 2. 模拟用户自定义的 mcp_config.json 传入参数
    const userMcpEnv = {
      TAVILY_API_KEY: 'tvly-custom-mcp-secret-111'
    };

    // 3. 构建物理过滤后的隔离环境变量对象
    const filteredEnv = buildSubprocessEnv(userMcpEnv);

    // 4. 物理 spawn 启动 Dummy 子进程，将隔离后的 env 传入
    const child = spawn(process.execPath, [dummyScriptPath], {
      env: filteredEnv
    });

    let stdoutData = '';
    
    return new Promise<void>((resolvePromise, reject) => {
      child.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      child.on('error', (err) => {
        reject(err);
      });

      child.on('close', (code) => {
        try {
          expect(code).toBe(0);

          // 解析子进程还原出的物理 env 对象
          const childEnv = JSON.parse(stdoutData.trim()) as Record<string, string>;

          // 物理断言 A：宿主机上的敏感变量绝对不能泄露至子进程中
          expect(childEnv.AGENT_LLM_API_KEY).toBeUndefined();
          expect(childEnv.AGENT_LLM_MODEL).toBeUndefined();
          expect(childEnv.SOME_UNAUTHORIZED_ENV).toBeUndefined();

          // 物理断言 B：强制注入的 Python 编码变量正常生效
          expect(childEnv.PYTHONIOENCODING).toBe('utf-8');
          expect(childEnv.PYTHONUTF8).toBe('1');

          // 物理断言 C：用户显式定义的自定义变量成功透传
          expect(childEnv.TAVILY_API_KEY).toBe('tvly-custom-mcp-secret-111');

          // 物理断言 D：白名单中的 PATH 等基础进程运转变量得以保留
          if (process.env.PATH !== undefined) {
            expect(childEnv.PATH).toBeDefined();
          }

          resolvePromise();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});
