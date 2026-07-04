## 1. System Prompt 措辞修改

- [x] 1.1 修改 `src/core/usecases/brain/prompts.ts` 中的 `RULE_FILE_SANDBOX` 常量，将“越权即拒绝访问”的结果预判改为中性委托措辞。
<!-- checkpoint: npx tsc --noEmit -->

## 2. 文件系统工具 description 调整

- [x] 2.1 修改 `src/adapters/tools/impl/filesystem/file-system.ts` 中 ReadFile 工具的 `description`，去除“授权工作区”式预判表述。
- [x] 2.2 修改 `src/adapters/tools/impl/filesystem/file-system.ts` 中 WriteFile 工具的 `description`，改为“默认在工作区内；外部路径由工具层依据安全策略处理”。
- [x] 2.3 修改 `src/adapters/tools/impl/filesystem/file-system.ts` 中 EditFile 工具的 `description`，同步调整边界措辞。
- [x] 2.4 修改 `src/adapters/tools/impl/filesystem/file-system.ts` 中 ListFiles 工具的 `description`，同步调整边界措辞。
- [x] 2.5 修改 `src/adapters/tools/impl/filesystem/directory-manager.ts` 中 CreateDirectory 工具的 `description`，将“自动校验工作区安全边界”调整为中性声明。
- [x] 2.6 修改 `src/adapters/tools/impl/filesystem/directory-manager.ts` 中 DeletePath 工具的 `description`，改为“默认在工作区内删除路径；外部路径由工具层依据安全策略处理”。
- [x] 2.7 修改 `src/adapters/tools/impl/filesystem/search.ts` 中 GrepSearch 工具的 `description`，同步调整边界措辞。
- [x] 2.8 修改 `src/adapters/tools/impl/filesystem/search.ts` 中 GlobSearch 工具的 `description`，同步调整边界措辞。
- [x] 2.9 修改 `src/adapters/tools/impl/filesystem/read-many-files.ts` 中 ReadManyFiles 工具的 `description`，去除“授权工作区”式预判表述。
<!-- checkpoint: npx tsc --noEmit -->

## 3. 终端工具 description 调整

- [x] 3.1 修改 `src/adapters/tools/impl/system/terminal.ts` 中 ExecuteCommand 工具的 `description`，将“在受限的工作区沙箱内执行”“禁止读写工作区外部路径”分别调整为“在工作区沙箱内执行”“外部路径由安全策略管控”。
<!-- checkpoint: npx tsc --noEmit -->

## 4. 测试校验

- [x] 4.1 运行 `npx vitest run test/core/usecases/brain/prompt.test.ts`，确认 `RULE_FILE_SANDBOX` 的回归测试通过。
- [x] 4.2 新增并运行 `npx vitest run test/adapters/tools/tool-definition-description.test.ts`，锁定工具描述的中性边界措辞。
- [x] 4.3 运行 `npx tsc --noEmit`，确认本次文案调整未引入类型回归。
<!-- checkpoint: npx vitest run -->
