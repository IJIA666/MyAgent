/**
 * 智能体沙箱基础安全控制与路径验证模块。
 * 负责授权工作区的全局初始化与获取，提供防范路径遍历与符号链接越权攻击的安全路径解析核心校验器。
 */

import { resolve, sep, dirname } from 'path';
import { realpathSync, existsSync } from 'fs';
import type { SessionEventPort } from '../../../ports/driven/session/SessionEventPort.js';
import type { ToolExecutionContext } from '../../../core/usecases/plugins/plugin-types.js';

/**
 * 授权工作区的绝对物理路径。
 * 通过 initWorkspace() 延迟物理初始化，锁定真实的物理真实路径。
 */
let authorizedDir: string | null = null;

export function getAuthorizedDir(): string | null {
  return authorizedDir;
}

/**
 * 将一个可能存在或不存在的路径，通过对其最接近的已存在祖先目录执行 realpathSync，
 * 解析并还原出其真实的物理绝对路径。用来抵御基于符号链接和挂载点的沙箱越界逃逸。
 * 
 * @param target - 具有潜在风险的目标文件或目录路径
 * @returns 还原出的真实物理绝对路径
 */
export function getPhysicalRealPath(target: string): string {
  let current = resolve(target);
  const parts: string[] = [];
  
  // 循环向上寻找在磁盘上确实存在的祖先节点
  while (!existsSync(current)) {
    const parent = dirname(current);
    // 如果到达了根目录，直接跳出以防死循环
    if (parent === current) {
      break;
    }
    // 记录未创建的子路径部分
    parts.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  
  // 对已存在的祖先节点执行物理 realpathSync 解析以追踪符号链接
  const resolvedParent = realpathSync(current);
  
  // 将未创建 of 子路径拼回到解析后的物理祖先路径上
  return parts.length > 0 ? resolve(resolvedParent, ...parts) : resolvedParent;
}

/**
 * 初始化授权工作区路径。
 * 在应用启动阶段由 index.ts 调用一次，强制将其转换为物理真实绝对路径。
 *
 * @param rootDir - 工作区配置路径
 */
export function initWorkspace(rootDir: string): void {
  // 强制通过 getPhysicalRealPath 对工作区根目录进行符号链接展开与物理定位
  authorizedDir = getPhysicalRealPath(rootDir);
}
/**
 * 检查指定路径是否已存在于临时只读白名单中。
 * @param pathStr - 待检查的物理路径
 * @param sessionContext - 可选的会话事件只读契约
 * @returns 是否在白名单中
 */
export function hasTemporaryReadWhitelist(pathStr: string, sessionContext?: SessionEventPort): boolean {
  return sessionContext ? sessionContext.hasTemporaryReadWhitelist(pathStr) : false;
}

/**
 * 检查指定路径是否已存在于临时可写白名单中。
 * @param pathStr - 待检查的物理路径
 * @param sessionContext - 可选的会话事件只读契约
 * @returns 是否在白名单中
 */
export function hasTemporaryWriteWhitelist(pathStr: string, sessionContext?: SessionEventPort): boolean {
  return sessionContext ? sessionContext.hasTemporaryWriteWhitelist(pathStr) : false;
}

/**
 * 判定目标物理路径是否在授权目录安全防护边界内。
 * 针对 Windows 平台下文件或目录尚未创建时（ realpathSync 无法对未存在子目录完全大小写对齐 ）导致的盘符或大小写不一致进行不敏感兼容判定。
 *
 * @param parent - 授权工作区的绝对物理路径
 * @param child - 经过规范化后的绝对物理路径
 * @returns 是否在边界内
 */
function isSubPath(parent: string, child: string): boolean {
  if (process.platform === 'win32') {
    const p = parent.toLowerCase();
    const c = child.toLowerCase();
    return c === p || c.startsWith(p + sep);
  }
  return child === parent || child.startsWith(parent + sep);
}

/**
 * 路径沙箱保护机制核心校验器。
 * 对给定的文件路径进行物理规范化处理，并依据受限边界进行硬隔离判定，
 * 从根本上杜绝潜在的路径遍历与符号链接挂载逃逸风险。
 * 
 * @param targetPath - 具有潜在风险的入参目标文件或目录路径
 * @returns 脱敏与清洗完毕的安全物理绝对路径
 * @throws 当工作区未初始化或路径试图打破授权保护区时抛出错误
 */
export function secureResolvePath(targetPath: string): string {
  // 防护检查：确保工作区已通过 initWorkspace() 完成初始化
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  // 基于工作区根目录和目标相对路径计算出物理真实的绝对路径
  const rawPath = resolve(authorizedDir, targetPath);
  const resolvedPath = getPhysicalRealPath(rawPath);

  // 加固判定：目标物理路径必须完全属于授权工作区，或在其子路径内
  const isAuthorized = isSubPath(authorizedDir, resolvedPath);
  if (!isAuthorized) {
    throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区的安全防护边界。`);
  }

  // 认证放行
  return resolvedPath;
}

/**
 * 文件只读操作安全路径校验器。
 * 接受 SessionEventPort（向后兼容）或 ToolExecutionContext。
 * 优先检查 call capability（access='read'），再检查 session 白名单，最后检查沙箱边界。
 *
 * @param targetPath - 待读取的目标相对或绝对路径
 * @param context - 可选的会话上下文（SessionEventPort）或工具调用执行上下文（ToolExecutionContext）
 * @returns 解析规范后的安全物理绝对路径
 */
export function secureResolveReadPath(targetPath: string, context?: SessionEventPort | ToolExecutionContext): string {
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  const rawPath = resolve(authorizedDir, targetPath);
  const resolvedPath = getPhysicalRealPath(rawPath);

  // 提取 SessionContext（兼容 ToolExecutionContext 包裹层和直接的 SessionEventPort）
  const sessionCtx = context
    ? ('toolCallId' in context ? (context as ToolExecutionContext).sessionContext : context as SessionEventPort)
    : undefined;

  // 0. 优先检查 ToolExecutionContext 的 call capability（access='read'）
  if (context && 'toolCallId' in context) {
    if ((context as ToolExecutionContext).sessionContext.hasClaimedResource((context as ToolExecutionContext).toolCallId, 'read', resolvedPath)) {
      return resolvedPath;
    }
  }

  // 1. 安全放行：如果目标物理路径已被临时授权加入只读白名单
  if (sessionCtx && typeof sessionCtx.hasTemporaryReadWhitelist === 'function' && sessionCtx.hasTemporaryReadWhitelist(resolvedPath)) {
    return resolvedPath;
  }

  // 2. 常规校验：判断是否在常规工作区授权边界内
  const isAuthorized = isSubPath(authorizedDir, resolvedPath);
  if (!isAuthorized) {
    throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区的安全防护边界。`);
  }

  return resolvedPath;
}

