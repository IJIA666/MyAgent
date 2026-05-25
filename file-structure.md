# 📁 当前目录完整文件结构（递归）

```
.
├── .agents/
│   └── rules/
│       └── guize.md
├── .env
├── .env.example
├── .git/                     # Git 内部目录（未展开）
├── .gitignore
├── node_modules/             # 依赖包目录（内容过多，未展开）
├── openspec/
│   ├── changes/
│   │   ├── archive/
│   │   └── create-simple-agent/
│   │       ├── .openspec.yaml
│   │       ├── design.md
│   │       ├── exploration.md
│   │       ├── proposal.md
│   │       ├── specs/
│   │       │   └── simple-agent-core/
│   │       │       └── spec.md
│   │       └── tasks.md
│   ├── config.yaml
│   ├── explorations/
│   ├── schemas/
│   │   ├── custom-spec-driven/
│   │   │   ├── schema.yaml
│   │   │   └── templates/
│   │   │       ├── design.md
│   │   │       ├── proposal.md
│   │   │       ├── spec.md
│   │   │       └── tasks.md
│   │   └── game-dev/
│   │       ├── schema.yaml
│   │       └── templates/
│   │           ├── design.md
│   │           ├── proposal.md
│   │           ├── spec.md
│   │           └── tasks.md
│   └── specs/
├── package-lock.json
├── package.json
├── src/
│   ├── index.ts
│   ├── session.ts
│   └── tools.ts
├── tsconfig.json
└── file-structure.md         # ← 本文件
```

---

> **备注**：
> - `.git/` 为 Git 版本控制的内部数据库，包含 commits、branches 等，此处未展开。
> - `node_modules/` 为项目依赖包目录，包含大量第三方库，此处未展开以避免过于冗长。
