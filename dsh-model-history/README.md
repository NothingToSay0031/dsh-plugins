# 模型记录 / Model History

一个只读的 DSH 插件：记录**当前会话**的模型请求实际使用的模型与思考强度，配置每变化一次记一条。不修改 DSH Core，不改任何提供方配置，也不影响模型选择。

## 功能

1. **会话视图「模型记录」**：一张表，按时间顺序列出本会话用过的每一份请求配置。列为：序号、时间、轮次/步骤、提供方、模型、思考强度、原因、持续时长。顶部显示当前正在生效的配置，最新一行标注「使用中」。入口在会话页「对话 / 轨迹」旁的页签。
2. **更多面板入口**：页头「更多会话视图」下拉菜单里新增一行「模型记录」，点击直接切到该视图。如果标签栏放不下、该视图已被折叠进这个菜单，这行会自动隐藏，避免出现两条同名入口。

## 记的是什么

宿主只在**请求信封变化时**写一条 `request/header` 事件，之后的请求沿用最新一条。所以「每份配置记一行」正好等于「发生变化记录一次」：

| 情况 | 是否新增一行 |
| --- | --- |
| 同一模型与强度继续发请求 | 否（沿用上一行） |
| 换模型 | 是 |
| 只换思考强度 | 是 |
| 换提供方 | 是 |
| 换回之前用过的配置 | 是（这是一次新的变化） |

行数据来自 `request/header` 里的 `header.config`，即**实际发出去的** provider / model / reasoningEffort，不靠当前选择推测历史。强度由适配器默认给出（`adapterDefaults.reasoningEffort`）时记为「提供方默认」。

## 实现

- **宿主侧**（`index.js` + `contracts.js`）：注册会话投影 `localModelRequestHistory`，`apply(state, event)` 折叠 `turn/start`、`step/start`、`request/header` 三种事件；与本单元无关的事件返回同一个 state 引用，不触发任何发布。视图直接返回行数组，引用只在真的追加一行时才变化。
- **浏览器侧**（`client.js`）：向 `conversation.view` 注册视图，向 `conversation.session.header.views.actions` 注册菜单行；数据通过标准 props `useProjection` 读取。

## 安装

在 profile 的 `package.json` 里加依赖并挂进 `dsh.profile.bundles`：

```json
"dependencies": { "@local/dsh-model-history": "link:<本插件目录的绝对路径>" }
```

```json
"dsh": { "profile": { "bundles": ["@local/dsh-model-history"] } }
```

## 验证

```bash
npm test    # node --test test/*.test.js
npm run check
```
