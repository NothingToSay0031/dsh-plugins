# @local/dsh-compaction-targets

DSH desktop profile 的“压缩点”设置页。它把绝对 token 目标换算成
`compaction-basic.config` 需要的 `thresholdRatio`，按勾选的 Agent 预设分别写入
`cordis.patch.yml` 的 `preset-*` 覆盖行，并把每个预设的 `tool-result-pruner` 关闭。

## 功能边界

- 模型清单来自当前 profile patch 的 `llm-pi-ai.config.providers` 下所有带非空 `models` 的 provider，不硬编码 provider 和模型。
- 每行只填压缩点 token；模型的实际输出预留 `maxTokens` 由 `llm-pi-ai` 决定，页面只读，
  不提供编辑。插件写回时仍按实际 `maxTokens` 校验安全上限。
- `modelPolicies` 只写用户勾选“写入单独策略”的模型；未勾选模型保持 fallback 行为。
- 保留现有 `thresholdRatio` fallback；全局 `retainTokens`、`headroomTokens`、
  `compaction-basic.maxTokens` 可编辑。
- SAVE 是唯一写入入口。加载 Host 插件、GET、打开设置页都不会写任何文件，也不会自动校正
  JSON 或 patch。
- Host 通过 `ctx.configEditor.documentPath` 定位 profile patch（桌面进程没有
  `DSH_PROFILE_DIR` 环境变量）；测试/CLI 仍可用 `DSH_PROFILE_DIR` 回退。
- 预设列表来自 `agentPresets.list()`，每个预设的基础 plugins 来自
  `agentPresets.readDocument()`。默认勾选所有可用预设；`standard` 使用已有覆盖，其他预设
  生成完整的 `preset-*` 覆盖行。GET 的 `profilePresets` 列出当前 patch 里实际存在的
  `preset-*` 行，`presets[].hasOverride` 标记每个预设是否已有覆盖。每个勾选预设的
  `tool-result-pruner` 都会写成 `disabled: true`；预设本身没有这个插件时保持没有。
- 写前重新解析候选 patch，断言非目标预设的顶层结构不变、目标预设 compaction 之外的内容不变。
- 写后再次解析并逐模型断言 `floor(min(window * ratio, window - actualReserve - headroom))`
  严格等于目标；差 1 token 也回滚。
- 第一次真正写入前创建整文件备份
  `cordis.patch.yml.bak-YYYYMMDD-HHMMSS`（同一秒内重名时追加序号，不覆盖已有备份）。
  临时文件 + rename；失败回滚。
- 同一组数字重复 SAVE 返回 `changed:false`，不写 patch、不建 backup、不产生 diff。
- 只有 patch 确实变化时才刷新 `~/.dsh/compaction-targets.json`；JSON 写入失败会明确报告，
  不会把失败说成成功。

## 安装

```text
plugin_manager action=install_bundle
target=<仓库根目录>/dsh-compaction-targets
```

安装只新增 bundle patch 里的 `compaction-targets` include；Plugin Manager 还会按正常语义更新 profile `package.json` 的依赖和 `dsh.profile.bundles` 选择。不手动改 `preset-standard`、`llm-pi-ai` 或任何现有条目的内容。

## 验证

```powershell
node --test test/targets.test.mjs   # 在本插件目录下执行
```

UI 的“应用到预设”区域会明确提示：保存会关闭每个勾选预设的 `tool-result-pruner`，
预设里没有这个插件时保持原样。保存成功后会再次提示，并显示写入路径、备份路径、
每模型目标/实际落点，以及“需要重启客户端才生效”。**重启由用户执行**；插件自身不会重启客户端。

## 回退

1. `plugin_manager action=remove_bundle target=@local/dsh-compaction-targets`
2. 删除本插件目录 `dsh-compaction-targets/`
3. 若手工残留：只删 profile patch 中 `id: compaction-targets` 的 insert/row 块。
4. `compaction-basic` 会保留最后一次 SAVE 的值；恢复写入前配置可用最近一次
   `cordis.patch.yml.bak-YYYYMMDD-HHMMSS`，或只还原该配置块。备份不会在 remove 时自动删除。

## 依赖

`vendor/js-yaml.cjs` 是 js-yaml 4.x 的单文件构建，MIT 许可，许可文本在
`vendor/js-yaml.LICENSE`。它只用于读写 profile patch，不参与浏览器端。
