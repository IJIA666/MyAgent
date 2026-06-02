## ADDED Requirements

### Requirement: 斜杠命令原生 Tab 补全
系统 MUST 拦截用户的输入行为，并在敲击 `<Tab>` 键时提供已注册斜杠命令的自动补全或推荐。

#### Scenario: 唯一匹配自动补全
- **WHEN** 用户键入 `/ro` 并按下 `<Tab>` 键
- **THEN** 系统由于只匹配到唯一的 `/rollback`，直接将输入行补全为 `/rollback ` 

#### Scenario: 多重匹配展示提示
- **WHEN** 用户仅键入 `/r` 且注册了 `/rollback` 与 `/resume`，按下 `<Tab>` 键
- **THEN** 系统在下方列出所有的备选命令，并保留用户的原输入不动，等待继续精确输入

#### Scenario: 忽略非斜杠输入
- **WHEN** 用户输入的第一个字符非 `/`，并在单词中途按下 `<Tab>` 键
- **THEN** 系统不做任何命令提示拦截，维持 readline 的默认行为或不做响应