/**
 * 文件写入/修改操作安全路径校验器。
 * 接受 SessionEventPort（向后兼容）或 ToolExecutionContext。
 * 优先检查 call capability（access='write'），再检查 session 白名单，最后检查沙箱边界。
 *
 * @param targetPath - 待写入的目标相对或绝对路径
 * @param context - 可选的会话上下文（SessionEventPort）或工具调用执行上下文（ToolExecutionContext）
 * @returns 解析规范后的安全物理绝对路径
 */
export function secureResolveWritePath(targetPath: string, context?: SessionEventPort | ToolExecutionContext): string {
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  const rawPath = resolve(authorizedDir, targetPath);
  const resolvedPath = getPhysicalRealPath(rawPath);

  // 提取 SessionContext（兼容 ToolExecutionContext 包裹层和直接的 SessionEventPort）
  const sessionCtx = context
    ? ('toolCallId' in context ? (context as ToolExecutionContext).sessionContext : context as SessionEventPort)
    : undefined;

  // 0. 优先检查 ToolExecutionContext 的 call capability（access='write'）
  if (context && 'toolCallId' in context) {
    if ((context as ToolExecutionContext).sessionContext.hasClaimedResource((context as ToolExecutionContext).toolCallId, 'write', resolvedPath)) {
      return resolvedPath;
    }
  }

  // 1. 安全放行：如果目标物理路径已被临时授权加入可写白名单
  if (sessionCtx && typeof sessionCtx.hasTemporaryWriteWhitelist === 'function' && sessionCtx.hasTemporaryWriteWhitelist(resolvedPath)) {
    return resolvedPath;
  }

  // 2. 常规校验：判断是否在常规工作区授权边界内
  const isAuthorized = isSubPath(authorizedDir, resolvedPath);
  if (!isAuthorized) {
    throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区的安全防护边界。`);
  }

  return resolvedPath;
}
