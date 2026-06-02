import { SessionManager } from './brain/index.js';
import { McpToolManager, initWorkspace } from './action/index.js';
import { loadConfig } from './config/index.js';
import { startCli } from './interface/index.js';

const COLOR_RESET = '\x1b[0m';
const COLOR_GRAY = '\x1b[90m';
const COLOR_RED = '\x1b[31m';
const COLOR_GREEN = '\x1b[32m';

/**
 * 负责初始化环境、加载会话管理器（SessionManager）等核心依赖装配，并启动主界面。
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
    const mcpManager = new McpToolManager(appConfig.mcp);
    await mcpManager.connectAll();
    session = new SessionManager(appConfig.llm, mcpManager);
  } catch (initError: unknown) {
    const errorMsg = initError instanceof Error ? initError.message : String(initError);
    console.log(`${COLOR_RED}[错误] 初始化会话管理器失败：${errorMsg}${COLOR_RESET}`);
    process.exit(1);
  }

  // 5. 将会话实例注入 Interface 层，启动终端应用
  startCli(session);
}

// 启动主程序
main().catch((err) => {
  console.error(`${COLOR_RED}致命错误：${COLOR_RESET}`, err);
  process.exit(1);
});
