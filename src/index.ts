import { SessionManager } from './brain/index.js';
import { McpToolManager, initWorkspace } from './action/index.js';
import { loadConfig, ensureConfigFiles } from './config/index.js';
import { startCli } from './interface/index.js';
import { theme } from './utils/theme.js';

/**
 * 负责初始化环境、加载会话管理器（SessionManager）等核心依赖装配，并启动主界面。
 */
async function main() {
  console.clear();

  // 1. 文件引导：确保配置文件存在
  ensureConfigFiles();

  // 2. 统一加载全部配置（dotenv → 必填校验 → MCP 加载 → 冻结）
  const appConfig = loadConfig();

  // 2. 初始化工作区沙箱路径
  initWorkspace(appConfig.workspace);

  // 3. 打印系统启动与配置信息，在 Banner 中追加展示当前的上下文窗口总大小限制
  const banner = `====================================================
[系统] IJIA Agent 启动完成
[配置] 授权工作区目录：${appConfig.workspace}
[配置] 模型：${appConfig.llm.model}
[配置] 上下文窗口限制：${appConfig.llm.contextWindow?.toLocaleString() ?? '未知'} tokens
[配置] 接口端点：${appConfig.llm.baseUrl}
====================================================`;
  console.log(theme.success(banner));
  console.log(theme.info('[监控] 交互追踪仪 (Tracer) 已就绪，快照将实时落盘。'));
  console.log(theme.dim('系统就绪，输入 "exit" 退出当前会话。\n'));

  // 4. 实例化核心会话组件
  let session: SessionManager;
  try {
    const mcpManager = new McpToolManager(appConfig.mcp);
    await mcpManager.connectAll();
    session = new SessionManager(appConfig.llm, mcpManager);
  } catch (initError: unknown) {
    const errorMsg = initError instanceof Error ? initError.message : String(initError);
    console.log(theme.error(`[错误] 初始化会话管理器失败：${errorMsg}`));
    process.exit(1);
  }

  // 5. 将会话实例注入 Interface 层，启动终端应用
  startCli(session);
}

// 启动主程序
main().catch((err) => {
  console.error(theme.error('致命错误：'), err);
  process.exit(1);
});
