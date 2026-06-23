import * as path from 'path';
import { SessionManager } from './core/usecases/session.js';
import { McpToolManager, ToolRegistry, initWorkspace } from './adapters/tools/index.js';
import { loadConfig, ensureConfigFiles } from './config/index.js';
import { startCli } from './adapters/input/interface/index.js';
import { theme } from './adapters/input/interface/views/theme.js';
import { OpenAiLlmAdapter } from './adapters/llm/OpenAiLlmAdapter.js';
import { TiktokenEstimator } from './adapters/llm/TiktokenEstimator.js';
import { abortSessionTasks } from './adapters/tools/tools/system/terminal-engine.js';
import { DefaultContextAdapter } from './adapters/context/DefaultContextAdapter.js';
import { loadSkillContent } from './core/usecases/contextLoader.js';
import { OpenAiEmbeddingAdapter } from './adapters/llm/OpenAiEmbeddingAdapter.js';
import { LocalVectorDbAdapter } from './adapters/vectordb/LocalVectorDbAdapter.js';
import { initLogger, disposeLogger } from './utils/logger.js';

/**
 * 负责初始化环境、加载会话管理器（SessionManager）等核心依赖装配，并启动主界面。
 */
async function main() {
  await initLogger();
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
    const toolRegistry = new ToolRegistry(mcpManager, { loadSkill: loadSkillContent });
    const llmAdapter = new OpenAiLlmAdapter(appConfig.llm);
    const tokenEstimator = new TiktokenEstimator();
    const contextAdapter = new DefaultContextAdapter(tokenEstimator);
    const embeddingAdapter = new OpenAiEmbeddingAdapter(appConfig.llm);
    const vectorDbAdapter = new LocalVectorDbAdapter(
      path.resolve(appConfig.workspace, '.agent/lancedb'),
      path.resolve(appConfig.workspace, '.agent/vectordb.json')
    );
    session = new SessionManager(
      appConfig.llm,
      llmAdapter,
      tokenEstimator,
      toolRegistry,
      contextAdapter,
      vectorDbAdapter,
      embeddingAdapter,
      appConfig,
      abortSessionTasks
    );
  } catch (initError: unknown) {
    const errorMsg = initError instanceof Error ? initError.message : String(initError);
    console.log(theme.error(`[错误] 初始化会话管理器失败：${errorMsg}`));
    process.exit(1);
  }

  // 5. 将会话实例注入 Interface 层，启动终端应用
  startCli(session);
}

// 挂载进程退出监听器，在应用异步终止时强制执行日志刷盘
const handleExitSignal = async () => {
  try {
    await disposeLogger();
  } catch {
    // 忽略日志刷盘本身的失败，防止阻碍退出
  }
  process.exit(0);
};

process.on('SIGINT', handleExitSignal);
process.on('SIGTERM', handleExitSignal);

// 启动主程序
main().catch((err) => {
  console.error(theme.error('致命错误：'), err);
  process.exit(1);
});
