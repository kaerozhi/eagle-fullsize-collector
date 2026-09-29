# Eagle 大图批量收藏

**一键安装**：<https://raw.githubusercontent.com/kaerozhi/eagle-fullsize-collector/main/eagle-fullsize.user.js>
（Tampermonkey 会直接弹出安装页）

解决一件事：**图片列表页 / 瀑布流只能批量收藏到预览图，原图必须逐张点进去才加载。**

Eagle 的 Chrome 扩展「批量收藏」读的是页面上 `<img>` 当前的 `src` —— 列表页里那就是缩略图。这个工具在它之前插一手：先把缩略图升级成原图地址，再交给 Eagle。

---

## 组成

| 文件 | 作用 |
|---|---|
| `eagle-fullsize.user.js` | Tampermonkey 油猴脚本（单文件，可直接安装） |
| `rules/default.json` | **订阅规则表** —— 一个站点一条规则，像 AdBlock 列表一样增删改 |
| `tests/` | 回归测试。把脚本本体加载进 `vm` 沙箱跑，见下面「回归测试」 |
| `.github/workflows/ci.yml` | 每次 push / PR 自动跑语法检查、规则表校验、两套回归测试 |

规则表托管在本仓库，脚本的**订阅地址默认就已经填好了**：
`https://raw.githubusercontent.com/kaerozhi/eagle-fullsize-collector/main/rules/default.json`。
每次启动拉最新版；拉取失败自动回退到上次成功的缓存，再回退到脚本内置的默认规则。
**改规则不用重装脚本** —— 那正是这个项目的设计目标。

---

## 安装

1. 装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 <https://raw.githubusercontent.com/kaerozhi/eagle-fullsize-collector/main/eagle-fullsize.user.js>，
   Tampermonkey 会弹出安装页；或者从本仓库下载 `eagle-fullsize.user.js`，拖进浏览器窗口。
   脚本头里带 `@updateURL`，装了以后会自动跟着仓库更新。
3. 打开 Eagle → 偏好设置 → 开发者 → 打开本地 API（默认端口 `41595`）。**不需要 token。**
4. 访问任一命中规则的页面，右上角会弹出面板。

脚本用 `@match *://*/*`（规则表驱动就必须全站生效），但**只在命中规则或手动开启学习模式时才注入面板**，不会污染其他网站。

---

## 三种使用方式

### A. 直推 Eagle（推荐）

面板 →「扫描本页」→「发送到 Eagle」。
在「设置」里可以选目标文件夹、填附加标签。脚本会带上来源网址（`website`）。

> ⚠️ **Eagle 的 HTTP API(41595) 和 MCP(41596) 共享同一个单线程事件循环**，高负载下 41595 会被"饿死"到完全不响应（本仓库 `.eagle-mcp/NOTES-http-api-starved.md` 有完整证据链）。
> 所以脚本**串行小批量**推送（默认每批 8 条、批间隔 400ms），并且不要调大。大批量推送时别同时跑打标任务。

**加素材端点到底叫什么（已从 Eagle 自身的 `app.asar` 取证，非推测）：**

| 基础路径 | 端点 | 请求体 |
|---|---|---|
| `/api/v2` | **`POST /item/add`** | `{ items: [{ url, name, website, tags, folders }], folderId, tags }` |
| `/api`（旧版） | `POST /item/addFromURLs`（批量）／ `POST /item/addFromURL`（单条） | 批量同上；单条是扁平体的一个条目 |

- **`/api/v2` 下根本没有 `addFromURL(s)`** —— v2 路由表里加素材只有 `item/add`（证据：`app.asar` 行 183182–183245）。
  旧版路由表里才有 `addFromURL` / `addFromURLs`（`app.asar` 行 18911–18948）。
- v2 写接口的约定是**把条目包在 `items: [...]` 里**。实证：`.eagle-mcp/test-http-write.mjs:14` 打
  `POST http://127.0.0.1:41595/api/v2/item/update`，body `{ items: [ { id, tags, annotation } ] }`，返回 `status:"success"`（无需 token）。
- 脚本会**按候选矩阵自动探测**哪个端点活着，并把每一步的**原始响应**打进面板日志。
  探测**不往素材库里写任何东西**：用空请求体判断路由是否存在（不存在 → 404）。
  旧实现会真发一条 `https://example.com/` 的假素材去试端点，又脏又慢，已废弃。
