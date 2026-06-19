/**
 * @file 系统内置原生工具名称契约常量模块。
 * 核心职责：统一定义 Action 模块中所有内置原生工具在注册和大模型分发时的唯一标识名称，实现命名契约的 Action 模块内物理闭环。
 */

/**
 * 原生内置工具名称常量类。
 */
export class NativeToolNames {
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
  /** 技能载入工具名称 */
  public static readonly LOAD_SKILL = 'load_skill';
  /** 正则全文检索工具名称 */
  public static readonly GREP_SEARCH = 'grepSearch';
  /** 通配符文件检索工具名称 */
  public static readonly GLOB_SEARCH = 'globSearch';

  /** 目录创建工具名称 */
  public static readonly CREATE_DIRECTORY = 'createDirectory';
  /** 安全删除工具名称 */
  public static readonly DELETE_PATH = 'deletePath';
  /** 移动路径工具名称 */
  public static readonly MOVE_PATH = 'movePath';
  /** 复制路径工具名称 */
  public static readonly COPY_PATH = 'copyPath';
  /** 批量文件读取工具名称 */
  public static readonly READ_MANY_FILES = 'readManyFiles';
  /** 代码修补工具名称 */
  public static readonly APPLY_PATCH = 'applyPatch';
  /** Git状态查看工具名称 */
  public static readonly GIT_SHOW_STATUS = 'gitShowStatus';
  /** Git增量变化查看工具名称 */
  public static readonly GIT_SHOW_DIFF = 'gitShowDiff';
  /** Git提交日志查看工具名称 */
  public static readonly GIT_SHOW_LOG = 'gitShowLog';
}
