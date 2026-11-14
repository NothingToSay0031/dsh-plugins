# 材质 / Material

给 DSH 客户端加一层「材质」：渐变、半透明、毛玻璃模糊。它不注册主题 id，也不改 Appearance 偏好，只把自己的 token 层叠在用户当前主题之上；light / dark / system 三种外观偏好全部继续生效。

## 为什么用 overrideTokens

| 做法 | 结果 |
| --- | --- |
| `register()` + `setTheme()` | 第三方主题 id 不落盘（`setTheme` 只为 light/dark/system 写设置），重启即丢 |
| 注入全局 CSS / 写 `localStorage` | 绕过生命周期，卸载后残留副作用 |
| `overrideTokens(source, tokens)` | 一层可精确释放的覆盖，随插件卸载干净撤掉 |

每个 token 写成 `{ light, dark }`，运行时按当前配色自动选边。`flat`（原始）档直接释放这一层，内置样式原样透出，相当于未安装。

## 配色

浅色下十四套配色可直接切换，外加 `flat`：

| 档位 | 出处 | 气质 |
| --- | --- | --- |
| `soft` 柔和 | 本项目手调 | 冷调蓝灰，薄玻璃 |
| `vivid` 玻璃 | 本项目手调 | 紫蓝，更厚的模糊与投影 |
| `latte` 拿铁 | Catppuccin Latte | 奶咖底、薰衣草淡色 |
| `rose` 玫瑰 | Rosé Pine Dawn | 暖纸色、灰紫 |
| `sage` 鼠尾草 | Everforest Light | 米纸、苔绿与薄荷 |
| `nord` 极地 | Nord Snow Storm | 雪原冷灰蓝 |
| `solar` 日光 | Solarized Light | 暖米纸、深青蓝 |
| `one` 简白 | Atom One Light | 近白纸、钴蓝 |
| `github` 墨白 | GitHub Primer Light | 冷灰白、链接蓝 |
| `flexoki` 纸墨 | Flexoki Light | 暖纸底、焦橙主按钮 |
| `gruvbox` 暖阳 | Gruvbox Light | 奶油黄、深橙与青 |
| `ayu` 晴空 | Ayu Light | 清透白、天蓝 |
| `kanagawa` 莲花 | Kanagawa Lotus | 宣纸黄、靛蓝 |
| `tokyo` 东京 | Tokyo Night Day | 蓝灰日光、夜蓝 |
| `flat` 原始 | — | 不加任何层 |

`soft` / `vivid` 逐 token 手调；其余十二套由 `soft` 的**结构**重着色而来——渐变角度、alpha、token 槽位完全一致，只换十来个角色色（画布、玻璃、淡色、描边、强调、按钮、提示条）。颜色取自各主题公开的调色板，只做两件工程化处理：把大面积底色抬到浅色模式下正文仍满足 WCAG AA 的亮度；把焦橙、靛蓝这类主色压到白字对比度 4.5:1 以上。小面积淡色和 hover 保留原主题色相。新配色还会接管 `soft` 有意留给内置品牌色的三个 token（`brand-primary`、`button-primary-fill/-hover`），让强调色跟着配色走。

## 面板与滑杆

入口在侧栏「更多」菜单。面板上方是**实时预览**：条纹壁纸垫在磨砂菜单与玻璃卡片下，输入框、代码块、diff 行都读当前 token，拖动滑杆或切换配色立即反映。下方三条滑杆使用真实单位：

- **不透明度** 0%–200%：乘在 21 个「玻璃面」token 的 alpha 上（卡片、侧栏、菜单、输入框、气泡、按钮底等）；行内码、diff 行、状态色这类实色不动。
- **模糊** 0–160px：菜单 backdrop-filter 的 blur 半径，`0` 关闭磨砂；输入区遮罩按原比例跟随。接管输入区的卡片（提问卡、计划评审、审批卡）复用同一档。
- **饱和** 0%–400%：backdrop-filter 的 `saturate()`；默认值来自配色本身（柔和 180%、玻璃 200%）。

