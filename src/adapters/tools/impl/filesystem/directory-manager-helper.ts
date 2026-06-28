/**
 * @file 目录递归复制辅助算法模块。
 * 核心职责：提供跨平台、安全的文件夹/文件递归深度拷贝逻辑。
 */

import { mkdirSync, existsSync, statSync, readdirSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * 递归复制文件或目录的辅助函数。
 * 
 * @param src - 源物理绝对路径
 * @param dest - 目标物理绝对路径
 */
export function copyRecursiveSync(src: string, dest: string): void {
  const stats = statSync(src);
  if (stats.isDirectory()) {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }
    const children = readdirSync(src);
    for (const child of children) {
      copyRecursiveSync(join(src, child), join(dest, child));
    }
  } else {
    const parentDir = dirname(dest);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    copyFileSync(src, dest);
  }
}
