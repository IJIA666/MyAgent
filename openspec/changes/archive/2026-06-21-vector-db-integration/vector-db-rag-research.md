# 调研主题: 混合检索中向量化截断与融合排序算法的竞品分析

## 1. 调研问题与背景

在引入本地向量数据库（ Vector DB ）以实现 Hybrid RAG 检索时，由于网络 Embedding 接口具有严格的 Token 准入上限（如 OpenAI 的 8192 tokens ），且过长的查询文本会引入较多的无关干扰，因此对检索 Query 进行截断防线（ Truncation ）非常关键。

同时，为了在代码开发和历史偏好召回中取得最佳检索效果，我们需要对“传统关键词检索（ 稀疏检索 ）”与“语义向量检索（ 稠密检索 ）”进行混合融合（ Hybrid Search ）。

## 2. 竞品实现与源码洞察

- **OpenClaw 向量库与截断控制**：
  
  - **限制检索长度**：在 [config.ts](file:///d:/Projects/Agents/openclaw/extensions/memory-lancedb/config.ts#L30) 中声明的默认最大检索字符限制 `DEFAULT_RECALL_MAX_CHARS` 为 `1000` 字符。
  
  - **相似度分数换算**：在 [index.ts](file:///d:/Projects/Agents/openclaw/extensions/memory-lancedb/index.ts#L295-L299) 中，针对 LanceDB 返回的 L2 欧氏距离，通过公式 $score = 1 / (1 + \text{distance})$ 将其归一化为 0-1 的相似度分值，硬编码过滤 $score < 0.5$ 的结果。

- **Hermes Agent 多源记忆提供商召回与混合检索**：
  
  - **检索前置截断**：在 [supermemory.py](file:///d:/Projects/Agents/hermes-agent/plugins/memory/supermemory/__init__.py#L571) 中，调用语义搜索前，会对传入的 Query 字符串直接使用 `query[:200]` 强制截取前 `200` 字符。
  
  - **Holographic 多路混合融合**：在 [retrieval.py](file:///d:/Projects/Agents/hermes-agent/plugins/memory/holographic/retrieval.py#L55-L108) 中，系统实现了一种极具代数美感的混合检索机制：
    1. **第一路：SQLite FTS5 全文检索**：召回 `Limit * 3` 的候选词，并将 FTS5 负 rank 分数归一化为 $[0, 1]$。
    2. **第二路：Jaccard 词袋相似度**：计算 Query 词集与记忆条目分词之间的重合度（交集 / 并集）作为 Jaccard score。
    3. **第三路：HRR 代数向量计算**：引入 VSA（向量符号架构）的相位向量计算其余弦相似度。
    4. **加权线性融合**：采用公式 $relevance = 0.4 \times \text{FTS} + 0.3 \times \text{Jaccard} + 0.3 \times \text{HRR}$，随后乘以信用权重 $trust\_score$ 和基于半衰期的天数衰减权重，输出最终排序。

- **LanceDB 工业界混合检索标准**：
  
  - **倒数排名融合 (RRF)**：作为默认的混合重排器（ `RRFReranker` ），忽略原始分值，以公式 $\text{Score}(d) = \sum \frac{1}{k + \text{rank}}$ 对两路检索的相对排名位置做加权求和，对参数和分值格式不敏感，鲁棒性极高。
  
  - **线性加权组合 (Linear Combination)**：在 `LinearCombinationReranker` 中对两路分值做 Min-Max 归一化，通过 `weight` 参数（默认向量权重 `0.7`，全文检索权重 `0.3`）进行加权求和。

## 3. 本地项目的落地规范建议

根据上述竞品分析，针对我们项目的“第三阶段：混合向量检索”，提出如下混合召回落地建议：

- **关键字与语义双路检索 (Hybrid RAG)**：
  
  - 在 `LongTermMemoryPlugin.BeforeModel` 执行时，同时发起两路匹配：
    - **向量检索路**：调用 `VectorDbPort.search` 匹配高相似度的语义片段。
    - **物理文本检索路**：读取 `.agent/MEMORY.md` 物理文件，通过 Query 中的核心技术词（如特定的类名、工具名、方法名）执行简单的大小写不敏感 `includes` 关键字包含匹配。
  
  - **融合排序与去重**：合并两路召回的记忆片段，以物理文本内容（`text`）作为唯一键去重。如果某个要点同时命中向量与关键字，赋予更高的置信度或合并输出，以保证既能应对模糊语义检索，又能精准定位特定的开发专业词汇（如接口名）。

- **前置截断与防御**：
  
  - 最新 user 消息在生成 Embedding 向量前截取前 `2000` 字符作为查询向量输入，保证网络稳定性。
