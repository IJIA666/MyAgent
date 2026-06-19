/* eslint-disable n/no-process-env */
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * 浏览器检测辅助工具类。
 * 核心职责：
 * 1. 扫描操作系统中的常规安装路径，探测本地 Google Chrome 或 Microsoft Edge 浏览器的可执行文件路径；
 * 2. 优先复用系统自带浏览器，避免强制下载大体积的 Chromium 内核，提高智能体首次启动体验。
 */
export class BrowserDetector {
  /**
   * Windows 系统下的 Chrome 和 Edge 常见安装路径列表。
   */
  private static readonly WINDOWS_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.USERPROFILE || '', 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];

  /**
   * macOS 系统下的 Chrome 和 Edge 常见安装路径列表。
   */
  private static readonly MACOS_PATHS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];

  /**
   * Linux 系统下的 Chrome、Chromium 和 Edge 常见安装路径列表。
   */
  private static readonly LINUX_PATHS = [
    '/usr/bin/google-chrome',
    '/usr/bin/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge'
  ];

  /**
   * 自动探测本地常规浏览器的可执行文件路径。
   * 按照优先级从高到低依次检测：
   * 1. 环境变量 BROWSER_EXECUTABLE_PATH 指定的自定义路径；
   * 2. 本地系统中的常规 Google Chrome 或 Microsoft Edge 路径。
   *
   * @returns 查找到的浏览器可执行文件绝对路径，若未找到则返回 null
   */
  public static detectExecutablePath(): string | null {
    // 1. 优先读取用户配置的环境变量重写项
    const envPath = process.env.BROWSER_EXECUTABLE_PATH;
    if (envPath && existsSync(envPath)) {
      return envPath;
    }

    // 2. 针对不同平台分发检测
    const platform = process.platform;
    const searchPaths = platform === 'win32'
      ? this.WINDOWS_PATHS
      : platform === 'darwin'
        ? this.MACOS_PATHS
        : this.LINUX_PATHS;

    // 3. 循环遍历常规路径，返回首个存在的浏览器路径
    for (const path of searchPaths) {
      if (path && existsSync(path)) {
        return path;
      }
    }

    return null;
  }
}
