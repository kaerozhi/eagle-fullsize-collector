# Eagle 大图批量收藏

**一键安装**：<https://raw.githubusercontent.com/kaerozhi/eagle-fullsize-collector/main/eagle-fullsize.user.js>
（Tampermonkey 会直接弹出安装页）

解决一件事：**图片列表页 / 瀑布流只能批量收藏到预览图，原图必须逐张点进去才加载。**

Eagle 的 Chrome 扩展「批量收藏」读的是页面上 `<img>` 当前的 `src` —— 列表页里那就是缩略图。这个工具在它之前插一手：先把缩略图升级成原图地址，再交给 Eagle。

两件独立的事分开维护：**站点规则**说「这一页上哪些 `<img>` 是图」，**图床表**说「这家图床的缩略图怎么换成原图」。
所以论坛那种「用户可以自由从各种图床贴图」的场景不用逐站适配 —— 加一家图床，所有站点同时受益。见《[图床表](#图床表hosts论坛场景的正解)》。

---

## 组成

| 文件 | 作用 |
|---|---|
| `eagle-fullsize.user.js` | Tampermonkey 油猴脚本（单文件，可直接安装） |
| `rules/default.json` | **订阅表** —— 站点规则（`rules`）+ 图床规则（`hosts`），像 AdBlock 列表一样增删改 |
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

#### 跨页相册

规则表支持在 `collect.pagination` 里声明分页链接选择器。脚本会从当前页递归发现所有分页（即使分页器中间用省略号隐藏页码），逐页抓取并合并条目，再统一解析和推送。例如美图录的 `3006.html` 相册，打开任意一页后点一次「扫描本页」即可收集整套分页图片；`maxPages` 是防止异常分页器无限扩张的安全上限。

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

> 防盗链图床（比如 imagetwist）要额外一步：带本站 Referer 去请求原图会拿到**占位图**，
> 所以脚本会按图床表的 `referrer` 字段给这些 `img` 设 `referrerPolicy = 'no-referrer'`，
> 日志里会补一句「其中 N 张来自防盗链图床」。见《图床表》。

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

## 素材命名（送进 Eagle 的文件名）

**为什么要有这个**：Eagle 的加素材接口如果没拿到 `name`，就会**用素材 id 当文件名**（`MUMT12OZPMAVP` 这种）。
那种名字在库里完全没法搜、也没法看，等于把图片的上下文全丢了。

脚本默认 `nameTemplate: '{basename}'` —— **取原图 URL 的最后一段（去掉扩展名）**。效果：

| 站点 | 原图 URL 尾段 | 送进 Eagle 的名字 |
|---|---|---|
| eporner | `10574489-gao-qiaoshou-zi-san-nude.jpg` | `10574489-gao-qiaoshou-zi-san-nude` |
| pornpics | `25875390_002_f6a3.jpg` | `25875390_002_f6a3` |
| kitty-kats | `751781495_ra_petalsvol54_domini_high_0001.jpg` | `751781495_ra_petalsvol54_domini_high_0001` |
| Pinterest | `abcdef0123456789.jpg` | `Shoko Takahashi, Yua Mikami - Meganekko … - Eporner-03` |

eporner 那条直接带上了站点的拼音 slug，正是「附带关键信息、方便搜索」想要的。
pornpics 那条是「画廊号 + 图内序号」，在库里搜 `25875390` 就能把同一个画廊的整套图捞出来，同样有用。

**弱名兜底。** Pinterest 这类 CDN 的尾段是一串哈希，当名字毫无意义。所以脚本会判定「弱名」并改用兜底模板：

- 长度 < 3；或是 `image` / `img` / `photo` / `untitled` / `download` / `thumb` / `large` / `original` … （一整张保留字表）
- 或纯十六进制且 ≥ 12 位（`abcdef0123456789`）
- 或**一个字母都没有**（纯数字 / 纯下划线 / 纯横线）

命中就退化成 `{page}-{alt}-{host}` 里第一个有值的，再加两位序号（`… - Eporner-03`）。
序号补齐到两位是为了排序好看 —— 不补的话按名字排序 `-10` 会排在 `-2` 前面。

**模板占位符**（设置面板里改，填错/填空都会回落到默认）：

| 占位符 | 含义 |
|---|---|
| `{basename}` | 原图 URL 尾段去扩展名（默认） |
| `{alt}` | 缩略图的 `alt`，没有就取 `title` |
| `{page}` | 页面 `<title>` 清洗后的结果 |
| `{host}` | 网站域名 |
| `{id}` | 规则采集到的条目 id（如 `data-photo-id`） |
| `{n}` | 本页序号，两位补零 |

例如 `{page}-{n}` 会把整页统一命名成「页面标题-01、-02…」。

> 两条硬保证：**名字永远不为空**（空串就等于 Eagle 又拿 id 当文件名了），
> 以及非法文件名字符 `<>:"/\|?*` 与控制字符一律清掉、折叠空白、截 120 字。

> 🧠 「Eagle 认不认 `name`」这事是**实测**过的，不是照文档猜的：手工 `POST /api/v2/item/add`
> 传 `name: 'EBC-NAMETEST-d4c7fad5'`，`GET /api/v2/item/get` 读回来一模一样。
> 所以文件名不对是纯客户端问题，改脚本即可。

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
| `host` | 拿缩略图 URL 去顶层 **`hosts`（图床表）**里找匹配的记录，按它的 `thumbRe`/`fullTo` 改写，**零请求** | **论坛场景的正解**：用户可以自由从各种图床贴图，一个站点一条规则从根上不成立 —— 见下文《图床表》 |
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
`probe` 还带一道**占位图守卫**：候选必须比缩略图更大、且不小于 200px，否则算失败。
不设这道关，`probe` 在主流图床上就是**必然误判** —— 它们拿不到原图时不返回 404，
而是回一张能正常解码的占位图（见下文），而 `probe` 只看「加载成功」。
`detail` 有三个自动守卫：① 条目链接若与当前页同 URL（仅 `#hash` 不同）直接跳过；② 连续失败 ≥8 次自动停用，避免被限流刷屏；③ 可选 `externalOnly: true` —— 只抓**外链**，论坛帖子里头像/引用/楼层链接全是站内链接，一条 `externalOnly` 就把噪音滤干净。

### 学习模式

命中不了的站点，开「学习模式」，然后手动点开一张大图。
脚本会比对页面上的**小图**与**大图**，找出两者的差异并泛化成一条 `rewrite` 规则，存进本地规则（覆盖订阅）。

它有一条硬守卫：**只有两个文件名一致（或仅差尺寸后缀）时才敢泛化。** 文件名完全不同的话，改写原理上不可能通用 —— 它会明确告诉你「应该用 detail 策略」，而不是生成一条只对这一张图有效的垃圾正则。

---

## 图床表（`hosts`）：论坛场景的正解

**问题**（用户实测，2026-10-05）：`kitty-kats.net` 这类**用户可以自由发图**的论坛，帖子里的图是用户从各种免费图床贴进来的。
同一个帖子就可能混用好几家 —— 用户给的那个帖子 117 张全是 ImageTwist，而之前取证过的帖子用的是 pixhost。

所以「为这个论坛写一条站点规则」**从根上就不成立**：改写规律属于**图床**，不属于站点。
v0.5.0 把这件事抽成顶层 `hosts` 表，与站点规则分开维护：

- **站点规则**只负责「页面上哪些 DOM 节点是帖子图」（`collect`）。
- **图床表**负责「这个图床的缩略图地址怎么变成原图地址」（`thumbRe` / `fullTo`）。

加一家新图床只往 `hosts` 里加一条，**所有站点规则同时受益**。

### 为什么不能用 `probe` 去「实测哪个能下」

这是这个项目里反复踩到的同一个坑：**这些图床拿不到原图时都不返回 404**，而是返回
`HTTP 200` + 一张**能正常解码**的 JPEG/PNG 占位图。`probe` 靠 `Image()` 的 `onload`
判成功，占位图当然能 onload —— 于是整页被推成一堆一模一样的占位图，
而日志还老老实实地报「N/N 张拿到原图」。

| 图床 | 触发条件 | 拿到的占位图 |
|---|---|---|
| pixhost | 主机号写错 | 257×126 / 16138 字节（`image/png`） |
| imagetwist | 主机号写错 | 177×142 / 8183 字节 |
| imagetwist | **图片请求带了外来 Referer** | 177×142 / 8346 字节（`image/jpeg`） |

所以图床表里**只用改写**，规律必须是人实测出来的，并写上 `verified` 日期。

### `hosts` 的字段

```jsonc
{
  "id": "imagetwist",           // 唯一标识
  "name": "ImageTwist",         // 面板/日志里显示的名字
  "match": ["*://*.imagetwist.com/*"],   // 命中该图床**图片 URL** 的 glob（语法同站点规则）
  "thumbRe": "//((?:img|s)\\d+)\\.imagetwist\\.com/th/",  // 缩略图 URL 的正则
  "fullTo": "//$1.imagetwist.com/i/",                     // 原图模板，$1 引用上面的捕获组
  "referrer": "no-referrer",    // 可选：该图床必须**不带 Referer** 才给原图
  "verified": "2026-10-05"      // 最后一次实机验证的日期。留空 = 没实测过，别信
}
```

`referrer` 这一项是**必须的**，漏了会静默出问题：浏览器默认策略会给跨域图片请求带上
本站 origin 当 Referer，而 imagetwist 看到外来 Referer 就回占位图。脚本在
「替换页面图片」时会据此把 `img.referrerPolicy` 设成 `no-referrer`。
（推 Eagle 不受影响 —— Eagle 自己下载时不带 Referer。）

### 通用图床论坛模式（不认站点，只认图床）

命中不了站点规则的页面，脚本会再看一眼：**页面上有没有 ≥3 张来自图床表里已知图床的图**。
有的话当场合成一条规则接管这一页：

```jsonc
"collect": { "item": "a[href] > img" },      // 缩略图外面套着图床分享页链接
"resolve": [
  { "type": "host" },                         // ① 已知图床：查表，零请求
  { "type": "detail", "externalOnly": true,   // ② 表里没有的：抓那个分享页取原图直链
    "selectors": ["meta[property='og:image']@content", "img.pic@src", "img#image@src", "..."] }
]
```

② 是万能的：不管哪家图床，它的分享页里一定有原图直链（实测 imagetwist 的分享页就含
`<img class="pic" src="https://img69.imagetwist.com/i/…">`，pixhost 是 `<img id="image">`），
而且**两家都不挑 Referer**。代价是每张图多一次请求，所以只在 ① 不认识时才用。

想关掉自动识别：设置里 `autoDetectHosts: false`。
页面上的图床还没进表、或自动识别没触发时，油猴菜单里有
**「通用图床论坛模式：在本页强开」**手动开一把（表里有的零请求，没有的走抓分享页）。

---

## 维护规则（这个项目的日常）

对外承诺是「你只要改 `rules/default.json`」。维护流程：

```bash
# 1. 改 rules/default.json —— 加一条站点规则，或修一条老规则
# 2. 本地自检（四条命令，都是毫秒级）
node --check eagle-fullsize.user.js   # 语法
node tests/validate-rules.mjs         # 结构校验：id 唯一 / match 语法 / resolve 字段齐全 / 正则能编译 / 图床表字段 / 内置表与订阅表不漂移
node tests/resolve-harness.mjs        # 解析器语义回归
node tests/scroll-harness.mjs         # 无限滚动 + 就地替换回归
# 3. 提交推送
git commit -am "rules: 新增 xxx 站点" && git push
```

CI（`.github/workflows/ci.yml`）会在每次 push / PR 上重跑这四步。**规则表是对外发布的订阅源** —— 一条坏规则会被所有装了脚本的人
在下次启动时拉到（脚本会回退到内置规则，但那个站会静默失效），所以这个守门人不是形式主义。

新增一个站点的最短路径：

1. 打开目标列表页，F12 看看「一个条目」的最小稳定选择器（优先 `data-*` 属性，别用会变的 class）。
2. 缩略图→原图如果只是**尺寸段不同**（`236x` → `originals`），写 `rewrite`，零请求最快。
3. 如果原图地址**推不出来**（文件名完全无关），看 Network 面板有没有一个请求一次带回整组原图
   —— 有的话写 `endpoint`，这是最强也最省流量的策略。eporner 就是这么解的。
4. 都不行才用 `detail` 逐张抓详情页（最慢，且要小心 hash 型页内 viewer，见下）。
5. 边界情况（虚拟化列表、1×1 占位符懒加载）记得开 `collect.scrollToLoad`。

**如果目标页是论坛/贴图板**（图由用户从外部图床贴进来），别写 `rewrite` —— 改写规律属于图床不属于站点。
去 `hosts` 里加一条，站点规则只写 `collect` + `resolve: [{"type":"host"}, {"type":"detail", "externalOnly":true, ...}]` 就够了；
甚至连站点规则都不必写，页面上 ≥3 张已知图床的图就会触发**通用图床论坛模式**自动接管。

新增图床时**必须实测**并写下 `verified` 日期，因为「写错」不会报错（见《图床表》里的占位图一节）。
一条图床记录要验证三件事：① 缩略图 → 原图 的真实 URL 对照；② 主机号/前缀是否必须原样保留（换个主机号是否也返回原图）；③ 图片请求带不带 Referer 的差别。
实机验证用 `tests/live-naming.mjs` 那种「真的发请求、读回字节与像素」的方式，别只看 HTTP 200。

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

本机需要 node（v20+）。测试都是**把 `eagle-fullsize.user.js` 本体加载进 `vm` 沙箱**执行，
而不是拷贝一份逻辑出来测；只替换两处 I/O（UI 日志、网络），且每处替换都带断言 —— 源码结构一变就报错，
不会静默变成假绿。

```bash
node tests/validate-rules.mjs    # 规则表结构校验
node tests/resolve-harness.mjs   # 解析器回归：假 DOM，145 项断言
node tests/scroll-harness.mjs    # 无限滚动 + 就地替换回归：假虚拟化瀑布流，37 项断言
node tests/live-eporner.mjs      # 真实站点端到端：需要能访问 eporner
node tests/live-naming.mjs       # 真实 Eagle 端到端：需要 Eagle 在跑（会写 3 条测试素材，跑完自动移进回收站）
```

> `live-naming.mjs` **不进 CI** —— 它要连本机的 Eagle。但它是唯一能证明「Eagle 真的按我们算的名字存下来」的东西，
> 动过命名逻辑（`nameTemplate` / `buildItemName` / 弱名表）就手动跑一次。
> 它分两层验证，因为这两件事失败起来长得很不一样：① 从网络替身抓下**原始请求体**，看 `name` 是不是本地算的那个；
> ② 再 `item/get` 读回来比对（**带重试** —— Eagle 建好素材不等于立刻可查）。

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
| 10 | **素材名**：`baseNameOfUrl` 从 URL 尾段取名字，弱名判定真值表（纯哈希 / 纯数字 / 保留字）逐条过 |
| 11 | **素材名**：Pinterest 那串哈希触发标题兜底；`{n}` 补两位；**任何情况下 `buildItemName` 都不返回空串** |
| 12 | **素材名**：`collectItems` 真的把 `alt` 采集进来了（兜底的原料） |
| 13 | **pornpics**：`a.rel-link, a[data-tid]` 选择器组能选中条目；`thumb` 取的是 `data-src` 的 460 图而不是 1px 占位图；规则确实不采集 `externalId` |
| 14 | **pornpics**：`rewrite` 的结果**逐条等于锚点自身的 `href`**（线上 20/20），且结果里不再有 460 段；3 条互不相同 |
| 15 | **pornpics 负例**：给同一条目加一条 `attr: img@src`，它会返回 1×1 占位图并骗过 `got !== thumb` 守卫 —— 这就是「pornpics 规则里不能写 attr」的实证 |
| 16 | **pornpics 负例**：两个画廊各自的 `002`，`itemKey` 必须落在 `link:` 上，不能塌缩成 `id:002`（这就是「不能写 idAttr」的实证） |
| 17 | **kitty-kats**：`a[href] > img` 把帖子图与头像**都**收进来（4 条），噪音留给 resolve 滤；`link` 是图床的分享页；`itemKey` 互不相同 |
| 18 | **图床 `host` 步骤（pixhost）**：`t2/thumbs/…` → `img2/images/…`、不再带 `/thumbs/`、结果互不相同；**`t9 → img9`、`t3.pixhost.to → img3.pixhost.to`**（主机号与 tld 都是捕获组，不是写死的 `img2`）；非 pixhost 的缩略图不会被误改 |
| 18b | **图床 `host` 步骤（imagetwist）**：`img69/th/` → `img69/i/`；**`s10` → `s10`（绝不能猜成 `img10`）**；`img202` → `img202`；已经是 `/i/` 的原图不再改；无关域名不误伤 |
| 19 | **kitty-kats 结构性负例**：规则里**没有 `probe`、也没有 `attr`** —— 因为 pixhost 主机号写错时返回的是**能正常 onload 的占位图**，`probe` 在此站必然误判成功；顺带钉死 `detail` 带 `externalOnly`、选择器是那 7 个、以及规则里已无内联 `rewrite` |
| 19b | **图床表本身**：imagetwist 记着 `referrer: 'no-referrer'`、两条都有 `verified`；`findHost` 认得 `img<N>` 与 `s<N>` 两种形态与三个 pixhost tld；空 URL 不炸 |
| 19c | **通用图床论坛模式**：合成的规则策略顺序是 `host` 在前 `detail` 在后、`collect` 是 `a[href] > img`、`detail` 带 `externalOnly`、`match` 不含任何站点域名；**页面上 3 张触发、6 张同一家图床也触发（门槛数的是「图」不是「图床」）、2 张不触发、未知域名不触发、`autoDetectHosts=false` 不触发** |
| 20 | **全规则裸域回归**：对 4 条规则逐条钉死「裸域 / `www` / 子域」三种写法都必须命中，外加 3 条反向负例（`example.com/kitty-kats.net/`、`notpornpics.com`、`pinterest.com.evil.test`）不许误伤 —— 守住 `patternToRe` 那个静默 bug（见下） |

### patternToRe 的裸域静默 bug（v0.4.1 修复）

`patternToRe()` 把规则里的通配写法编译成正则，原文是：

```js
s = s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');  // 先把 . 转义成 \.
s = s.replace(/\*\./g, '(?:[^/]+\\.)?');      // 再找 *. —— 已经不存在了
```

第二行是**死代码**：第一行已经把 `.` 转义成 `\.`，字符串里是 `*\.`，而这里找的是 `*.`，永远匹配不上。
于是 `*://*.kitty-kats.net/*` 编译成 `^(?:https?|file)://.*\.kitty-kats\.net/.*$` —— **必须带子域**才命中。

而人访问时敲的几乎都是裸域（`https://kitty-kats.net/threads/...`，不是 `www.` 开头），
症状就是**脚本装好了、版本也对，但打开页面什么都不发生**。四条规则全部中招，且完全不像正则问题。

修法：把模式改成 `/\*\\\./g`（匹配 `*` + `\` + `.`），让那行注释「`*.example.com` 也匹配裸域」
第一次变成真的。第 20 节断言即为它而设。这个 bug 是由用户实机反馈（"kitty-kat 好像不成功"）暴露的 ——
纯靠 CI 不可能发现，因为原来的测试全都用 `www.` 开头的 URL 去命中规则。

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

### pornpics（2026-09-29 取证）

这条规则和 eporner 正好相反 —— eporner 的原图 slug 藏得无处可寻、只能靠 `endpoint`，
而 pornpics 的**原图地址就明写在页面上**，只是藏在锚点自己的 `href` 里：

```html
<a class='rel-link' href='https://cdni.pornpics.com/1280/…_002_f6a3.jpg' data-tid="002">
  <img src='https://static.pornpics.com/style/img/1px.png'
       data-src='https://cdni.pornpics.com/460/…_002_f6a3.jpg'>
</a>
```

`src` 是 1×1 透明占位图，`data-src` 是 460 预览图，而锚点自己的 `href` 指着 1280。
尺寸段只是 URL 路径的第一段，其余部分逐字节相同：

| 尺寸段 | HEAD 实测 |
|---|---|
| `/460/` | 200 · 920×614 |
| `/1280/` | 200 · **1920×1281**，与页面 `data-pswp-width/height` 的声明完全吻合 |
| `/640/` `/800/` `/1600/` `/1920/` `/2560/` `/orig/` `/full/` | **全部 404** |

所以 `/1280/` 就是原图。把每条 `data-src` 的 460 按规则改写成 1280，再与**同一锚点自身的
`href`** 比对：**线上 20/20 完全一致**。也就是说这条规则不是在猜地址，而是在**重建页面
已经发布出去的地址** —— 这正是它比 `probe` 可靠的地方：不需要为了试地址而多发任何请求。

两个反直觉的地方，都写成了负例测试（#15、#16）：

- **绝对不能写 `attr` 步骤。** 条目 `img` 的 `src` 是 1×1 占位图，它和缩略图（460）不同、
  而且是 `https`，能通过 `resolveItem` 的 `got !== thumb` 守卫 → 整页 20 条会被全部推成
  同一张 1×1 占位图。这和 eporner 那次 `catimg/3_small.jpg`（106 条全变成 102×75）是
  **同型故障**，不是新 bug。
- **绝对不能写 `idAttr`。** `data-tid` 是 `002`/`005` 这种，只在**单个画廊内**唯一；而
  `itemKey` 让 `externalId` 优先 → 页面上只要出现第二个画廊，两边的 `002` 就会塌缩成一条。
  去掉 `idAttr` 后去重落到 `link:`（＝锚点 href 的 `/1280/` 地址），全局唯一。

> 顺带一提：该页 `meta description` 写「Watch **20 pics**」，页面也确实只有 20 个条目、
> 没有分页。页面上另有一处「54 pics」是**赞助外链**的文案，与画廊无关 —— 别拿页面上的
> 数字当抓取目标数。

### kitty-kats（2026-09-30 取证）

这个站是 XenForo 论坛，自己不存图 —— 帖子里嵌的是 **pixhost** 图床的缩略图，所以要两跳：

```html
<a href='https://pixhost.cc/show/9569/751781495_ra_petalsvol54_domini_high_0001.jpg'>
  <img class='bbImage'
       src='https://t2.pixhost.cc/thumbs/9569/751781495_ra_petalsvol54_domini_high_0001.jpg'
       data-url='…同一个缩略图地址'>
</a>
```

外层 `a` 指向 pixhost 的 **show 页**（不是图片直链）。show 页里的 `<img id='image'>` 给出真身：

```
https://img2.pixhost.cc/images/9569/751781495_ra_petalsvol54_domini_high_0001.jpg  → 2811×4000
https://t2.pixhost.cc/thumbs/9569/751781495_ra_petalsvol54_domini_high_0001.jpg    → 210×300
```

规律是 `t<N>.pixhost.<tld>/thumbs/` ⇄ `img<N>.pixhost.<tld>/images/`，路径其余部分逐字节相同，
**主机号必须原样保留**（3 张图逐一对照 show 页，3/3 都是 `t2 → img2`）。

#### ★ 这条规则真正的坑：主机号写错返回的不是 404，是一张占位图

| 请求 | 结果 |
|---|---|
| `img2.…/images/…` | 200 · `image/jpeg` · 999434 字节 · **2811×4000**（真身） |
| `t2.…/thumbs/…` | 200 · `image/jpeg` · 7942 字节 · 210×300（真缩略图） |
| `img1` / `img3` / `img4` / `t1` / `t3` | 200 · **`image/png`** · 16138 字节 · **257×126** — 全都是**同一张**占位图（sha 去重后只剩一个） |

也就是说：**请求 `.jpg` 却回 `image/png` 就是占位图**；在这个站，200 和 `image/*` 都不可信。

后果很严重：`probe` 策略靠 `Image()` 的 `onload` 判成功，而**占位图能正常 onload** ——
于是 `probe` 在这个站**必然误判成功**，把整页推成一堆一模一样的占位图，而日志还报「N/N 张拿到原图」。
这和 eporner 那次 `catimg/3_small.jpg` 事故**同型**，但更隐蔽：那次 URL 全部相同，这次 URL 各不相同，
只有字节相同 —— 光看 URL 列表根本发现不了。

所以 kitty-kats 规则里**没有 `probe`、也没有 `attr`**，由 #19 用结构性断言钉死。

> **主机号写错时脚本不纠错。** `t1 → img1`，而那本身就是占位图。图床表只负责按规律改写，
> 不负责猜「用户其实想要 img2」—— 猜不了，因为两者都返回 200。

### imagetwist（2026-10-05 取证）

同一周用户又给了一个 kitty-kats 的帖子，那个帖子 **117 张全是 ImageTwist** —— 同一个论坛、
换个帖子，图床就不一样了。这条取证直接推翻了「一个站点一条规则」的做法，催生了 v0.5.0 的图床表。

```
缩略图  https://img69.imagetwist.com/th/71393/jsgmyvo51tmd.jpg   → 350×233 · 21199 字节
原图    https://img69.imagetwist.com/i/71393/jsgmyvo51tmd.jpg    → 4080×2723 · 2610374 字节
```

规律：`/th/` → `/i/`，**主机名整段原样保留**。主机名有两种形态 `img<N>` 与 `s<N>`
（实测出现过 `img202` / `img34` / `img69` / `img166` / `s10`），不能把 `s10` 猜成 `img10`。
用户给的那个 `/i/…jpg/1__62_.jpg` 里的 `1__62_.jpg` 只是分享页的显示文件名，去掉一样能拿到原图。

| 请求（同一 basename 打不同主机） | 结果 |
|---|---|
| `s10.…/i/71393/jpgx4n11m5n1.jpg` | 200 · **4080×2723** · 3705541 字节（真身，`s10` 上确实有这个文件） |
| `img166.…/i/71393/fsi35sdbao4b.jpg` | 200 · **4080×2723** · 2460968 字节（真身） |
| 该文件不存在的主机号（`img34`/`s10`/`img166`/`img69` 上查 `5isyrqx9svfh`） | 200 · **177×142** · 8183 字节 — 占位图，`/th/` 与 `/i/` 都回它 |

#### ★ 第二个坑：图片请求带外来 Referer 也回占位图

同一个 URL `img69.…/i/71393/jsgmyvo51tmd.jpg`：

| Referer | 结果 |
|---|---|
| 不带 | 200 · 4080×2723 · **2610374 字节**（真身） |
| `https://imagetwist.com/` | 200 · 4080×2723 · 2610374 字节（真身） |
| `https://kitty-kats.net/` | 200 · `image/jpeg` · **8346 字节 · 177×142** — 占位图 |

也就是说：**同一个 URL，带不带 Referer 是两个完全不同的结果，而两者都是 HTTP 200 + 合法 JPEG。**
浏览器默认策略会给跨域图片请求带上本站 origin，所以「替换页面图片」这条路必须显式设
`img.referrerPolicy = 'no-referrer'` —— 脚本按图床表的 `referrer` 字段自动做这件事。
推 Eagle 不受影响（Eagle 下载时不带 Referer）。

分享页 `https://imagetwist.com/<id>` 则**没有**防盗链：Referer 为 无 / kitty-kats / imagetwist
三种都是 200 + 约 36.5KB，且页内就有原图直链
`<img class="pic img img-responsive" src="https://img69.imagetwist.com/i/71393/<id>.jpg/1__62_.jpg">`。
所以图床表还没收录它时，`detail` 抓分享页这条路对 imagetwist 同样成立（这也是通用图床论坛模式第 ② 步的依据）。

`match` 只写 `*://*.kitty-kats.net/*`（论坛域名），**不去匹配 pixhost / imagetwist** —— 否则任何贴了
这些图的网站都会套上这条站点规则。图床域名的匹配属于 `hosts` 表里每条记录的 `match`。

> 取证方式：**kitty-kats 在 Cloudflare 后面**，`Invoke-WebRequest`（即使带完整浏览器头）一律 HTTP 403
> 「Sorry, you have been blocked」；但插件提供的 `web_fetch` 网页桥能拿到 200 —— 帖子里的真实标记就是从它
> 拿到的（117 张形如 `[![](https://img202.imagetwist.com/th/71393/5isyrqx9svfh.jpg)](https://imagetwist.com/5isyrqx9svfh/1__1_.jpg)`）。
> pixhost / imagetwist 本身没有反爬，那两半是自己实测的（PowerShell 抓字节 + `System.Drawing` 解像素）。

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
| 推送说成功，但 Eagle 里全是**同一张**小图（URL 全都一样） | **先看解析来源**（日志里 `验证原图（解析来源 …）` 那一行）。<br>实测根因：**`attr` 选择器退化到整页匹配** —— 条目自己的 `img` 没有 `data-src`（懒加载占位是 `data:` URI），整页兜底就返回了文档里第一个 `img[data-src]`，也就是站点图标 `catimg/N_small.jpg`（102×75）。**这种情况下日志会显示「解析完成：N/N 张拿到原图」，完全不报错。** 现在整页兜底默认关闭，必须规则显式声明 `allowDocument: true` **且**结果与缩略图同目录才放行。<br>若解析来源正常却仍是同一张，点「**验证原图**」看带/不带 Referer 拿到的像素尺寸，判断是不是 CDN 防盗链（那时改用 **B. 替换页面图片**）。 |
| 收进来 / 替换后全是 **177×142** 或 **257×126** 的小图（**URL 各不相同**，所以去重拦不住） | **图床占位图。** 这两家图床拿不到原图时不返回 404，而是回 `HTTP 200` + 一张能正常解码的占位图（pixhost 主机号写错 → 257×126 / 16138 字节 `image/png`；imagetwist 主机号写错 → 177×142 / 8183 字节；**imagetwist 带外来 Referer → 177×142 / 8346 字节**）。<br>看「验证原图」的判读：**只有不带 Referer 才拿到大图 → 图床防盗链**，属于该图床的 `referrer: 'no-referrer'`（脚本替换时会自动设 `img.referrerPolicy`），推 Eagle 不受影响。<br>**只有带 Referer 才拿到大图 → 反过来**，得改成让页面自己下。<br>两种都小 → 地址解析错了（图床规律写错，比如把 `s10` 猜成 `img10`）。 |
| 论坛帖子里图明明很多，面板却不弹 / 一张都不收 | ① 站点规则还没写 → 但页面上若有 **≥3 张**已知图床（`hosts` 表里）的图，会自动触发**通用图床论坛模式**；② 图床还没进 `hosts` 表，自动识别认不出 —— 用油猴菜单 **「通用图床论坛模式：在本页强开」**，已知图床零请求、未知的走抓分享页；③ 设置里 `autoDetectHosts` 被关了。 |
| 论坛头像、引用的小图也被收进来了 | 合成规则的 `detail` 带了 `externalOnly: true`，只抓**外链**分享页 —— 站内链接（头像、楼层跳转）会被直接跳过。若站点规则是自己写的且没带这个字段，可以补上；或者把 `collect.item` 收窄。 |
| Eagle 里出现重复素材，数量少于条目数 | 页面上条目数常多于画廊的实际照片数（实测 eporner：106 个条目 → 85 张照片）。脚本推送前会按原图 URL 去重，日志打 `有 21 个条目与前面的条目指向同一张原图，已跳过`。 |
| 推送成功但图是封面 | 该站点误配了 `detail`。检查条目链接是否与当前页同 URL。 |
| 瀑布流滚了很久，数字却停在 20 左右不动 | 该站点是**虚拟化列表**：滚出视野的 tile 会被从 DOM 里卸载，所以静态快照永远只有当前挂载的那 ~20 个。修法是给规则的 `collect` 加 `scrollToLoad: true` —— 脚本会**边走边滚、边滚边收**并按稳定 key（id / 详情页链接）累计。跨多次「扫描本页」也会继续**累加**（不再被覆盖），所以手动滚一段再扫一次同样有效。见 `tests/scroll-harness.mjs`。 |
| 「替换页面图片」只换掉了首屏那十几张 | 同上的虚拟化原因：那一刻 DOM 里**只有**那十几张。旧实现还额外用了 `thumb` 对齐，而重挂载后同一个 pin 的 `thumb` 常常换成另一个尺寸的候选地址，于是连那十几张都可能对不上。现在改为按**稳定 key**（详情页链接去掉 query/hash）对齐，并且「跟随滚动」模式下**边滚边换**。见 `tests/scroll-harness.mjs` 断言 7、8。 |
| 日志说「N 个 tile 指向同一张原图」 | 不是 bug。Pinterest 的推荐流会把同一个 pin 推好几次，页面上就有几个 tile 指向同一张原图。脚本按 URL 去重后再推送，重复项会被标成「重复，已跳过」；本地替换为了保持所见即所得仍然照换，挑图时留意即可。 |
| 页面上明明有几百条，推送却只发了一部分 | 看推送日志里的 `（已按 URL 去重）`：条目数常多于实际照片数（实测 eporner 106 条 → 85 张）。 |
| 送进 Eagle 的文件名全是 `MUMT12OZPMAVP` 这种 | 那是**素材 id** —— 说明发出去的 `name` 是空串。实测确认 `POST /api/v2/item/add` 是认 `name` 的（传什么读回来就是什么），所以这是纯客户端问题。检查设置里的「素材命名模板」是不是被清空了；模板填空会回落到默认的 `{basename}`。见上面的「素材命名」。 |
| 名字是 `image-01` / `3_small` 这种没信息量的 | 原图 URL 尾段本身就是弱名（哈希、纯数字、保留字），触发了兜底。想更可读就把模板改成 `{page}-{n}` 或 `{alt}` —— 弱名兜底时会优先取 `{page}`/`{alt}`。 |
| 推了 N 条，Eagle 里却只有 N-1 条 | **Eagle 不会留下下载失败的原图。** 实测：给一条 404 的地址，Eagle 照常返回一个素材 id，但 `item/get` 重试 20 秒仍是 `total: 0`。所以「少了一条」多半是那条原图挂了（防盗链 / 已删除），不是脚本漏发。脚本推送日志里的 `ok=N failed=0` 反映的是 HTTP 层面，不代表 Eagle 下载成功。 |
| 升级了脚本，却一直收不到规则更新 | 老版本的 GM 存储里存着一份 `subscriptionUrl: ''`，而 `Object.assign({}, DEFAULT_SETTINGS, stored)` 会让存下来的旧值**盖掉新默认值** —— 而且这个失败是完全静默的（日志只会说「未配置订阅地址，使用内置规则」）。现在 `subscriptionUrlOf()` 把空字符串归一化成官方订阅表，设置页里显示的就是**实际生效**的地址；想彻底只用内置规则（离线 / 内网），把那一栏明确填成 `none`。`tests/resolve-harness.mjs` 有 10 条断言盯着这个行为。 |
| Tampermonkey 里出现了两份同名脚本 | 脚本身份是 `@name` + `@namespace` 的组合。本仓库沿用了最初的 `namespace: eagle-batch-collector`，所以从旧版升级是**原地更新、设置不丢**；如果你手动改过 `@namespace`，Tampermonkey 会当成另一个脚本装第二份，删掉多余的那份即可。 |