- **★ 405 的真凶：URL 拼接把路径吞进了 query。** 这是最终定位到的根因，比下面两条判据更根本：
  Eagle 会给出一个**带 token 的地址**，形如 `http://localhost:41595/?token=xxxxxxxx-…`。
  旧代码用字符串相加 `eagleOrigin + path`，拼出来是
  `http://localhost:41595/?token=xxxxxxxx-…/api/v2/item/add` —— pathname 只剩一个 `/`，
  实际请求的是 **`POST /`**，Eagle 回 405 method not allowed。
  而 `GET /` 恰好返回 200，所以探测一直以为「基础路径可用」，误导了整整两轮排查。
  现在一律走 `buildApiUrl()`：用 `new URL()` 解析，path 只写进 `pathname`，query（token）原样保留。
  **凡是「端点找不到 / 方法不对」的怪现象，第一眼先看日志里的 `实际请求：` 那行 URL。**
- **探测缓存的版本号**：`CACHE_V`。改动 `ADD_CANDIDATES` 或探测语义后**必须 +1**，
  否则用户浏览器里存着的老 `caps` 会被判为有效并直接复用 —— 新逻辑一次都不执行。
  （踩过：改完 `DEAD=[404,405,501]` 后探测完全没跑，推送直接用了老缓存。）
- **两个判据是踩过坑才定下来的**（为 405 做的防御，仍然有效，只是不是那次失败的真凶）：
  - **405 算死路，不算活着。** 405 = 路由在、方法不对。旧判据只排除 404，于是 405 被当成"通过"，
    整轮推送全打在一个方法不对的路由上，全灭。现在的判据是 `DEAD = [404, 405, 501]`，
    并把 405 响应里的 `Allow` 头打出来 —— 直接告诉你这个路由允许什么方法。
  - **不按 base 过滤候选。** v2 路由和旧版 `/api` 路由**注册在同一个 server 上**
    （`app.asar` 184342：`api-server.js` 末尾 `require('./api-server-v2').initAPIServerV2(APIServer)`），
    所以 `/api/v2/library/info` 打得通**并不代表** `/api/item/addFromURLs` 不能用。
    旧探测一旦探通 v2 就只试 v2 候选，旧版兜底**一次都没被试过**。
- 四种请求体形状是真实差异，不是保险起见：v2 批量 `{ items: [...] }`、v2 单条（条目本身）、
  旧版批量 `{ urls: [...] }`、旧版单条 `{ url, name, website, tags, folderId }`。
- 设置里有 **「诊断接口」** 按钮：把「方法 × 路径」组合全打一遍（5 条路径 × GET/POST），
  原始响应与 `Allow` 头全部摊在日志里。请求体一律是 `{}`，Eagle 会用"没有来源"拒掉它，
  **不发素材、不写库**。接口对不上时先点这个，再把日志发我。
- 设置里有 **「验证原图」** 按钮：真的把第一张原图下下来，分别**带 Referer**与**不带 Referer**
  各请求一次，打印 HTTP 状态、`Content-Type`、字节数，以及**图片的真实像素尺寸**。
  它是「地址解析错了」和「地址对了但被防盗链换成占位图」这两件事之间**唯一的分界线** ——
  这两种原因的修法完全不同，在上层日志里却长得一模一样。
  判读：两种都拿到大尺寸图 → 问题在 Eagle 侧；只有带 Referer 才行 → 防盗链，要换下载方式。
- 推送前会打印 `待发送 N 张，去重后 M 个不同 URL` 与三条样例 URL。
  **若 M == 1，就是解析器的 bug，与 Eagle 无关**；M 正常但 Eagle 里仍是同一张，则问题在下载侧。
- 推送失败时**不重试已部分成功的批次**：Eagle 没有幂等键，重试只会塞进重复素材。
  所以第一个失败批次就停下，并把原始响应打出来。

### B. 替换页面图片 + Eagle 官方扩展批量收藏

面板 →「替换页面图片」。脚本把页面上每个缩略图的 `src` 就地换成原图、并清掉 `srcset`（否则浏览器可能仍按 `srcset` 选小图）。
之后照常用 Eagle 官方扩展的「批量收藏」，抓到的就是原图。**这条路完全不依赖 Eagle API。**

