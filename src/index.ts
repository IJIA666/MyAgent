import { createInterface } from 'readline';
import { SessionManager } from './session.js';
import { McpToolManager } from './mcp-client.js';
import { loadConfig } from './config/index.js';
import { initWorkspace } from './tools.js';
import { dispatchCommand } from './command.js';

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
  let rl: ReturnType<typeof createInterface>;

  const initRl = () => {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const updatePrompt = () => {
      rl.setPrompt(`${COLOR_CYAN}用户 [${session.getModelName()}] > ${COLOR_RESET}`);
    };

    // 首次渲染输入提示符
    updatePrompt();
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

      // 拦截 Slash Command，委托给独立路由模块处理
      if (input.startsWith('/')) {
        // 彻底关闭并解绑原有的 readline 监听，将 stdin 让渡给 @clack/prompts
        rl.close();
        try {
          await dispatchCommand(input, { session, rl });
        } finally {
          // 执行完毕后，重新初始化 REPL 并接管终端
          initRl();
        }
        return;
      }

      // 推进会话状态，记录用户侧输入记录
      session.addUserMessage(input);

      try {
        // 发起大模型推理请求，并消费产生的事件流
        let hasPrintedReasoning = false;
        let hasPrintedContent = false;

        for await (const event of session.chat()) {
          switch (event.type) {
            case 'thinking':
              if (!hasPrintedReasoning) {
                process.stdout.write(`\n${COLOR_GRAY}[思考过程]\n`);
                hasPrintedReasoning = true;
              }
              process.stdout.write(`${COLOR_GRAY}${event.content}${COLOR_RESET}`);
              break;
            case 'content':
              if (!hasPrintedContent) {
                if (hasPrintedReasoning) {
                  process.stdout.write('\n\n'); // 思考结束后空行
                }
                hasPrintedContent = true;
              }
              process.stdout.write(event.content);
              break;
            case 'tool_call_start':
              process.stdout.write(`\n\n${COLOR_CYAN}[⚡ 正在调用工具 "${event.functionName}"]${COLOR_RESET}\n`);
              console.log(`${COLOR_YELLOW}[调度参数] ${JSON.stringify(event.functionArgs)}${COLOR_RESET}`);
              break;
            case 'tool_call_result':
              console.log(`${COLOR_GRAY}[反馈] 工具 "${event.functionName}" 执行完毕，返回了 ${event.result.length} 字节的数据。${COLOR_RESET}`);
              break;
            case 'error':
              console.log(`${COLOR_RED}[异常] ${event.message}${COLOR_RESET}`);
              break;
          }
        }

        // 推理完成，向标准输出提交最终文本响应结果（新起一行避免拥挤）
        console.log(`\n\n${COLOR_MAGENTA}系统响应 >${COLOR_RESET} 完毕。\n`);

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
  };

  initRl();
}

// 启动主程序
main().catch((err) => {
  console.error(`${COLOR_RED}致命错误：${COLOR_RESET}`, err);
  process.exit(1);
});
