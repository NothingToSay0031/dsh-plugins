# 模型控制 / Model Control

两个独立的模型体验增强，不修改 DSH Core。

> **注意**：上下文窗口预算不再由本插件修改，改在模型网关代理侧配置（见下文）。

## 功能

### 1. 切换模型时自动用最高思考强度

替换 composer 中的模型选择器，继续复用 DSH 官方 ModelDirectory 的目录、选择、错误处理与会话绑定：

- 切换到**新模型**时，使用目标模型提供的最高强度（按适配器给出的由低到高顺序取最后一档），绝不沿用前一个模型的档位；
- 再次点击**同一模型**保留当前强度；
- 强度列表只显示模型真实支持的档位，没有虚构的「Default」选项；未显式选档而由提供方默认生效时，只在只读标题显示该默认档名称；
- 之后手动选择的强度始终保留。

仅覆盖 composer 选择器；原生 `/model` 命令和其他 API 调用不被拦截。

### 2. 逐回复的模型标签

在已完成的 assistant 回复操作行追加实际使用的模型与强度，位置在「用量 + 时间」之后。数据来自该条回复之前已提交的 `request/header` 与 `assistant/message.source`，**不使用当前选择推测历史**。

## 上下文预算在哪里改

改模型网关代理的配置文件——代理上报的 `context_length` 就是 DSH 看到的窗口：

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
- `context_window_overrides`：按模型 ID（或裸模型名）前缀覆盖，最长前缀优先，且不超过上游容量。
- `include_prefixes`：空数组表示全部模型；`exclude_prefixes` / `exclude_patterns` 优先排除。
- 改完重启代理进程，再在网关里刷新模型列表。

## 安装

在 profile 的 `package.json` 里加依赖并挂进 `dsh.profile.bundles`：

```json
"dependencies": { "@local/dsh-model-control": "link:<本插件目录的绝对路径>" }
```

```json
"dsh": { "profile": { "bundles": ["@local/dsh-model-control"] } }
```

## 验证

```bash
npm test    # node --test test/provenance.test.js test/registration.test.js
node --check index.js && node --check contracts.js && node --check client.js
```
