# 模型控制 / Model Control

第二个独立 DSH 插件，不修改会话协作插件或 DSH Core。

> **注意**：上下文窗口不再由本插件修改。

## 功能

1. **模型切换最高强度**：替换 composer 中的模型选择 Slot，继续复用 DSH 官方 ModelDirectory 的目录、选择、错误与会话绑定。切换到新模型时使用目标模型提供的最高强度（按适配器给出的由低到高顺序取最后一档），绝不沿用前一个模型的档位；同一模型再次点击保留当前强度。强度列表只显示模型真实支持的档位，不再提供 “Default” 选项；未显式选档而由提供方默认生效时，只在只读标题显示该默认档名称。仅覆盖 composer picker，原生 `/model` 和其他 API 调用不被拦截。
2. **逐回复模型标签**：在已完成的 assistant 回复操作行追加实际模型与强度，位置在“用量+时间”之后。数据来自该条回复之前已提交的 `request/header` 与 `assistant/message.source`，不使用当前选择推测历史。

## 上下文预算在哪里改

改模型网关代理的配置文件（代理上报的 `context_length` 就是 DSH 看到的窗口）：

```json
{
  "context_window": 500000,
  "context_window_overrides": { "gpt-": 270000 },
  "include_prefixes": [],
  "exclude_prefixes": [],
  "exclude_patterns": []
}
```

- `context_window`：无前缀匹配时上报的窗口；`0` 表示沿用上游。
- `context_window_overrides`：按模型 ID（或裸模型名，如 `anthropic/gpt-6.1-sol`）前缀覆盖，最长前缀优先，且不超过上游容量。
- `include_prefixes`：空数组表示全部模型；`exclude_prefixes` / `exclude_patterns` 优先排除（当前均不启用，只改窗口）。
- 改完重启代理进程，再在网关里刷新模型列表。

已用当前网关验证：不筛选，128 个模型全部透传；`gpt-*` 上报 270000，其余上报 500000。

## 验证

```
node --test test/provenance.test.js test/registration.test.js
node --check index.js
node --check contracts.js
node --check client.js
```
