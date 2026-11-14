# 压缩点设置 / Compaction Targets

DSH 桌面端的「压缩点」设置页，入口在侧栏「更多」菜单。它把每个模型的**压缩触发 token 目标**换算成 `compaction-basic` 需要的 `thresholdRatio`，按勾选的 Agent 预设写入配置，并顺带管理每个预设的 `tool-result-pruner` 开关与子代理默认模型路由。

## 两个配置文件

| 文件 | 内容 | 谁维护 |
| --- | --- | --- |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 手工内容：提供方配置、本地插件、本插件自己的 overlay 行 | **人**；本插件从不写入 |
| `~/.dsh/cordis.patch.yml`（home 层） | 生成的 `preset-*` 覆盖行 | **机器**；本插件只写这个文件，保留其它行 |

Host 的配置层次是 bundle 层 → profile 层 → **home 层** → 启动 overlay，home 层在 profile 层之后应用，因此**同一条目 id 以 home 层为准**：生成的预设覆盖永远压过 profile 里同名的手写行，而 profile 文件保持「只有人写的内容」。两个文件都被 HMR 监视，改完立即生效。

> 迁移说明：早先版本把生成的 `preset-*` 行写在 profile 文件里。现在这些行已移到 home 层；旧 profile 里若还留着同名 `preset-*` 行，会被 home 层压住（不生效），删掉即可。

## 功能

- **模型清单**来自当前 profile patch 的 `llm-pi-ai.config.providers` 下所有带非空 `models` 的提供方，不硬编码。
- 每行只填压缩点 token；模型的实际输出预留 `maxTokens` 由 `llm-pi-ai` 决定，页面只读。写回时按实际 `maxTokens` 校验安全上限。
- `modelPolicies` 只写勾选「写入单独策略」的模型；未勾选模型保持 fallback 行为。
- 全局 `retainTokens`、`headroomTokens`、`compaction-basic.maxTokens` 可编辑，保留现有 `thresholdRatio` fallback。
- 默认勾选所有可用预设；每个勾选预设的 `tool-result-pruner` 写成 `disabled: true`（预设里没有这个插件时保持原样）。

### 不单独限制压缩输出

「摘要输出上限」旁有一个开关：**不单独限制（用模型自己的输出上限）**。打开后，每个受管模型的 `modelPolicies[].maxTokens` 写成它自己在 `llm-pi-ai` 里声明的 `maxTokens`，全局 `compaction-basic.maxTokens` 退化成整张模型表里**最小**的值（只给不在表里的模型兜底）。这样压缩不会被一个凭空的小数字截断，代价是单次压缩最坏耗时跟着模型自己的上限走。

文件里不需要额外的模式标记：每一行受管 policy 都带着自己模型的上限就是「不单独限制」；只要有一行没带，读回来的就是一个真实数字。模型已从提供方表里移除的 policy 行不参与判断，也不会被改写。

## 预设行如何生成

每个预设的**基线是 bundle 层（上游）的声明**，不是 profile 里的生效声明——Loader 整块替换 `preset-*` 行的 `config`，profile 里的预设行必然是上游声明的一份拷贝；拿生效声明当基线会让拷贝永远陈旧。每次写入都以上游声明重新生成：

```
预设行 = 上游声明 + 显式声明的定制（overlay） + 插件管理的三个字段
```

三个受管字段：`compaction-basic.config`、`tool-result-pruner.disabled`、`tool-subagent.config.agentOptions`。

要保留的定制写在 profile 里本插件行（`id: compaction-targets`）的 `config.presetOverrides.<presetId>` 中，例如：

```yaml
- id: compaction-targets
  config:
    presetOverrides:
      standard:
        - id: tool-subagent
          config:
            maxDepth: 2
```

覆盖项按插件行 id 匹配（可命中分组内的行）：`config` 逐键合并，`disabled` / `name` 直接覆盖；上游没有这个 id 时作为新行追加。

**未声明的差异会让保存直接失败**，并列出每一处路径（例如 `delegation.tool-subagent.config.maxDepth`）。两种处理：写进上面的 overlay，或在页面勾选「丢弃未声明的定制」后保存——被丢弃的项会在保存结果里逐条列出。上游有、profile 行没有的内容（陈旧拷贝）不算定制，直接按上游修正。

页面 GET 会返回每个预设的 `hasOverride`（是否已有覆盖）、`upstream`（能否读到上游声明）、`drift`（与上游的差异路径），打开页面即可看到陈旧点，不必先保存。

## 写入安全