首次打开显示配色原值；动过之后就是绝对数值，换配色不覆盖。「细节」标题右侧有**重置滑杆**按钮，未改动时置灰。滑杆即时生效，450ms 防抖后整组写回 profile 的 `cordis.patch.yml`；浏览器自己不存任何东西。模糊和饱和没动过时不写入，保持「跟随配色」：

```yaml
- id: local-dsh-material
  name: "@local/dsh-material"
  config:
    preset: vivid
    opacity: 1
    blurPx: 46
    saturatePct: 200
```

切到 `flat` 时预览仍在、滑杆置灰，并提示「原始档没有材质层」。

## 覆盖范围

覆盖面按「消费方读什么槽位」决定：同一个面在浅色里能接渐变，它的兄弟 token 未必能——例如 `--dsw-alias-markdown-code-block` 被 21 处 `background-color` 读取，只能给实色（渐变进 `background-color` 会整条声明失效），而它上面的 banner 只被 `background` 读取，可以给渐变。校验脚本逐 token 给出结论。

侧栏白色卡片来自 `--dsw-alias-bg-layer-1/-2`：本层写成带淡色的近白并降低 alpha，卡片透出画布颜色而不是糊成白纸。交付卡片（「已交付文件」卡、计划卡、日程卡）的组件样式直接写静态调色板 `--dsw-static-neutral-50/-100/-850/-800` 而不经过 alias；这四个名字同样声明在 `body` 上，本层把它们写成与 `bg-layer-2` 对齐的玻璃底，于是这些卡片与界面其它卡片是同一种材质。

## 兼容样式表：唯一一处非 token 的例外

少数组件把值写死在自己身上，token 覆盖够不到，需要一张随插件生命周期存活的兼容样式表（`<style data-dsh-material="compat">`）：

- **会话悬浮卡**：HoverCard 把 `--dsw-hovercard-bg: #2C2C2E` 写在卡片元素自身，元素自身声明压过任何继承值，body 层刷不动它。样式表把该变量交还给 body 层（`inherit`），再补描边、backdrop-filter 和投影；卡内文字改回主题的三级层次（标题 primary、路径/时间 secondary、状态 tertiary）。`preview` / `media` 变体自带底色，只补同一道模糊——它们同样是半透明面，不模糊就会把背后的文字透上来。
- **提示条与通知条**：底色与文字色是 token，但墨色写死在组件里（Tooltip 写死纯白、Toast 操作链接写死深色主题的蓝）。浅色档下它们不再是两块黑岛：提示条换成浅色玻璃 + 主题文字色，通知条操作链接改指 `--dsw-alias-brand-primary`。
- **输入区遮罩**：`.composerSeat` 原本刷一层「透明→画布实色」的遮罩，实色部分正好落在停靠卡（任务面板、队列面板）背后，半透明卡片只能磨一块平色。样式表把遮罩搬到输入卡根上（渐变是背景层，画在内容下面），停靠卡背后重新是正文，可以真正磨出毛玻璃。
- **接管输入区的卡片**（代理提问卡、计划评审、审批卡）：本层把它们的底色 token 写成半透明，但组件没有模糊，卡片文字会和背后正文叠在一起。样式表在运行时认出它们并补上 backdrop-filter。识别特征刻意收窄：同时「读输入面色 + 取会话内容宽度 + 一条自己的声明」才算接管卡；输入卡自己取的是另一个宽度变量，不会被误认。
- **浮层按钮**（选中正文后的「引用」胶囊、「回到底部」、计划卡「打开」等）：读 `--dsw-alias-button-floating-fill`，本层写成 78% 近白——半透明却没有模糊，按钮压在正文上时两层字叠在一起。样式表按「谁读了这个填充」找出这些浮层并补模糊。

选择器全部在运行时从 `document.styleSheets` 读取：CSS 模块每次构建都会换哈希，写死类名下次发版就失效。样式表挂在 `document.head`，`MutationObserver` 盯着 head 变化，懒加载 chunk 到达后重建。

## 选中色

