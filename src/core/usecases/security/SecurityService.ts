import { resolve, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../../utils/logger.js'; // 导入统一日志单例 logger

/**
 * 命令安全白名单及访问控制服务。
 * 全局单例，接管对 `.agent/allowed_commands.json` 磁盘文件的读取、内存缓存与持久化写入。
 */
export class SecurityService {
  private static instance: SecurityService | null = null;
  private securityAllowlist: string[] = [];
  private readonly filePath: string;

  private constructor(configPath?: string) {
    this.filePath = configPath ? resolve(configPath) : resolve(process.cwd(), '.agent/allowed_commands.json');
    this.loadSecurityAllowlist();
  }

  /**
   * 获取 SecurityService 的全局单例实例。
   *
   * @param configPath - 可选的配置文件重定向路径（主要供单元测试使用）
   * @returns 安全服务单例实例
   */
  public static getInstance(configPath?: string): SecurityService {
    if (!SecurityService.instance) {
      SecurityService.instance = new SecurityService(configPath);
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

  /**
   * 从工作区磁盘配置文件中重载命令安全白名单。
   *
   * @returns 最新加载的白名单规则列表
   */
  public loadSecurityAllowlist(): string[] {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, 'utf-8');
        this.securityAllowlist = JSON.parse(data) as string[];
        return this.securityAllowlist;
      }
    } catch {
      // 忽略文件读取异常，回退为空列表
    }
    this.securityAllowlist = [];
    return [];
  }

  /**
   * 将更新后的安全命令白名单持久化存盘，并更新内存缓存。
   *
   * @param commands - 新的白名单规则列表
   */
  public saveSecurityAllowlist(commands: string[]): void {
    try {
      this.securityAllowlist = commands;
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(commands, null, 2), 'utf-8');
    } catch (err) {
      logger.error('保存命令安全白名单至磁盘失败:', err);
    }
  }

  /**
   * 获取当前有效的安全命令白名单列表。
   * 若内存缓存为空，则触发一次磁盘加载。
   *
   * @returns 安全命令白名单列表
   */
  public getSecurityAllowlist(): string[] {
    if (this.securityAllowlist.length === 0) {
      this.loadSecurityAllowlist();
    }
    return this.securityAllowlist;
  }

  // 内存缓存的临时只读绝对路径白名单，Key 为 sessionId
  private temporaryReadWhitelist = new Map<string, Set<string>>();
  // 内存缓存的临时可写绝对路径白名单，Key 为 sessionId
  private temporaryWriteWhitelist = new Map<string, Set<string>>();

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
   * 检查指定路径是否已存在于指定会话的临时只读白名单中。
   *
   * @param sessionId - 会话唯一标识
   * @param pathStr - 待检查的物理路径
   * @returns 是否在白名单中
   */
  public hasTemporaryReadWhitelist(sessionId: string, pathStr: string): boolean {
    const list = this.temporaryReadWhitelist.get(sessionId);
    return list ? list.has(resolve(pathStr)) : false;
  }

  /**
   * 检查指定路径是否已存在于指定会话的临时可写白名单中。
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
   * 清空内存中指定会话所暂存的所有临时读写白名单。
   *
   * @param sessionId - 会话唯一标识
   */
  public clearTemporaryWhitelists(sessionId: string): void {
    this.temporaryReadWhitelist.delete(sessionId);
    this.temporaryWriteWhitelist.delete(sessionId);
  }
}
