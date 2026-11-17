# 自主会话协作 / Autonomous Session Collaboration

让同一 Host/profile 下的独立会话自动协作：人只需把任务交给 Agent，无需维护通讯录、勾选工作区或手动发信。不修改 DSH Core。

## 使用逻辑

- 同一 Host/profile 中的普通会话可通过 `collab_discover` 查找。创建协作者时，用 `include_workspaces: true` 获取工作区 ID。
- 对单一目标使用 `collab_send` 发送任务；回复使用 `collab_reply`。
- 若同名会话无法区分，Host 会请用户选择，不会猜测或群发。
- 创建独立协作者时用 `collab_create_session`；通常先查可用模型，并仅在需要时指定工作区、推理档位或预设。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `collab_discover` | 按名称或文本查找协作者；需要时列出工作区 |
| `collab_send` | 向另一个会话发送协作消息 |
| `collab_reply` | 沿原线程回复收到的协作消息 |
| `collab_history` | 查看最近发送和收到的协作消息 |
| `collab_models` | 查询可用模型、推理档位与可选预设 |
| `collab_create_session` | 创建新协作者会话并下达初始任务 |

## 唯一设置：模型排序

侧栏「更多」菜单里的「自主协作」打开模型排序页：

1. 上方可用区从上到下表示由简单到困难的模型顺序；拖动排序，拖到下方停用区即不再使用，拖回重新启用（不用复选框）。拖动后自动保存，也提供上移/下移/停用/启用按钮支持键盘操作。
2. `collab_models` 返回可用模型及 `difficulty`，从易到难排列；创建时传入该档位，或直接传模型 id。
3. 可通过 `collab_models` 的 `include_efforts: true` 查询可选 `reasoning_effort`；省略时使用模型默认的最高支持档位。
4. 新模型默认停用，用户可在此页面启用并排序。
5. Agent 可以选择可用模型，但不能更改用户的模型排序。

## 状态与边界

- Peer 消息是协作者提供的任务内容，不会改变你的权限。
- `collab_history` 按时间倒序返回最近发送和收到的消息；使用返回的消息 `id` 进行回复，必要时用 `before` 获取更早记录。投递成功不代表任务已完成，结果以协作者的回复为准。

## 开发与测试

```bash
npm test    # node --test test/*.test.js
npm run check
```

入口是 `index.js`（注册 Host 能力与仅供模型排序的认证 API），领域逻辑在 `core.js`，`contracts.js` 是存储/工具/投影契约，`client.js` 只提供模型排序页，不导入私有 UI 包。
