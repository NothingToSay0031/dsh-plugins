# 压缩信封 / Compaction Envelope

让压缩（compaction）的摘要请求带上当前会话实际使用的 `reasoningEffort`（思考强度），从而命中提供方的 prompt cache。

## 为什么需要

`@deepseek-ai/dsh-compaction-basic` 生成摘要时，会把当前会话的消息重放一遍再追加总结指令，但**不传 `reasoningEffort`**。而网关的 prompt cache 按 `reasoning_effort` 分命名空间：`max` 是独立的一份，`high` 与不传共用另一份。于是：

- 会话按 `effort=max` 运行时，摘要请求落到「不传」的命名空间；
- 重放的会话消息一条都命不中，只能复用静态的 system + 工具 schema 那一段。

同一网关、同样消息前缀的 A/B 对照：摘要请求带上会话的 effort 后缓存命中率约 **98%**，不带则为 **0%**。

## 做法

在 `llm.stream` 入口包一层：只对 `purpose === "compaction"`、且调用自己没有指定 `reasoningEffort` 的请求，补上该 `sessionId` 实际路由使用的 effort。其余调用原样透传，一个字段都不动。

不用框架的 `llm/stream` waterfall 拦截点，是因为它的监听器签名只有 `(options, next)`，`next(...)` 不会把修改后的参数带给下游或内置实现——监听器只能整体替换返回的流，从而跳过下游监听器和内置的失败包装。要「只补一个字段、其余全不动」，只能在更外层入口做，waterfall 仍然照常运行在补过字段的 options 上。

## 配置

在 profile 的 `cordis.patch.yml` 对应行上加 `config`：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时完全不安装。 |
| `requireSameRoute` | `true` | 仅当事件里的 provider/model 与会话路由一致时才补。摘要模型被单独指向别的模型（`summarizationModel`）时，阻止把会话的 effort 硬套过去。 |
| `diagnose` | `true` | 记录每次压缩流的 chunk 统计（见「诊断」）。 |

## 行为与边界

- 解析不到会话、会话已删除、路由里没有 effort → 不补，原样调用。
- 摘要模型与会话模型不是同一个 → 不补（不同模型对 effort 的取值集合不同，硬套可能非法）。
- 包装层内部任何异常都回退成原始调用，**不会让模型调用失败**。
- 服务不可写（被代理或冻结）→ 报告 `not-writable` 并保持不安装。
- 卸载时恢复原 `stream`。
- 注入值仍要过服务自己的校验（必须在该模型的 `reasoning.efforts` 里）。即使撞上「header 里的 effort 过期、摘要目标已换模型」的竞态，后果也只是这一次摘要被拒（`UNSUPPORTED_REASONING_EFFORT`），不会损坏会话。
- 并发安全：每次调用都在自己的 `sessionId` 上现算 effort，没有全局状态、队列或锁；不修改调用方传入的对象（只生成浅拷贝，`messages` / `toolHistory` / `signal` 按引用透传）。多路会话同时压缩互不影响。路由不一致而被跳过时会打一行 warn，避免「悄悄没优化」。

## 热重载

改完插件不必重启 Host：`@deepseek-ai/dsh-hmr` 会重新导入变化的文件。包装层自带撤销函数，新实例先撤销旧包装再安装自己的，所以重载是**替换**而不是叠一层。早于该机制的版本安装的包装没有撤销函数，此时会再套一层并在日志中说明；内层运行时 `reasoningEffort` 已存在，会直接跳过，压缩调用仍然只被改写一次。

安装成功以属性写入成功为准（服务可能用写入前的值回应一次属性读取，不能以回读判断）；写入失败时把障碍写进日志并保持不安装。

## 诊断：摘要为什么是空的

`dsh-compaction-basic` 在流结束后要求至少有一个非空 text 块，否则抛 `summarization produced no text summary content`。这条错误只出现在 `finish.kind === 'stop'` 时，而从外面分不清三种情况：

- 模型把请求当成了工具调用轮次（请求带着整个会话的 `tools` 且没有 `toolChoice`），只输出了 tool-call；
- 只输出了 reasoning 就正常结束；
- 流被网关掐断、连 finish 块都没有——装配器在没有 finish 块时默认返回 `{ kind: 'stop' }`，静默截断也会走到这条错误上。

包装层在原样透传的同时记录每条压缩流：各类 chunk 数量、text / reasoning / toolArgs 字符数、finish 原因（`none` = 没有 finish 块）、上报的 token 数、本次注入的 effort，每次压缩调用打一行日志，例如：

```
compaction-envelope: ... produced no text (text=0 reasoning=812 toolArgs=1433 finish=stop tokens=2245 effort=max chunks=block-start:2,tool-call-delta:37,finish:1)
```

同样的内容也挂在 `llm[Symbol.for('@local/dsh-compaction-envelope.stats')].lastStream` 上，便于不读日志直接核对。`diagnose: false` 关闭统计（流仍原样透传）。计数不改流：chunk 按原对象、原顺序 yield；消费方提前 break、抛错或正常结束，都在 finally 里报告一次。

## 安装

在 profile 的 `package.json` 里加依赖并挂进 `dsh.profile.bundles`：

```json
"dependencies": { "@local/dsh-compaction-envelope": "link:<本插件目录的绝对路径>" }
```

```json
"dsh": { "profile": { "bundles": ["@local/dsh-compaction-envelope"] } }
```

插件自带的 `cordis.patch.yml` 会插入配置行，重启客户端后生效。插件管理页的标题、简介来自包内 `locale/en.json` / `locale/zh.json` 的 `meta`，图标来自 `icon.svg`。

## 验证

```bash
npm test    # node --test test/*.test.js，31 个用例
```

覆盖注入条件、路由不符、会话缺失、异常回退、卸载还原、重载接管、不可写服务、多路会话交错、压缩流透传与计数。

启动后日志（`~/.dsh/logs/` 下对应 profile 的日志）应有：

```
compaction-envelope: installed; compaction calls inherit the routed reasoning effort
```

每次注入另有一行 `compaction call inherits reasoningEffort=...`。再看会话文件里的 `compaction/summary` 事件，`usage.cacheReadTokens` 应从几千跳到接近输入 token 数。

## 什么时候可以删掉这个插件

上游 `compaction-basic` 的 `summarizeWithLlm` 把 `reasoningEffort` 一并从路由配置转发之后，本插件就是多余的。
