/**
 * @file 记忆巩固四阶段提示词（对齐官方 Auto Dream consolidationPrompt）。
 * Orient/Gather/Consolidate/Prune 四阶段；会话检索按 MyAgent JSON 快照格式
 * （session_<id>.json），grep 窄词 + 行数限制，禁止全量读取。
 */

/** 记忆索引文件名（主记忆契约）。 */
const MEMORY_INDEX_NAME = 'MEMORY.md';
/** 记忆索引规模上限（对齐官方 MAX_ENTRYPOINT_LINES）。 */
const MAX_INDEX_LINES = 200;
/** 记忆索引体积上限（对齐官方 ~25KB）。 */
const MAX_INDEX_BYTES = 25 * 1024;

/**
 * 构建记忆巩固任务提示词。
 *
 * @param memoryDir - 记忆目录绝对路径（巩固 Agent 唯一可写的记忆根）
 * @param sessionsDir - 会话快照目录绝对路径（信号收集输入，只读）
 * @param sessionIds - 自上次巩固后触碰的会话 ID 列表（当前会话已排除）
 * @param extra - 附加上下文（如工具约束注记）
 * @returns 完整四阶段提示词
 */
export function buildMemoryConsolidationPrompt(
  memoryDir: string,
  sessionsDir: string,
  sessionIds: readonly string[],
  extra = '',
): string {
  const sessionList = sessionIds.length > 0
    ? `\nSessions since last consolidation (${sessionIds.length}):\n${sessionIds.map(id => `- ${id}`).join('\n')}`
    : '\nNo sessions since last consolidation — focus on pruning and fixing existing memories.';
  const sessionHint = sessionsDir
    ? `\nSession snapshots: \`${sessionsDir}\` (JSON files named session_<id>.json — grep narrowly, don't read whole files)`
    : '';

  const prompt = `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${memoryDir}\`
If it does not exist yet, create it and start fresh.
${sessionHint}

---

## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- Read \`${MEMORY_INDEX_NAME}\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Existing memories that drifted** — facts that contradict something you see in the codebase now
2. **Session snapshot search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSON snapshots for narrow terms:
   \`grep -rn "<narrow term>" ${sessionsDir}/ --include="session_*.json" | tail -50\`
3. **Repeated themes** — the same conclusion or decision appearing across multiple snapshots

Don't exhaustively read snapshots. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update \`${MEMORY_INDEX_NAME}\` so it stays under ${MAX_INDEX_LINES} lines AND under ~25KB (${MAX_INDEX_BYTES} bytes). It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.${extra ? `\n\n## Additional context\n\n${extra}` : ''}${sessionList}`;

  return prompt;
}
