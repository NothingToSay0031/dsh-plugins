# 会话回收 / Session Reaper

DSH 宿主会把整个会话日志解析后常驻内存，其中工具结果（`tool/result`）等事件的载荷可达数 MB 到数十 MB。会话越长、同时打开的会话越多，堆占用越高。

本插件做三件事：

1. **打开时懒加载**：大会话日志在打开时不再整体解析常驻，而是返回轻量视图，载荷第一次被读取时才从磁盘解压回读（见「打开时懒加载」）。
2. **按需回读历史载荷**：把较早事件的载荷留在磁盘上，内存中只保留轻量视图；某条载荷第一次被读取时，才从磁盘上的会话日志（zstd 压缩）解压读回。
3. **内存压力下释放缓存**：堆占用超过阈值时，驱逐宿主可复用的会话缓存并强制垃圾回收。

它缓解历史载荷常驻带来的堆压力，但不承诺任意会话规模下永不 OOM。

## 工作原理

宿主解析后的 `session.log` 是一个事件数组。插件把常驻窗口之外的事件替换成**延迟视图**：

- `type` / `seq` / `time` 等身份字段仍是真实值，遍历、过滤、排序不受影响；
- `data` / `sourceEventSeqs` / `surfaceOp` 变成 getter，第一次被读取时才用 `zstdDecompressSync` 从磁盘日志的对应压缩帧解出。

由此得到两条基本性质：

- **磁盘日志永不改写**。历史、分叉、压缩看到的事件字节与原来完全一致。
- 每个事件要么完全常驻，要么完全可按需回读，不存在「改了一半」的中间态。

为了按事件定位磁盘上的压缩帧，插件维护一张**帧索引**（每个 zstd 帧的起止偏移 + 事件 seq 区间 + `session/end-seed` 标记），缓存在 `$DSH_HOME/cache/session-reaper-index/`。冷扫描一个大会话日志代价较高，所以扫描按 tick 分片进行（见 `indexBudgetMs`），结果落盘后下次启动直接采用，不必重扫。索引只是加速缓存：删掉它只会让下次启动重扫一次，不影响正确性。索引格式升级到 v3（新增标记段）后，旧版缓存会被拒绝并重扫一次。

## 打开时懒加载

宿主打开会话时会把整个日志解析成事件数组并常驻到会话关闭。实测常驻堆约为磁盘日志的 2 倍（279 MB 的日志约 1.7 GB），同时打开两个这样的会话就逼近 Electron 的 V8 上限（约 4192 MB）。

`lazyOpen`（默认开启）包装 jsonl 后端的解码入口 `decodeStoredLog`——打开与追加后重读都经过它——对不小于 `lazyOpenMinMB`（默认 16 MB）的物理完整日志返回**冻结的延迟视图**：

- 视图的键集与宿主信封校验完全一致（`type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable`）：`seq` 常驻，其余键第一次被读取时才解压对应 zstd 帧；
- **词汇表守卫**：回读时按宿主自己的 `KNOWN_SESSION_EVENT_TYPES` 拒绝「未知且非 `ignorable`」的事件类型，并复用宿主的 `adoptSessionEvent` 做逐事件准入——与 eager 解码的 fail-closed 拒绝一致。该词汇集在首次解码时从宿主模块运行时解析（调用栈锚点 + `createRequire`），**不是硬编码副本**；解析不到时整个懒路径回退 eager，绝不提供无法校验的视图。
- 回读走与打开后回收同一个有界 LRU（`hydrationCacheSize` / `hydrationCacheMB`），字节估算**完整遍历载荷、不截断**，因此字节预算是真实上界而非估算下界。Session 构造期的校验与折叠仍会逐条读一遍载荷，但读过的随即被驱逐，**常驻内存不再跟随日志大小**；超过单条上限的载荷用一个单槽缓存复用同一次解析，避免每个 getter 重复解析。
- 打开时视图与打开后回收共享同一个 handle owner，巡检 tick 会**直接跳过**这些视图（在读 `type` 之前判定），不再为了决定跳过而把整段载荷水合一遍。
- 继承截断点（`inheritedEventCount`）从扫描时记录的 `session/end-seed` 标记推导：取最后一个 `inherited: true` 标记的 seq，与格式编解码器的规则一致。

