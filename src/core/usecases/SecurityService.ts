import { resolve, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

/**
 * 命令安全白名单及访问控制服务。
 * 全局单例，接管对 `.agent/allowed_commands.json` 磁盘文件的读取、内存缓存与持久化写入。
 */
export class SecurityService {
  private static instance: SecurityService | null = null;
  private securityAllowlist: string[] = [];
  private readonly filePath = resolve(process.cwd(), '.agent/allowed_commands.json');

  private constructor() {
    this.loadSecurityAllowlist();
  }

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
      console.error('保存命令安全白名单至磁盘失败:', err);
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

  // 内存缓存的临时只读绝对路径白名单
  private temporaryReadWhitelist = new Set<string>();
  // 内存缓存的临时可写绝对路径白名单
  private temporaryWriteWhitelist = new Set<string>();

  /**
   * 将指定物理绝对路径加入临时只读白名单。
   *
   * @param pathStr - 物理绝对路径
   */
  public addTemporaryReadWhitelist(pathStr: string): void {
    this.temporaryReadWhitelist.add(resolve(pathStr));
  }

  /**
   * 将指定物理绝对路径加入临时可写白名单。
   *
   * @param pathStr - 物理绝对路径
   */
  public addTemporaryWriteWhitelist(pathStr: string): void {
    this.temporaryWriteWhitelist.add(resolve(pathStr));
  }

  /**
   * 检查指定路径是否已存在于临时只读白名单中。
   *
   * @param pathStr - 待检查的物理路径
   * @returns 是否在白名单中
   */
  public hasTemporaryReadWhitelist(pathStr: string): boolean {
    return this.temporaryReadWhitelist.has(resolve(pathStr));
  }

  /**
   * 检查指定路径是否已存在于临时可写白名单中。
   *
   * @param pathStr - 待检查的物理路径
   * @returns 是否在白名单中
   */
  public hasTemporaryWriteWhitelist(pathStr: string): boolean {
    return this.temporaryWriteWhitelist.has(resolve(pathStr));
  }

  /**
   * 清空内存中暂存的所有临时读写白名单。
   */
  public clearTemporaryWhitelists(): void {
    this.temporaryReadWhitelist.clear();
    this.temporaryWriteWhitelist.clear();
  }
}
