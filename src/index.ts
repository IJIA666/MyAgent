import { SessionManager } from './core/usecases/engine/session.js';
import {
  McpToolManager,
  PermissionSettingsStore,
  ToolRegistry,
  initWorkspace,
} from './adapters/tools/index.js';
import { loadConfig, ensureConfigFiles } from './config/index.js';
import { startCli } from './adapters/input/interface/index.js';
import { theme } from './adapters/input/interface/views/theme.js';
import { OpenAiLlmAdapter } from './adapters/llm/OpenAiLlmAdapter.js';
import { OpenAiLlmClientFactory } from './adapters/llm/OpenAiLlmClientFactory.js';
import { TiktokenEstimator } from './adapters/llm/TiktokenEstimator.js';
import { abortSessionTasks } from './adapters/tools/impl/system/terminal-engine.js';
import { setBrowserPaths } from './adapters/tools/impl/browser/browser-action.js';
import { DefaultContextAdapter } from './adapters/context/DefaultContextAdapter.js';
import { initLogger, configureFileSink, logger } from './utils/logger.js';
import { ensureAppDataRoot } from './config/application-paths.js';
import { detectLegacyLayout, warnLegacyLayout } from './config/legacy-layout-detector.js';
import { setSkillPaths, setSessionsDir } from './adapters/input/interface/command.js';
import { setSettingsRepository } from './adapters/tools/impl/system/terminal-config.js';
import { SkillUsageStore } from './core/usecases/brain/skill-usage-store.js';
import { SkillLibrary } from './core/usecases/brain/skill-library.js';
import {
  SkillPendingStore,
  SkillWriteApprovalController,
} from './core/usecases/brain/skill-pending-store.js';
import { SkillCuratorStateStore } from './core/usecases/brain/skill-curator-state-store.js';
import { SkillCuratorBackupStore } from './core/usecases/brain/skill-curator-backup.js';
import { SkillCurator } from './core/usecases/brain/skill-curator.js';
import { SkillCuratorReportStore } from './core/usecases/brain/skill-curator-report.js';
import { SubagentExecutionController } from './core/usecases/subagent/SubagentExecutionController.js';
import { SubagentDefinitionRegistry } from './core/usecases/subagent/SubagentDefinitionRegistry.js';
import { AgentDefinitionLoader } from './core/usecases/subagent/AgentDefinitionLoader.js';
import { parseAgentCliArg } from './cli-args.js';

/**
 * 负责初始化环境、加载会话管理器（SessionManager）等核心依赖装配，并启动主界面。
 */