配合「**跟随我的滚动**」采集方式（默认，见下）时，替换是**边滚边做**的：你往下滚，脚本静默解析新挂载进来的 tile
并当场把它们的缩略图换成原图，直到你停。所以「先滚一遍再替换」不是必须的。

**采集方式：跟随滚动（默认）vs 自动滚动到底**

| 模式 | 行为 | 什么时候用 |
|---|---|---|
| **跟随我的滚动**（默认） | 脚本**绝不碰滚动条**。你滚，它一声不响；你停 700ms，它把当前挂载的那批收下来、解析原图、需要的话就地替换。你不滚它什么都不做。 | 想挑图（Pinterest 搜索结果那种），或者不想让页脚被拽着跑。 |
| 自动滚动到底 | 脚本自己往下滚到滚不动为止，再滚回原位。面板上有「**停止滚动**」可随时中断，已收集的条目会保留。 | 目标清单很干净、只想要全部原图时。数量上限由设置里的「单页最多收集」控制（默认 800）。 |

> 🧠 这一版是照用户实测反馈改的 —— 原先只要规则带 `scrollToLoad` 就无条件自动滚，
> 用户碰上「滚动了 42 轮，拿到了 377 张原图…这个操作逻辑会有点失控」。控制权现在在用户手上。

### C. 本地下载

`GM_download` 逐个下载到浏览器默认目录，之后手动导入 Eagle。适合 API 不通、或想先人工筛一遍的情况。

---

## 规则表格式

```jsonc
{
  "version": 1,
  "updated": "2026-09-29",
  "rules": [
    {
      "id": "example",              // 唯一标识，本地覆盖按 id 合并
      "name": "示例站",
      "enabled": true,
      "match": ["*://*.example.com/gallery/*"],   // 语法同 @match；*.a.com 也匹配裸域
      "spa": true,                  // 无限滚动站点：跟踪新增内容
      "referer": "https://www.example.com/",      // 防盗链站点必填
      "concurrency": 5,             // detail 策略并发
      "delayMs": 120,               // 请求间隔，站点限流严就加大

      "collect": {                  // 怎么在列表页找到"每一张图"
        "item": "a[href*='/photo/']",   // 一个条目；留空则退化为全页 img
        "img": "img",                   // 条目内的 img
        "link": "self",                 // self = 条目本身是 <a>；也可写选择器
        "scrollToLoad": true            // 无限滚动 / 虚拟化列表必开：边走边滚、边滚边收
      },

      "resolve": [ /* 见下 */ ]
    }
  ]
}
```

### `resolve`：有序管线，逐级降级，第一个产出原图地址的环节胜出

| type | 做什么 | 什么时候用 |
|---|---|---|
| `endpoint` | **最强。** 按规则声明的站点接口发**一次**请求，把响应里所有原图直链挖出来建成 `id → 原图` 索引，每个条目只查表 | 站点有「一次返回整组」的接口（见 eporner：一次请求拿全 85 张） |
| `attr` | 直接从列表页 DOM 读：`img@data-full`、`img@srcset:last`、`img@src` | 页面本身就藏了原图地址（最常见、最快） |
| `rewrite` | 对缩略图 URL 做正则改写，**零请求** | 原图地址能从缩略图**推导出来**（如 Pinterest `236x/` → `originals/`） |
| `pagedata` | 从页面自身数据里按「同目录 + 同 id」找原图：扒页面源码 + 挂钩 XHR/fetch 抓 viewer 响应 + 页面上已显示的大图 | `endpoint` 失效时的兜底 |
| `probe` | 候选改写逐个用 `Image()` 实测；**只在第一张上定胜负**，之后整页复用胜出的那个 | rewrite 不确定，但可枚举候选 |
| `detail` | 并发抓每个条目的详情页取 `og:image` | 原图确实只在独立详情页上 |

`endpoint` 的 `url` 模板用 `{变量}` 占位，`vars` 给每个变量的取值来源（按顺序取第一个非空）：

```jsonc
{
  "type": "endpoint",
  "url": "/xhr/gallery-slide/{galleryId}",
  "vars": {
    "galleryId": ["[data-gallery-id]@data-gallery-id", "url:/gallery/([^/]+)/"]
  },
  "idFrom": "([0-9]{6,})"   // 怎么从图片文件名里认出一条地址属于哪个条目
}
```