浏览器自带选中高亮是硬蓝（Chromium `#3390FF` 配白字），不属于任何一套配色。平台没有 `::selection` 规则，也没有可复用的选中 token。本层自定义 `--dsw-material-selection`：每套配色给出自己强调色的一层半透明淡色，兼容样式表把它交给 `::selection`，并把选中的文字显式设为主题的 `--dsw-alias-label-primary`（UA 默认选中文字是白色，浅色底上会读不出来）。十二套后加配色在重着色时一并替换该 token。这是本包唯一一个平台不认识的 token，读它的只有本包自己的样式表；校验脚本逐套验证「选中文字在自己的高亮上仍过 AA」。`flat` 档撤掉样式表，选中色回到浏览器默认。

## 降低透明度（系统设置）

系统声明 `prefers-reduced-transparency: reduce` 时，不退回 `flat`，而是把同一档材质「加厚」：

- 21 个「玻璃面」token 的 alpha 抬到 0.96 以上，渐变结构保留；
- 14 个本就不该透明的淡色 token（行内码、状态淡色、diff 行、提示条/通知条底等）按当前画布合成为实色——像素观感一样，但没有透明层；
- 2 个模糊 token 改成 `none`。

降级只在渲染时发生，用户选的档位不变，面板原地说「材质已加厚并关闭模糊」，关掉系统设置自动恢复。三条滑杆只影响未降级的渲染路径，系统设置永远优先。校验脚本对每个半透明 token 检查它是否被正确分进这三类。

## Windows 标题栏

桌面端标题栏不是 CSS，而是 `setTitleBarOverlay` 的入参：preload 用一个读 `--dsw-specific-sidebar-fill` 的探针取像素。渐变在这个槽位里整条声明失效、算作透明，标题栏会变成一条透明带。因此 `html[data-platform='win32']` 时本层把该 token 换成「侧栏渐变首段合成到画布上」的实色，其余表面照旧渐变；`data-platform` 晚到也会被 `MutationObserver` 接住重绘。Web 端没有这个属性，完全走原路径。代价是 Windows 上侧栏顶端在标题栏高度内只剩单色。

## 安装

```bash
dsh plugin --profile web add <本插件目录的绝对路径>
```

Desktop 用同一份前端产物，`dsh.client.platform` 保持 `web`，只换 profile：

```bash
dsh plugin --profile desktop add <本插件目录的绝对路径>
```

两条命令都只把包装进 profile；真正决定激活与否的是 `package.json` 的 `dsh.profile.bundles`。手工挂载需要三项：`node_modules/@local/dsh-material` 指向源码的链接、`dependencies` 里的 `"link:<路径>"`、`bundles` 数组里加 `"@local/dsh-material"`。少第三行就是「装上了但没激活」。

插件页卡片的名称与简介来自 `locale/en.json` / `locale/zh.json` 的 `meta`，图标走 `./icon` 导出；`exports` 必须放行 `"./locale/*.json"`，否则卡片退回显示包名。

默认档位可在 profile 的 `cordis.patch.yml` 里改（`preset: soft | vivid | latte | … | flat`）。Host 条目要解析 `@deepseek-ai/schemastery`（已在 `dependencies` 声明）。写回配置要求条目带 `.volatile()` 字段的 `Config` schema：没有 schema 时 settings 服务拒绝整个命名空间；volatile 字段解析出来是 `{ get() }` 盒子，必须 `.get()` 读。写回被拒时材质层本次会话仍生效，面板把「未能保存」显示在原处。

本地开发注意：用软链挂未发布的包时，pnpm（或权限不足的 `ln -s`）可能把它复制成真实目录，复制体不跟随源文件更新，现象是「改了代码但页面里还是老行为」。请确认 `node_modules/@local/dsh-material` 是链接：Windows 目录用 `mklink /J`（junction 不需要开发者模式）。Host 侧依赖解析失败时条目只是安静地不激活（启动日志一行 `failed to import`）。

## 校验

