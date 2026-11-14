# DSH Plugins

DeepSeek Harness（DSH）的独立插件集合。每个插件自包含，不修改 DSH Core；安装与配置细节见各插件目录的 README。

| 插件 | 简介 |
| --- | --- |
| [dsh-compaction-envelope](dsh-compaction-envelope/) | 让压缩摘要请求继承会话的思考强度，命中提供方 prompt cache |
| [dsh-compaction-targets](dsh-compaction-targets/) | 按模型设置压缩触发点与子代理默认路由的设置页 |
| [dsh-material](dsh-material/) | 客户端材质层：渐变、半透明、毛玻璃，十四套配色与三条调节滑杆 |
| [dsh-model-control](dsh-model-control/) | 切换模型自动用最高思考强度；逐回复显示实际模型标签 |
| [dsh-model-history](dsh-model-history/) | 只读记录会话实际使用的模型与思考强度 |
| [dsh-session-collab](dsh-session-collab/) | 独立会话间的自主协作，按任务难度选择模型 |
| [dsh-session-reaper](dsh-session-reaper/) | 历史会话载荷按需回读，内存压力下驱逐宿主缓存 |

## 通用安装方式

插件以 `link:` 依赖挂进 profile（`~/.dsh/profiles/<profile>/package.json`）：

```json
"dependencies": { "@local/dsh-<name>": "link:<插件目录的绝对路径>" }
```

并加入 `dsh.profile.bundles` 数组才会激活：

```json
"dsh": { "profile": { "bundles": ["@local/dsh-<name>"] } }
```

也可以用 `dsh plugin --profile <profile> add <插件目录>` 或 Plugin Manager 的 `install_bundle`。各插件自带的 `cordis.patch.yml` 会插入默认配置行，可在 profile 的 `cordis.patch.yml` 里覆盖。

## 许可

MIT。
