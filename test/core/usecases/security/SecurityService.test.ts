/**
 * @fileoverview SecurityService 的单元测试，验证命令安全白名单、物理落盘及临时白名单生命周期。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SecurityService } from '../../../../src/core/usecases/security/SecurityService.js';

describe('SecurityService', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    SecurityService.resetInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-security-test-'));
    configPath = path.join(tempDir, 'allowed_commands.json');
  });

  afterEach(() => {
    SecurityService.resetInstance();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('持久化白名单命令控制', () => {
    it('应能在配置文件不存在时默认加载空列表', () => {
      const service = SecurityService.getInstance(configPath);
      const list = service.getSecurityAllowlist();
      expect(list).toEqual([]);
    });

    it('应能正确保存并更新持久化白名单，且懒加载功能生效', () => {
      const service = SecurityService.getInstance(configPath);
      const commands = ['git status', 'npm install'];
      
      service.saveSecurityAllowlist(commands);
      
      expect(fs.existsSync(configPath)).toBe(true);
      const fileData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(fileData).toEqual(commands);

      const serviceNew = SecurityService.getInstance(configPath);
      expect(serviceNew.getSecurityAllowlist()).toEqual(commands);
    });

    it('应在配置文件包含无效JSON时容错并回退为空数组', () => {
      fs.writeFileSync(configPath, 'invalid json {', 'utf-8');
      
      const service = SecurityService.getInstance(configPath);
      const list = service.loadSecurityAllowlist();
      expect(list).toEqual([]);
    });
  });

  describe('内存临时读写路径白名单', () => {
    it('应能正确添加、校验及清空只读与可写临时路径', () => {
      const service = SecurityService.getInstance(configPath);
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
});