来源两种写法：`<selector>@<attr>` 从 DOM 读；`url:<正则>` 从当前页 URL 抠。响应里带 `_WxH` 尺寸后缀的地址会被当成缩略图剔掉。

`probe` 的"整页复用"是省流量的关键：不会对 N 张图各试一遍候选。
`detail` 有两个自动守卫：① 条目链接若与当前页同 URL（仅 `#hash` 不同）直接跳过；② 连续失败 ≥8 次自动停用，避免被限流刷屏。

### 学习模式

命中不了的站点，开「学习模式」，然后手动点开一张大图。
脚本会比对页面上的**小图**与**大图**，找出两者的差异并泛化成一条 `rewrite` 规则，存进本地规则（覆盖订阅）。

它有一条硬守卫：**只有两个文件名一致（或仅差尺寸后缀）时才敢泛化。** 文件名完全不同的话，改写原理上不可能通用 —— 它会明确告诉你「应该用 detail 策略」，而不是生成一条只对这一张图有效的垃圾正则。

---

## 维护规则（这个项目的日常）

对外承诺是「你只要改 `rules/default.json`」。维护流程：

```bash
# 1. 改 rules/default.json —— 加一条站点规则，或修一条老规则
# 2. 本地自检（三条命令，都是毫秒级）
node tests/validate-rules.mjs     # 结构校验：id 唯一 / match 语法 / resolve 字段齐全 / 正则能编译
node tests/resolve-harness.mjs    # 解析器语义回归
node tests/scroll-harness.mjs     # 无限滚动 + 就地替换回归
# 3. 提交推送
git commit -am "rules: 新增 xxx 站点" && git push
```

CI 会在每次 push / PR 上重跑这四步。**规则表是对外发布的订阅源** —— 一条坏规则会被所有装了脚本的人
在下次启动时拉到（脚本会回退到内置规则，但那个站会静默失效），所以这个守门人不是形式主义。

新增一个站点的最短路径：

1. 打开目标列表页，F12 看看「一个条目」的最小稳定选择器（优先 `data-*` 属性，别用会变的 class）。
2. 缩略图→原图如果只是**尺寸段不同**（`236x` → `originals`），写 `rewrite`，零请求最快。
3. 如果原图地址**推不出来**（文件名完全无关），看 Network 面板有没有一个请求一次带回整组原图
   —— 有的话写 `endpoint`，这是最强也最省流量的策略。eporner 就是这么解的。
4. 都不行才用 `detail` 逐张抓详情页（最慢，且要小心 hash 型页内 viewer，见下）。
5. 边界情况（虚拟化列表、1×1 占位符懒加载）记得开 `collect.scrollToLoad`。

## eporner 的实测结论（重要，别再试 rewrite）

用真实样例 + 一次 DevTools 取证定型的结论：

```
缩略图  https://static-ca-cdn.eporner.com/gallery/Ol/oQ/5IUmqWloQOl/10574489-10574489_296x1000.jpg
原图    https://static-ca-cdn.eporner.com/gallery/Ol/oQ/5IUmqWloQOl/10574489-gao-qiaoshou-zi-san-shang-you-ya-megane-tsu-niang-nude.jpg
```

- 目录相同、id 前缀 `10574489-` 相同；
- 但后半段一个是 `10574489_296x1000`（id + 尺寸后缀），一个是拼音 slug —— **完全不相关**。

**结论 1：rewrite 在原理上不可能。** slug 不可推导，必须从别处取。
**结论 2：`detail` 也不能用。** "点进去之后"的地址是
`.../gallery/<hash>/<slug>/#gallery-photo=10574489` —— **同一个画廊页的 hash**，不是独立详情页。抓它只会拿到画廊的 `og:image` 封面，结果是**同一张封面被重复收藏 N 次**。eporner 规则里的 detail 已移除，并给 detail 加了同页守卫。
**结论 3：slug 不在页面源码里。** DevTools 取证显示：内联 `<script>` 里搜不到该 id，初始 HTML 的 129 条图片直链里只有那张缩略图。
**结论 4（正解）：有一个「一次返回整组」的接口。**

```
【XHR GET】/xhr/gallery-slide/5IUmqWloQOl   (139695 bytes)
【原图候选】https://static-ca-cdn.eporner.com/gallery/Ol/oQ/5IUmqWloQOl/10574489-gao-qiaoshou-…-nude.jpg
```

