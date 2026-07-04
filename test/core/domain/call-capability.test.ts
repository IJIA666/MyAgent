/**
 * CallCapability 三状态机 + hasClaimedResource access-aware 校验 + computeArgumentsDigest 单元测试。
 * 覆盖 approval-capability-lifecycle change 的核心令牌生命周期和读写隔离不变量。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionContext, computeArgumentsDigest } from '../../../src/core/domain/context.js';
import type { SafetyResource } from '../../../src/core/usecases/security/SafetyResource.js';

/** 构造测试用的路径资源 */
function pathResource(access: 'read' | 'write', normalizedPath: string): SafetyResource {
  return { kind: 'path', access, normalizedPath };
}

describe('computeArgumentsDigest', () => {
  it('11.x 相同参数产生相同摘要', () => {
    const a = computeArgumentsDigest({ targetPath: '/foo/bar', content: 'hello' });
    const b = computeArgumentsDigest({ targetPath: '/foo/bar', content: 'hello' });
    expect(a).toBe(b);
  });

  it('11.x 参数顺序不同仍产生相同摘要（key 排序规范化）', () => {
    const a = computeArgumentsDigest({ content: 'hello', targetPath: '/foo/bar' });
    const b = computeArgumentsDigest({ targetPath: '/foo/bar', content: 'hello' });
    expect(a).toBe(b);
  });

  it('11.x 参数值不同产生不同摘要（防篡改）', () => {
    const a = computeArgumentsDigest({ targetPath: '/foo/bar' });
    const b = computeArgumentsDigest({ targetPath: '/foo/baz' });
    expect(a).not.toBe(b);
  });
});

describe('CallCapability — 三状态生命周期', () => {
  let ctx: SessionContext;

  beforeEach(() => {
    ctx = new SessionContext('test-session-cap');
  });

  /** 辅助：注册一个带 digest 的令牌 */
  function registerToken(toolCallId: string, toolName: string, resources: SafetyResource[], args: Record<string, unknown>): void {
    const digest = computeArgumentsDigest(args);
    ctx.registerCallCapability({
      toolCallId,
      toolName,
      resources,
      argumentsDigest: digest,
      state: 'registered',
      createdAt: Date.now()
    });
  }

  it('11.1 注册后令牌为 registered 状态，claim 成功切换为 claimed', () => {
    const resources = [pathResource('write', '/tmp/test.txt')];
    registerToken('call-1', 'writeFile', resources, { targetPath: '/tmp/test.txt' });

    const claimed = ctx.claimCapability('call-1', 'writeFile', { targetPath: '/tmp/test.txt' });
    expect(claimed).not.toBeNull();
    expect(claimed).toEqual(resources);
  });

  it('11.1 重复 claim 同一令牌返回 null（已被领取）', () => {
    registerToken('call-1', 'writeFile', [pathResource('write', '/tmp/test.txt')], { targetPath: '/tmp/test.txt' });

    ctx.claimCapability('call-1', 'writeFile', { targetPath: '/tmp/test.txt' });
    // 第二次 claim
    const second = ctx.claimCapability('call-1', 'writeFile', { targetPath: '/tmp/test.txt' });
    expect(second).toBeNull();
  });

  it('11.1 令牌消费后不可复用（registered→claimed→removed）', () => {
    registerToken('call-1', 'writeFile', [pathResource('write', '/tmp/test.txt')], { targetPath: '/tmp/test.txt' });

    ctx.claimCapability('call-1', 'writeFile', { targetPath: '/tmp/test.txt' });
    ctx.consumeCapability('call-1');

    // consumed 后 hasClaimedResource 返回 false
    expect(ctx.hasClaimedResource('call-1', 'write', '/tmp/test.txt')).toBe(false);
  });

  it('11.x 参数变更导致 claim 失败（argumentsDigest 不匹配）', () => {
    registerToken('call-1', 'writeFile', [pathResource('write', '/tmp/test.txt')], { targetPath: '/tmp/test.txt' });

    // 用不同的参数尝试 claim
    const claimed = ctx.claimCapability('call-1', 'writeFile', { targetPath: '/tmp/hijacked.txt' });
    expect(claimed).toBeNull();
  });

  it('11.x toolName 不匹配返回 null', () => {
    registerToken('call-1', 'writeFile', [pathResource('write', '/tmp/test.txt')], { targetPath: '/tmp/test.txt' });

    const claimed = ctx.claimCapability('call-1', 'deletePath', { targetPath: '/tmp/test.txt' });
    expect(claimed).toBeNull();
  });

  it('11.x 不存在的 toolCallId 返回 null', () => {
    const claimed = ctx.claimCapability('nonexistent', 'writeFile', { targetPath: '/tmp/test.txt' });
    expect(claimed).toBeNull();
  });
});