async function main() {
  await initLogger();
  console.clear();

  // 0. 最小 CLI 参数解析：--agent <type>（未知 flag 忽略保持向后兼容）
  const agentCliType = parseAgentCliArg(process.argv);
  if (agentCliType) {
    console.log(theme.info(`[参数] 以子代理定义启动主会话: ${agentCliType}`));
  }

  // 1. 文件引导：确保配置文件存在
  ensureConfigFiles();

  // 2. 统一加载全部配置（dotenv → 必填校验 → MCP 加载 → 路径解析 → 冻结）
  const appConfig = loadConfig();

  // 3. 注入技能路径和会话路径到 CLI 命令模块
  setSkillPaths(
    appConfig.applicationPaths.userSkillsDir,
    appConfig.applicationPaths.projectSkillsDir,
  );
  setSessionsDir(appConfig.applicationPaths.sessionsDir);

  // 4. 确保用户应用数据根可创建；失败时输出错误并阻止持久化初始化，但允许继续显示 banner
  const dataRootReady = ensureAppDataRoot(appConfig.applicationPaths.userAppDataRoot);
  if (!dataRootReady) {
    console.error(`[错误] 用户应用数据根不可写: ${appConfig.applicationPaths.userAppDataRoot}`);
    console.error('[错误] 日志、会话、trace 等持久化功能不可用，无法继续初始化。');
    process.exit(1);
  }

  // 4. 注入终端配置的 SettingsRepository 和浏览器目录
  setSettingsRepository(appConfig.settingsRepository);
  setBrowserPaths(appConfig.applicationPaths.browserDir, appConfig.applicationPaths.screenshotsDir);

  // 5. 旧布局检测与警告
  const legacyInfo = detectLegacyLayout(appConfig.workspace);
  warnLegacyLayout(legacyInfo, appConfig.workspace);

  // 5. 配置文件日志 sink（两阶段初始化的第二阶段）
  await configureFileSink(appConfig.applicationPaths.logsDir);

  // 5. 初始化工作区沙箱路径与长期记忆目录
  const activeMemoryDirectory = appConfig.autoMemoryEnabled
    ? appConfig.autoMemoryDirectory ?? appConfig.applicationPaths.memoryDir
    : undefined;
  initWorkspace(
    appConfig.workspace,
    activeMemoryDirectory,
    appConfig.autoMemoryDirectory ? 'custom' : 'default',
    appConfig.autoMemoryDirectory ?? appConfig.applicationPaths.memoryDir,
  );

  // 6. 打印系统启动与配置信息，在 Banner 中追加展示当前的上下文窗口总大小限制
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
    const { LifecycleManager } = await import('./core/usecases/engine/LifecycleManager.js');
    LifecycleManager.register('mcp-manager', () => mcpManager.close());
    const { BrowserSession } = await import('./adapters/tools/impl/browser/browser-action.js');
    LifecycleManager.register('browser-session', () => BrowserSession.close());
    const permissionSettingsStore = new PermissionSettingsStore(appConfig.settingsRepository);

    // 构造共享 Skill 生命周期组件
    const skillUsageStore = new SkillUsageStore(appConfig.applicationPaths.skillUsagePath);
    const skillLibrary = new SkillLibrary(
      appConfig.applicationPaths.userSkillsDir,
      appConfig.applicationPaths.projectSkillsDir,
      appConfig.applicationPaths.skillArchiveDir,
      skillUsageStore,
      { skillLocksDir: appConfig.applicationPaths.skillLocksDir },
    );
    const skillPendingStore = new SkillPendingStore(
      appConfig.applicationPaths.skillPendingDir,
      skillLibrary,
    );
    const skillWriteApprovalController = new SkillWriteApprovalController(
      appConfig.skills.writeApproval,
    );
    const skillCuratorStateStore = new SkillCuratorStateStore(
      appConfig.applicationPaths.skillCuratorStatePath,
    );
    const skillCuratorBackupStore = new SkillCuratorBackupStore(
      appConfig.applicationPaths.userSkillsDir,
      appConfig.applicationPaths.skillArchiveDir,
      appConfig.applicationPaths.skillUsagePath,
      appConfig.applicationPaths.skillCuratorStatePath,
      appConfig.applicationPaths.skillCuratorBackupsDir,
      appConfig.curator.backup.keep,
    );
    const skillCuratorReportStore = new SkillCuratorReportStore(
      appConfig.applicationPaths.skillCuratorLogsDir,
    );
    const skillCurator = new SkillCurator(
      appConfig.curator,
      skillLibrary,
      skillUsageStore,
      skillCuratorStateStore,
      skillCuratorBackupStore,
      skillCuratorReportStore,
    );

    // 控制器先于 ToolRegistry 创建，Agent 工具只获得稳定端口；具体运行器稍后由 SessionManager 绑定。
    const subagentExecutionController = new SubagentExecutionController();
    const subagentLlmClientFactory = new OpenAiLlmClientFactory();

    // 子代理定义注册表：组合根创建唯一实例（内置 + user/project 自定义 Markdown 定义），
    // 类型快照写入 Agent 工具 schema，实例共享注入 SessionManager（运行器与协调器）。
    const subagentDefinitionRegistry = new SubagentDefinitionRegistry(
      appConfig.runtimeLimits.subagentForkEnabled,
      new AgentDefinitionLoader(
        appConfig.applicationPaths.userAgentsDir,
        appConfig.applicationPaths.projectAgentsDir,
      ),
    );
    // --agent 主线程定义解析：未知类型提示并回退默认行为（官方 warn 语义）。
    const mainAgentDefinition = agentCliType
      ? subagentDefinitionRegistry.resolve(agentCliType)
      : undefined;
    if (agentCliType && !mainAgentDefinition) {
      console.log(theme.warning(`[参数] 未找到子代理定义 "${agentCliType}"，使用默认会话行为`));
    }

    const toolRegistry = new ToolRegistry(mcpManager, {
      skillLibrary,
      skillPendingStore,
      skillWriteApprovalController,
      subagentExecutionPort: subagentExecutionController,
      // 协作工具端口复用同一控制器（实现 SubagentMessagingPort 转发）。
      subagentMessagingPort: subagentExecutionController,
      subagentForkEnabled: appConfig.runtimeLimits.subagentForkEnabled,
      agentTypes: subagentDefinitionRegistry.list().map(definition => definition.type),
    }, permissionSettingsStore);
    const llmAdapter = new OpenAiLlmAdapter(appConfig.llm);
    const tokenEstimator = new TiktokenEstimator();
    const contextAdapter = new DefaultContextAdapter(tokenEstimator);
    session = new SessionManager(
      appConfig.llm,
      llmAdapter,
      tokenEstimator,
      toolRegistry,
      contextAdapter,
      appConfig,
      abortSessionTasks,
      skillLibrary,
      skillPendingStore,
      skillWriteApprovalController,
      undefined,
      skillCurator,
      subagentExecutionController,
      subagentLlmClientFactory,
      subagentDefinitionRegistry,
      mainAgentDefinition,
    );
  } catch (initError: unknown) {
    const errorMsg = initError instanceof Error ? initError.message : String(initError);
    console.log(theme.error(`[错误] 初始化会话管理器失败：${errorMsg}`));
    process.exit(1);
  }

  // 显式打开会话，派发 SessionOpened 生命周期事件
  try {
    await session.open();
  } catch (openError: unknown) {
    const errorMsg = openError instanceof Error ? openError.message : String(openError);
    console.log(theme.error(`[错误] 会话打开被拦截：${errorMsg}`));
    process.exit(1);
  }

  // 记录启动配置结构化日志（空会话不产生 trace iteration 或伪聊天消息）
  // 日志与会话制品边界：run.log 记录配置事件，但 session snapshot 和 trace 只在
  // 真实聊天内容产生后创建，因此此处不触发 ContextRepository.saveState()。
  {
    const llmConfig = appConfig.llm;
    const safeUrl = llmConfig.baseUrl ? new URL(llmConfig.baseUrl) : null;
    logger.info('[启动] runtime_config_loaded', {
      component: 'runtime',
      event: 'runtime_config_loaded',
      profileId: llmConfig.profile?.id ?? 'unknown',
      providerModel: llmConfig.model,
      contextWindow: llmConfig.contextWindow,
      reasoningEffort: llmConfig.reasoningEffort,
      endpoint: safeUrl ? `${safeUrl.protocol}//${safeUrl.hostname}` : 'unknown'
    });
  }

  // 5. 将会话实例注入 Interface 层，启动终端应用
  startCli(session);
}

// 挂载全局进程退出监听器，交由 LifecycleManager 统一托管优雅清理流程
process.on('SIGINT', async () => {
  const { LifecycleManager } = await import('./core/usecases/engine/LifecycleManager.js');
  void LifecycleManager.shutdown(0);
});
process.on('SIGTERM', async () => {
  const { LifecycleManager } = await import('./core/usecases/engine/LifecycleManager.js');
  void LifecycleManager.shutdown(143);
});

// 启动主程序
main().catch(async (err) => {
  const { theme } = await import('./adapters/input/interface/views/theme.js');
  console.error(theme.error('致命错误：'), err);
  process.exit(1);
});


