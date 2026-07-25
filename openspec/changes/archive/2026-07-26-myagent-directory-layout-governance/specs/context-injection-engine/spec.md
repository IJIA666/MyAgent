## MODIFIED Requirements

### Requirement: Global Rules Loading

The system MUST load all valid user-level rule files from `~/.myagent/rules/` during System Prompt construction. Files MUST be processed in a stable order, and an absent user rules directory MUST be treated as an empty rule set.

#### Scenario: Global Rules Exist

- **WHEN** the agent builds the system prompt and one or more valid rule files are present in the user rules directory
- **THEN** their contents are injected into the final prompt in stable order and surrounded by `<global_rules>` tags

#### Scenario: Global Rules Do Not Exist

- **WHEN** the agent builds the system prompt and the user rules directory is absent or empty
- **THEN** prompt construction continues without global rule content and without creating a rules directory in the workspace

### Requirement: Local Project Rules Loading

The system MUST load all valid project rule files from `<workspace>/.myagent/rules/` during System Prompt construction. Project rules MUST be injected after user rules so that project-specific guidance is closest to the active task.

#### Scenario: Local Rules Exist

- **WHEN** the agent builds the system prompt and valid rule files are present in the project rules directory
- **THEN** their contents are injected in stable order and surrounded by `<project_rules>` tags

### Requirement: Skills Discovery and Loading

The system MUST discover skills from `~/.myagent/skills/` and `<workspace>/.myagent/skills/`. Each skill MUST be defined by a `SKILL.md` file with YAML Frontmatter and parsed using a standard YAML parser. Project skills MUST override user skills with the same skill name; different names MUST be merged. The full text of all skills MUST NOT be injected by default; the system MUST construct an `<available_skills>` index.

#### Scenario: Injecting Merged Skill Index

- **WHEN** the agent builds the system prompt
- **THEN** valid user and project skills are merged by name, project definitions win same-name conflicts, and one summarized `<available_skills>` index containing name and description is injected

#### Scenario: Tool-driven Full Skill Loading

- **WHEN** the agent identifies a need to use a skill from the `<available_skills>` index
- **THEN** the agent CAN invoke the designated internal tool to load the full text from the resolved winning skill definition

### Requirement: Hot Reloading

The system MUST NOT require a process restart to apply changes to project rule or project skill files under `<workspace>/.myagent/`. Reloading MUST use the current workspace's resolved project configuration paths.

#### Scenario: Project Rule File Modification

- **WHEN** a user modifies and saves a rule file under `<workspace>/.myagent/rules/` during an active session
- **THEN** the next message sent to the agent MUST incorporate the updated project rule contents

#### Scenario: Project Skill File Modification

- **WHEN** a user modifies a valid `SKILL.md` under `<workspace>/.myagent/skills/` during an active session
- **THEN** the skill index and subsequent full-skill loading MUST use the updated content after the configured debounce
