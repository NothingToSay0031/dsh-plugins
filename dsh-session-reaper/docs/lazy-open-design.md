# lazyOpen 设计笔记：为什么默认关闭，以及怎样才能真正优化

本文记录 session-reaper 的 open-time 懒加载（`lazyOpen`）从「引入 → 暴露冻结 → 定位根因 →
自适应折中 → 默认关闭」的完整推理，以及治本方向。结论先行：

- **`lazyOpen` 默认关闭。** 默认路径 = eager 解码（让出式）+ 打开后回收（稳态内存有界）。
- `lazyOpen` 保留为**可选**的「按内存 headroom 自适应常驻前缀 + 懒尾部」模式，供「打开瞬间峰值
  才是硬约束」的部署手动开启。
- **治本**（open 不读整份、因而也不冻）需要宿主把 open 接上已有的「投影检查点 + 尾部重放」梯子，
  或把构造器折叠改异步 / worker 隔离。这是内核改动，插件边界内做不到。

## 1. 症状与架构事实

症状：打开一个超大会话（数十万事件 / 数百 MB 压缩日志）时，**所有**会话标签都停在「加载中」，
重启后复现（启动恢复先打开上次活跃的大会话）。

架构事实（决定了一切取舍）：

1. Desktop 只有**一个 host 进程、一条 Node 事件循环**，所有会话的 open / history RPC 都在它上面。
   同步代码执行期间，其他会话的请求只能排队。「一个会话加载、全部加载中」= 主循环被同步段占住。
2. 宿主对 Session 的建模不变量：**完整 append-only 事件数组 + 由全量重放派生的 surface**。
   open 时构造器逐事件做信封校验、seq 连续性、`validateNext`（surface 折叠）、push；
   message projection 会读每个 message 事件的 `data`。因此 open **必须读整份载荷**，这不是显示
   的需要（显示只要 surface 尾部），而是模型 / 消费者（`append` 用 `log.length` 定 seq、
   `eventAt/snapshotEvents`、query、fork）假设全量 log 在场。
3. surface 的 replace op 引用更早的 seq；丢前缀会让 `replacementRange` 找不到节点、折叠出错误
   surface。所以「只给尾部 seed」的 naive fake-open 会 throw 或显示错，不可行。

## 2. 三种部署位置，同一套懒加载机器

懒视图 + 磁盘帧索引 + 有界回读 LRU 是同一套机器；区别只在**插入点**：

| 模式 | 插入点 | 常驻峰值 | open 同步段 | 稳态内存 |
| --- | --- | --- | --- | --- |
| 纯 eager（无插件） | 解码时全量解析 | 高（≈2×磁盘） | 短（冻结+折叠） | 高（不释放） |
| eager + 打开后回收（默认） | 解码后 tick 释放窗口外 | 高（transient） | 短 | 低（窗口） |
| open-time lazyOpen（原样） | 解码时给视图 | 低 | **长（全量同步回读）** | 低 |
| 自适应 headroom（opt-in） | 解码时常驻前缀+懒尾部 | 被 headroom 夹住 | ∝未覆盖比例 | 低 |

关键因果：**getter 是同步的，构造器折叠也是同步的**。open-time lazyOpen 把「解压+解析」从
eager 的**让出式解码阶段**搬进了**同步折叠阶段**，于是 open 临界路径 = 全量同步回读 → 冻。
打开后回收发生在折叠**之后**：折叠读已常驻对象（便宜），回收在 tick 慢慢释放，释放后的零星回读
不在 open 临界路径 → 不冻。

原 lazyOpen 的 README 本就承认「open time is not reduced / 冷打开 1.5–2.5× eager」；其 bench 是
单线程离线测构造耗时，没有「其他会话在同一条主循环上等 RPC」的场景，因此测出了 wall time 却没
暴露「饿死所有会话」的 UX 后果。**冻结不是实现 bug，是原设计用打开期同步回读换无常驻峰值的固有
代价。**

## 3. 本次修复的实现层缺陷（已修，与架构取舍无关）

即便接受「open 期同步回读」，原实现还有三个把代价放大到无界 / 不必要的缺陷：

1. **索引自驱逐 thrashing**：`index-pool.trim()` 把「单帧解码文本缓存」（宽帧可达数十 MB）计入
   字节预算，读一个宽帧就把**正在被读的索引自己**驱逐；下一次读取重新 adopt 整张帧表（解析数十万
   条记录）+ 重解压 + 重解析 → 每读一次付一次全表 adopt，同步段从几十秒放大到几十分钟（无界）。
   修复：字节超预算不再驱逐 MRU（活跃读者），按 LRU 在他会话接管后回收。
