/* eslint-disable n/no-process-env */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BrowserDetector } from '../../src/action/tools/browser/browser-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('BrowserDetector 浏览器检测辅助工具单元测试', () => {
  const tempFakeBrowserPath = resolve(__dirname, 'fake_chrome.exe');

  beforeAll(() => {
    // 写入一个临时空文件，模拟浏览器可执行文件
    writeFileSync(tempFakeBrowserPath, '');
  });

  afterAll(() => {
    // 清理临时文件
    if (existsSync(tempFakeBrowserPath)) {
      rmSync(tempFakeBrowserPath, { force: true });
    }
  });

  test('如果配置了 BROWSER_EXECUTABLE_PATH 且路径存在，应优先返回该路径', () => {
    const originalEnv = process.env.BROWSER_EXECUTABLE_PATH;
    process.env.BROWSER_EXECUTABLE_PATH = tempFakeBrowserPath;

    try {
      const detected = BrowserDetector.detectExecutablePath();
      expect(detected).toBe(tempFakeBrowserPath);
    } finally {
      // 还原环境变量
      if (originalEnv === undefined) {
        delete process.env.BROWSER_EXECUTABLE_PATH;
      } else {
        process.env.BROWSER_EXECUTABLE_PATH = originalEnv;
      }
    }
  });

  test('即使配置了 BROWSER_EXECUTABLE_PATH，但如果该路径不存在，仍应回退并扫描系统默认目录', () => {
    const originalEnv = process.env.BROWSER_EXECUTABLE_PATH;
    process.env.BROWSER_EXECUTABLE_PATH = 'C:\\non-existent-path-for-test\\chrome.exe';

    try {
      const detected = BrowserDetector.detectExecutablePath();
      // 这里不一定会是 null，如果运行此测试的系统已装有常规 Chrome/Edge，将返回系统路径；否则返回 null
      if (detected !== null) {
        expect(existsSync(detected)).toBe(true);
      }
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BROWSER_EXECUTABLE_PATH;
      } else {
        process.env.BROWSER_EXECUTABLE_PATH = originalEnv;
      }
    }
  });

  test('默认情况下进行自适应检测，检测结果应当为已存在的路径或 null', () => {
    const originalEnv = process.env.BROWSER_EXECUTABLE_PATH;
    delete process.env.BROWSER_EXECUTABLE_PATH;

    try {
      const detected = BrowserDetector.detectExecutablePath();
      if (detected !== null) {
        expect(existsSync(detected)).toBe(true);
      } else {
        expect(detected).toBeNull();
      }
    } finally {
      if (originalEnv !== undefined) {
        process.env.BROWSER_EXECUTABLE_PATH = originalEnv;
      }
    }
  });
});
