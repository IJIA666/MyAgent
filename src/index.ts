import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from './session.js';

// 集中定义 ANSI 控制台颜色代码，打造高品质的高级终端视效
const COLOR_RESET = '\x1b[0m';
const COLOR_CYAN = '\x1b[36m';   // 用户提示符使用青色
const COLOR_MAGENTA = '\x1b[35m';// Agent 自然回复使用洋红色
const COLOR_YELLOW = '\x1b[33m'; // Tools 工具运行状态使用黄色
const COLOR_GRAY = '\x1b[90m';   // 思考过程回显使用灰色
const COLOR_RED = '\x1b[31m';    // 错误信息回显使用红色
const COLOR_GREEN = '\x1b[32m';  // 欢迎界面及成功状态使用绿色

/**
 * 自动检测并初始化本地开发环境所需的最小配置。
 * 若检测到本地缺少 .env 配置文件，将自动基于 .env.example 复制一份，
 * 引导用户配置其专有的大模型 API Key。
 */
function ensureDotEnvExists(): void {
  const envPath = path.resolve('.env');
  const examplePath = path.resolve('.env.example');

  // 如果 .env 不存在且 .env.example 存在，自动为其生成
  if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
    console.log(`${COLOR_YELLOW}[系统] 检测到缺少 .env 配置文件。正在从 .env.example 自动复制生成...${COLOR_RESET}`);
    fs.copyFileSync(examplePath, envPath);
    console.log(`${COLOR_GREEN}[系统] 成功创建 ".env" 配置文件。如果需要，请在文件中更新您的大模型 API Key。${COLOR_RESET}\n`);
  }
}

/**
 * 极简 Agent 命令行主控入口函数。
 * 负责组装会话管理器、初始化控制台 readline REPL 接口，
 * 并提供打字机级的高颜值纯中文状态回显。
 */
async function main() {
  console.clear();

  // 1. 确保环境变量配置文件就绪
  ensureDotEnvExists();

  const workspaceRoot = path.resolve(process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd());

  // 2. 打印极具仪式感和高品质的终端欢迎横幅（全中文呈现）
  console.log(`${COLOR_GREEN}====================================================`);
  console.log(`🤖  欢迎使用 IJIA Agent`);
  console.log(`🏠  授权工作区根目录：${workspaceRoot}`);
  console.log(`⚙️   模型与 API 端点均通过本地 .env 进行动态配置`);
  console.log(`====================================================${COLOR_RESET}`);
  console.log(`${COLOR_GRAY}输入 "exit" 或 "quit" 可随时退出会话。\n${COLOR_RESET}`);

  // 3. 实例化会话管理器
  let session: SessionManager;
  try {
    session = new SessionManager();
  } catch (initError: any) {
    console.log(`${COLOR_RED}[错误] 初始化会话管理器失败：${initError.message}${COLOR_RESET}`);
    process.exit(1);
  }

  // 4. 创建 readline 接口以捕获终端标准输入输出
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${COLOR_CYAN}用户 > ${COLOR_RESET}`
  });

  // 触发第一轮输入提示符
  rl.prompt();

  // 5. 监听输入流的行输入事件，展开多轮交互 REPL 循环
  rl.on('line', async (line) => {
    const input = line.trim();

    // 如果用户输入退出指令，优雅清理并结束进程
    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log(`\n${COLOR_GREEN}[系统] 正在关闭会话。再见！${COLOR_RESET}`);
      rl.close();
      process.exit(0);
    }

    // 忽略空白行输入
    if (!input) {
      rl.prompt();
      return;
    }

    // 将用户输入加入内存会话历史中
    session.addUserMessage(input);

    try {
      // 触发 Agent 思考-行动大轮转逻辑，注入精细化状态显示回调
      const agentReply = await session.chat((status) => {
        switch (status.type) {
          case 'thinking':
            // 灰度回显思考状态
            process.stdout.write(`${COLOR_GRAY}[智能体] 正在思考中...${COLOR_RESET}\r`);
            break;
          case 'tool_call':
            // 擦除之前的思考提示，并高亮打印当前的工具调用信息
            process.stdout.write(' '.repeat(60) + '\r');
            console.log(`${COLOR_YELLOW}⚙️  [智能体动作] ${status.detail}${COLOR_RESET}`);
            break;
          case 'tool_response':
            // 灰度回显工具操作反馈
            console.log(`${COLOR_GRAY}📥 [智能体沙箱] ${status.detail}${COLOR_RESET}`);
            break;
          case 'error':
            // 红色回显报错信息（如沙箱拦截警报）
            console.log(`${COLOR_RED}⚠️  [智能体警报] ${status.detail}${COLOR_RESET}`);
            break;
        }
      });

      // 清除多余行，并以高品味洋红色输出 Agent 的最终回复文本
      process.stdout.write(' '.repeat(60) + '\r');
      console.log(`\n${COLOR_MAGENTA}智能体 >${COLOR_RESET} ${agentReply}\n`);

    } catch (error: any) {
      // 捕获 API 级或网络等全局不可抗力错误，友好输出
      process.stdout.write(' '.repeat(60) + '\r');
      console.log(`\n${COLOR_RED}⚠️  [智能体错误] ${error.message}${COLOR_RESET}\n`);
    }

    // 继续下一轮对话循环
    rl.prompt();
  });

  // 监听 Ctrl+C 等终端退出信号
  rl.on('SIGINT', () => {
    console.log(`\n${COLOR_GREEN}[系统] 正在关闭会话。再见！${COLOR_RESET}`);
    rl.close();
    process.exit(0);
  });
}

// 启动主程序
main().catch((err) => {
  console.error(`${COLOR_RED}致命错误：${COLOR_RESET}`, err);
  process.exit(1);
});