点开任意一张大图时，viewer 发的是 `GET /xhr/gallery-slide/<galleryId>` —— **一次 139KB，带回整个画廊 85 张（页面自己写着 `Continue · 63/85`）的全部原图直链。**
而 `galleryId` 不用猜：锚点上就写着 `data-gallery-id="5IUmqWloQOl"`，URL 路径里也有。

所以 eporner 走 **`endpoint`** 策略：一次请求建好 `id → 原图` 索引，之后每个条目只查表。**不需要逐张点击，也不需要端点回放。**

**其他两条实测修正（都已写进规则）：**

- 缩略图外层是 `<a id="gallery-view-slideshow" data-gallery-id="5IUmqWloQOl" data-photo-id="10574489" href="…#gallery-photo=10574489">`。用它当 `collect.item` 比匹配 href 可靠得多，同时 `idAttr: "self@data-photo-id"` 给了一个**不依赖文件名的 id 来源**（缩略图还没懒加载出来时也照样能查表）。
- 整页 `<img>` 的 `src` 初值是 **1×1 透明 gif 占位符**（`data:image/gif;base64,R0lGODlh…`），因为缩略图是懒加载的。所以采集器必须过滤 `data:`/`blob:`，且规则开了 `scrollToLoad: true` —— 扫描前先滚到底再滚回来，强制把真地址换进来。**否则拿到的 thumb 全是占位符。**

**兜底判据**（`endpoint` 万一失效时用）：原图文件名是 `<id>-<slug>.jpg`，缩略图是 `<id>-<id>_<W>x<H>.jpg` ——
**「同 id 但不带 `_WxH` 尺寸后缀的那个」就是原图。** `pagedata` 就按这个从页面源码 / 嗅探到的响应 / 页面上已显示的大图里找。

---

## 已知限制

- **规则表是按站点 DOM 手写的，会随对方改版失效。** 失效时面板会提示"没找到条目"或"0 张解析成功" —— 改 `collect.item` 选择器即可，不用动脚本。
- **Pinterest 的 `originals/` 并非每张图都存在**（部分 pin 的原图上限就是 736x），所以有 `probe` 兜底。
- 面板日志会打印 Eagle API 的**原始响应**。第一次跑如果 add 端点猜错了，把日志发我，改 `ADD_CANDIDATES` 这一个常量即可（候选矩阵：base / path / 是否用 `items` 包一层）。
- 脚本无法绕过登录墙 / 付费墙，用的是你浏览器当前的 cookie（`GM_xmlhttpRequest`）。

---

## 回归测试

本机已可运行 node（v24+）。两个测试都是**把 `eagle-fullsize.user.js` 本体加载进 `vm` 沙箱**执行，
而不是拷贝一份逻辑出来测；只替换两处 I/O（UI 日志、网络），且每处替换都带断言 —— 源码结构一变就报错，
不会静默变成假绿。

```bash
node eagle-batch-collector/tests/resolve-harness.mjs   # 解析器回归：假 DOM，30 项断言
node eagle-batch-collector/tests/scroll-harness.mjs    # 无限滚动 + 就地替换回归：假虚拟化瀑布流，37 项断言
node eagle-batch-collector/tests/live-eporner.mjs      # 真实站点端到端：需要能访问 eporner
```

覆盖的事故与守卫：

| # | 断言 |
|---|---|
| 0 | 规则自检：`endpoint` 是 eporner 的第一条策略，且 `attr` 没有开 `allowDocument` |
| 1 | `readSelectorAttr(document, 'img@data-src')` 拿到的确实是**站点图标**（复现事故源头） |
| 2 | `pathDir(图标) !== pathDir(缩略图)` —— 同目录守卫的依据成立 |
| 2b | `collectItems` 能认出 3 个条目锚点，并带上 `data-photo-id` |
| 3 | 真实规则在「条目 img 带缩略图 `data-src`」时，经 `endpoint` 拿到原图 |
| 4 | 真实规则在「条目 img 只有 1×1 占位 gif」时，同样拿到原图 |
| 5 | endpoint 响应里带 `_WxH` 的缩略图被剔除，且**只发一次请求** |
| 6 | **负例**：默认禁止整页兜底，不再返回站点图标（`url` 为空，不会被推送） |
| 7 | **正例**：显式 `allowDocument: true` 且同目录时，兜底仍然可用 |
| 8 | **负例**：`allowDocument: true` 但跨目录，仍必须拒绝 |
| 9 | 按 URL 去重：106 个条目 → 85 张待发，21 个重复被拦下 |

