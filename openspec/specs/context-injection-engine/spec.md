# Purpose
支持向系统提示词（System Prompt）中动态注入上下文（如全局规则、本地规则和可用技能等），实现上下文数据的外置与热加载。

## Requirements

### Requirement: Global Rules Loading
The system MUST dynamically load global rules from `D:\Projects\MyAgent\.agent\global_rules.md` (development path) during System Prompt construction if the file exists.

#### Scenario: Global Rules Exists
- **WHEN** the agent builds the system prompt and `global_rules.md` is present
- **THEN** its contents are injected into the final prompt surrounded by `<global_rules>` tags.

### Requirement: Local Project Rules Loading
The system MUST dynamically load local workspace rules from `D:\Projects\MyAgent\.agent\rules\guize.md` (development path mapping) during System Prompt construction if the file exists.

#### Scenario: Local Rules Exists
- **WHEN** the agent builds the system prompt and `guize.md` is present
- **THEN** its contents are injected into the final prompt surrounded by `<project_rules>` tags.

### Requirement: Skills Discovery and Loading
The system MUST discover skills from the `D:\Projects\MyAgent\.agent\skills\` directory. Each skill is defined by a `SKILL.md` file with YAML Frontmatter. The system MUST parse this frontmatter using a robust, standard YAML parser to fully support complex/nested data types (not just flat regex strings). The system MUST NOT inject the full text of all skills by default. Instead, it must construct an `<available_skills>` index.

#### Scenario: Injecting Skill Index
- **WHEN** the agent builds the system prompt
- **THEN** the contents of all discovered `SKILL.md` files are parsed for their YAML frontmatter, and a summarized `<available_skills>` index (containing name and description) is injected into the final prompt.

#### Scenario: Tool-driven Full Skill Loading
- **WHEN** the agent identifies a need to use a skill based on the `<available_skills>` index
- **THEN** the agent CAN invoke a designated internal Tool (e.g., `skill_view`) to load the full text of that skill dynamically.

### Requirement: CLI `/skill` Command
The system MUST provide a CLI command to manage skill states manually.

#### Scenario: User manages skills via CLI
- **WHEN** the user types `/skill list`
- **THEN** the terminal prints a list of all available skills.
- **WHEN** the user types `/skill enable <name>`
- **THEN** the specified skill's full text is persistently added to the system context for the current session.

### Requirement: Hot Reloading
The system MUST NOT cache rule or skill file contents persistently across turns in a way that requires process restarts to apply changes.

#### Scenario: Rule File Modification
- **WHEN** a user modifies and saves `.agentrules` during an active session
- **THEN** the next message sent to the agent MUST incorporate the freshly updated contents of the file.
