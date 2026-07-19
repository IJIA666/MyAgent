import { resolve, relative } from 'path';

/**
 * 会话级临时文件访问授权服务。
 * 权限规则持久化由 PermissionRuleStore 和 PermissionSettingsStore 负责。
 */
export class SecurityService {
  private static instance: SecurityService | null = null;

  private constructor() {}

  /**
   * 获取 SecurityService 的全局单例实例。
   *
   * @returns 安全服务单例实例
   */
  public static getInstance(): SecurityService {
    if (!SecurityService.instance) {
      SecurityService.instance = new SecurityService();
    }
    return SecurityService.instance;
  }

  /**
   * 重置 SecurityService 的单例状态（仅供单元测试清理环境使用）。
   * @internal
   */
  public static resetInstance(): void {
    SecurityService.instance = null;
  }

  // 内存缓存的临时只读绝对路径白名单，Key 为 sessionId
  private temporaryReadWhitelist = new Map<string, Set<string>>();
  // 内存缓存的临时可写绝对路径白名单，Key 为 sessionId
  private temporaryWriteWhitelist = new Map<string, Set<string>>();
  // 内存缓存的目录范围只读白名单，存放经过 getPhysicalRealPath 解析的目录树根路径，Key 为 sessionId
  private temporaryDirectoryScopeReadWhitelist = new Map<string, Set<string>>();

  /**
   * 将指定物理绝对路径加入指定会话的临时只读白名单。
   *
   * @param sessionId - 会话唯一标识
   * @param pathStr - 物理绝对路径
   */
  public addTemporaryReadWhitelist(sessionId: string, pathStr: string): void {
    if (!this.temporaryReadWhitelist.has(sessionId)) {
      this.temporaryReadWhitelist.set(sessionId, new Set());
    }
    this.temporaryReadWhitelist.get(sessionId)!.add(resolve(pathStr));
  }

  /**
   * 将指定物理绝对路径加入指定会话的临时可写白名单。
   *
   * @param sessionId - 会话唯一标识
   * @param pathStr - 物理绝对路径
   */
  public addTemporaryWriteWhitelist(sessionId: string, pathStr: string): void {
    if (!this.temporaryWriteWhitelist.has(sessionId)) {
      this.temporaryWriteWhitelist.set(sessionId, new Set());
    }
    this.temporaryWriteWhitelist.get(sessionId)!.add(resolve(pathStr));
  }

  /**
   * 将指定目录根路径加入指定会话的目录范围只读白名单。
   * 该目录及其所有递归子路径的读操作将被自动放行。
   *
   * @param sessionId - 会话唯一标识
   * @param dirRoot - 经物理路径归一化的目录根路径
   */
  public addTemporaryDirectoryScopeReadWhitelist(sessionId: string, dirRoot: string): void {
    if (!this.temporaryDirectoryScopeReadWhitelist.has(sessionId)) {
      this.temporaryDirectoryScopeReadWhitelist.set(sessionId, new Set());
    }
    this.temporaryDirectoryScopeReadWhitelist.get(sessionId)!.add(resolve(dirRoot));
  }

  /**
   * 判断目标路径是否命中了指定会话的目录范围只读白名单中的某个授权根。
   * 基于 relative() 计算相对路径，判定目标是否位于授权根目录树内。
   *
   * @param sessionId - 会话唯一标识
   * @param targetPath - 待检查的物理绝对路径
   * @returns 是否命中任一目录范围授权根
   */
  private matchesDirectoryScopeReadWhitelist(sessionId: string, targetPath: string): boolean {
    const scopeRoots = this.temporaryDirectoryScopeReadWhitelist.get(sessionId);
    if (!scopeRoots || scopeRoots.size === 0) return false;

    const resolved = resolve(targetPath);
    for (const root of scopeRoots) {
      const rel = relative(root, resolved);
      // 相对路径为空（相同目录）或既不以 .. 开头也不是绝对路径 → 在目录树内
      if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !/^[a-zA-Z]:[/\\]/.test(rel))) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查指定路径是否已存在于指定会话的临时只读白名单中。
   * 先检查精确路径匹配，再回退到目录范围白名单的子树匹配。
   *
   * @param sessionId - 会话唯一标识
   * @param pathStr - 待检查的物理路径
   * @returns 是否在白名单中
   */
  public hasTemporaryReadWhitelist(sessionId: string, pathStr: string): boolean {
    const list = this.temporaryReadWhitelist.get(sessionId);
    if (list && list.has(resolve(pathStr))) return true;
    // 精确未命中时回退到目录范围子树匹配
    return this.matchesDirectoryScopeReadWhitelist(sessionId, pathStr);
  }

  /**
   * 检查指定路径是否已存在于指定会话的临时可写白名单中。
   * 写白名单不做目录范围匹配，始终保持精确路径授权。
   *
   * @param sessionId - 会话唯一标识
   * @param pathStr - 待检查的物理路径
   * @returns 是否在白名单中
   */
  public hasTemporaryWriteWhitelist(sessionId: string, pathStr: string): boolean {
    const list = this.temporaryWriteWhitelist.get(sessionId);
    return list ? list.has(resolve(pathStr)) : false;
  }

  /**
   * 清空内存中指定会话所暂存的所有临时读写白名单（含目录范围白名单）。
   *
   * @param sessionId - 会话唯一标识
   */
  public clearTemporaryWhitelists(sessionId: string): void {
    this.temporaryReadWhitelist.delete(sessionId);
    this.temporaryWriteWhitelist.delete(sessionId);
    this.temporaryDirectoryScopeReadWhitelist.delete(sessionId);
  }
}
