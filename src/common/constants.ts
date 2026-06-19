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

  /** 终端工具判定别名集合 */
  public static readonly TERMINAL_ALIASES = [
    ToolConstants.EXECUTE_COMMAND,
    'bash',
    'run_command',
    'sh',
    'executeCommandTool'
  ] as const;

  /** 文件只读工具判定别名集合 */
  public static readonly FILE_READ_ALIASES = [
    ToolConstants.READ_FILE,
    ToolConstants.LIST_FILES,
    ToolConstants.READ_MANY_FILES,
    ToolConstants.GIT_SHOW_STATUS,
    ToolConstants.GIT_SHOW_DIFF,
    ToolConstants.GIT_SHOW_LOG,
    'read_file',
    'list_files',
    'readManyFiles',
    'gitShowStatus',
    'gitShowDiff',
    'gitShowLog'
  ] as const;

  /** 文件写入与修改工具判定别名集合 */
  public static readonly FILE_WRITE_ALIASES = [
    ToolConstants.WRITE_FILE,
    ToolConstants.EDIT_FILE,
    ToolConstants.CREATE_DIRECTORY,
    ToolConstants.DELETE_PATH,
    ToolConstants.MOVE_PATH,
    ToolConstants.COPY_PATH,
    ToolConstants.APPLY_PATCH,
    'write_file',
    'edit_file',
    'createDirectory',
    'deletePath',
    'movePath',
    'copyPath',
    'applyPatch'
  ] as const;
}
