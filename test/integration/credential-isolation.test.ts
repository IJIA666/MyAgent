/**
 * @file 凭据受众与真实子进程环境隔离测试。
 * 验证宿主 secrets 不会默认进入 Terminal、MCP、browser、plugin 或 sub-agent，
 * 并验证受信配置可为单一受众精确注入所需凭据。
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createCredentialEnvironment,
  createCredentialProfile,
} from '../../src/core/domain/security/credential-profile.js';

const hostEnvironment = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  USERPROFILE: process.env.USERPROFILE,
  XDG_CONFIG_HOME: '/tmp/xdg-config',
  OPENAI_API_KEY: 'provider-secret',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  MCP_PRIVATE_TOKEN: 'mcp-host-secret',
  UNRELATED_SECRET: 'unrelated-secret',
};

describe('CredentialProfile', () => {
  it('Terminal 标记 inheritHostEnv 但只复制基础 allowlist，不继承 secrets', () => {
    const profile = createCredentialProfile('terminal');
    const environment = createCredentialEnvironment(profile, hostEnvironment);

    expect(profile.inheritHostEnv).toBe(true);
    expect(environment.PATH).toBe(hostEnvironment.PATH);
    expect(environment.XDG_CONFIG_HOME).toBe('/tmp/xdg-config');
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.UNRELATED_SECRET).toBeUndefined();
  });

  it('MCP/plugin/sub-agent/browser 默认都不继承宿主凭据', () => {
    for (const audience of ['mcp-server', 'plugin', 'sub-agent', 'browser'] as const) {
      const profile = createCredentialProfile(audience);
      const environment = createCredentialEnvironment(profile, hostEnvironment);
      expect(profile.inheritHostEnv).toBe(false);
      expect(environment.OPENAI_API_KEY).toBeUndefined();
      expect(environment.MCP_PRIVATE_TOKEN).toBeUndefined();
      expect(environment.UNRELATED_SECRET).toBeUndefined();
    }
  });

  it('显式 MCP 凭据只进入该次 MCP 环境并覆盖同名基础值', () => {
    const environment = createCredentialEnvironment(
      createCredentialProfile('mcp-server'),
      hostEnvironment,
      {
        TAVILY_API_KEY: 'exact-mcp-secret',
        PATH: 'D:\\isolated-bin',
      },
    );

    expect(environment.TAVILY_API_KEY).toBe('exact-mcp-secret');
    expect(environment.PATH).toBe('D:\\isolated-bin');
    expect(environment.OPENAI_API_KEY).toBeUndefined();
  });

  it('最小 Terminal 环境应在真实 Node 子进程中物理阻断宿主 secret', () => {
    const environment = createCredentialEnvironment(
      createCredentialProfile('terminal'),
      hostEnvironment,
    );
    const child = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: { ...environment }, encoding: 'utf8' },
    );

    expect(child.status).toBe(0);
    const childEnvironment = JSON.parse(child.stdout) as Record<string, string>;
    expect(childEnvironment.OPENAI_API_KEY).toBeUndefined();
    expect(childEnvironment.UNRELATED_SECRET).toBeUndefined();
    if (hostEnvironment.PATH !== undefined) {
      expect(childEnvironment.PATH).toBeDefined();
    }
  });

  it('profile 和环境快照必须不可变', () => {
    const profile = createCredentialProfile('mcp-server');
    const environment = createCredentialEnvironment(profile, hostEnvironment);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.allowedEnvVars)).toBe(true);
    expect(Object.isFrozen(environment)).toBe(true);
  });
});
