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
}
