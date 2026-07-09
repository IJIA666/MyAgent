/**
 * @file 临时白名单访问契约。
 * 定义会话授权状态访问临时读写白名单所需的最小接口，解耦 SessionContext 与 SecurityService 单例。
 */
/**
 * 临时白名单访问接口。
 * 抽象 SessionContext 与 SecurityService 单例之间的桥接关系，
 * AuthorizationState 负责实现此接口，使会话对象不再直接调用 SecurityService.getInstance()。
 */
export interface TemporaryWhitelistAccess {
  /**
   * 检查指定路径是否处于当前会话的临时只读白名单中。
   *
   * @param sessionId - 会话唯一标识
   * @param path - 物理绝对路径
   * @returns 在白名单中返回 `true`
   */
  hasReadWhitelist(sessionId: string, path: string): boolean;

  /**
   * 检查指定路径是否处于当前会话的临时可写白名单中。
   *
   * @param sessionId - 会话唯一标识
   * @param path - 物理绝对路径
   * @returns 在白名单中返回 `true`
   */
  hasWriteWhitelist(sessionId: string, path: string): boolean;

  /**
   * 将指定路径加入当前会话的临时只读白名单。
   *
   * @param sessionId - 会话唯一标识
   * @param path - 物理绝对路径
   */
  addReadWhitelist(sessionId: string, path: string): void;

  /**
   * 将指定路径加入当前会话的临时可写白名单。
   *
   * @param sessionId - 会话唯一标识
   * @param path - 物理绝对路径
   */
  addWriteWhitelist(sessionId: string, path: string): void;

  /**
   * 将指定目录根路径加入当前会话的目录范围只读白名单。
   *
   * @param sessionId - 会话唯一标识
   * @param dirRoot - 经物理路径归一化的目录根路径
   */
  addDirectoryScopeReadWhitelist(sessionId: string, dirRoot: string): void;

  /**
   * 清空当前会话在内存中暂存的所有临时读写白名单。
   *
   * @param sessionId - 会话唯一标识
   */
  clearWhitelists(sessionId: string): void;
}
