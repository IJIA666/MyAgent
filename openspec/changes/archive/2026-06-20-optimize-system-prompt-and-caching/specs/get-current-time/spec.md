## 新增需求

### Requirement: 提供只读原生高精度时间获取工具
系统必须（MUST）提供一个轻量级、只读、无副作用的原生高精度时间获取工具 `get_current_time`，并将其正式注册到系统的工具链注册表（`toolRegistry`）中，供智能体在运行时显式调起，以消除时间感知盲区。

#### Scenario: 成功获取当前系统时间
- **WHEN** 智能体显式发起对 `get_current_time` 的工具调用请求时
- **THEN** 系统必须（MUST）以 JSON 格式返回当前的 ISO 格式时间戳（`formattedTime`）和本地格式时间字符串（`localTime`），并且该工具调用状态为成功，无任何业务副作用。