**打开时间不会缩短**：Session 构造器仍要校验并折叠每个事件。省的是常驻内存，不是延迟。冷打开比 eager 多一整轮索引扫描解压，且构造期每个事件的多个 getter 会多次读取载荷（帧缓存避免重复解压，超大载荷仍可能多次解析），所以冷打开耗时约为原来的 1.5–2.5×；索引落盘后下次打开省去扫描。冷扫描按 `lazyOpenBudgetMs` 分片让出事件循环。

以下情况自动回退到原始解码（行为与未装插件完全一致）：日志小于阈值、非 `.zstd` 后缀、快照与文件长度不符、末尾帧撕裂、seq 不连续（含重复+缺失）、头部含多余键/退休字段/`-0`、头部 `isSeeded` 与标记不一致、头部 id 与会话不符、宿主词汇表解析失败、后端不是 jsonl。已退休的 `request/header`（`data.reason: 'fallback'`）与未知必需事件类型在第一次读取该事件时拒绝。

## 常驻窗口

每个会话保留一段尾部事件完全常驻，窗口起点由三个约束共同决定：

1. **最近 N 条**（`keepLastEvents`）。
2. **surface 下界**。surface（`session.surface.nodes`）是会话当前仍可见的事件节点表：压缩会把较早的对话总结成摘要并遮蔽原事件，但摘要之外仍有未遮蔽的节点。压缩生成摘要时会重新读取它即将总结的那段对话，每轮 prompt 也读取同一组 surface 节点，所以这些节点必须常驻，否则一个回合会变成几百次磁盘读。surface 最老节点之前的事件已被摘要遮蔽、不会再被读，可以整体释放。
   - 边界不能用「最新摘要事件的 seq」：摘要总是追加在日志尾部，只遮蔽它总结过的那段区间，尾部之外仍可能有未遮蔽节点。
   - 节点 0 若是系统提示（`system/message`）则不计入下界：它体积极小且永远在 surface 里。
   - surface 坐标可能异常（投影被移除、旧节点被保留），因此下界最多回溯 `floorMaxEvents` 个事件，超出则夹住并在遥测中标记 `floorClamped`。
3. **字节预算**（`keepLastMB`）。条数不等于字节：同样 2000 条事件，载荷总量可能差几个数量级，而常驻总量 ≈ 打开会话数 × 每会话窗口字节。预算从尾部向前累加事件尺寸，超预算就把窗口起点后移，遥测标记 `byteTrimmed`；若因此切到 surface 下界之前，再标记 `floorTrimmed`——表示下一次压缩需要把这些节点重新读回，是用磁盘读换内存的显式取舍。最新一条事件永远保留；`keepLastMB: 0` 关闭字节预算。

尺寸测量不读取 `data` 字段（读它等于把刚释放的载荷重新读回内存）：替换时把尺寸记在视图上，未替换的事件测一次后缓存，预算只做累加。

刚重新打开的会话在 `hotWindowMs` 内不回收，避免与客户端的首次遍历抢同一份数据。

## 安装与启用

在 profile 的 `package.json` 里加依赖并挂进 `dsh.profile.bundles`：

```json
"dependencies": { "@local/dsh-session-reaper": "link:<本插件目录的绝对路径>" }
```

```json
"dsh": { "profile": { "bundles": ["@local/dsh-session-reaper"] } }
```

插件自带的 `cordis.patch.yml` 会插入配置行。在 profile 的 `cordis.patch.yml` 里可以覆盖：

```yaml
- id: local-session-reaper
  name: '@local/dsh-session-reaper'
  config:
    enabled: true
    dryRun: false
```

注意两点：

- **`dryRun` 代码默认 `true`**（只测量、只写遥测，不替换任何事件），随包附带的 patch 行已把它设为 `false`。
- 覆盖这一行时 `config` 是**整体替换**：需要把关心的字段都写上，未写的字段回到代码默认值。

## 配置