2. **启动安装空窗**：解码包装等到第一个巡检 tick 才挂载，启动恢复落进 eager 整体解码 → 峰值
   逼近 V8 上限 → GC 风暴。修复：后端就绪后 250ms 快速重试安装。
3. **回读双重全量遍历**：每次 hydrate 在 `JSON.parse` 之外再跑一遍 `estimateBytes` 全量遍历做字节
   记账。修复：改 O(1) 可证上界（44×行字符+64；对象节点 ≤L/2、键/串计数与字符总量各 ≤L、其余标量
   ≤L，代入完整遍历规则即得），只高估不低估，内存 ceiling 承诺不变。曾试 reviver 精确累加，反而
   失去 `JSON.parse` 快路径、比独立遍历更慢，已弃用。

另修 `advance` 中 `> 1 << 18` 的优先级 bug，并给 `loaded` 遥测加版本号便于现场确认。

## 4. 自适应 headroom（opt-in）：把代价随可用内存平滑分配

开启 `lazyOpen` 时，打开时计算 `headroom = V8 上限 − 当前 heap − lazyOpenHeadroomMB`：

- 整份常驻估算（≈2×磁盘）≤ headroom → 回退 eager（**不冻**）；
- 否则在**让出式**异步阶段预解析一个 sized-by-headroom 的常驻前缀，仅未覆盖尾部给懒视图 →
  折叠只同步回读未覆盖部分，冻结时长 ∝ 未覆盖比例，峰值被 headroom 夹住不 OOM。

内存宽裕 = 不冻；紧张 = 峰值有界 + 冻结缩短；极端紧张 = 近乎全懒保命。它比原 lazyOpen 好（宽裕时
不冻），但**没有消除**「同步折叠必须读载荷」的根，只是把尽可能多的读取挪回让出式阶段。

## 5. 治本：open 接「检查点 + 尾部重放」梯子

「只读最近一段、其余留给运行时」的正确形式不是截断 seed（破坏 seq/surface/append 不变量），而是：

- **持久化 surface / projection 检查点**：在某个 seq 存下折叠态，open 加载检查点 + 只重放其后事件；
- **log 改懒的按-seq 随机访问存储**：前缀给懒视图（不折叠不 hydrate），尾部常驻重放。

DSH **已经造好了一半**：`session-projection-cache` 持久化每个 projection unit 的折叠检查点
（`(sessionId, key, ver, seq, val)`，落 `storages/session_projcache/sessions/<id>.json`），冷读时
`sessionProjections.restore(rows, tail, base, …)` 用检查点种子化已折叠前缀、只重放尾部；丢一次写
只代价「更长的尾部重放」，不会错。**缺口**：这条梯子目前服务 query/projection 冷读路径，而
Session.open 的核心 surface 折叠 + 全量 log seed 没走它，仍从 seq 0 全量重放。把 open 接上这条
梯子（新增 restore mode + 前缀懒视图 + 尾部常驻）即治本；基础设施已在，属 wiring 改动而非从零造。
另一等价方向是把构造器折叠改异步让出 / worker 隔离。两者都是内核改动，需快照回归，插件代劳不了。

## 6. 配置与验证建议

- 默认：`lazyOpen: false`。稳态内存由打开后回收保证（窗口 = max(尾部条数, surface floor) 再被
  `keepLastMB` 夹取）；峰值 transient，有 `triggerMB/pressureMB` 强制 GC + 清回读缓存 + 观察缓存
  容量压 1 兜底。
- 多怪物同开防 OOM 且能接受打开期冻结：opt-in `lazyOpen: true` + 调 `lazyOpenHeadroomMB`。
- 想缩短 transient 峰值窗口：调低 `hotWindowMs`（代价：客户端首次遍历多几次磁盘读，surface floor
  保证下一轮压缩/prompt 要读的节点仍常驻）。
- 验证：遥测 `loaded.version` 确认构建；`lazy-open` / `lazy-open-resident` 行看 open 路径与常驻切点；
  tick 连续性看主循环是否被饿死；`indexPool.misses/evictions` 看 thrashing 是否消失；
  `perSession.windowMB` / `heapMB` 看稳态上界。离线全读基准见私有仓库 `tools/reaper-open-pass.mjs`。
