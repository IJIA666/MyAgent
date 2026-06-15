/**
 * 智能体沙箱基础安全控制与路径验证模块。
 * 负责授权工作区的全局初始化与获取，提供防范路径遍历越权攻击的安全路径解析核心校验器。
 */

import { resolve, sep } from 'path';

/**
 * 授权工作区的绝对路径。
 * 通过 initWorkspace() 延迟初始化，不在模块加载阶段读取 process.env。
 */
let authorizedDir: string | null = null;

export function getAuthorizedDir(): string | null {
  return authorizedDir;
}

/**
 * 初始化授权工作区路径。
 * 在应用启动阶段由 index.ts 调用一次，后续不再变更。
 *
 * @param rootDir 已 resolve 的工作区绝对路径
 */
export function initWorkspace(rootDir: string): void {
  authorizedDir = resolve(rootDir);
}

/**
 * 路径沙箱保护机制核心校验器。
 * 对给定的文件路径进行解析与规范化处理，并依据受限边界进行硬隔离判定，
 * 从根本上杜绝潜在的路径遍历（Path Traversal）安全渗透风险。
 * 
 * @param targetPath 具有潜在风险的入参目标文件或目录路径
 * @returns 脱敏与清洗完毕的安全物理绝对路径
 * @throws 当工作区未初始化或路径试图打破授权保护区时抛出错误
 */
export function secureResolvePath(targetPath: string): string {
  // 防护检查：确保工作区已通过 initWorkspace() 完成初始化
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  // 基于安全边界生成规范化的拼接结果，该策略将隐性消除全部的偏移量标识（如 '..'）
  const resolvedPath = resolve(authorizedDir, targetPath);

  // 加固判定：目标路径必须完全等于授权工作区根目录，
  // 或者以授权工作区根目录加上系统路径分隔符开头（证明属于工作区内的直接子元素），
  // 从根本上防范类似于 /auth/path-secret 穿透 /auth/path 的逃逸隐患。
  const isAuthorized = resolvedPath === authorizedDir || resolvedPath.startsWith(authorizedDir + sep);
  if (!isAuthorized) {
    throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区的安全防护边界。`);
  }

  // 认证放行
  return resolvedPath;
}
