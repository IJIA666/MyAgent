## 改造原因

项目中目前存在多处散落的硬编码工具名魔术字符串（如 `'load_skill'`、`'grepSearch'`、`'globSearch'`）以及安全卡关拦截插件中的本地工具别名数组。这些魔术字符串极易因开发期拼写错误而引入安全隐患，导致白名单或物理越界检测失效。为了控制爆炸半径、保障系统安全卡关的一致性，有必要将这些零散的工具常量及别名数组收拢至 `ToolConstants` 契约体系中进行集中化管理，消除硬编码。

## 变更内容

1. 扩展 `src/common/constants.ts` 中的 `ToolConstants`，补充缺少的本地内置工具名常量，并集中声明工具名别名的只读判定数组。
2. 改造 `src/brain/plugins/HumanApprovalPlugin.ts`，废弃局部硬编码数组，统一使用 `ToolConstants` 中的别名判定数组。
3. 改造 `src/action/virtual-mcp.ts`，将魔术字符串分支替换为 `ToolConstants` 的常量。
4. 改造 `src/action/tools.ts`，将内置工具声明中的硬编码 `name` 替换为 `ToolConstants` 引用。

## 业务能力

### 新增业务能力
无。本次变更为纯技术重构，不包含新增的业务能力。

### 修改业务能力
无。本次变更为纯技术重构，不涉及既有业务能力规格的变更。

## 影响范围

- **受影响模块**：
  - `src/common/constants.ts` (增加常量定义与判定别名集合)
  - `src/brain/plugins/HumanApprovalPlugin.ts` (安全拦截匹配判定逻辑)
  - `src/action/virtual-mcp.ts` (本地虚拟 MCP 工具的分发路由器)
  - `src/action/tools.ts` (内置工具的声明元数据定义)
- **API 兼容性**：无破坏性变更（Non-breaking），所有原硬编码工具名在运行时均与常量提取后的字符串内容保持 100% 精确一致。
