## 1. 级联正则提取与关键字路检索 (Regex Extraction & Keyword Search)

- [x] 1.1 在 `LongTermMemoryPlugin.ts` 中实现 `extractKeywords(text: string): string[]` 辅助方法，使用三组级联正则捕获反引号代码词、驼峰标识词及配置文件名，去重并过滤空白项。
- [x] 1.2 在 `LongTermMemoryPlugin.ts` 中实现内存事实切片检索：通过实例已有的 `this.memoryFilePath` 属性读取对应的物理文件（若不存在或为空直接跳过），拆分为要点行列表，计算各行包含的关键词命中次数 `matchCount`，降序排列召回 `matchCount > 0` 的排位记录。

<!-- checkpoint: npm run build -->

## 2. 倒数排名融合算法与重排实现 (RRF Combined Re-ranking)

- [x] 2.1 在 `LongTermMemoryPlugin.ts` 中实现 `reciprocalRankFusion(vectorResults: VectorSearchResult[], keywordResults: Array<{ id: string; text: string }>): VectorSearchResult[]` 方法。
- [x] 2.2 在该方法中按照 $Score(d) = \sum \frac{1}{60 + rank}$ 公式计算两路加权得分并实施全局排位重整，剔除重复实体。

<!-- checkpoint: npm run build -->

## 3. 插件 RAG 双路集成 (Plugin Hook Integration)

- [x] 3.1 改造 `LongTermMemoryPlugin.handleBeforeModel`：同时开启向量检索路与精确定位物理关键字匹配路。
- [x] 3.2 对两路召回结果调用 RRF 排序重整，过滤保留排名前 5 的有效事实。
- [x] 3.3 注入 System Prompt 尾部，与主干运行机制解耦。

<!-- checkpoint: npm run build -->

## 4. 单元与集成测试验证 (Testing & Validation)

- [x] 4.1 编写 `test/brain/plugins.test.ts` 新的单元测试，模拟不同级别的用户问询：
  - 模拟包含反引号或驼峰命名的 Query，验证正则提取精确度；
  - 模拟双路重合或单路漏匹配场景，验证 RRF 重排后的首位召回确实是期望的精准物理事实。
- [x] 4.2 运行 `npm run lint` 验证 ESLint 代码规范，确保无 un-used vars 违规。
- [x] 4.3 运行 `npm test` 执行全量 170+ 个测试用例，确保全部 100% 成功通过。

<!-- checkpoint: npm test -->
