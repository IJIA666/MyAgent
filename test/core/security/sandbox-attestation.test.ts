/**
 * @file 原生运行时 sandbox attestation 真实性测试。
 * 没有 OS containment 时不得把适配器级环境裁剪宣传成全局凭据隔离。
 */

import { describe, expect, it } from 'vitest';
import { createSandboxAttestation } from '../../../src/core/domain/security/sandbox-attestation.js';

describe('createSandboxAttestation', () => {
  it('原生 backend 应诚实报告 policy-only 与未建立的 OS 隔离', () => {
    const attestation = createSandboxAttestation();

    expect(attestation).toMatchObject({
      backend: 'native',
      level: 'policy-only',
      fileIsolation: false,
      networkIsolation: false,
      processIsolation: false,
      credentialIsolation: false,
    });
  });

  it('backend 初始化失败必须报告 degraded，不能回退成 contained', () => {
    const attestation = createSandboxAttestation({
      backend: 'isolated-worker',
      initializationFailed: true,
      fileIsolation: true,
      networkIsolation: true,
      processIsolation: true,
      credentialIsolation: true,
    });

    expect(attestation.level).toBe('degraded');
    expect(attestation.backend).toBe('isolated-worker');
  });

  it('只有四类隔离全部真实建立时才可报告 contained', () => {
    expect(createSandboxAttestation({
      backend: 'isolated-worker',
      fileIsolation: true,
      networkIsolation: true,
      processIsolation: true,
      credentialIsolation: false,
    }).level).toBe('policy-only');
    expect(createSandboxAttestation({
      backend: 'isolated-worker',
      fileIsolation: true,
      networkIsolation: true,
      processIsolation: true,
      credentialIsolation: true,
    }).level).toBe('contained');
  });
});
