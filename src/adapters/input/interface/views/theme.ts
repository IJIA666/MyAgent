/**
 * @file 终端交互界面（CLI）的主题样式防腐层。
 * 集中管理所有的 ANSI 颜色常量的格式化包裹，与底层业务逻辑隔离。
 */

const COLOR_RESET = '\x1b[0m';
const COLOR_CYAN = '\x1b[36m';
const COLOR_MAGENTA = '\x1b[35m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_GRAY = '\x1b[90m';
const COLOR_RED = '\x1b[31m';
const COLOR_GREEN = '\x1b[32m';

export const theme = {
  /**
   * 成功、正常退出的系统级反馈（绿色）
   */
  success: (text: string) => `${COLOR_GREEN}${text}${COLOR_RESET}`,

  /**
   * 致命错误、异常中断提示（红色）
   */
  error: (text: string) => `${COLOR_RED}${text}${COLOR_RESET}`,

  /**
   * 弱化的后台反馈与大模型思考过程（灰色）
   */
  dim: (text: string) => `${COLOR_GRAY}${text}${COLOR_RESET}`,

  /**
   * 提示符、常规系统信息（青色）
   */
  info: (text: string) => `${COLOR_CYAN}${text}${COLOR_RESET}`,

  /**
   * 过渡态、强调（黄色）
   */
  highlight: (text: string) => `${COLOR_YELLOW}${text}${COLOR_RESET}`,

  /**
   * 警告、回退提示（黄色）
   */
  warning: (text: string) => `${COLOR_YELLOW}${text}${COLOR_RESET}`,

  /**
   * 人机协作黄色高亮提示（黄色）
   */
  intervention: (text: string) => `${COLOR_YELLOW}⚠️  [人机风控协作] ${text}${COLOR_RESET}`,

  /**
   * 系统响应边界（洋红色）
   */
  divider: (text: string) => `${COLOR_MAGENTA}${text}${COLOR_RESET}`
};

