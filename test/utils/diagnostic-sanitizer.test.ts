/**
 * @fileoverview 诊断 sanitizer 单元测试，验证默认安全边界、递归副本和异常输入容错。
 */

import { describe, expect, it } from 'vitest';
import {
  digestDiagnosticValue,
  sanitizeDiagnosticData,
  validateDiagnosticPatterns
} from '../../src/utils/diagnostic-sanitizer.js';

describe('diagnostic sanitizer', () => {
  it('should redact nested secret fields without mutating the original input', () => {
    const input = {
      request: {
        headers: { Authorization: 'Bearer top-secret' },
        arguments: { api_key: 'sk-test-secret', query: 'safe query' }
      },
      list: [{ password: 'password-secret' }, { content: 'ordinary content' }]
    };

    const sanitized = sanitizeDiagnosticData(input, 'operational') as Record<string, unknown>;

    expect(JSON.stringify(sanitized)).not.toContain('top-secret');
    expect(JSON.stringify(sanitized)).not.toContain('sk-test-secret');
    expect(JSON.stringify(sanitized)).not.toContain('password-secret');
    expect(input.request.headers.Authorization).toBe('Bearer top-secret');
    expect(input.list[1].content).toBe('ordinary content');
    expect(String((sanitized.request as Record<string, unknown>).arguments)).toContain('[Object, sha256:');
  });

  it('should preserve replay content while retaining the basic secret boundary', () => {
    const input = {
      content: 'replay body',
      result: { text: 'tool result' },
      token: 'must-not-be-written'
    };

    const sanitized = sanitizeDiagnosticData(input, 'replay') as Record<string, unknown>;

    expect(sanitized.content).toBe('replay body');
    expect(sanitized.result).toEqual({ text: 'tool result' });
    expect(sanitized.token).toBe('[REDACTED]');
  });

  it('should apply built-in and custom patterns, then clean JSONL separators', () => {
    const sanitized = sanitizeDiagnosticData(
      'url=https://user:secret@example.com\ncustom=customer-secret\r\nBearer abcdefghijkl ghp_abcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrstuvwxyz',
      'audit',
      { customPatterns: ['customer-secret'] }
    );

    expect(sanitized).toContain('https://[REDACTED]@example.com\\n');
    expect(sanitized).toContain('custom=[REDACTED]\\n');
    expect(sanitized).not.toContain('customer-secret');
    expect(sanitized).not.toContain('Bearer abcdefghijkl');
    expect(sanitized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(sanitized).not.toContain('github_pat_abcdefghijklmnopqrstuvwxyz');
  });

  it('should summarize oversized strings and arrays', () => {
    const sanitized = sanitizeDiagnosticData(
      { content: 'x'.repeat(20), values: [1, 2, 3, 4] },
      'replay',
      { maxStringLength: 10, maxArrayItems: 2 }
    ) as Record<string, unknown>;

    expect(sanitized.content).toContain('[String: 20 chars');
    expect(sanitized.values).toBe('[Array: 4 items]');
  });

  it('should tolerate Error objects and circular inputs without leaking values', () => {
    const error = new Error('request failed with token=error-secret');
    const circular: Record<string, unknown> = { error };
    circular.self = circular;

    const sanitized = sanitizeDiagnosticData(circular, 'operational') as Record<string, unknown>;
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('error-secret');
    expect(serialized).toContain('[Circular]');
    expect((sanitized.error as Record<string, unknown>).message).toContain('[REDACTED]');
  });

  it('should reject unsupported custom patterns without exposing the pattern text', () => {
    expect(() => validateDiagnosticPatterns(['['])).toThrow('合法正则');
    expect(() => validateDiagnosticPatterns(new Array(21).fill('safe'))).toThrow('安全上限');
  });

  it('should produce a stable irreversible digest for audit summaries', () => {
    expect(digestDiagnosticValue({ value: 'same' })).toBe(digestDiagnosticValue({ value: 'same' }));
    expect(digestDiagnosticValue({ value: 'same' })).not.toBe(digestDiagnosticValue({ value: 'different' }));
  });
});