`live-eporner.mjs` 用**脚本自己的 `buildEndpointIndex`** 处理真实响应，2026-09-29 实测：

```
画廊页 → HTTP 200｜335525 字节
  服务端 HTML 里 data-photo-id 出现 1 次（其余 105 个条目由前端 JS 注入）
  带 data-src 的 <img> 15 个（去重 15 个），其中 catimg 站点图标 8 个 ← 事故来源确实存在
XHR /xhr/gallery-slide/5IUmqWloQOl → HTTP 200｜143990 字节｜511 ms
  图片直链去重 255 条：带 _WxH 170 条、原图 85 条
  脚本请求的 URL：https://www.eporner.com/xhr/gallery-slide/5IUmqWloQOl   ✅ 与真实端点一致
  建出索引条目：85 条 ｜ 残留缩略图：0 条 ｜ key 全是纯数字 id ✅
```

顺带确认两件事：① 站点图标是**真实存在**的（服务端 HTML 里就有 8 个 `catimg/*_small.jpg`），
事故前提成立，不是我的误判；② **CDN host 按地区变**（实测为 `static-sg-cdn`，用户环境是 `static-ca-cdn`），
所以规则**绝不能写死 CDN host** —— 现有规则只匹配页面域名 `*.eporner.com/gallery/*`，是对的。

### `scroll-harness.mjs`：虚拟化列表（Pinterest 那一类）

复现用户实测里的第二起事故：

> 只能获取首屏加载的图片，比如19张。然后向下滚动之后的照片似乎也只能加载到当前阶段获取的图片，
> 因为数字还是在20张左右跳动。

测试里搭了一个**真的会卸载 tile** 的假瀑布流（共 25 张，任一时刻 DOM 里只挂载 8~10 个），
把**真实的内置 Pinterest 规则**喂给 `collectAll`：

| # | 断言 |
|---|---|
| 1 | 静态快照只拿得到当前挂载的 8/25 —— 这就是「数字停在 20 左右」的来源 |
| 1 | `collectAll` 边走边收，收全 **25/25**（旧实现只有 8） |
| 1 | 全程 DOM 里最多只挂载过 10 个 tile —— 证明卸载真的发生了，不是假模型 |
| 2 | 稳定 key：25 条 key 互不相同；链接 key 去掉 query/hash；`externalId` 优先于链接 |
| 3 | 同一批条目并两次，第二次新增 0 条（卸载再挂载不会算成两条） |
| 4 | 1×1 占位符 thumb 会被后到的真地址**升级**（否则会推给 Eagle 一堆透明 gif） |
| 5 | 滚到底单收一次仍然只有少量 tile；两次扫描合并去重后仍是 25 条 |
| 6 | 默认的 **follow 模式** `collectAll` 一次都不滚动（`scrolled === false`、`rounds === 0`） |
| 7 | **就地替换按稳定 key 对齐**：页面挂载的是 `736x`、记录里存的是 `236x`，仍然替换成功（旧实现按 `thumb` 对齐会得 0） |
| 7 | 替换后 `data-src` 被清掉；再调一次是幂等的（`data-ebc-full` 守卫） |
| 8 | 滚到新位置后**后挂载进来的 tile 会被后续调用补上**（跟随滚动能滚多远换多远） |
| 9 | 同一张原图被两个 tile 指着时报告 `dupes === 1`（Pinterest 推荐流会重复推同一个 pin） |

**为什么是「边走边收」而不是「滚到底再滚回来」**：虚拟化列表会把滚出视野的 tile 从 DOM 里
**移除**，所以滚回起点后 DOM 又只剩顶部那 ~20 个，最后重收一次几乎等于什么都没收到。
只有每隔一屏就把当时 DOM 里的条目按稳定 key 存进累计表，才能拿到全部。旧的
`forceLazyLoad`（滚到底→滚回来→重收一次）已因此删除。