describe('hasClaimedResource — access-aware 读写隔离', () => {
  let ctx: SessionContext;

  beforeEach(() => {
    ctx = new SessionContext('test-session-access');
    // 注册并 claim 一个 write 令牌
    const resources: SafetyResource[] = [pathResource('write', '/tmp/write-only.txt')];
    const digest = computeArgumentsDigest({ targetPath: '/tmp/write-only.txt' });
    ctx.registerCallCapability({
      toolCallId: 'call-write',
      toolName: 'writeFile',
      resources,
      argumentsDigest: digest,
      state: 'registered',
      createdAt: Date.now()
    });
    ctx.claimCapability('call-write', 'writeFile', { targetPath: '/tmp/write-only.txt' });
  });

  it('11.11 读授权不能升级为写：write 令牌的 hasClaimedResource(..., read, ...) 返回 false', () => {
    // write 令牌的资源是 access='write'，用 'read' 检查应失败
    expect(ctx.hasClaimedResource('call-write', 'read', '/tmp/write-only.txt')).toBe(false);
  });

  it('11.11 写授权不能通过读检查：匹配 access 时返回 true', () => {
    expect(ctx.hasClaimedResource('call-write', 'write', '/tmp/write-only.txt')).toBe(true);
  });

  it('11.12 路径不匹配返回 false', () => {
    expect(ctx.hasClaimedResource('call-write', 'write', '/tmp/other-path.txt')).toBe(false);
  });

  it('11.x 同时注册 read + write 令牌，各自 isolation 正确', () => {
    const ctx2 = new SessionContext('test-session-mixed');
    const readRes: SafetyResource[] = [pathResource('read', '/shared/path')];
    const writeRes: SafetyResource[] = [pathResource('write', '/shared/path')];

    const readDigest = computeArgumentsDigest({ targetPath: '/shared/path' });
    ctx2.registerCallCapability({
      toolCallId: 'call-read', toolName: 'readFile', resources: readRes,
      argumentsDigest: readDigest, state: 'registered', createdAt: Date.now()
    });
    ctx2.claimCapability('call-read', 'readFile', { targetPath: '/shared/path' });

    const writeDigest = computeArgumentsDigest({ targetPath: '/shared/path' });
    ctx2.registerCallCapability({
      toolCallId: 'call-write', toolName: 'writeFile', resources: writeRes,
      argumentsDigest: writeDigest, state: 'registered', createdAt: Date.now()
    });
    ctx2.claimCapability('call-write', 'writeFile', { targetPath: '/shared/path' });

    // read 令牌只能过 read 检查
    expect(ctx2.hasClaimedResource('call-read', 'read', '/shared/path')).toBe(true);
    expect(ctx2.hasClaimedResource('call-read', 'write', '/shared/path')).toBe(false);

    // write 令牌只能过 write 检查
    expect(ctx2.hasClaimedResource('call-write', 'write', '/shared/path')).toBe(true);
    expect(ctx2.hasClaimedResource('call-write', 'read', '/shared/path')).toBe(false);
  });
});

describe('CallCapability — 并发隔离', () => {
  it('11.x 两个并发调用各自独立，互不影响', () => {
    const ctx = new SessionContext('test-session-concurrent');

    const resA: SafetyResource[] = [pathResource('write', '/tmp/a.txt')];
    const resB: SafetyResource[] = [pathResource('write', '/tmp/b.txt')];

    const digestA = computeArgumentsDigest({ targetPath: '/tmp/a.txt' });
    ctx.registerCallCapability({
      toolCallId: 'call-A', toolName: 'writeFile', resources: resA,
      argumentsDigest: digestA, state: 'registered', createdAt: Date.now()
    });

    const digestB = computeArgumentsDigest({ targetPath: '/tmp/b.txt' });
    ctx.registerCallCapability({
      toolCallId: 'call-B', toolName: 'writeFile', resources: resB,
      argumentsDigest: digestB, state: 'registered', createdAt: Date.now()
    });

    // call-A claim
    ctx.claimCapability('call-A', 'writeFile', { targetPath: '/tmp/a.txt' });
    expect(ctx.hasClaimedResource('call-A', 'write', '/tmp/a.txt')).toBe(true);
    expect(ctx.hasClaimedResource('call-A', 'write', '/tmp/b.txt')).toBe(false);

    // call-B claim
    ctx.claimCapability('call-B', 'writeFile', { targetPath: '/tmp/b.txt' });
    expect(ctx.hasClaimedResource('call-B', 'write', '/tmp/b.txt')).toBe(true);

    // 消费 call-A，call-B 不受影响
    ctx.consumeCapability('call-A');
    expect(ctx.hasClaimedResource('call-A', 'write', '/tmp/a.txt')).toBe(false);
    expect(ctx.hasClaimedResource('call-B', 'write', '/tmp/b.txt')).toBe(true);
  });
});
