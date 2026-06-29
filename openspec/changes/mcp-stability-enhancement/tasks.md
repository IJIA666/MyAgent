## 1. MCP 驱动层保活重启实现

- [ ] 1.1 **自愈重连机制引入**： 在 `src/adapters/tools/virtual-mcp.ts` 的 `VirtualMcpClient` 中引入连接重连哨兵。对 `callTool` 阶段捕获的底层网络超时或进程挂死断连，执行热重启重建并引入指数退避（最高 3 次）防循环熔断保护；重连与重试过程必须（MUST）在 `callTool` 内部同步循环内完成，直接返回重试成功结果，对上层调用方和消息历史保持完全透明。
- [ ] 1.2 **重连哨兵单测编写**： 在 `test/adapters/tools/` 目录下（如 `mcp-client.test.ts` ）增加重连自愈的单元测试，模拟第一次连接崩溃发生后自动热拉起自愈成功，断言后续交互流程顺利修复。

<!-- checkpoint: npm run test -->

## 2. 系统异常分类响应引导

- [ ] 2.1 **错误区分指令注入**： 在 `src/core/usecases/brain/prompts.ts` 的 `BASE_SYSTEM_PROMPT` 中注入第 9 条关于“错误性质区分及网络超时防参数幻觉重试”的红线规则。
- [ ] 2.2 **全局测试集成回归**： 运行项目中所有集成测试，验证提示词注入与驱动层健壮性，确保回归 100% 绿灯。

<!-- checkpoint: npm run test -->
