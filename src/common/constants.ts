/**
 * 全局智能体核心契约常量定义。
 * 包含所有系统工具的公共标识名，由 action 模块与 brain 插件模块等跨模块全局共享。
 */
export class ToolConstants {
  private constructor() {} // 限制外部实例化行为

  /** 终端原子命令执行工具名称 */
  public static readonly EXECUTE_COMMAND = 'execute_command';
  /** 文件只读读取工具名称 */
  public static readonly READ_FILE = 'readFile';
  /** 文件覆盖写入工具名称 */
  public static readonly WRITE_FILE = 'writeFile';
  /** 文件夹子文件列举工具名称 */
  public static readonly LIST_FILES = 'listFiles';
  /** 文件增量编辑修改工具名称 */
  public static readonly EDIT_FILE = 'editFile';
}