默认值为代码内置值；随包 patch 行另外设置了 `dryRun: false`、`keepLastEvents: 2000`、`evictObservationCache: true`。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时不安装定时器。 |
| `dryRun` | `true` | 只测量、只写遥测，不替换事件。 |
| `intervalMs` | `60000` | 巡检周期（tick 间隔），下限 2000。 |
| `triggerMB` | `1500` | 堆低于此值时整个 tick 提前返回，下限 64。 |
| `keepLastEvents` | `20000` | 每个会话尾部保持常驻的事件条数。 |
| `floorMaxEvents` | `20000` | surface 下界最多回溯的事件数；超出则夹住并标记 `floorClamped`。 |
| `keepLastMB` | `48` | 每会话常驻窗口的字节预算，`0` 关闭。 |
| `types` | `['tool/result','assistant/message']` | 参与替换的事件类型；`'*'` 表示所有类型（依赖 surface 下界保护仍会被读到的事件）。 |
| `hotWindowMs` | `120000` | 刚重新打开的会话在此窗口内不回收。 |
| `lazyOpen` | `true` | 打开时对大会话日志返回延迟视图而非整体解析常驻；需要 `enabled` 且 `dryRun: false`。 |
| `lazyOpenMinMB` | `16` | 小于此值（MB）的日志保持原始解码，下限 1。 |
| `lazyOpenBudgetMs` | `250` | 打开时冷扫描每个事件循环回合的时长上限（毫秒），下限 20。 |
| `indexBudgetMs` | `250` | 每个 tick 允许单个会话冷扫描日志的时长，下限 20。 |
| `indexBuildsPerTick` | `1` | 每个 tick 最多启动几个冷扫描（采用已有缓存索引不受限）。 |
| `indexCacheSize` | `16` | 常驻帧索引的个数上限。 |
| `indexCacheMB` | `64` | 帧索引及其读取/解压缓存的保守字节预算；超预算的索引同步使用后即释放，不进入常驻池。 |
| `hydrationCacheSize` | `256` | 已回读载荷的缓存条数上限。 |
| `hydrationCacheMB` | `64` | 已回读载荷的缓存字节上限，下限 4；单条超过预算 1/4 的载荷只返回、不缓存。 |
| `gcEvery` | `4` | 每 N 个 tick 强制一次 GC（堆超过 `pressureMB` 时每个 tick 都做）。 |
| `pressureMB` | `3200` | GC 后堆仍超过此值时，丢弃可释放的缓存（观察缓存、回读缓存）。 |
| `evictObservationCache` | `false` | 每个 tick 清理会话查询引擎的冷观察缓存中未被引用的条目。 |
| `indexCacheDir` | 空 | 帧索引缓存目录；空表示 `$DSH_HOME/cache/session-reaper-index/`。 |
| `logFile` | 空 | 遥测文件路径；空表示 `$DSH_HOME/logs/session-reaper.jsonl`。 |

### 诊断选项

默认全部关闭，只在排查内存问题时临时打开：

| 键 | 作用 |
| --- | --- |
| `probe` | 对常驻日志做一次字符串长度直方图。 |
| `probeSession` | 逐字段称量每个已加载 Session，定位常驻字节。 |
| `probeAgents` | 称量 agents 服务与各 agent。 |
| `probeFold` | 报告 surface 折叠状态仍持有哪些事件引用。 |
| `probeGlobal` | 对从全局对象可达的结构按大小排序。 |
| `measureDerived` | 称量派生结构（投影、折叠状态等）的常驻字符串体积。 |
| `lazyLogFile` | 显式指定延迟回读用的日志路径；空则从会话根目录解析。 |
| `snapshotPath` | 写一次堆快照供引用链分析（每进程一次）。目标文件已存在时不覆盖；要重新采样请换新路径。 |
| `snapshotMinMB` | 堆至少达到此值（默认 1000）才写快照，避免刚启动就 dump。 |

## 保证

- 磁盘日志只读，任何情况下不写 `session-*.jsonl.zstd`。
- 帧索引只记录**已证明**的帧边界（解码器恰好停住、后续字节能独立解帧、或文件到此结束且文本以换行收尾）；半截帧不记录。正好停在文件末尾、仅靠换行判定的那一帧不写入缓存，下次重读。索引版本/指纹不符即丢弃重建。索引逐事件校验 seq 连续性，非连续（含重复+缺失）的表不落盘、懒打开回退 eager。
- 日志数组被替换时，宿主的解析水位（watermarks）一并作废，否则重新解析出的前缀永远不会再被回收。
- surface 读不出来（投影被移除、会话已脱附）时退化为 `keepLastEvents` 尾部窗口，不让单个会话的异常弄失败整个 tick。
- 字节预算只后移窗口起点，绝不前移；最新一条事件永远保留。
- 延迟视图只持有轻量索引句柄，不固定帧索引本身：索引池驱逐一张表后，旧视图仍可按需重新获取索引，不会把被驱逐的表重新钉在内存里。插件卸载时清空索引池并转为临时读取模式，已替换事件上的 getter 继续有效。
- 打开时懒加载的包装在插件卸载时还原为原始解码；重复安装（插件重载）时每个包装都回退到真正的原始函数，旧实例的卸载不会覆盖新实例的包装。
- 懒打开只在能拿到宿主权威事件词汇集时才提供视图；拿不到就回退 eager。回读守卫与打开后回收共用同一 handle，未知必需类型与退休形状在两条路径上都被拒绝。
- 遥测文件 append-only、多实例共用，每行带实例 id（`boot`），写入串行化，轮转不会吞掉已排队的行。

