/* eslint-disable n/no-process-env */
/**
 * @file config-guide.spec.ts
 * @description 物理配置引导与加载集成测试。
 * 本文件在独立的临时物理工作区内，验证配置文件（.env, mcp_config.json）
 * 的物理自生成拷贝机制以及 loadConfig 物理热读取字段解析功能。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { ensureConfigFiles, loadConfig } from '../../src/config/loader.js';

describe('Configuration Integration & Guide Tests', () => {
  const originalCwd = process.cwd();
  const tempWorkspaceDir = resolve(originalCwd, 'test-temp-integration-workspace');

  beforeEach(() => {
    if (!existsSync(tempWorkspaceDir)) {
      mkdirSync(tempWorkspaceDir);
    }
    // 拷贝主目录下的模板到临时沙箱，以便测试文件引导复制机制
    copyFileSync(resolve(originalCwd, '.env.example'), resolve(tempWorkspaceDir, '.env.example'));
    copyFileSync(resolve(originalCwd, 'mcp_config.example.json'), resolve(tempWorkspaceDir, 'mcp_config.example.json'));
    
    // 改变工作目录到临时物理目录以进行安全沙箱测试
    process.chdir(tempWorkspaceDir);
  });

  afterEach(() => {
    // 恢复全局工作目录
    process.chdir(originalCwd);
    if (existsSync(tempWorkspaceDir)) {
      rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
  });

  it('Requirement: 配置文件引导 - 物理引导自拷贝验证', () => {
    expect(existsSync('.env')).toBe(false);
    expect(existsSync('mcp_config.json')).toBe(false);

    // 运行物理引导函数
    ensureConfigFiles();

    expect(existsSync('.env')).toBe(true);
    expect(existsSync('mcp_config.json')).toBe(true);
  });

  it('Requirement: 集中配置物理热加载 - 验证物理文件装配正确性', () => {
    ensureConfigFiles();

    // 修改物理 .env 文件以预设特定的自定义变量
    const customEnvContent = `
AGENT_LLM_API_KEY=mock-integrated-key-456
AGENT_LLM_MODEL=deepseek-v4-flash[1m]
AGENT_LLM_REASONING_EFFORT=low
`;
    writeFileSync('.env', customEnvContent, 'utf-8');

    // 采用与生产环境一致的加载模式，使用 process.env 进行热读取物理文件
    const config = loadConfig(process.env);

    // 验证 API 凭证及思考努力度完全对齐物理写入的内容
    expect(config.llm.apiKey).toBe('mock-integrated-key-456');
    expect(config.llm.model).toBe('deepseek-v4-flash');
    expect(config.llm.reasoningEffort).toBe('low');
  });
});