**顺带修掉的第二个缺口**：`已发送` 状态现在按 URL 记在 `sentUrls` 里。以前每次重扫都会重建
`resolvedCache` 并把状态重置成「就绪」，所以「滚一段 → 再点扫描 → 再点发送」会把**已经进
Eagle 的图重推一遍**，在素材库里堆出重复。现在重扫时命中 `sentUrls` 的条目直接标成「已发送」，
推送会跳过它们。面板上的「重收」按钮只清空累计条目表，不动 `sentUrls`。

## 排错

| 现象 | 原因 |
|---|---|
| 「无匹配规则」 | 该站点还没有规则。开学习模式现场生成一条。 |
| 「找到 0 个候选条目」 | `collect.item` 选择器对不上这个站的 DOM。 |
| 「所有策略均未解析出原图」 | 原图地址不在页面源码里。点开一张大图后再点「扫描本页」。 |
| 推送失败 / add 端点找不到 | **先看日志里的 `实际请求：` 行，确认 URL 没被拼坏**（带 token 的地址最容易踩，见上）。Eagle 没启动、或没开本地 API 也会失败。面板「设置 → 诊断接口」会把方法 × 路径的原始响应与 URL 全打出来。<br>**HTTP 405 = 路由在、方法不对**（不是服务不可用）；**404 = 路由不存在**。v2 的加素材端点是 `POST /api/v2/item/add`，旧版是 `POST /api/item/addFromURL(s)`，两套同时注册在同一个 server 上。 |
| 推送说成功，但 Eagle 里全是同一张小图 | **先看解析来源**（日志里 `验证原图（解析来源 …）` 那一行）。<br>实测根因：**`attr` 选择器退化到整页匹配** —— 条目自己的 `img` 没有 `data-src`（懒加载占位是 `data:` URI），整页兜底就返回了文档里第一个 `img[data-src]`，也就是站点图标 `catimg/N_small.jpg`（102×75）。**这种情况下日志会显示「解析完成：N/N 张拿到原图」，完全不报错。** 现在整页兜底默认关闭，必须规则显式声明 `allowDocument: true` **且**结果与缩略图同目录才放行。<br>若解析来源正常却仍是同一张，点「**验证原图**」看带/不带 Referer 拿到的像素尺寸，判断是不是 CDN 防盗链（那时改用 **B. 替换页面图片**）。 |
| Eagle 里出现重复素材，数量少于条目数 | 页面上条目数常多于画廊的实际照片数（实测 eporner：106 个条目 → 85 张照片）。脚本推送前会按原图 URL 去重，日志打 `有 21 个条目与前面的条目指向同一张原图，已跳过`。 |
| 推送成功但图是封面 | 该站点误配了 `detail`。检查条目链接是否与当前页同 URL。 |
| 瀑布流滚了很久，数字却停在 20 左右不动 | 该站点是**虚拟化列表**：滚出视野的 tile 会被从 DOM 里卸载，所以静态快照永远只有当前挂载的那 ~20 个。修法是给规则的 `collect` 加 `scrollToLoad: true` —— 脚本会**边走边滚、边滚边收**并按稳定 key（id / 详情页链接）累计。跨多次「扫描本页」也会继续**累加**（不再被覆盖），所以手动滚一段再扫一次同样有效。见 `tests/scroll-harness.mjs`。 |
| 「替换页面图片」只换掉了首屏那十几张 | 同上的虚拟化原因：那一刻 DOM 里**只有**那十几张。旧实现还额外用了 `thumb` 对齐，而重挂载后同一个 pin 的 `thumb` 常常换成另一个尺寸的候选地址，于是连那十几张都可能对不上。现在改为按**稳定 key**（详情页链接去掉 query/hash）对齐，并且「跟随滚动」模式下**边滚边换**。见 `tests/scroll-harness.mjs` 断言 7、8。 |
| 日志说「N 个 tile 指向同一张原图」 | 不是 bug。Pinterest 的推荐流会把同一个 pin 推好几次，页面上就有几个 tile 指向同一张原图。脚本按 URL 去重后再推送，重复项会被标成「重复，已跳过」；本地替换为了保持所见即所得仍然照换，挑图时留意即可。 |
| 页面上明明有几百条，推送却只发了一部分 | 看推送日志里的 `（已按 URL 去重）`：条目数常多于实际照片数（实测 eporner 106 条 → 85 张）。 |
