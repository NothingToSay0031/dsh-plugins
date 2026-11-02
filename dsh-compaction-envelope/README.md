# 压缩信封 / Compaction Envelope

让压缩（compaction）的摘要请求带上这个会话真正的 `reasoningEffort`。

## 为什么需要

`@deepseek-ai/dsh-compaction-basic` 做摘要时，会把当前会话的消息重放一遍再追加一段指令，但**不传 `reasoningEffort`**（`summarizeWithLlm` 的 options 只带了 provider / model / messages / tools / toolHistory / maxTokens）。网关的 prompt cache 按 `reasoning_effort` 分命名空间，`max` 是独立的一份，`high` 和不传共用另一份。于是：

- 会话按 `effort=max` 跑，摘要请求落到“不传”的命名空间；
- 重放的消息一个都命不中，只能复用静态的 system + 工具 schema 那一段。

实测（同一个网关、同样的消息前缀，A/B 对照）：摘要请求带上 `effort=max` → 命中 **98.0%**；不带 → **0%**；会话本身按 `effort=high` 跑、摘要不带 → **97.5%**。历史 109 次真实摘要调用合计 2,538 万输入 token，其中只有 134 万命中（**5.0%**），命中的部分全是 10,368 / 6,272 这种“只有头部”的块。

## 做法

包一层 `llm.stream`：只对 `purpose === "compaction"`、且自己没有指定 `reasoningEffort` 的调用，补上该 `sessionId` 实际路由用的 effort。其余调用原样透传，一个字段都不动。

为什么不是 `llm/stream` waterfall：那是框架正式给出的拦截点（`ctx.waterfall(this, "llm/stream", options, () => adapterStream(...))`），但它的监听器签名只有 `(options, next)`，`options` 是闭包里同一个对象，`next(...)` 不会把新参数带给下游或内置实现 —— 监听器只能整体替换返回的流（于是跳过下游监听器和内置的失败包装）。要“只补一个字段、其余全不动”，只能在更外层入口做，这样 waterfall 仍然照常运行在补过字段的 options 上。

## 配置

`cordis.patch.yml` 的行上可加 `config`：

- `enabled`：默认 `true`；设 `false` 则完全不装。
- `requireSameRoute`：默认 `true`。检查事件里的 provider/model 与会话路由一致才补；把摘要模型单独指到别的模型（`summarizationModel`）时这项会阻止硬套。

## 状态与边界

- 解析不到会话、会话已删除、路由里没有 effort → 不补，原样调用；
- 摘要模型（`summarizationModel`）与会话模型不是同一个 → 不补（不同模型对 effort 的取值集合不同，硬套可能非法）；
- 包装层内部任何异常都被吞掉并回退成原始调用，**不会让模型调用失败**；
- 服务不可写（被代理或冻结）→ 报告 `not-writable` 并保持不安装，不改任何东西；
- 重复加载不会叠两层（用全局 `Symbol.for` 标记识别自己的包装）；
- 扩展卸载时恢复原 `stream`。

并发：每次调用都在自己的 `sessionId` 上现算 effort，插件里没有“当前会话”这类全局变量，没有队列、锁、缓冲，也不改调用方传进来的对象（只生成一份浅拷贝，`messages` / `toolHistory` / `signal` 按引用透传）。几路会话同时压缩时互不写入；不同模型、不同 effort 的会话各取各的值。唯一共享的是诊断计数器，没有任何决策读它。路由不一致而被跳过时会打一行 warn，避免“悄悄没优化”。

注入值仍要过服务自己的校验（`resolveCallWithInfo` 会检查它在模型的 `reasoning.efforts` 里），所以只在 provider 和 model 都与会话路由一致时才补——那个值必然是同一模型已经接受过的。真要撞上“header 里的 effort 过期、而摘要目标已换模型”的竞态，后果是这一次摘要被拒（`UNSUPPORTED_REASONING_EFFORT`，引擎记一条 `step compaction failed` 后继续本轮），不是会话损坏。

## 安装

profile `~/.dsh/profiles/desktop/package.json` 里加依赖：

```json
"@local/dsh-compaction-envelope": "link:<本插件目录的绝对路径>"
```

并把它加进 `dsh.profile.bundles`；插件自带的 `cordis.patch.yml` 会把行插进配置。重启桌面端后生效。

插件卡片会显示「压缩信封 / Compaction Envelope」和信封图标：标题、说明来自包内 `locale/en.json`、`locale/zh.json` 的 `meta`，图标来自 `icon.svg`，由 `exports` 里的 `./locale/*.json` 与 `./icon` 暴露；插件管理器只读取这些静态资源，不执行插件代码。

## 验证

`node --test test/*.test.js`（22 个用例，覆盖注入条件、路由不符、会话缺失、异常回退、类方法遮蔽、卸载还原，以及三路会话交错校验各自的 effort）。

重启后看日志 `~/.dsh/logs/desktop-next.log`：启动时会有一行

```
compaction-envelope: installed; compaction calls inherit the routed reasoning effort
```

每次注入还会有一行

```
compaction-envelope: compaction call inherits reasoningEffort=max (demo/model-...)
```

再看会话文件里的 `compaction/summary` 事件，`usage.cacheReadTokens` 应该从 6k 量级跳到接近输入 token 数（命中率 ~98%）。

## 开发与测试

`npm test`（等价于 `node --test test/*.test.js`，22 个用例）；语法检查 `node --check index.js && node --check envelope.js`。

入口是 `index.js`，包装实现与纯函数（`decide`、`installEnvelope`、`WRAPPED`）在 `envelope.js`。`test/envelope.test.js` 覆盖注入判定，`test/plugin.test.js` 覆盖注册、失败回滚与卸载还原。显示元数据只有 `locale/*.json` 与 `icon.svg`，和 `cordis.patch.yml` 一样属于包内静态资源。

## 什么时候可以删掉这个插件

上游在 `packages/compaction/compaction-basic` 的 `summarizeWithLlm` 里把 `reasoningEffort` 一并转发（和 provider / model / maxTokens 一样从路由配置里取）之后，这个插件就是多余的。