## 遥测

每个 tick 写一行 JSON 到 `logFile`（超过 8 MB 轮转，只保留一份 `<log>.1`）。`at` 是该行的创建时刻，`boot` 是插件实例 id。每个会话一条 `perSession` 记录：

| `mode` | 含义 |
| --- | --- |
| `lazy` | 正常替换到 `lastSeq`；`pending` 是尚未落盘的事件数。 |
| `dry-run` | 只测量，未替换。 |
| `indexing` | 冷扫描未完成，本 tick 不动它；`scannedMB` 是进度。 |
| `hot` | 处于重新打开的保护窗口内。 |
| `index-deferred` | 本 tick 的冷扫描配额已用完。 |
| `index-rewound` | 日志比索引覆盖的短，索引作废重建。 |
| `lazy-unavailable` | 找不到该会话的日志文件。 |
| `error` | 该会话出错（不影响其他会话），`error` 是原因。 |

顶层字段：`heapMB` / `heapBeforeGC`（强制 GC 后的地板值与峰值）、`ms`（本 tick 占用事件循环的时间）、`hydration`（回读缓存的条数与字节）、`gc`（本 tick 是否强制回收）、`indexPool`（常驻索引数、估算字节、帧数、命中/重建/驱逐计数）。估算字节不等于 V8 精确 retained size，也不含正在同步解码的一帧的瞬时峰值。

打开时懒加载另写几种事件行：`lazy-open-installed`（包装安装成功）、`lazy-open-vocabulary`（宿主词汇集解析结果，`known` 为类型数，0 表示解析失败将回退 eager）、`lazy-open`（一次懒解码成功，含 `events` / `bytes` / `cut` / `ms`）、`lazy-open-error`（懒路径出错并回退，含原因）。

## 已知取舍

- 打开时懒加载省的是常驻内存，不是打开时间：冷打开比 eager 多一轮索引扫描解压，构造期每个事件的多个 getter 会多次读取载荷，冷打开耗时约为原来的 1.5–2.5×（索引 adopted 后省去扫描）。
- 懒路径不调用宿主那个会物化整份日志的逐事件校验器，而是**在回读时复现其关键拒绝**：未知必需事件类型（用宿主权威词汇集）、退休 `request/header` 形状、以及宿主 `adoptSessionEvent` 的逐事件准入。这些拒绝发生在第一次读取该事件时（构造期会读到每个事件，因此实际仍在打开阶段失败），诊断比原始解码略晚。**残余取舍**：整份日志级别的关系校验（生命周期/压缩/catalog/delivery 归属，宿主的 `assertReleasedV4Relationships`）不在懒路径复现——其中 surface 关系仍由 Session 构造器的折叠校验，其余关系校验被跳过。对同版本宿主写出的正常日志无影响；对损坏/异版本日志，这是相对 eager 的一处放宽，已知且有限。
- 一帧可能装多个事件，一次解码也可能跨两帧，所以遥测里的「帧数」是记录条数，不是文件里的物理帧数。
- 真实日志的帧头没有解压后长度字段，「恰好停在文件末尾的帧」只能靠结构判断；一旦后续字节证明边界有误，整张索引自动重建。
- 驱逐冷观察缓存时，会把查询引擎公开的 `cacheCapacity` 字段调低到 1（`dsh-session-query` 的 `SessionObservationReader`，语义是「最多保留几个未固定的冷观察」）。该字段没有 setter，调低它是阻止缓存重新填满的唯一手段。
- 文件身份、首部和长度检查能拒绝可检测的日志重写，但不保证识别同 inode、首部不变的任意中段改写；磁盘日志须遵循宿主的 append-only 约束。

## 验证

```bash
npm test          # node --test test/*.test.mjs：载荷、帧边界、字节预算、索引池、打开时懒加载回归
npm run check     # node --check index.js / lazy.mjs / lazy-open.mjs / index-pool.mjs
```
