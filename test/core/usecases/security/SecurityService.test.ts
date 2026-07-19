/**
 * @fileoverview SecurityService 的单元测试，验证会话级临时路径授权生命周期。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { SecurityService } from '../../../../src/core/usecases/security/SecurityService.js';

/** 跨平台统一 resolve，避免 Windows 正斜杠/反斜杠不一致 */
const r = (...segments: string[]): string => path.resolve(...segments);

describe('SecurityService', () => {
  beforeEach(() => {
    SecurityService.resetInstance();
  });

  afterEach(() => {
    SecurityService.resetInstance();
  });

  describe('内存临时读写路径白名单', () => {
    it('应能正确添加、校验及清空只读与可写临时路径', () => {
      const service = SecurityService.getInstance();
      const sessionId = 'test-session-id';
      
      const readPath = path.resolve('/test/workspace/read.ts');
      const writePath = path.resolve('/test/workspace/write.ts');

      expect(service.hasTemporaryReadWhitelist(sessionId, readPath)).toBe(false);
      expect(service.hasTemporaryWriteWhitelist(sessionId, writePath)).toBe(false);

      service.addTemporaryReadWhitelist(sessionId, readPath);
      service.addTemporaryWriteWhitelist(sessionId, writePath);

      expect(service.hasTemporaryReadWhitelist(sessionId, readPath)).toBe(true);
      expect(service.hasTemporaryWriteWhitelist(sessionId, writePath)).toBe(true);

      // 并发会话隔离性校验：跨会话的 other-session 应无权限
      expect(service.hasTemporaryReadWhitelist('other-session', readPath)).toBe(false);

      service.clearTemporaryWhitelists(sessionId);
      expect(service.hasTemporaryReadWhitelist(sessionId, readPath)).toBe(false);
      expect(service.hasTemporaryWriteWhitelist(sessionId, writePath)).toBe(false);
    });
  });

  describe('目录范围只读白名单子树匹配', () => {
    /** 任务 6.1：批准 listFiles("abc") 的 session 后，再访问 abc/def 不再触发审批 */
    it('(6.1) 目录子树授权后子目录应自动放行', () => {
      const service = SecurityService.getInstance();
      const sessionId = 'ds-test-1';
      const dirRoot = r('/workspace/projects');

      // 模拟 listFiles("abc") 的 session 授权
      service.addTemporaryDirectoryScopeReadWhitelist(sessionId, dirRoot);

      // 同一子树下的路径应命中
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects/sub'))).toBe(true);
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects/sub/deep'))).toBe(true);
      // 根路径自身也应命中
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects'))).toBe(true);
    });

    /** 任务 6.2：批准 listFiles("abc") 后，访问兄弟目录 abd 仍需审批 */
    it('(6.2) 兄弟目录不应被目录范围授权覆盖', () => {
      const service = SecurityService.getInstance();
      const sessionId = 'ds-test-2';

      service.addTemporaryDirectoryScopeReadWhitelist(sessionId, r('/workspace/projects/a'));
      // 兄弟目录 b 不应命中
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects/b'))).toBe(false);
      // 父级目录也不应命中
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects'))).toBe(false);
    });

    /** 任务 6.3：目录范围读可复用到 readFile("abc/file.txt") */
    it('(6.3) 目录范围授权应覆盖子树内的文件读取', () => {
      const service = SecurityService.getInstance();
      const sessionId = 'ds-test-3';

      service.addTemporaryDirectoryScopeReadWhitelist(sessionId, r('/workspace/projects'));
      // 子树内的文件应命中读白名单
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects/sub/a.txt'))).toBe(true);
    });

    /** 任务 6.4：目录范围读不能复用于任何写操作 */
    it('(6.4) 写白名单不应受目录范围读授权影响', () => {
      const service = SecurityService.getInstance();
      const sessionId = 'ds-test-4';

      service.addTemporaryDirectoryScopeReadWhitelist(sessionId, r('/workspace/projects'));
      // 写检查应仍然返回 false
      expect(service.hasTemporaryWriteWhitelist(sessionId, r('/workspace/projects/sub/a.txt'))).toBe(false);
      expect(service.hasTemporaryWriteWhitelist(sessionId, r('/workspace/projects'))).toBe(false);
    });

    /** 任务 6.5：软链接或真实路径跳出授权目录时不得误命中 */
    it('(6.5) 真实路径跳出授权根时不得误命中', () => {
      const service = SecurityService.getInstance();
      const sessionId = 'ds-test-5';

      service.addTemporaryDirectoryScopeReadWhitelist(sessionId, r('/workspace/projects'));
      // 路径前缀相似但实际是独立路径，不应命中
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects-other'))).toBe(false);
      // 完全不相关的路径
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/other/path'))).toBe(false);
    });

    /** 任务 6.6：once 不得产生目录范围授权（验证从未调用 addTemporaryDirectoryScopeReadWhitelist 的场景） */
    it('(6.6) 未授予目录范围授权的会话不应有目录范围放行', () => {
      const service = SecurityService.getInstance();
      const sessionId = 'ds-test-6';

      // 模拟 once 场景：仅添加精确路径读白名单
      service.addTemporaryReadWhitelist(sessionId, r('/workspace/projects/file.txt'));

      // 同目录其他文件不应放行
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects/other.txt'))).toBe(false);
      // 子目录也不应放行
      expect(service.hasTemporaryReadWhitelist(sessionId, r('/workspace/projects/sub/file.txt'))).toBe(false);
    });
  });
});