- **SAVE 是唯一写入入口**。加载插件、GET、打开页面都不写任何文件。
- 写前重新解析候选 patch：断言非目标预设的顶层结构不变；目标预设断言等于「上游声明 + overlay + 三个受管字段」。
- 重建出的预设行必须与上游声明逐字段一致，只有三个受管字段允许变化；其它字段被改动即拒绝写入。声明里丢了 `name:` 的行会补回标准预设里同名插件的名字，补不回来时拒绝写入。
- 顶层条目不一定带 `id`（Loader 方言允许 `- insert:` 行把真实 id 放在 `insert` 里）：这类行按「在无 id 行中的序号」匹配；无 id 行被改动或消失同样拒绝并回滚。
- 写后再次解析，逐模型断言 `floor(min(window × ratio, window − actualReserve − headroom))` 严格等于目标；差 1 token 也回滚。
- 第一次真正写入前在被写文件旁创建整文件备份 `~/.dsh/cordis.patch.yml.bak-YYYYMMDD-HHMMSS`（同一秒重名追加序号，不覆盖已有备份）。临时文件 + rename，失败回滚。
- 同一组数字重复 SAVE 返回 `changed: false`：不写 patch、不建备份。
- 只有 patch 确实变化时才刷新 `~/.dsh/compaction-targets.json`；JSON 写入失败会明确报告。

## 子代理模型选择与默认路由

| 位置 | 键 | 谁维护 |
| --- | --- | --- |
| 预设 `delegation` 组的 `tool-subagent` | `modelSelection`、`modelDiscovery` | 上游声明；生成的预设行只读保留 |
| 预设 `delegation` 组的 `tool-subagent` | `agentOptions` | **本页**；和压缩值一起写入 |
| Host 行 `subagent-model-selection-settings` | `enabled`、`allowedModels` | **人**，写在 profile 文件里；页面只读显示 |

- `modelSelection: true` 才给模型暴露 `provider` / `model` / `reasoning_effort` 三个字段；`modelDiscovery: true` 注册 `list_subagent_models`（同一作用域只能有一个实例开，上游只给 spawn 开、fork 不开）。
- `agentOptions` 是**子代理的默认路由**：父级没有显式指定时的默认模型；显式指定时以显式值为准，并清掉这里配置的 `reasoningEffort`（改用所选模型的默认档位）。页面只改 `subagent`（spawn）一行；`subagent_fork` 仍继承父会话路由。
- 默认路由不必出现在 `allowedModels` 里：那份清单只限制**模型显式选择**的路由。页面在选择非清单路由时会提示这一点。
- 下拉里的模型和 effort 都来自 `llm-pi-ai`：新选一个清单外的模型、或该模型没声明的 effort，保存直接失败；**行里原本就有的**这类值按原样保留并在保存结果里说明（模型被移出清单不至于卡住其它保存）。
- 页面值写在 home 层，因此**压过 profile 的 `presetOverrides`**。overlay 里若还声明着 `agentOptions`，只剩「首次写入时的基线」作用；页面会提示这处不一致。`agentOptions` 不算「未声明的定制」，不出现在 drift 里。
- 未勾选的预设不会被写入；改动某行的默认路由会自动勾选该预设。
- **预设版本和授权都在会话创建时固定**：改了预设行或 `enabled` / `allowedModels` 都要新建会话才生效，已打开的会话继续用旧版本。

GET 的 `modelSelection` 段给出当前状态（授权行、每个预设的路由与来源、检查项如 `policy-disabled`、`preset-model-selection-off`、`default-route-not-allowed` 等）。SAVE 请求体里 `subagentRoutes` 是 `{ presetId: route | null }`（`null` = 继承父会话路由，缺省 = 不改）；结果回显写入值与原样保留的说明。

## 安装

```text
plugin_manager action=install_bundle
target=<本插件目录的绝对路径>
```

安装只新增 bundle patch 里的 `compaction-targets` include，并按正常语义更新 profile `package.json` 的依赖和 `dsh.profile.bundles`；不手动改任何现有条目。

改了插件源码后不必重启客户端：`set_bundle` 停用再启用一次即可让 HMR 重新载入模块（`install_bundle` 对已安装的包会直接拒绝）。

## 验证

```bash
node --test test/*.test.mjs   # 在本插件目录下执行
```

保存成功后页面会显示写入路径、备份路径、每模型目标/实际落点、被丢弃的差异、写入的子代理默认路由，并提示「预设版本在会话创建时固定，请新建会话后生效」。**新建会话由用户执行**；插件不会重启客户端，也不改动已打开的会话。

## 回退

1. `plugin_manager action=remove_bundle target=@local/dsh-compaction-targets`
2. 删除本插件目录。
3. 若手工残留：只删 profile patch 中 `id: compaction-targets` 的 insert/row 块。
4. `compaction-basic` 会保留最后一次 SAVE 的值；恢复写入前配置可用最近一次 `~/.dsh/cordis.patch.yml.bak-*`，或只还原该配置块。备份不会在 remove 时自动删除。
5. 生成行留在 home 层里不影响其它功能（只是普通 overlay 行），删掉它们即退回上游默认的压缩参数。

## 依赖

`vendor/js-yaml.cjs` 是 js-yaml 4.x 的单文件构建（MIT，许可文本在 `vendor/js-yaml.LICENSE`），只用于 Host 侧读写 patch，不参与浏览器端。