```bash
pnpm run validate                 # node tools/check-materials.mjs
node tools/check-materials.mjs --tokens bg-    # 逐 token 的「渐变安全」结论
node tools/check-materials.mjs --coverage      # 反查：能覆盖但还没写的 token
```

静态扫描真实的 DSH 样式表，对十四套配色逐条回答：变量名是否存在、body 内联覆盖能否作用到它、消费方接受的值类型是否匹配、合成后的表面是否满足 WCAG AA（原始、加厚、滑杆两端各跑一遍）、两层半透明叠加的透过率是否在预算内、每个半透明/模糊 token 是否被加厚逻辑正确分类、Windows 标题栏探针 token 换成实色后是否仍可栅格化且与标题文字保持 AA、选中色是否仍过 AA，以及兼容样式表里两条非 token 规则（`::selection` 与浮层模糊）是否还在。

```bash
node tools/capture-web.mjs <token-url>
```

静态扫描只能证明「理论上够得到」。这个脚本开着真实的 `dsh web` 跑 34 个场景（浅色十四套 + 深色各视图），每个场景截图，并对全部 token 出四组证据：`painted`（真的有元素画出这一层的颜色）、`resolves`（读该 token 的规则命中的元素上解析成本包写的值）、`stood-in`（屏上没有匹配节点时用替身元素量一次）、`live` / `readers`（命中元素数 / 读该名字的规则数）。`resolves` 与 `stood-in` 用于区分「这一层没覆盖到」和「这个视图刚好没打开那个表面」（滚动条伪元素、hover、懒加载 chunk 等）。每个场景还会临时把 `data-platform` 改成 `win32` 再撤销，验证 Windows 分支生效、Web 分支不被改道、撤销后层原样恢复。三个滑杆另有独立探针（最小/最大/重置/持久化读回）。`NOSTUB=1` 时不 stub 系统降低透明度设置，同一套断言跑加厚后的读法。

## 已知边界

- 文档画布 `--dsw-alias-bg-base` 被 `background-color` 读取，只能给实色；渐变放在只被 `background` 读取的面。
- `--dsw-alias-bg-layer-1/-2` 同时喂给轨迹视图的 `box-shadow`，所以用半透明实色而非渐变。
- 能覆盖 alias 层与声明在 `body` 上的静态调色板；覆盖不了派生层——`--dsh-scrollbar-thumb`、`--dsw-elevation-stroke-color` 等在各自样式表里被重新绑定到背后的 alias，按派生名覆盖会被局部重声明吃掉，所以本包改的是 alias 名。反过来，直接写在 `body` 上的派生 alias（如 `--dsw-alias-settings-card-fill`）会跟着本层自动变，故意不写，避免把 `var()` 链拍成死值。
- 插画页与一次性引导页的底色（`--dsw-static-neutral-bluish-00`、`--dsw-alias-onboarding-*`）不在材质内：插画自带构图，染上画布色反而脏。
- `--shiki-*` 语法配色是写死的十六进制，不接 alias，不随材质变化；代码块底色、banner、diff 行、行内码照常被覆盖。
- 十二套后加配色的深色读法由 `soft` 的深色结构混入各自色相生成，表面层级与对比度一致；要用深色时优先 `soft` / `vivid`。
- 输入区遮罩搬走后，停靠卡两侧的空当不再被实色遮住，正文直接可见——「磨得到正文」与「背后有实色」不能同时成立，与本包其它浮层的读法一致。
- 接管卡的识别依赖平台现有的那条声明，平台若更换声明，识别特征要跟着改。
- 面板没有返回/关闭按钮，选中任意会话即可离开（宿主面板槽位的现状）。
- 材质层在插件加载后才生效，首帧仍是内置配色（未声明 `immediately`，避免抢在 ui-theme 之前注册）。
- 模糊只在渲染进程内部取样；桌面端真正「透出窗外」需要应用侧配合，本包不处理。
- 兼容范围写在 `engines.dsh`：`>=0.2.1-rc.4 <0.3.0`。token 名是本包的依赖面，跨小版本升级请重跑校验脚本再放开范围。
