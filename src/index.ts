import { createInterface } from 'readline';
import { SessionManager } from './session.js';
import { McpToolManager } from './mcp-client.js';
import { loadConfig } from './config.js';
import { initWorkspace } from './tools.js';

/**
 * 定义 ANSI 终端颜色常量，用于区分不同状态输出的展示层级。
 */
const COLOR_RESET = '\x1b[0m';
const COLOR_CYAN = '\x1b[36m';
const COLOR_MAGENTA = '\x1b[35m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_GRAY = '\x1b[90m';
const COLOR_RED = '\x1b[31m';
const COLOR_GREEN = '\x1b[32m';

/**
 * 负责初始化环境、加载会话管理器（SessionManager），并建立基于 Readline 的 REPL 交互循环。
 */
async function main() {
  console.clear();

  // 1. 统一加载全部配置（文件引导 → dotenv → 必填校验 → MCP 加载 → 冻结）
  const appConfig = loadConfig();

  // 2. 初始化工作区沙箱路径
  initWorkspace(appConfig.workspace);

  // 3. 打印系统启动与配置信息
  console.log(`${COLOR_GREEN}====================================================`);
  console.log(`[系统] IJIA Agent 启动完成`);
  console.log(`[配置] 授权工作区目录：${appConfig.workspace}`);
  console.log(`[配置] 模型：${appConfig.llm.model}`);
  console.log(`[配置] 接口端点：${appConfig.llm.baseUrl}`);
  console.log(`====================================================${COLOR_RESET}`);
  console.log(`${COLOR_GRAY}系统就绪，输入 "exit" 退出当前会话。\n${COLOR_RESET}`);

  // 4. 实例化核心会话组件
  let session: SessionManager;
  try {
    // 通过依赖注入传递已加载的配置
    const mcpManager = new McpToolManager(appConfig.mcp);

    // 连接所有已配置的 MCP Server
    await mcpManager.connectAll();

    session = new SessionManager(appConfig.llm, mcpManager);
  } catch (initError: unknown) {
    const errorMsg = initError instanceof Error ? initError.message : String(initError);
    console.log(`${COLOR_RED}[错误] 初始化会话管理器失败：${errorMsg}${COLOR_RESET}`);
    process.exit(1);
  }

  // 5. 配置并启动终端交互接口
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${COLOR_CYAN}用户 > ${COLOR_RESET}`
  });

  // 首次渲染输入提示符
  rl.prompt();

  // 6. 事件监听器设定：处理用户输入并展开多轮交互
  rl.on('line', async (line) => {
    const input = line.trim();

    // 解析退出指令，提供安全终止流程
    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log(`\n${COLOR_GREEN}[系统] 进程正在终止，结束会话。${COLOR_RESET}`);
      rl.close();
      process.exit(0);
    }

    // 规避无意义交互触发
    if (!input) {
      rl.prompt();
      return;
    }

    // 推进会话状态，记录用户侧输入记录
    session.addUserMessage(input);

    try {
      // 发起大模型推理请求，并注册状态回调函数以向上层暴露执行生命周期
      const agentReply = await session.chat((status) => {
        switch (status.type) {
          case 'thinking':
            // 反馈推理等待状态
            process.stdout.write(`${COLOR_GRAY}[处理] 正在分析请求...${COLOR_RESET}\r`);
            break;
          case 'tool_call':
            // 暴露工具调用细节
            process.stdout.write(' '.repeat(60) + '\r');
            console.log(`${COLOR_YELLOW}[调度] ${status.detail}${COLOR_RESET}`);
            break;
          case 'tool_response':
            // 暴露工具执行后的数据状态
            console.log(`${COLOR_GRAY}[反馈] ${status.detail}${COLOR_RESET}`);
            break;
          case 'error':
            // 暴露非致命性异常日志（主要针对沙箱访问阻断的内部修正阶段）
            console.log(`${COLOR_RED}[异常] ${status.detail}${COLOR_RESET}`);
            break;
        }
      });

      // 推理完成，向标准输出提交最终文本响应结果
      process.stdout.write(' '.repeat(60) + '\r');
      console.log(`\n${COLOR_MAGENTA}系统响应 >${COLOR_RESET} ${agentReply}\n`);

    } catch (error: unknown) {
      // 兜底捕获并暴露全局致命级错误（例如网络阻断）
      const errorMsg = error instanceof Error ? error.message : String(error);
      process.stdout.write(' '.repeat(60) + '\r');
      console.log(`\n${COLOR_RED}[系统故障] ${errorMsg}${COLOR_RESET}\n`);
    }

    // 恢复控制权以接纳下一轮指令
    rl.prompt();
  });

  // 挂载进程强制中断事件处理
  rl.on('SIGINT', () => {
    console.log(`\n${COLOR_GREEN}[系统] 收到中断信号，程序退出。${COLOR_RESET}`);
    rl.close();
    process.exit(0);
  });
}

// 启动主程序
main().catch((err) => {
  console.error(`${COLOR_RED}致命错误：${COLOR_RESET}`, err);
  process.exit(1);
});
