# 详细设计: 长期记忆双路混合检索与 RRF 重排融合

## 1. 架构流转流程
双路检索融合发生于 `LongTermMemoryPlugin.ts` 的 `BeforeModel` 拦截钩子中。核心调用链路如下：

```mermaid
graph TD
    UserQuery["用户 Query 输入"] --> Extractor["标识符正则提取器"]
    UserQuery --> Embedder["向量特征生成器"]
    
    Extractor -->|提取关键词列表| ExactSearch["精确定位匹配路 (includes)"]
    Embedder -->|向量表达 (1536维)| VectorSearch["语义向量检索路 (VectorDb.search)"]
    
    ExactSearch -->|精确排序列表 R1| RRFFusion["RRF 排序融合引擎 (k=60)"]
    VectorSearch -->|向量排序列表 R2| RRFFusion
    
    RRFFusion -->|去重并重排得分| FinalSelection["匹配分值 Top-5 过滤列表"]
    FinalSelection -->|System Prompt 注入| LlmCall["LLM 交互推理流"]
```

## 2. 精确匹配路: 正则级联捕获设计
为保证物理匹配的精度并消除日常中英文自然语言助词/虚词干扰，利用以下级联正则进行过滤和匹配项提取：

1. **反引号包裹捕获**：
   - 模式：``/`([^`]+)`/g``
   - 作用：匹配用户输入中被 `` ` `` 包裹的代码、API 或文件名，拥有最高的实体属性。
2. **大写驼峰词捕获**：
   - 模式：`/\b[A-Z][a-zA-Z0-9]{3,}\b/g`
   - 作用：匹配大写字母开头的类名、接口名、类静态方法名等关键技术术语。
3. **常见文件名后缀捕获**：
   - 模式：`/\b[a-zA-Z0-9_-]+\.(?:ts|js|json|md|py|go|java)\b/g`
   - 作用：精准提取被提及的源码、配置文件或文本规范文件名。

匹配提取的关键词将通过 `MEMORY.md` 切片遍历：
`const matchCount = keywords.filter(kw => chunkText.includes(kw)).length;`
并根据匹配命中数 `matchCount > 0` 降序排列作为精确路的列表。

## 3. RRF (Reciprocal Rank Fusion) 重排引擎
对于召回的两路列表，根据其在各自路中的物理排位 `rank`（从 1 开始计）计算融合得分：

$$Score(d) = \frac{1}{60 + Rank_{vector}(d)} + \frac{1}{60 + Rank_{keyword}(d)}$$

*注：若某条记录仅在单路中被召回，则另一路的排位 Rank 视为无穷大，即对应项得分为 0。*

重排逻辑伪代码：
```typescript
interface RankedItem {
  id: string;
  text: string;
}

function rrfCombine(vectorList: RankedItem[], keywordList: RankedItem[]): RankedItem[] {
  const k = 60;
  const scoreMap = new Map<string, { item: RankedItem; score: number }>();
  
  const addScores = (list: RankedItem[]) => {
    list.forEach((item, index) => {
      const rank = index + 1;
      const current = scoreMap.get(item.id) || { item, score: 0 };
      current.score += 1 / (k + rank);
      scoreMap.set(item.id, current);
    });
  };
  
  addScores(vectorList);
  addScores(keywordList);
  
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(v => v.item);
}
```

## 4. 安全与隔离规范
- 物理事实文件 `.agent/MEMORY.md` 仅在内存中执行只读式的分块切割匹配，检索用的文件物理路径必须唯一地取自插件实例在构造时绑定的私有属性 `this.memoryFilePath`。整个召回检索过程只读，绝不物理修改或写入任何物理文本文件。
- RRF 排序在当前主线程轻量级运行，无任何网络或外部依赖开销。
