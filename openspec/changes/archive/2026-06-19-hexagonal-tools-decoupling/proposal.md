## 改造原因

目前智能体的原生工具在物理组织与安全设计上存在以下痛点：
1. **水平切分弊端与领域知识物理散落**：系统的内置原生工具目前以扁平形式放在 `src/action/native-tools/` 目录下（共 18 个文件），缺乏按业务 Feature 的物理内聚。具体的工具实现与相关的专属辅助逻辑（如 `apply-patch-helper.ts` 等 `helper`）被平铺在同一层级，没有物理聚合。
2. **跨层双向紧耦合**：脑皮层的插件 `HumanApprovalPlugin` 与外围 Action 层的工具在安全校验层面强耦合。网关插件静态导入并执行了特定工具的具体安全判定函数（如 `terminal-config.ts`、`terminal-guard.ts`），导致 Core 与具体外围工具细节在编译期强耦合，违背了六边形架构中 Core 仅通过 Port 与外围 Adapter 交互的理念。

因此，需要在物理上对工具按业务 Feature 子目录进行打包内聚，并在逻辑上基于统一的安全契约实现 Core 与 Adapter 在编译期和逻辑上的双重解耦。

## 变更内容

本次变更核心包含以下几个方面：
1. **工具 Feature 物理聚合**：在 `src/action/tools/` 目录下，将扁平的原生工具类及辅助 helper 按功能拆分为 `git`、`filesystem`、`system`、`skill` 等子包，并提供统一的包入口进行批量导出与注册，消除全局工具名常量的散落。
2. **安全防护契约抽象（BREAKING）**：对 `NativeTool` 契约接口进行修改，引入异步的安全校验方法 `checkSafety(args: Record<string, unknown>): Promise<SafetyCheckResult>`。由于所有内置的原生工具都需要实现此新方法，此更改对 `NativeTool` 契约是 **BREAKING** 不兼容的。
3. **安全校验 Default Deny 兜底防线**：在网关拦截处进行反射防御判定。若被调工具未定义 `checkSafety` 契约方法（例如外部接入的第三方 MCP 工具），系统坚决不放行。将兜底判定其为高危写操作类型并强制进入 `suspend` 人机核准卡关。
4. **安全状态上提与依赖反转**：彻底剥离具体工具（如 `base.ts`）内持有的白名单状态，将其上提到全局统一的 Brain 层安全服务（如 `SecurityService`）中。脑网关直接调用该服务回写临时白名单，具体工具（Adapter）也导入并从该服务读取白名单，彻底在物理和逻辑上斩断 Core 向具体 Action 工具的强依赖。

## 业务能力

### 新增业务能力
<!-- 本次引入的新业务能力。用 kebab-case 命名（如 user-auth、data-export），每个能力会生成 specs/<name>/spec.md -->

### 修改业务能力
<!-- 已有的、其需求规格发生变化的业务能力（不仅仅是实现细节的调整）。
     仅当 spec 级别的行为发生变化时才列在此处。每项需要一个增量 spec file。
     使用 openspec/specs/ 中已有的 spec 名称。若无需求变更则留空。 -->
- `tool-security-category`: 演进安全确权规范，引入统一的 `checkSafety` 异步校验契约，将具体安全校验职责下沉至原生工具内部，插件改写为通用的无状态挂起决策网关。

## 影响范围

1. **NativeTool 契约接口**：新增了异步安全判定方法规范，且未实现该接口的任何外部工具默认判定为需要人类挂起审批（Default Deny 兜底防线）。
2. **HumanApprovalPlugin**：移除了对终端配置及命令筛查、文件路径越界检测的具体依赖，改为通过工具实例的安全反射多态方法进行审查，且彻底断开对具体文件/终端工具类的直接物理 import。
3. **安全服务层（SecurityService）**：演进安全服务以统一管理运行时内存临时路径白名单和终端规则，底层的沙箱文件校验依赖此服务读取授权状态。
4. **工具注册与加载模块（virtual-mcp.ts, toolRegistry.ts）**：需调整为按包引入工具并批量注册，不再在 `LocalFileSystemMcpServer` 中挨个静态引入所有具体工具类。
5. **单元测试与集成测试**：需要对各个 Feature 工具的 `checkSafety` 行为进行独立单元测试，并调整插件拦截测试，适配无状态网关。
