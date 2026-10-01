// ==UserScript==
// @name         Eagle 大图批量收藏
// @name:en      Eagle Full-Size Collector
// @namespace    eagle-batch-collector
// @version      0.6.0
// @description  订阅规则表驱动的原图批量采集：把列表页/瀑布流里的缩略图升级成原图，直推 Eagle 素材库（或替换页面图片，配合 Eagle 官方扩展批量收藏）
// @author       kaerozhi
// @license      MIT
// @homepageURL  https://github.com/kaerozhi/eagle-fullsize-collector
// @supportURL   https://github.com/kaerozhi/eagle-fullsize-collector/issues
// @downloadURL  https://raw.githubusercontent.com/kaerozhi/eagle-fullsize-collector/main/eagle-fullsize.user.js
// @updateURL    https://raw.githubusercontent.com/kaerozhi/eagle-fullsize-collector/main/eagle-fullsize.user.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        GM_notification
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  /* ============================================================
   * 0. 常量与默认设置
   * ============================================================ */

  const NS = 'ebc.';                      // 存储命名空间
  const VERSION = '0.6.0';

  const DEFAULT_SETTINGS = {
    // 远程订阅规则表 URL（同 AdBlock 订阅）。留空 = 只用内置规则。
    // 默认指向本项目的 rules/default.json —— 维护者只改那一个文件，
    // 所有装了脚本的人下次启动就会拉到新版，**不用重装脚本**。
    // 也可改成自己的 GitHub raw / gist raw / 任意 https 直链 JSON。
    subscriptionUrl: 'https://raw.githubusercontent.com/kaerozhi/eagle-fullsize-collector/main/rules/default.json',
    // Eagle 本地 API。不需要 token。
    eagleOrigin: 'http://127.0.0.1:41595',
    // 目标文件夹 id（面板里选）与附加标签
    folderId: '',
    tags: '',
    // 送 Eagle 时每批条数。Eagle 的 HTTP API 与 MCP 共享单线程事件循环，
    // 高负载会被饿死 —— 所以批次要小、请求要串行。
    batchSize: 8,
    batchDelayMs: 400,
    // resolve 管线默认并发与间隔
    concurrency: 5,
    delayMs: 120,
    // 命中规则时自动展开面板
    autoOpenPanel: true,
    // 学习模式：记录 缩略图→原图 配对，用于自动生成 rewrite 规则
    learnMode: false,
    // 无限滚动列表最多累计多少条（0 = 不封顶）。瀑布流/画廊是虚拟化列表，
    // 滚出视野的 tile 会被卸载，只能边走边收 —— 这里给它一个安全上限。
    maxItems: 800,
    // 采集方式（用户实测反馈后加的）：
    //   'follow'（默认）—— 脚本**不主动滚动**。你滚到哪，它静默地把当时挂着的
    //                      那批条目收下来、解析原图（配合 autoReplace 就地替换）。
    //   'auto'          —— 自动一路滚到底再收。会夺走滚动控制权，长列表下很吓人，
    //                      所以必须是显式选择。
    scanMode: 'follow',
    // 跟随滚动时，把已解析出原图的缩略图**就地**换成原图 —— 然后用 Eagle 官方
    // 扩展的「批量收藏」慢慢挑。这样不必先把几百张塞进素材库再回来清理。
    autoReplace: true,
    // 上面那个「停下来就收一遍」的防抖：滚动停下多久才做一次。
    followDebounceMs: 700,
    // 送 Eagle 时的素材名。Eagle 的 POST /api/v2/item/add **认 name**（已实测：
    // 传什么读回什么）；传空字符串时 Eagle 会拿素材 id 当名字，于是库里全是
    // MUMT12OZPMAVP 这种没法搜的东西 —— 这个需求就是用户提的。
    // 可用占位符：
    //   {basename} 原图 URL 的文件名（去扩展名）—— eporner 那种拼音 slug 最有信息量
    //   {alt}      图片的 alt / title 文本
    //   {page}     页面标题
    //   {host}     原图域名
    //   {id}       条目 id（规则从 data-* 读到的）
    //   {n}        本条在本次结果里的序号
    // 渲染结果为空、或结果本身没有信息量（纯哈希 / 纯数字 / image、photo 这种通用名）
    // 时自动兜底成「页面标题-序号」，**绝不返回空串**。
    nameTemplate: '{basename}',
    // 通用图床论坛模式：站点规则没命中时，如果页面上有 ≥3 张来自「图床表」
    // 里已知图床的图，就自动按图床表启用。用户实测的场景是论坛里用户可以
    // 从任意免费图床贴图 —— 那种页面没法为每家图床写站点规则，只能按图床认。
    autoDetectHosts: true,
  };

  // 各家图床**分享页**里的原图选择器，按「最可能命中」排序，取不到就继续往下试。
  // 用户实测的场景（论坛）：帖子里的图是用户从各种免费图床贴进来的，所以站点规则
  // 不可能把它们一一列全 —— 只能拿缩略图外面的那个 `<a href>` 去抓分享页。
  // 实测：imagetwist 的分享页是 <img class='pic' src='…/i/…'>，pixhost 是 <img id='image'>。
  const HOST_GALLERY_DETAIL_SELECTORS = [
    "meta[property='og:image']@content",
    'img.pic@src', // imagetwist
    'img#image@src', // pixhost / imagebam
    'img.centered@src', // imagevenue
    '#image-container img@src',
    '.image-view img@src',
    'img@src',
  ];

  // 内置默认规则表（离线可用）。远程订阅会按 id 覆盖它。
  const BUILTIN_RULES = [
    {
      id: 'pinterest',
      name: 'Pinterest 瀑布流',
      enabled: true,
      match: [
        '*://*.pinterest.com/*',
        '*://*.pinterest.co.uk/*',
        '*://*.pinterest.de/*',
        '*://*.pinterest.fr/*',
        '*://*.pinterest.jp/*',
      ],
      spa: true,
      referer: 'https://www.pinterest.com/',
      collect: {
        item: "div[data-test-id='pin'], div[data-grid-item]",
        img: 'img',
        link: "a[href*='/pin/']",
        // ★ Pinterest 的瀑布流是**虚拟化**列表：只挂载视口附近的 tile。
        //   必须边走边收（collectAll），单次快照永远只有首屏那 ~19 张。
        scrollToLoad: true,
      },
      resolve: [
        { type: 'attr', selectors: ['img@data-src', 'img@srcset:last', 'img@src'] },
        {
          type: 'rewrite',
          rules: [
            {
              re: '//i\\.pinimg\\.com/(?:\\d+x\\d*|originals|\\d+x)/',
              to: '//i.pinimg.com/originals/',
            },
          ],
        },
        {
          type: 'probe',
          candidates: [
            { re: '//i\\.pinimg\\.com/(?:\\d+x\\d*|originals|\\d+x)/', to: '//i.pinimg.com/originals/' },
            { re: '//i\\.pinimg\\.com/(?:\\d+x\\d*|originals|\\d+x)/', to: '//i.pinimg.com/736x/' },
          ],
        },
      ],
    },
    {
      id: 'meitulu',
      name: '美图录分页相册',
      enabled: true,
      match: ['*://*.meitulu.me/item/*.html'],
      collect: {
        // 美图录的相册正文是 .container-inner-fix-m 下的原图；推荐相册也有 img，
        // 所以不能退化到全页 img，否则会把推荐封面一并收进来。
        item: '.container-inner-fix-m > img',
        img: 'self',
        pagination: {
          // 分页器带省略号时，从已发现的链接递归继续发现后续页，直到没有新页。
          links: 'ul.pagination a[href]',
          maxPages: 100,
        },
      },
      resolve: [
        // 这里的 src 本身就是 1200x1800 原图；允许 attr 返回与 thumb 相同的地址。
        { type: 'attr', selectors: ['img@src'], allowSameThumb: true },
      ],
    },
    {
      id: 'eporner',
      name: 'Eporner 画廊',
      enabled: true,
      match: ['*://*.eporner.com/gallery/*', '*://*.eporner.com/photo/*'],
      referer: 'https://www.eporner.com/',
      concurrency: 5,
      delayMs: 120,
      collect: {
        // 实测：每个缩略图外面是 <a data-photo-id="10574489" href="…#gallery-photo=10574489">
        item: 'a[data-photo-id]',
        img: 'img',
        link: 'self',
        idAttr: 'self@data-photo-id',
        // 实测：缩略图是懒加载的，未进视口时 src 是 1x1 透明 gif 占位符
        scrollToLoad: true,
      },
      // 实测结论（2026-09-29，用户提供的真实样例）：
      //   缩略图 …/gallery/Ol/oQ/5IUmqWloQOl/10574489-10574489_296x1000.jpg
      //   原图   …/gallery/Ol/oQ/5IUmqWloQOl/10574489-gao-qiaoshou-…-nude.jpg
      // 目录和 id 前缀相同，但文件名后半段是拼音 slug，**无法由缩略图改写得到**。
      // 所以这里不能用 rewrite，也不能用 detail（"详情页"其实是同页面的 #hash，
      // 抓回来只会拿到画廊封面，导致同一张封面被重复收藏 N 次）。
      // 正确做法：从列表页自身的数据里按「同目录 + 同 id」找出原图地址。
      resolve: [
        {
          // ★ endpoint 排第一：实测一次性返回整组 85 张正确原图，是所有策略里唯一被
          //   真实数据证明过的。原来 attr 排第一，而它在本站必然退化失败（见下），
          //   还会用站点图标冒充原图，所以让位。
          // 实测取证：GET /xhr/gallery-slide/<galleryId> 一次返回 136KB，
          // 含整个画廊（85 张）的 <id>-<拼音slug>.jpg 原图直链。
          // galleryId 从页面上任意 [data-gallery-id] 或 URL 路径 /gallery/<hash>/ 取。
          type: 'endpoint',
          url: '/xhr/gallery-slide/{galleryId}',
          vars: {
            galleryId: ['[data-gallery-id]@data-gallery-id', 'url:/gallery/([^/]+)/'],
          },
          idFrom: '([0-9]{6,})',
        },
        {
          // 条目级读属性：本站条目 img 通常没有可用的 data-src，
          // 所以这一步大概率返回空、直接落到 pagedata，留着不吃亏。
          // 注意：整页兜底已默认禁用（需要 allowDocument: true），本站绝不能再开 ——
          // 否则会拿到站点分类图标 catimg/3_small.jpg（102x75）。
          type: 'attr',
          selectors: ['img@data-src', 'img@data-original', 'img@data-full', 'img@srcset:last', 'img@src'],
        },
        { type: 'pagedata', idFrom: '([0-9]{6,})' },
        { type: 'probe', candidates: [{ re: '_\\d+x\\d+\\.jpg$', to: '.jpg' }] },
      ],
    },
    {
      id: 'pornpics',
      name: 'PornPics 画廊',
      enabled: true,
      match: ['*://*.pornpics.com/*'],
      referer: 'https://www.pornpics.com/',
      collect: {
        // 实测：图块是 <a class='rel-link' … data-tid="002">，原图就挂在它自己的 href 上。
        // 两个选择器选的是同一批元素，写成组是为了多一层保险（列表页的画廊链接是
        // JS 渲染的，无法离线核实其标记）。
        item: 'a.rel-link, a[data-tid]',
        img: 'img',
        link: 'self',
        // 实测：src 是 1x1 透明占位图（static.pornpics.com/style/img/1px.png），
        // 真图在 data-src（460 预览图），所以是懒加载页
        scrollToLoad: true,
      },
      // 实测结论（2026-09-29，真实画廊页 + node 自校验）：
      //   条目长这样：
      //     <a class='rel-link' href='https://cdni.pornpics.com/1280/…_002_f6a3.jpg' data-tid="002">
      //       <img src='https://static.pornpics.com/style/img/1px.png'
      //            data-src='https://cdni.pornpics.com/460/…_002_f6a3.jpg'>
      //     </a>
      //   尺寸段是 URL 路径的第一段，其余部分逐字节相同。HEAD 实测：
      //     /460/  → 920x614
      //     /1280/ → 1920x1281，与页面 data-pswp-width/height 声明完全吻合
      //     而 /640/ /800/ /1600/ /1920/ /2560/ /orig/ /full/ 全部 404
      //   → /1280/ 就是原图。
      //   把每条 data-src 的 460 按下面这条规则改写成 1280，再与同一锚点**自身的
      //   href** 比对：线上 20/20 完全一致。
      //   也就是说这不是「猜原图地址」，而是重建页面已经发布出去的地址。
      resolve: [
        {
          type: 'rewrite',
          rules: [{ re: '//cdni\\.pornpics\\.com/\\d+/', to: '//cdni.pornpics.com/1280/' }],
        },
        // ★ 故意不写 attr 步骤：本站条目 img 的 src 是 1x1 占位图，它与缩略图(460)
        //   不同且是 https，能通过 resolveItem 的 got !== thumb 守卫，于是占位图会被
        //   当成原图推给每一条 —— 正是 eporner 那次 catimg/3_small.jpg 事故
        //   （106 条全变成同一张 102x75）的同型故障。
        // ★ 也故意不写 idAttr：data-tid 是 002/005 这种，只在单个画廊内唯一，而
        //   itemKey 让 externalId 优先 —— 一旦页面含多个画廊就会互相塌缩成一条。
        //   去掉 idAttr 后，去重落到 link:（＝锚点 href 的 /1280/ 地址），全局唯一。
      ],
    },
    {
      id: 'kitty-kats',
      name: 'Kitty-Kats 论坛（图床由 hosts 表决定）',
      enabled: true,
      match: ['*://*.kitty-kats.net/*'],
      collect: {
        // 实测（用户从真实浏览器导出的 DOM + 联网复测）：帖子图长这样 ——
        //   <a href='https://pixhost.cc/show/9569/<id>_<name>.jpg'>
        //     <img class='bbImage' src='https://t2.pixhost.cc/thumbs/9569/<id>_<name>.jpg'>
        //   </a>
        // 外层 a 指向图床的**分享页**（不是图片直链），所以要两跳。
        // 两个选择器命中的是同一批图：前者拿到外链可靠的帖子图，后者兜住没有外层 a
        // 的；itemKey 会按外层 a 的 href 去重，不会重复收集。
        // ★ 故意不再按图床名筛（原来的 a[href*='pixhost']）—— 实测同一个论坛里
        //   用户混用多家图床（另一个帖子 117 张全是 imagetwist）。
        item: 'a[href] > img, img.bbImage',
        img: 'self',
      },
      // v0.5 起这条规则**瘦身成一条薄绑定**：改写规律全部移进 hosts（图床表，
      // 见 2.5 节），resolve 只剩 host + detail。理由：同一个论坛混用多家图床，
      // 把某一家的改写规律写进站点规则是错的分层。
      // 历史实测结论（2026-09-30，对 pixhost 的联网实测）：show 页里的 <img id='image'>
      //   给出真身 https://img2.pixhost.cc/images/9569/<id>_<name>.jpg → 2811x4000，
      //   而缩略图 t2.pixhost.cc/thumbs/… 是 210x300；规律 t<N>/thumbs/ ⇄ img<N>/images/，
      //   主机号必须原样保留。★★ 主机号写错**不会 404**，而是一张 16138 字节 257x126 的
      //   占位图（HTTP 200 + image/png），所以 probe 在此站必然误判成功 —— 规律全部
      //   收进 hosts 表并只用改写，绝不写 probe。★ 也故意不写 attr：img 的 src 与
      //   data-url 都是缩略图地址，读出来还是缩略图。
      resolve: [
        // ① 已知图床：查图床表，零请求改写
        { type: 'host' },
        // ② 表格里还没收录的图床：抓外层 a 那个分享页，从里面读原图直链。
        //    实测 imagetwist / pixhost 的分享页都不挑 Referer（无 / 本站 / 图床自己
        //    三种都是 HTTP 200 且含原图直链），所以这里不设 referer。
        //    externalOnly 挡噪音：帖子里的头像/引用全是站内链接，只有用户贴的
        //    图床分享页是外链。
        {
          type: 'detail',
          excludeThumb: true,
          externalOnly: true,
          selectors: HOST_GALLERY_DETAIL_SELECTORS,
        },
      ],
      delayMs: 150,
    },
  ];

  /* ============================================================
   * 1. 存储层（Tampermonkey 缺失时退化为 localStorage）
   * ============================================================ */

  const hasGM = typeof GM_getValue === 'function';

  const store = {
    get(key, fallback) {
      const k = NS + key;
      try {
        if (hasGM) {
          const raw = GM_getValue(k, null);
          if (raw === null || raw === undefined) return fallback;
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
        const raw = localStorage.getItem(k);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        console.warn('[EBC] store.get failed', k, e);
        return fallback;
      }
    },
    set(key, value) {
      const k = NS + key;
      try {
        const raw = JSON.stringify(value);
        if (hasGM) GM_setValue(k, raw);
        else localStorage.setItem(k, raw);
      } catch (e) {
        console.warn('[EBC] store.set failed', k, e);
      }
    },
  };

  const settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));

  // ★ 这里的空字符串不等于「我不要订阅」。
  //
  // 老版本在这套存储里留下过一份 `subscriptionUrl: ''`（那时默认值就是空），
  // 而 Object.assign 会让存下来的旧值盖掉新默认值 —— 结果是「脚本升级了，
  // 却永远收不到规则更新」，而且这个失败**完全静默**：日志只会说
  // 「未配置订阅地址，使用内置规则」，用户不会觉得哪里不对。
  //
  // 所以规则是：空 = 跟随 DEFAULT_SETTINGS 里的官方订阅表（升级即生效）；
  // 想彻底只用内置规则（离线 / 内网 / 不想联网），把它明确填成 `none`。
  const SUBSCRIPTION_OFF = new Set(['none', 'off', '-', '0', 'false', 'no']);
  function subscriptionUrlOf() {
    const raw = String(settings.subscriptionUrl == null ? '' : settings.subscriptionUrl).trim();
    if (!raw) return DEFAULT_SETTINGS.subscriptionUrl;
    if (SUBSCRIPTION_OFF.has(raw.toLowerCase())) return '';
    return raw;
  }

  function saveSettings(patch) {
    Object.assign(settings, patch);
    store.set('settings', settings);
  }

  /* ============================================================
   * 2. URL 匹配（@match 风格通配 → 正则）
   * ============================================================ */

  const reCache = new Map();
  function patternToRe(pat) {
    if (reCache.has(pat)) return reCache.get(pat);
    // 先转义正则元字符，但保留 * 与 /
    let s = String(pat).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(/\*:\/\//g, '(?:https?|file)://');   // 协议部分
    // ★ 这里匹配的是 *\.（星号 + 反斜杠 + 点），不是 *.
    // 上一行已经把 . 转义成 \. 了，写成 /\*\./ 永远匹配不上 —— 那是个静默 bug：
    // 所有 "*://*.example.com/*" 形式的规则只认子域、不认裸域，
    // 而大家访问时几乎都敲裸域（https://eporner.com/... 而不是 www.eporner.com/...）。
    // v0.4.1 修的就是这个。
    s = s.replace(/\*\\\./g, '(?:[^/]+\\.)?');         // *.example.com 也匹配裸域
    s = s.replace(/\*/g, '.*');                        // 其余 * 任意字符（含 /）
    const re = new RegExp('^' + s + '$', 'i');
    reCache.set(pat, re);
    return re;
  }

  function matchAny(url, patterns) {
    if (!Array.isArray(patterns) || !patterns.length) return false;
    return patterns.some((p) => patternToRe(p).test(url));
  }

  /* ============================================================
   * 2.5 图床表：缩略图 → 原图 的改写规律，按图床而不是按站点
   *
   * 为什么不按站点写（用户实测，kitty-kats 这类「用户可以自由发图的论坛」）：
   * 帖子里的图是用户从各种免费图床贴进来的，同一个帖子就可能混用好几家，
   * 所以「为这个论坛写一条规则」从根上就不成立 —— 得认**图床**。
   *
   * 为什么必须用「改写」而不是「实测哪个能下」：
   * 这两家图床拿不到原图时**都不返回 404**，而是返回 HTTP 200 + 一张能正常
   * 解码的 JPEG 占位图：
   *   · imagetwist：主机号写错 或 图片请求带了外来 Referer → 177x142 / 8183~8346 字节
   *   · pixhost   ：主机号写错                            → 257x126 / 16138 字节
   * 也就是说 probe 这类「加载成功就算命中」的策略在这里**必然误判成功**，
   * 只会把一堆占位图塞进 Eagle，而日志看起来一切正常。只能靠既知规律改写。
   *
   * 结构：
   *   match    []    命中该图床图片 URL 的 glob（与站点规则的 match 同语法）
   *   thumbRe  ''    缩略图 URL 的正则（捕获组可用 $1 引用）
   *   fullTo   ''    替换成原图 URL 的模板，$1 引用 thumbRe 的捕获组
   *   referrer ''    可选。填 'no-referrer' 表示该图床**必须不带 Referer** 才给原图
   *                  （就地替换页面图片时脚本会照着设 img.referrerPolicy）
   *   verified ''    这条规律最后一次实机验证的日期。留空 = 没实测过，别信
   * ============================================================ */

  const BUILTIN_HOSTS = [
    {
      id: 'pixhost',
      name: 'pixhost',
      enabled: true,
      match: ['*://*.pixhost.cc/*', '*://*.pixhost.to/*', '*://*.pixhost.org/*'],
      thumbRe: '//t(\\d+)\\.pixhost\\.(cc|to|org)/thumbs/',
      fullTo: '//img$1.pixhost.$2/images/',
      verified: '2026-09-30',
    },
    {
      id: 'imagetwist',
      name: 'ImageTwist',
      enabled: true,
      match: ['*://*.imagetwist.com/*'],
      // ★ 主机前缀（img69 / img202 / s10 …）和它的数字必须**原样保留**：
      //   换一个主机号不会 404，只会给一张 177x142 的占位图。
      thumbRe: '//((?:img|s)\\d+)\\.imagetwist\\.com/th/',
      fullTo: '//$1.imagetwist.com/i/',
      // ★ 实测：带外来 Referer（哪怕只是 origin）→ HTTP 200 + 8346 字节 177x142
      //   占位图；不带 Referer → 2610374 字节 4080x2723 原图。
      referrer: 'no-referrer',
      verified: '2026-10-05',
    },
  ];

  function activeHosts() {
    return (ruleset.hosts || []).filter((h) => h.enabled !== false);
  }

  /**
   * 按**图片 URL**（不是页面 URL）查图床表。查不到返回 null。
   * 站点规则只负责「页面上哪些节点是帖子图」，具体怎么拿到原图交给图床表。
   */
  function findHost(url) {
    if (!url) return null;
    for (const h of activeHosts()) {
      try {
        if (matchAny(url, h.match)) return h;
      } catch (e) {
        /* 单条记录写错不该拖垮整页 */
      }
    }
    return null;
  }

  function hostNames() {
    return activeHosts().map((h) => h.name || h.id).join('、');
  }

  /* ============================================================
   * 3. 规则表加载与合并
   * ============================================================ */

  function mergeRules(base, overrides) {
    const byId = new Map();
    for (const r of base || []) byId.set(r.id, r);
    for (const r of overrides || []) {
      // 本地覆盖：同 id 合并顶层字段；resolve/collect 整体替换
      const prev = byId.get(r.id);
      byId.set(r.id, prev ? Object.assign({}, prev, r) : r);
    }
    return Array.from(byId.values());
  }

  let ruleset = {
    version: 0,
    updated: '',
    rules: mergeRules(BUILTIN_RULES, store.get('localRules', [])),
    // 图床表与站点规则分开维护：加一家图床只动 hosts，所有站点规则同时受益。
    hosts: mergeRules(BUILTIN_HOSTS, store.get('localHosts', [])),
    remote: null,
  };

  function applyRemoteHosts(data) {
    if (!data || !Array.isArray(data.hosts)) return;
    ruleset.hosts = mergeRules(BUILTIN_HOSTS, data.hosts.concat(store.get('localHosts', [])));
  }

  function activeRules() {
    return ruleset.rules.filter((r) => r.enabled !== false);
  }

  function findRuleFor(url) {
    for (const r of activeRules()) {
      if (matchAny(url, r.match)) return r;
    }
    return null;
  }

  function gmGet(url, { timeout = 15000, headers = {}, method = 'GET', data = null, responseType = '' } = {}) {
    return new Promise((resolve, reject) => {
      const opts = {
        method,
        url,
        headers: Object.assign({ Accept: '*/*' }, headers),
        data,
        timeout,
        onload: (r) => resolve(r),
        onerror: () => reject(new Error('network error: ' + url)),
        ontimeout: () => reject(new Error('timeout: ' + url)),
      };
      // responseType 只在确实要二进制时设置：'blob' 模式下 Tampermonkey 不保证有 responseText
      if (responseType) opts.responseType = responseType;
      GM_xmlhttpRequest(opts);
    });
  }

  async function loadSubscription(silent) {
    const url = subscriptionUrlOf();
    if (!url) {
      if (!silent) log('订阅已关闭（订阅地址填的是 none），只用内置规则。', 'warn');
      return false;
    }
    try {
      const r = await gmGet(url, { timeout: 20000, headers: { 'Cache-Control': 'no-cache' } });
      if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
      const data = JSON.parse(r.responseText);
      if (!data || !Array.isArray(data.rules)) throw new Error('订阅内容不含 rules 数组');
      ruleset.remote = data;
      ruleset.rules = mergeRules(data.rules, store.get('localRules', []));
      applyRemoteHosts(data);
      store.set('subCache', { at: Date.now(), data });
      if (!silent) {
        const nh = (data.hosts || []).length;
        log(`订阅已更新：${data.rules.length} 条站点规则${nh ? ` + ${nh} 条图床规则` : ''}（${data.updated || '未标日期'}）`, 'ok');
      }
      renderStatus();
      return true;
    } catch (e) {
      // 回退到上次成功的缓存，再回退到内置
      const cached = store.get('subCache', null);
      if (cached && cached.data) {
        ruleset.remote = cached.data;
        ruleset.rules = mergeRules(cached.data.rules, store.get('localRules', []));
        applyRemoteHosts(cached.data);
        log(`订阅拉取失败（${e.message}），已回退到缓存版本。`, 'warn');
      } else {
        log(`订阅拉取失败（${e.message}），继续使用内置规则。`, 'error');
      }
      renderStatus();
      return false;
    }
  }

  /* ============================================================
   * 4. 从列表页采集「条目」
   * ============================================================ */

  /* ------------------------------------------------------------
   * 4.0 素材命名
   *
   * 用户反馈：送进 Eagle 之后文件名全是 `MUMT12OZPMAVP` 这种，毫无信息量，
   * 没法在库里搜。原因不是 Eagle 的问题 —— 实测 `POST /api/v2/item/add`
   * 传 `name: 'xxx'`，`item/get` 读回来就是 `xxx`；是**本脚本一直传空字符串**，
   * 于是 Eagle 退化成拿素材 id 当名字。
   *
   * 这里从**原图地址**派生一个有意义的素材名。难点是「原图地址里根本没有
   * 有意义的文件名」这种情况真实存在：
   *   - Pinterest 的 i.pinimg.com 是 `.../originals/ab/cd/ef/abcdef0…jpg`，纯哈希；
   *   - 有些站直接是 `image_1.jpg`、`photo.jpg`。
   * 这种名字塞进库里还是搜不到，所以命中「无意义」判据时改用页面标题兜底。
   * ------------------------------------------------------------ */

  // Eagle 素材名会进 UI、进搜索，也可能被导出成文件名 —— 清掉路径分隔符与控制字符。
  function sanitizeName(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 120)
      .trim();
  }

  // 原图 URL 的 basename（去掉扩展名，URL 解码）。拿不到返回 ''。
  function baseNameOfUrl(url) {
    try {
      const u = new URL(url, location.href);
      let last = u.pathname.split('/').filter(Boolean).pop() || '';
      try { last = decodeURIComponent(last); } catch (e) {}
      return last.replace(/\.[a-z0-9]{1,5}$/i, '');
    } catch (e) {}
    return '';
  }

  // 「这个 basename 本身就没有信息量」——命中就换别的来源。
  const WEAK_BASE_RE =
    /^(image|img|photo|picture|pic|untitled|download|blob|preview|thumb|thumbnail|large|original|default|placeholder|asset|file|\d+|_+|-+)$/i;
  function isWeakBase(name) {
    const s = String(name == null ? '' : name).trim();
    if (s.length < 3) return true;
    if (WEAK_BASE_RE.test(s)) return true;
    if (/^[0-9a-f]{12,}$/i.test(s)) return true;      // Pinterest 那样的纯哈希
    if (!/[a-z\u4e00-\u9fa5]/i.test(s)) return true;  // 一个字母都没有
    return false;
  }

  /**
   * 算出送 Eagle 用的素材名。
   * 先渲染 nameTemplate；渲染结果为空、或名字没有信息量时自动兜底成
   * 「页面标题-序号」。**保证永不返回空串** —— 空串就是用户在库里看到的乱码。
   */
  function buildItemName(it, url, index) {
    const n = (index == null ? 0 : index) + 1;
    const page = sanitizeName(document.title || '');
    const alt = sanitizeName(it && it.alt ? it.alt : '');
    const id = it && it.externalId ? String(it.externalId).trim() : '';
    let host = '';
    try { host = new URL(url || location.href, location.href).hostname; } catch (e) {}
    const base = baseNameOfUrl(url);

    // {n} 补齐两位：否则库里按名字排序时空标题的 `-10` 会排在 `-2` 前面
    const padN = String(n).padStart(2, '0');
    const vars = { basename: base, alt, page, host, id, n: padN };
    const rendered = sanitizeName(
      String(settings.nameTemplate || '{basename}').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
    );

    // 名字要有信息量：模板渲染为空、或本身就是哈希/纯数字/通用名时，换页面标题。
    if (!rendered || isWeakBase(rendered)) {
      const lead = page || alt || host || 'image';
      return sanitizeName(`${lead}-${padN}`);
    }
    return rendered;
  }

  /**
   * 返回 [{ el, img, thumb, link, externalId, alt }]
   * thumb = 缩略图当前地址（原图的改写起点）；externalId = 从 DOM 属性读到的条目 id
   */
  function collectItems(rule, root = document, baseUrl = location.href) {
    const c = rule.collect || {};
    const imgSel = c.img || 'img';
    const out = [];
    const seen = new Set();

    // 懒加载占位符（1x1 透明 gif 的 data: URI）绝不能当缩略图地址用 ——
    // eporner 整页都是这种占位符，拿它去改写/挖掘全是空转。
    const usable = (u) => !!u && /^https?:/i.test(u);
    const absolute = (u) => {
      if (!u || /^(data|blob):/i.test(String(u))) return '';
      try { return new URL(String(u), baseUrl).href; } catch (e) { return ''; }
    };

    function pickThumb(img) {
      const cands = [
        img.getAttribute('data-src'),
        img.getAttribute('data-original'),
        img.getAttribute('data-lazy-src'),
        img.currentSrc,
        img.src,
      ];
      for (const v of cands) {
        const u = absolute(v);
        if (usable(u)) return u;
      }
      return '';
    }

    // 从条目元素上按 "self@data-photo-id" 这类 spec 读 id，作为不依赖文件名的 id 来源
    function pickExternalId(el) {
      if (!c.idAttr) return '';
      const at = c.idAttr.lastIndexOf('@');
      const sel = at < 0 ? 'self' : c.idAttr.slice(0, at).trim();
      const attr = c.idAttr.slice(at + 1).trim();
      if (sel && sel !== 'self' && el.matches && !el.matches(sel)) return '';
      const v = el.getAttribute ? el.getAttribute(attr) : '';
      return v || '';
    }

    // img 上的说明文字 —— 原图地址没有有意义文件名时，这是最好的兜底素材名。
    // （eporner 详情里写的是照片标题，Pinterest 写的是 pin 的描述。）
    function pickAlt(img) {
      if (!img || !img.getAttribute) return '';
      return (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
    }

    function linkValue(a) {
      if (!a) return '';
      const raw = a.getAttribute('href') || a.href || '';
      // 保留当前页面的原始 href，兼容既有规则/测试；远程分页文档则必须按
      // 该分页自己的 URL 归一化，否则 detail 会把相对链接解析到当前页。
      return baseUrl === location.href ? (a.href || raw) : absolute(raw);
    }

    function pickLink(el, img) {
      if (c.link === 'self' && el && el.tagName === 'A') return linkValue(el);
      if (c.link && c.link !== 'self') {
        const a = el ? el.querySelector(c.link) : null;
        if (a) return linkValue(a);
      }
      // 兜底：条目内或 img 的祖先里找 a[href]
      let n = el || img;
      const body = root.body || null;
      while (n && n !== body) {
        if (n.tagName === 'A' && (n.href || n.getAttribute('href'))) return linkValue(n);
        n = n.parentElement;
      }
      return '';
    }

    if (c.item) {
      for (const el of root.querySelectorAll(c.item)) {
        const img = el.tagName === 'IMG' ? el : el.querySelector(imgSel) || (el.matches('img') ? el : null);
        if (!img) continue;
        const thumb = pickThumb(img);
        const externalId = pickExternalId(el);
        const link = pickLink(el, img);
        // 缩略图还没懒加载出来时，只要拿得到 id，后面 pagedata 仍能靠 id 工作
        const key = thumb || externalId || link;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ el, img, thumb, link, externalId, alt: pickAlt(img), pageUrl: baseUrl, baseUrl });
      }
      if (out.length) return out;
      // item 选择器没命中就别死心，退化到全页 img
    }

    for (const img of root.querySelectorAll(imgSel)) {
      const thumb = pickThumb(img);
      if (!thumb || seen.has(thumb)) continue;
      // 过滤明显不是内容的图（图标）
      const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0', 10) || 0;
      const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '0', 10) || 0;
      if ((w && w < 60) || (h && h < 60)) continue;
      seen.add(thumb);
      out.push({
        el: img,
        img,
        thumb,
        link: pickLink(img, img),
        externalId: '',
        alt: pickAlt(img),
        pageUrl: baseUrl,
        baseUrl,
      });
    }
    return out;
  }

  /* ============================================================
   * 4.5 无限滚动：边走边收
   *
   * 背景（用户实测，Pinterest）：瀑布流只加载首屏 ~19 张，向下滚动之后
   * 数字还是停在 20 左右。原因不是「懒加载还没触发」，而是这类列表是**虚拟化**
   * 的 —— 滚出视野的 tile 会被**卸载**。所以「滚到底 → 等一会 → 滚回来 →
   * 重收一次」这个做法拿到的和滚之前差不多，滚过去的全没了。
   *
   * 正解是**边走边收集**：每滚一小步，就把当前 DOM 里的条目按稳定 key 合并进
   * 一张表；tile 在视野里的时候就已经存下来了，之后被卸载也不影响。
   * ============================================================ */

  const SCROLL = {
    step: 0.85,          // 每轮滚动的视口比例
    maxRounds: 240,      // 轮数硬上限（防止无限列表滚不完）
    budgetMs: 180000,    // 时间硬上限（3 分钟）
    noGrowthStop: 3,     // 连续 N 轮没有新增就认为到底了
    settleIdleMs: 700,   // DOM 静默多久算「这一轮加载完了」
    settleMaxMs: 6000,   // 每轮最多等这么久
  };

  const usableUrl = (u) => !!u && /^https?:/i.test(String(u));

  /**
   * 条目的稳定身份。虚拟化列表里同一个 tile 会被卸载再挂载成**新节点**，
   * 所以绝不能用元素引用或 DOM 顺序当 key。
   * id / 详情页链接都是稳定的；链接要去掉 query（Pinterest 会挂跟踪参数）
   * 和 hash（eporner 用 `#gallery-photo=<id>` 定位）。
   */
  function itemKey(it) {
    const id = String(it.externalId || '').trim();
    if (id) return 'id:' + id;
    const link = String(it.link || '');
    if (link) {
      try { const u = new URL(link, location.href); return 'link:' + u.origin + u.pathname; } catch (e) {}
    }
    const thumb = String(it.thumb || '');
    if (thumb) {
      try { const u = new URL(thumb, location.href); return 'thumb:' + u.origin + u.pathname; } catch (e) {}
      return 'thumb:' + thumb;
    }
    return '';
  }

  /**
   * 把一批条目合并进累计表，返回新增条数。
   * 同一个 key 又出现时：刷新节点引用（旧节点可能已经被卸载），并把占位符
   * 缩略图升级成真地址 —— 后来滚到的那个 tile 往往已经加载好了。
   */
  function mergeItems(map, list) {
    let added = 0;
    for (const it of list) {
      const k = itemKey(it);
      if (!k) continue;
      const prev = map.get(k);
      if (!prev) { map.set(k, it); added++; continue; }
      prev.el = it.el;
      prev.img = it.img;
      if (!prev.link && it.link) prev.link = it.link;
      if (!prev.externalId && it.externalId) prev.externalId = it.externalId;
      if (!prev.pageUrl && it.pageUrl) prev.pageUrl = it.pageUrl;
      if (!prev.baseUrl && it.baseUrl) prev.baseUrl = it.baseUrl;
      if (!usableUrl(prev.thumb) && usableUrl(it.thumb)) prev.thumb = it.thumb;
    }
    return added;
  }

  /**
   * 等这一轮滚动触发的加载落定：DOM 高度与条目数连续稳定一段时间就返回。
   * 固定 sleep 在慢网/快网之间两头不讨好，这里用「静默」判据。
   */
  async function waitForSettle(rule) {
    const itemSel = ((rule.collect || {}).item) || 'img';
    const sig = () => {
      let n = 0;
      try { n = document.querySelectorAll(itemSel).length; } catch (e) {}
      return document.documentElement.scrollHeight + '|' + n;
    };
    const t0 = Date.now();
    let last = sig();
    let stableSince = Date.now();
    while (Date.now() - t0 < SCROLL.settleMaxMs) {
      await sleep(180);
      const cur = sig();
      if (cur !== last) { last = cur; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= SCROLL.settleIdleMs) return;
    }
  }

  function canonicalPageUrl(url, baseUrl = location.href) {
    try {
      const u = new URL(url, baseUrl);
      u.hash = '';
      return u.href;
    } catch (e) {
      return '';
    }
  }

  function paginationLinks(rule, root = document, baseUrl = location.href) {
    const p = (rule.collect || {}).pagination;
    if (!p) return [];
    const selector = p.links || p.selector || 'a[href]';
    const out = [];
    const seen = new Set();
    try {
      for (const node of root.querySelectorAll(selector)) {
        const raw = node.getAttribute('href') || node.href || '';
        const url = canonicalPageUrl(raw, baseUrl);
        if (!url || !/^https?:/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        out.push(url);
      }
    } catch (e) {
      /* invalid/missing pagination selector: leave the page as single-page */
    }
    return out;
  }

  async function fetchPaginationDocument(url, rule) {
    const r = await gmGet(url, {
      timeout: 30000,
      headers: rule.referer ? { Referer: rule.referer } : {},
    });
    if (r.status < 200 || r.status >= 400) throw new Error('HTTP ' + r.status);
    if (typeof DOMParser === 'undefined') throw new Error('浏览器不支持 DOMParser');
    return new DOMParser().parseFromString(r.responseText || '', 'text/html');
  }

  /**
   * 递归发现并抓取分页。只依赖页面上声明的分页链接，不猜 URL 模板；
   * 这样既能处理 3006.html → 3006_2.html，也能处理带省略号的分页器。
   * 每个远程页面在条目上保留自己的 baseUrl，relative src/link 才不会被当前页误解析。
   */
  async function collectPagination(rule, map, onPage) {
    const p = (rule.collect || {}).pagination;
    if (!p) return { pagesFetched: 0, paginationCapped: false, paginationAborted: false };
    const cap = parseInt(settings.maxItems, 10) || 0;
    const maxPages = Math.max(1, parseInt(p.maxPages, 10) || 100);
    const queue = paginationLinks(rule, document, location.href);
    const seen = new Set([canonicalPageUrl(location.href)]);
    let pagesFetched = 0;
    let paginationCapped = false;
    let paginationAborted = false;

    while (queue.length && pagesFetched < maxPages) {
      if (scanAbort) { paginationAborted = true; break; }
      if (cap > 0 && map.size >= cap) { paginationCapped = true; break; }
      const url = queue.shift();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      try {
        const doc = await fetchPaginationDocument(url, rule);
        const added = mergeItems(map, collectItems(rule, doc, url));
        pagesFetched++;
        if (onPage) onPage(pagesFetched, url, map.size, added);
        if (cap > 0 && map.size >= cap) { paginationCapped = true; break; }
        for (const next of paginationLinks(rule, doc, url)) {
          if (!seen.has(next)) queue.push(next);
        }
      } catch (e) {
        pagesFetched++;
        log(`分页 ${url} 抓取失败：${e && e.message ? e.message : e}`, 'warn');
      }
    }
    if (queue.length && pagesFetched >= maxPages) paginationCapped = true;
    return { pagesFetched, paginationCapped, paginationAborted };
  }

  /**
   * 收集条目。声明了 scrollToLoad 的站点会**边走边收**，把整个无限列表
   * 累计下来；没声明的站点保持原来的单次快照（一页到底的详情页之类）。
   * @returns {{items:Array, rounds:number, capped:boolean, timedOut:boolean, scrolled:boolean}}
   */
  async function collectAll(rule, onRound, onPage) {
    const map = new Map();
    mergeItems(map, collectItems(rule));
    const c = rule.collect || {};
    const pagination = await collectPagination(rule, map, onPage);
    // 自动滚动是**显式选择**。默认的 'follow' 模式下脚本绝不抢滚动条 ——
    // 这里只取当前挂在 DOM 里的那一批，剩下的交给 follow 采集器跟着用户滚。
    if (!c.scrollToLoad || settings.scanMode !== 'auto') {
      return {
        items: [...map.values()],
        rounds: 0,
        capped: false,
        timedOut: false,
        scrolled: false,
        ...pagination,
      };
    }

    const cap = parseInt(settings.maxItems, 10) || 0;
    const startY = window.scrollY;
    const t0 = Date.now();
    let rounds = 0;
    let noGrowth = 0;
    let capped = false;
    let timedOut = false;
    let aborted = false;

    while (rounds < SCROLL.maxRounds) {
      if (scanAbort) { aborted = true; break; }
      if (cap > 0 && map.size >= cap) { capped = true; break; }
      if (Date.now() - t0 >= SCROLL.budgetMs) { timedOut = true; break; }
      rounds++;
      const h = document.documentElement.scrollHeight;
      const step = Math.max(400, Math.floor(window.innerHeight * SCROLL.step));
      window.scrollTo(0, Math.min(window.scrollY + step, h));
      await waitForSettle(rule);
      const added = mergeItems(map, collectItems(rule));
      if (onRound) onRound(rounds, map.size, added);
      if (!added) noGrowth++; else noGrowth = 0;
      // 连着几轮没再长东西 → 到底了。这条对「本来就不是无限列表」的站点
      // （比如 eporner，条目一开始就全在 DOM 里）同样成立，所以不必再单独判断是否到底。
      if (noGrowth >= SCROLL.noGrowthStop) break;
    }

    // 把用户放回他原来的位置。收集结果已经在 map 里了，跟滚回去无关。
    try { window.scrollTo(0, startY); } catch (e) {}
    if (rounds) await sleep(150);
    return {
      items: [...map.values()],
      rounds,
      capped: capped || pagination.paginationCapped,
      timedOut,
      aborted,
      scrolled: rounds > 0,
      ...pagination,
    };
  }

  /* ============================================================
   * 4.6 跟随滚动：不抢滚动条，只在用户停下来时静默收一批
   *
   * 用户实测反馈：「我期望发生的是随着我的滚动而加载，而不是默认就无限滚动加载…
   * 插件已经滚动了 42 轮，拿到了 377 张原图，我觉得这个操作逻辑会有点失控」。
   * 完全同意 —— 自动滚动把控制权从人手里拿走了。这里改成被动模式：
   * 你在滚，脚本一声不响；你一停，它把当前挂着的那批收下来、解析原图、
   * 需要的话就地替换成原图。你不滚，它什么都不做。
   * ============================================================ */

  let followTimer = null;
  let followBusy = false;
  let followCount = 0;   // 本轮已静默补进来的条目数
  let followFilled = 0;  // 本轮已替换成原图的 tile 数

  async function followPass() {
    if (followBusy || scanRunning) return;
    if (!currentRule) return;
    followBusy = true;
    try {
      const added = mergeItems(accum.map, collectItems(currentRule));
      if (!added) return;
      followCount += added;
      // 只解析**还没有解析过**的新条目，已经解析过的直接复用缓存的 URL
      const fresh = [...accum.map.entries()].filter(([k, it]) => k && !resolvedByKey.has(k));
      if (fresh.length) {
        // 复用同一个 state：endpoint 索引只建一次，不用每停一次都重发请求
        const state = followState;
        if (!usableUrl(state.refDir)) {
          for (const it of accum.map.values()) {
            if (usableUrl(it.thumb)) { state.refDir = pathDir(it.thumb); break; }
          }
        }
        const epStep = (currentRule.resolve || []).find((s) => s.type === 'endpoint');
        if (epStep) {
          // buildEndpointIndex 内部会用 state.endpointIndex 自带去重，建成功就不再发
          try { await buildEndpointIndex(epStep, state); } catch (e) {}
        }
        const conc = currentRule.concurrency || settings.concurrency;
        const results = await pool(
          fresh.map(([, it]) => it),
          conc,
          (it) => resolveItem(it, currentRule, state)
        );
        fresh.forEach(([key, it], i) => {
          const r = results[i];
          const u = r && r.url ? r.url : '';
          const rec = {
            url: u,
            via: r && r.via ? r.via : '',
            key,
            thumb: it.thumb,
            // 素材名从**原图地址**派生，不能用缩略图 —— 缩略图是
            // `10574489-10574489_296x1000.jpg`，原图才是带 slug 的那个。
            name: buildItemName(it, u, i),
            website: it.link || location.href,
            status: u ? (sentUrls.has(u) ? '已发送' : '就绪') : (r && r.error ? r.error : '未解析'),
          };
          resolvedByKey.set(key, rec);
          resolvedCache.push(rec);
        });
      }
      const done = resolvedCache.filter((x) => x.url).length;
      if (ui && ui.st) {
        ui.st.textContent = `跟随滚动：已收集 ${accum.map.size} 条｜已解析 ${done} 张`;
      }
      if (settings.autoReplace) {
        const r = applyReplacements({ quiet: true });
        followFilled += r.n;
        if (r.n) {
          if (ui && ui.st) {
            ui.st.textContent =
              `跟随滚动：已收集 ${accum.map.size} 条｜已解析 ${done} 张｜已替换 ${followFilled} 张`;
          }
          renderList();
        }
      }
    } catch (e) {
      log(`跟随滚动解析出错：${e && e.message ? e.message : e}`, 'error');
    } finally {
      followBusy = false;
    }
  }

  function onFollowScroll() {
    if (settings.scanMode !== 'follow') return;
    if (followTimer) return;
    followTimer = setTimeout(() => {
      followTimer = null;
      followPass();
    }, Math.max(150, parseInt(settings.followDebounceMs, 10) || 700));
  }

  function startFollowCollector() {
    if (followBound) return;
    if (!currentRule || !currentRule.spa) return;
    if (!(currentRule.collect || {}).scrollToLoad) return;
    followBound = true;
    followCount = 0;
    followFilled = 0;
    window.addEventListener('scroll', onFollowScroll, { passive: true });
  }

  /* ============================================================
   * 5. resolve 管线
   * ============================================================ */

  // 5.0 图片地址嗅探 + 页面数据挖掘
  //
  // 背景：像 eporner 这种「点缩略图弹大图」的画廊，是个 hash 驱动的页内 viewer，
  // 原图地址既不能由缩略图改写得到，也不在缩略图的 DOM 属性里。但它一定存在于
  // 浏览器能拿到的某个地方 —— 要么在页面内联脚本里，要么在 viewer 自己发的
  // XHR/fetch 响应里。所以这里两手都抓：扒页面源码 + 挂钩网络请求。

  const IMG_URL_RE = /https?:\/\/[^"'\s\\)<>,\]]+?\.(?:jpe?g|png|webp|gif|avif)/gi;

  function extractImageUrls(text) {
    if (!text || typeof text !== 'string') return [];
    // JSON 里的 \/ 转义要还原，否则正则截断
    const s = text.replace(/\\\//g, '/');
    const out = [];
    let m;
    IMG_URL_RE.lastIndex = 0;
    while ((m = IMG_URL_RE.exec(s))) out.push(m[0]);
    return out;
  }

  const sniff = {
    cache: new Set(),
    installed: false,
    absorb(text) {
      if (!text || typeof text !== 'string' || text.length > 4e6) return;
      if (!/\.(jpe?g|png|webp|gif|avif)/i.test(text)) return;
      for (const u of extractImageUrls(text)) this.cache.add(u);
    },
    install() {
      if (this.installed) return;
      this.installed = true;
      try {
        // --- XMLHttpRequest ---
        const oOpen = XMLHttpRequest.prototype.open;
        const oSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function () {
          try {
            this.__ebcUrl = arguments[1];
          } catch (e) {
            /* ignore */
          }
          return oOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          try {
            this.addEventListener('load', () => {
              try {
                if (!this.responseType || this.responseType === 'text') {
                  sniff.absorb(this.responseText);
                } else if (this.responseType === 'json' && this.response) {
                  sniff.absorb(JSON.stringify(this.response));
                }
              } catch (e) {
                /* CORS/opaque，忽略 */
              }
            });
          } catch (e) {
            /* ignore */
          }
          return oSend.apply(this, arguments);
        };
        // --- fetch ---
        const oFetch = window.fetch;
        if (typeof oFetch === 'function') {
          window.fetch = function () {
            const p = oFetch.apply(this, arguments);
            try {
              p.then((res) => {
                try {
                  res
                    .clone()
                    .text()
                    .then((t) => sniff.absorb(t))
                    .catch(() => {});
                } catch (e) {
                  /* ignore */
                }
              }).catch(() => {});
            } catch (e) {
              /* ignore */
            }
            return p;
          };
        }
      } catch (e) {
        console.warn('[EBC] sniffer install failed', e);
      }
    },
  };

  function pathDir(u) {
    try {
      const p = new URL(u, location.href).pathname;
      const i = p.lastIndexOf('/');
      return i >= 0 ? p.slice(0, i + 1) : '/';
    } catch (e) {
      return '';
    }
  }

  function baseName(u) {
    try {
      return new URL(u, location.href).pathname.split('/').pop() || '';
    } catch (e) {
      return String(u).split('/').pop() || '';
    }
  }

  // 汇总所有「可能藏着原图」的地址池：页面源码 + 嗅探到的响应 + 页面上已显示的大图
  function buildPagePool(state) {
    if (state.pagePool) return state.pagePool;
    const pool = new Set();
    try {
      for (const u of extractImageUrls(document.documentElement.outerHTML)) pool.add(u);
    } catch (e) {
      /* ignore */
    }
    for (const u of sniff.cache) pool.add(u);
    for (const img of document.querySelectorAll('img')) {
      const w = img.naturalWidth || img.width || 0;
      const src = img.currentSrc || img.src || '';
      if (src && /^https?:/i.test(src) && w >= 700) pool.add(src);
    }
    state.pagePool = pool;
    return pool;
  }

  /**
   * pagedata：从「同目录 + 同 id」的地址池里挑出原图。
   * 判据来自实测：原图文件名是 <id>-<slug>.<ext>，而缩略图是 <id>-<id>_<W>x<H>.<ext>。
   * 所以「带 _WxH 后缀的一律当成缩略图剔掉」是个很干净的通用判别式。
   */
  function resolveByPageData(item, step, state) {
    const exts = step.exts || 'jpe?g|png|webp';
    const thumbUsable = !!item.thumb && /^https?:/i.test(item.thumb);

    // id：优先用 DOM 属性给的（如 a[data-photo-id]），更可靠；否则从缩略图文件名里抠
    let id = item.externalId || '';
    let dir = '';
    if (thumbUsable) {
      if (!id) {
        const m = baseName(item.thumb).match(new RegExp(step.idFrom || '([0-9]{6,})'));
        id = m ? m[1] : '';
      }
      dir = pathDir(item.thumb);
    }
    // 缩略图还没懒加载出来时，借用本页其它缩略图学到的目录
    if (!dir) dir = state.refDir || '';
    if (!id || !dir) return '';

    const thumbPattern = new RegExp(step.thumbPattern || '_\\d+x\\d+\\.(?:' + exts + ')$', 'i');
    const isFull = new RegExp('^' + esc(dir) + '[^/]*' + esc(id) + '[^/]*\\.(?:' + exts + ')$', 'i');
    let thumbPath = '';
    if (thumbUsable) {
      try {
        thumbPath = new URL(item.thumb, location.href).pathname;
      } catch (e) {
        thumbPath = '';
      }
    }

    const pool = buildPagePool(state);
    let best = '';
    for (const u of pool) {
      if (!u.includes(id)) continue;
      let p = '';
      try {
        p = new URL(u, location.href).pathname;
      } catch (e) {
        continue;
      }
      if (!p || p === thumbPath) continue;
      if (!isFull.test(p)) continue;
      if (thumbPattern.test(p)) continue; // 同 id 但带 _WxH → 还是缩略图
      if (p.length > best.length) best = u;
    }
    return best;
  }

  /**
   * endpoint：按规则声明的站点接口发**一次**请求，把响应里的图片直链挖出来建成
   * id → 原图 的索引。整组数据一次到手，比逐张抓详情页快一个数量级，
   * 也完全不依赖 URL 可否改写。
   *
   * 实测（eporner）：GET /xhr/gallery-slide/<galleryId> 一次返回 139KB，
   * 含整个画廊 85 张照片的 <id>-<slug>.jpg 原图直链。
   */

  // 变量来源：'url:<regex>' 从当前页 URL 抠；'<selector>@<attr>' 从 DOM 读
  function resolveVarSource(src) {
    try {
      const s = String(src);
      if (s.startsWith('url:')) {
        const m = location.href.match(new RegExp(s.slice(4)));
        return m ? m[1] || m[0] : '';
      }
      const at = s.lastIndexOf('@');
      if (at < 0) return '';
      const sel = s.slice(0, at).trim();
      const attr = s.slice(at + 1).trim();
      if (!sel || !attr) return '';
      const node = document.querySelector(sel);
      if (!node) return '';
      const v = node.getAttribute(attr) || (attr in node ? node[attr] : '');
      return v ? String(v) : '';
    } catch (e) {
      return '';
    }
  }

  async function buildEndpointIndex(step, state) {
    if (state.endpointIndex) return state.endpointIndex;
    // 并发池里会有多个 worker 同时进来，用 promise 去重，保证只发一次请求
    if (state.endpointPromise) return state.endpointPromise;

    state.endpointPromise = (async () => {
      try {
        const vars = {};
        for (const [name, sources] of Object.entries(step.vars || {})) {
          for (const src of sources || []) {
            const v = resolveVarSource(src);
            if (v) {
              vars[name] = v;
              break;
            }
          }
        }
        let url = String(step.url);
        for (const [k, v] of Object.entries(vars)) {
          url = url.split('{' + k + '}').join(encodeURIComponent(v));
        }
        if (/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(url)) {
          log(`endpoint 缺少变量，请求 URL 拼不出来：${url}`, 'warn');
          state.endpointFailed = true;
          return null;
        }
        const abs = new URL(url, location.href).href;
        const r = await gmGet(abs, {
          timeout: 30000,
          headers: Object.assign({ Referer: location.href }, step.headers || {}),
        });
        if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);

        const idRe = new RegExp(step.idFrom || '([0-9]{6,})');
        const thumbPattern = new RegExp(step.thumbPattern || '_\\d+x\\d+\\.', 'i');
        const map = new Map();
        for (const u of extractImageUrls(r.responseText)) {
          if (thumbPattern.test(u)) continue; // 带 _WxH = 缩略图，跳过
          const m = baseName(u).match(idRe);
          if (!m) continue;
          const id = m[1];
          if (!map.has(id) || u.length > map.get(id).length) map.set(id, u);
        }
        if (!map.size) {
          log('endpoint 响应里没挖到原图直链（可能接口变了）。', 'warn');
          state.endpointFailed = true;
          return null;
        }
        log(
          `endpoint 一次拿到 ${map.size} 张原图（${abs.replace(/^https?:\/\/[^/]+/, '')}，` +
            `响应 ${Math.round(r.responseText.length / 1024)} KB）。`,
          'ok'
        );
        state.endpointIndex = map;
        return map;
      } catch (e) {
        log('endpoint 请求失败：' + (e.message || e), 'error');
        state.endpointFailed = true;
        return null;
      }
    })();
    return state.endpointPromise;
  }

  // 5.1 selector@attr —— 支持 srcset:last / srcset:first
  function pickFromSrcset(v, which) {
    const parts = String(v)
      .split(',')
      .map((s) => s.trim().split(/\s+/)[0])
      .filter(Boolean);
    if (!parts.length) return '';
    return which === 'first' ? parts[0] : parts[parts.length - 1];
  }

  // 从单个节点上按 spec 读值（spec = "selector@attr"）
  function readAttrOfNode(n, spec, baseUrl = location.href) {
    const at = spec.lastIndexOf('@');
    if (at < 0) return '';
    const attr = spec.slice(at + 1).trim();
    try {
      if (attr === 'srcset:last' || attr === 'srcset:first') {
        const v = n.getAttribute('srcset') || n.getAttribute('data-srcset') || '';
        const u = pickFromSrcset(v, attr === 'srcset:first' ? 'first' : 'last');
        return u ? new URL(u, baseUrl).href : '';
      }
      if (attr === 'text') {
        return n.textContent && n.textContent.trim() ? n.textContent.trim() : '';
      }
      const v = n.getAttribute(attr) || (attr in n ? n[attr] : '');
      if (!v) return '';
      const s = String(v).trim();
      // 懒加载占位符（data:image/gif;base64,R0lGODlh…）和 blob: 一律不算地址，
      // 否则它们会被当成"原图"推给 Eagle，收进来一堆 1x1 透明图。
      if (/^(data|blob):/i.test(s)) return '';
      return new URL(s, baseUrl).href;
    } catch (e) {
      return '';
    }
  }

  function readSelectorAttr(root, spec, baseUrl = location.href) {
    const at = spec.lastIndexOf('@');
    if (at < 0) return '';
    const sel = spec.slice(0, at).trim();
    let nodes;
    try {
      nodes = root.querySelectorAll(sel);
    } catch (e) {
      return '';
    }
    for (const n of nodes) {
      const v = readAttrOfNode(n, spec, baseUrl);
      if (v) return v;
    }
    return '';
  }

  function applyRewrite(url, rules) {
    for (const r of rules || []) {
      try {
        const re = new RegExp(r.re, r.flags || '');
        if (re.test(url)) return url.replace(re, r.to);
      } catch (e) {
        console.warn('[EBC] bad rewrite regex', r, e);
      }
    }
    return '';
  }

  // 5.2 用 Image() 实测候选（走页面网络栈，自带 cookie/referer）
  function probeImage(url, timeoutMs) {
    timeoutMs = timeoutMs || 12000;
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      img.onload = () => finish({ url, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => finish(null);
      img.decoding = 'async';
      img.src = url;
    });
  }

  // 5.3 并发池
  async function pool(items, size, worker, onProgress) {
    const results = new Array(items.length);
    let idx = 0;
    let done = 0;
    const runners = new Array(Math.max(1, Math.min(size, items.length))).fill(0).map(async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        try {
          results[i] = await worker(items[i], i);
        } catch (e) {
          results[i] = { error: e.message || String(e) };
        }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    });
    await Promise.all(runners);
    return results;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 5.4 detail：抓详情页取原图
  async function fetchDetailImage(link, rule, thumb) {
    const r = await gmGet(link, {
      timeout: 25000,
      headers: rule.referer ? { Referer: rule.referer } : {},
    });
    if (r.status < 200 || r.status >= 400) throw new Error('HTTP ' + r.status);
    const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
    const specs = (rule.resolve.find((s) => s.type === 'detail') || {}).selectors || [
      "meta[property='og:image']@content",
      'img@src',
    ];
    const excludeThumb = (rule.resolve.find((s) => s.type === 'detail') || {}).excludeThumb !== false;
    const norm = (u) => {
      try {
        const x = new URL(u, link);
        x.hash = '';
        return x.href;
      } catch (e) {
        return '';
      }
    };
    const thumbNorm = norm(thumb || '');
    for (const spec of specs) {
      const got = readSelectorAttr(doc, spec);
      if (!got) continue;
      if (!/\.(jpe?g|png|webp|gif|avif|bmp)(\?|$)/i.test(got) && spec.includes('@content')) {
        // og:image 一般是图片直链；不是也先收着
      }
      if (excludeThumb && thumbNorm && norm(got) === thumbNorm) continue;
      return { url: got, via: 'detail:' + spec };
    }
    throw new Error('详情页未找到原图');
  }

  /**
   * 核心：把一条目解析成原图 URL
   * 返回 { url, via, thumb }
   */
  async function resolveItem(item, rule, state) {
    const thumb = item.thumb;
    const baseUrl = item.baseUrl || item.pageUrl || location.href;

    for (const step of rule.resolve || []) {
      // ---- attr：列表页 DOM 里现成的 ----
      if (step.type === 'attr') {
        for (const spec of step.selectors || []) {
          let got = '';
          try {
            const at = spec.lastIndexOf('@');
            const sel = at < 0 ? spec : spec.slice(0, at);
            // 1) 条目自身的 img（或条目元素）若匹配该选择器，直接读它
            const self = item.img || item.el;
            if (self && self.matches && sel && self.matches(sel)) got = readAttrOfNode(self, spec, baseUrl);
            // 2) 否则在条目范围内查
            if (!got && item.el) got = readSelectorAttr(item.el, spec, baseUrl);
            // 3) 整页兜底 —— ★ 默认禁用，必须由规则显式写 allowDocument: true
            //
            //    ★ 这是踩过的真实事故（用户实测）：eporner 画廊页的条目 img 没有可用的
            //    data-src，于是落进这一步，readSelectorAttr(document, 'img@data-src')
            //    返回的是**文档里第一个**带 data-src 的 img —— 站点自己的分类图标
            //    https://static-ca-cdn.eporner.com/catimg/3_small.jpg（102x75）。
            //    106 个条目全部解析成这一个 URL，Eagle 收到的 106 份字节完全相同，
            //    内容去重后只剩一张 102x75 的小图；而日志还报「解析完成：106/106 张拿到原图」。
            //
            //    问题本质：整页兜底把 item 级的解析偷偷降级成了 page 级，且失败是静默的。
            //    它对「一个页面就一张图」的详情页合理，对列表页是灾难。所以：
            //      · 默认关闭，规则要显式声明 allowDocument: true 才启用；
            //      · 即便启用，也要求结果与原缩略图**同目录**，否则一律丢弃。
            if (!got && step.allowDocument === true && thumb) {
              const g = readSelectorAttr(document, spec, baseUrl);
              if (g && pathDir(g) === pathDir(thumb)) got = g;
            }
          } catch (e) {
            got = '';
          }
          if (got && (got !== thumb || step.allowSameThumb === true) && /^https?:/i.test(got)) {
            return { url: got, via: 'attr:' + spec, thumb };
          }
        }
        continue;
      }

      // ---- rewrite：纯本地改写，零请求 ----
      if (step.type === 'rewrite') {
        if (!thumb) continue;
        const got = applyRewrite(thumb, step.rules);
        if (got && got !== thumb) return { url: got, via: 'rewrite', thumb };
        continue;
      }

      // ---- host：查图床表改写，纯本地、零请求 ----
      //
      // 与 rewrite 的区别：rewrite 把规律写死在**站点规则**里（只对这个站生效），
      // host 把规律放在**图床表**里（所有站点共享）。论坛那种「用户从各种免费
      // 图床贴图」的场景只能走这条 —— 见 2.5 节。
      if (step.type === 'host') {
        if (!thumb) continue;
        const h = findHost(thumb);
        if (!h) continue;
        if (!h.thumbRe || !h.fullTo) continue;
        const got = applyRewrite(thumb, [{ re: h.thumbRe, to: h.fullTo }]);
        if (got && got !== thumb) return { url: got, via: 'host:' + h.id, thumb, hostId: h.id };
        continue;
      }

      // ---- probe：候选实测（只在第一张上定胜负，整页复用） ----
      if (step.type === 'probe') {
        if (!thumb) continue;
        const cands = step.candidates || [];
        if (!cands.length) continue;
        const key = rule.id + '|probe';
        let winner = state.probeWinner;
        if (winner === undefined) {
          // 缩略图自己的像素尺寸，用来判「这个候选到底有没有变大」
          const tw = (item.img && (item.img.naturalWidth || item.img.width)) || 0;
          const th = (item.img && (item.img.naturalHeight || item.img.height)) || 0;
          // 逐个实测，第一个成功者胜出
          for (let i = 0; i < cands.length; i++) {
            const u = applyRewrite(thumb, [cands[i]]);
            if (!u || u === thumb) continue;
            const ok = await probeImage(u);
            if (!ok) continue;
            // ★ 占位图守卫 —— 不设这道关，probe 在主流图床上就是必然误判。
            //
            //   实测（两家的「拿不到原图」都不是 404，而是 HTTP 200 + 一张能正常
            //   解码的 JPEG 占位图，所以 onload 一定成功）：
            //     · imagetwist：主机号写错 / 带外来 Referer → 177x142，8183~8346 字节
            //     · pixhost   ：主机号写错                    → 257x126，16138 字节
            //   判据两条，都很朴素：原图必须**比缩略图大**，且不至于小到 200px 以下。
            const tooSmall = ok.width < 200 || ok.height < 200;
            const notBigger = tw > 0 && th > 0 && ok.width * ok.height <= tw * th;
            if (tooSmall || notBigger) {
              log(
                `probe 候选 #${i + 1} 被「占位图守卫」拒绝：${shortUrl(u)} 只有 ${ok.width}x${ok.height}` +
                  (tw ? `（缩略图 ${tw}x${th}）` : '') +
                  ' —— 这类图床拿不到原图时会回一张同样能解码的占位图，光看「加载成功」会全收成小图。',
                'warn'
              );
              continue;
            }
            winner = i;
            state.probeWinner = i;
            log(`probe 命中候选 #${i + 1}：${shortUrl(u)}（${ok.width}x${ok.height}）`, 'ok');
            return { url: u, via: `probe#${i + 1}`, thumb };
          }
          state.probeWinner = -1;
          continue;
        }
        if (winner >= 0) {
          const u = applyRewrite(thumb, [cands[winner]]);
          if (u && u !== thumb) return { url: u, via: `probe#${winner + 1}`, thumb };
        }
        continue;
      }

      // ---- endpoint：一次请求拿到整组原图 ----
      if (step.type === 'endpoint') {
        if (state.endpointFailed) continue;
        let eid = item.externalId || '';
        if (!eid && item.thumb) {
          const m = baseName(item.thumb).match(new RegExp(step.idFrom || '([0-9]{6,})'));
          eid = m ? m[1] : '';
        }
        if (!eid) continue;
        const map = await buildEndpointIndex(step, state);
        if (map && map.has(eid)) return { url: map.get(eid), via: 'endpoint', thumb: item.thumb };
        continue;
      }

      // ---- pagedata：从页面自身的数据里找原图 ----
      if (step.type === 'pagedata') {
        const got = resolveByPageData(item, step, state);
        if (got) return { url: got, via: 'pagedata', thumb };
        continue;
      }

      // ---- detail：抓详情页 ----
      if (step.type === 'detail') {
        if (!item.link) continue;
        // 可选的「只抓外链」守卫，专治论坛帖子里 <a href> 满地都是这件事：
        // 头像、引用、楼层链接全是**站内**链接，只有用户贴进来的图床分享页是外链。
        // 实测 kitty-kats：帖子图的外层 a 指向 imagetwist.com / pixhost.cc，
        // 而头像指向 /members/…。跳过同站链接就把噪音一次滤干净了。
        if (step.externalOnly) {
          try {
            if (new URL(item.link, location.href).hostname === location.hostname) continue;
          } catch (e) {
            /* 解析不了就当成外链 */
          }
        }
        if (state.detailDisabled && state.detailDisabledFor === rule.id) {
          continue;
        }
        // 守卫：若"详情页"与当前页是同一个 URL（只有 #hash 不同），说明这是页内
        // viewer，抓回来只会拿到画廊封面 —— 那会让同一张封面被重复收藏 N 次。
        const stripHash = (u) => String(u || '').split('#')[0].replace(/\/$/, '');
        if (stripHash(item.link) === stripHash(location.href)) {
          if (!state.samePageWarned) {
            state.samePageWarned = true;
            log('detail 已跳过：条目的"详情页"和当前页是同一个 URL（#hash 型 viewer），抓取只会拿到封面。', 'warn');
          }
          continue;
        }
        try {
          const got = await fetchDetailImage(item.link, rule, thumb);
          if (rule.delayMs) await sleep(rule.delayMs);
          return { url: got.url, via: got.via, thumb };
        } catch (e) {
          if (rule.delayMs) await sleep(rule.delayMs);
          state.detailErrors = (state.detailErrors || 0) + 1;
          if (state.detailErrors >= 8 && !state.detailDisabled) {
            state.detailDisabled = true;
            state.detailDisabledFor = rule.id;
            log('detail 连续失败 ≥8 次，已停用 detail 策略（可能被限流或没有详情页链接）。', 'error');
          }
          continue;
        }
      }
    }

    // 兜底：如果页面上这张图本身就已经是大图（宽高都 ≥700），那它本身就能用，
    // 没必要再升级。有些站点的 data-src 放的直接就是原图。
    if (thumb && item.img) {
      const w = item.img.naturalWidth || item.img.width || 0;
      const h = item.img.naturalHeight || item.img.height || 0;
      if (w >= 700 && h >= 700) return { url: thumb, via: 'already-large', thumb };
    }

    return { url: '', via: '', thumb, error: '所有策略均未解析出原图' };
  }

  /* ============================================================
   * 6. Eagle 本地 API 客户端
   * ============================================================ */

  const rawHead = (s, n = 300) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t ? (t.length > n ? t.slice(0, n) + '…' : t) : '(空响应)';
  };

  /**
   * 按原图 URL 去重，保留第一次出现的条目。
   *
   * 为什么必须做这一步：页面上的条目数**可能多于**画廊的实际照片数。
   * 实测 eporner 画廊页：106 个候选条目，而端点只返回 85 张照片 ——
   * 不去重就会往 Eagle 里塞 21 组完全重复的素材，而日志和计数看起来一切正常。
   * 只比 URL 全等，语义不同的条目绝不会被误合并。
   *
   * @param {Array<{url:string}>} list 调用方需保证每项 url 非空
   */
  function dedupeByUrl(list) {
    const seen = new Set();
    const unique = [];
    const dupes = [];
    for (const x of list) {
      if (seen.has(x.url)) {
        dupes.push(x);
        continue;
      }
      seen.add(x.url);
      unique.push(x);
    }
    return { unique, dupes };
  }

  /**
   * 加素材端点候选矩阵。
   *
   * 这些结论全部来自 Eagle 自身的 app.asar（grep 实证，非猜测）：
   *   · v2 路由表（asar 183182–183245）里加素材**只有** POST /api/v2/item/add ——
   *     v2 下根本没有 addFromURL(s)。这正是「未找到可用的 addFromURL(s) 端点」的根因：
   *     旧代码一旦 /api/v2/library/info 探通就锁定 base=/api/v2 并 break，
   *     于是 /api/item/addFromURLs 从头到尾**一次都没被请求过**。
   *   · 旧版路由（asar 18911–18948）才有 /api/item/addFromURL 与 /api/item/addFromURLs。
   *   · v2 写接口请求体裁法是 { items: [...] } —— 见 .eagle-mcp/test-http-write.mjs:14
   *     实测：打 /api/v2/item/update，body { items: [ { id, tags, annotation } ] }，
   *     返回 status:"success"（41595、无需 token）。
   *   · 官方自测脚本（asar 1592955–1593250）确认 item/add 同时支持单一模式与批量模式
   *     （标记 [4a,4b] / [4c]），且「无来源」的请求会被拒绝 —— 说明单条模式必须带 url。
   */
  // 探测结果的缓存版本号。★ 只要 ADD_CANDIDATES 或探测语义变了就必须 +1，
  // 否则用户浏览器里存着的老 caps 会被当成有效结果直接复用，新逻辑根本不执行
  // （踩过：改成 DEAD=[404,405,501] 之后探测一次都没跑，因为老缓存里 candIndex 是数字）。
  const CACHE_V = 2;

  /**
   * 把 Eagle 地址与 API 路径拼成合法 URL。
   *
   * ★ 这里曾经是「发送到 Eagle」全灭的真凶。旧写法是
   *     settings.eagleOrigin.replace(/\/+$/, '') + path
   *   字符串相加。而 Eagle 给出的地址带 token，形如
   *     http://localhost:41595/?token=xxxxxxxx-…
   *   相加之后路径被吞进 query：
   *     http://localhost:41595/?token=xxxxxxxx-…/api/v2/item/add
   *   实际请求的是 `POST /`（pathname 只有一个斜杠），Eagle 回
   *   405 method not allowed —— 看起来像「端点名写错了」，其实是 URL 拼坏了。
   *   而 `GET /` 恰好返回 200，所以探测一直以为「基础路径可用」。
   *
   * 正确做法：用 URL 解析，path 只写进 pathname，query（token）原样保留。
   */
  const buildApiUrl = (origin, path) => {
    const raw = String(origin || '').trim() || DEFAULT_SETTINGS.eagleOrigin;
    let u;
    try {
      u = new URL(raw);
    } catch (e) {
      return raw.replace(/\/+$/, '') + path; // 地址不合法时退回旧行为，别把整个流程打死
    }
    const base = u.pathname.replace(/\/+$/, '');
    // 用户可能把地址填成 .../api/v2 而 path 也是 /api/v2/...，这时去掉重复的前缀段
    const tail = base && path.startsWith(base) ? path.slice(base.length) : path;
    u.pathname = base + tail;
    return u.toString();
  };

  // 从响应头里取 Allow —— 405 会带上它，直接告诉我们这个路由允许什么方法。
  const allowHeader = (r) => {
    const m = /^allow:\s*(.+)$/im.exec(String((r && r.hdr) || ''));
    return m ? m[1].trim() : '';
  };

  // 把状态码翻成一句人话：405 是「方法不对」，不是「服务不可用」，两者排错方向完全不同。
  const httpNote = (r) => {
    const allow = allowHeader(r);
    if (r.status === 405) return `HTTP 405（方法不对${allow ? '，Allow: ' + allow : ''}）`;
    if (r.status === 404) return 'HTTP 404（路由不存在）';
    return 'HTTP ' + r.status;
  };

  // 通用响应头取值。allowHeader 只关心 Allow，这个用于 Content-Type / Content-Length。
  const headerValue = (r, name) => {
    const re = new RegExp('^' + name + ':\\s*(.+)$', 'im');
    const m = re.exec(String((r && r.responseHeaders) || ''));
    return m ? m[1].trim() : '';
  };

  /**
   * 量一张图真实的像素尺寸。
   *
   * ★ 这是「地址解析错了」和「地址对了但下到的是占位图」这两件事之间**唯一的分界线**。
   *   用户实测里 Eagle 里 106 张全是同一张 102×75 的小图 —— 这个尺寸既不像缩略图
   *   （eporner 缩略图是 296×1000），也完全不符合任何一张原图，最像站点在
   *   防盗链命中时回的那张统一占位图。而这两种原因的修法完全不同，
   *   在上层日志里却长得一模一样，所以必须真的把字节抓下来量一量。
   */
  async function imageSize(blob) {
    try {
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(blob);
        const d = { w: bmp.width, h: bmp.height };
        if (bmp.close) bmp.close();
        return d;
      }
    } catch (e) {
      /* 退到 <img> 方案 */
    }
    return new Promise((resolve) => {
      const u = URL.createObjectURL(blob);
      const im = new Image();
      const done = (w, h) => {
        URL.revokeObjectURL(u);
        resolve({ w, h });
      };
      im.onload = () => done(im.naturalWidth, im.naturalHeight);
      im.onerror = () => done(0, 0);
      im.src = u;
    });
  }

  /**
   * 加素材端点候选矩阵。
   *
   * ★ 教训（用户实测踩到的）：405 = 「路由在、方法不对」。旧探测的判据是
   *   `status !== 404`，于是 405 被当成了「这条路由活着」，整轮推送全打在一个
   *   方法不对的路由上，106 张 0 成功。判据现在排除 404/405/501。
   *
   * ★ 教训二：base 过滤也是错的。v2 路由和旧版 /api 路由**注册在同一个 server 上**
   *   （app/js/api-server.js 末尾 require('./api-server-v2') 并 initAPIServerV2(APIServer)），
   *   所以 /api/v2/library/info 打得通**并不代表** /api/item/addFromURLs 不可用。
   *   旧探测按 base 过滤候选，导致旧版兜底一次都没被试过。现在全矩阵都试。
   *
   * 路由与字段名的依据（均来自 Eagle 自身 app.asar 与工作区实证，非猜测）：
   *   · v2 路由表 asar 183182–183245：['POST', '/api/v2/item/add', 'item.add']，
   *     且 item/add 在 183254 有专门的分支支持批量（183256 `Array.isArray(args.items)`）。
   *   · 旧版路由 asar 18911–18948：POST /api/item/addFromURL、/api/item/addFromURLs。
   *   · v2 写接口把条目包在 items: [...] 里 —— .eagle-mcp/test-http-write.mjs:14 实测
   *     打 /api/v2/item/update 返回 status:"success"（41595、无需 token）。
   *   · 条目字段名 name / website / tags / folders / annotation 来自插件 SDK
   *     eagle.item.addFromPath —— .eagle-mcp/eagle-comfyui-bridge/js/eagle-ops.js:94。
   */
  const ADD_CANDIDATES = [
    { method: 'POST', base: '/api/v2', path: '/item/add', shape: 'items', label: 'POST /api/v2/item/add（批量·items 包层）' },
    { method: 'POST', base: '/api/v2', path: '/item/add', shape: 'item', label: 'POST /api/v2/item/add（单条·扁平体）' },
    { method: 'POST', base: '/api', path: '/item/addFromURLs', shape: 'urls', label: 'POST /api/item/addFromURLs（旧版批量）' },
    { method: 'POST', base: '/api', path: '/item/addFromURL', shape: 'url', label: 'POST /api/item/addFromURL（旧版单条）' },
  ];

  const eagle = {
    // 缓存探测结果：{ base, wrap, candIndex, addUrls, addUrl, note, raw }
    caps: store.get('eagleCaps', null),

    async req(path, { method = 'GET', body = null, timeout = 30000 } = {}) {
      const url = buildApiUrl(settings.eagleOrigin, path); // ★ 必须走 URL 解析，见 buildApiUrl 的注释
      const r = await gmGet(url, {
        method,
        timeout,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : null,
      });
      let json = null;
      try {
        json = JSON.parse(r.responseText);
      } catch (e) {
        /* 非 JSON 响应 */
      }
      // 把真实请求的 url 一并带出去 —— 日志里有它，URL 拼坏这种事一眼就能看出来
      return { status: r.status, text: r.responseText, json, hdr: r.responseHeaders || '', url };
    },

    // 探测：基础路径（/api/v2 还是 /api）+ 加素材端点（item/add 还是 addFromURL(s)）
    //
    // ★ 关键设计：探测**不往素材库里写任何东西**。
    //   旧实现会真发一条 https://example.com/ 的假素材去试端点，既脏又慢。
    //   新实现只判断「路由存不存在」：先用一个必然不存在的路径取对照状态码，
    //   再用**空请求体**打每个候选。路由不存在 → 404；路由存在但参数不对 →
    //   Eagle 回 4xx 或 200+status:"error"，两者都说明端点活着。
    //
    //   ★ 405 必须算「死路」：405 = 路由在、方法不对。曾经的判据只排除 404，
    //     于是把 405 当成了通过，整轮推送都打在一个方法不对的路由上，全灭。
    //     判据现在是 DEAD = [404, 405, 501]，并把 Allow 响应头一起打出来。
    async probe(force) {
      // ★ 缓存必须带版本号校验：老版本存下的 caps 里 candIndex 也是数字，
      //   只查 typeof 会把新逻辑整个跳过（实测踩到过）。
      if (
        this.caps &&
        !force &&
        this.caps.v === CACHE_V &&
        typeof this.caps.candIndex === 'number' &&
        typeof this.caps.shape === 'string'
      ) {
        return this.caps;
      }
      const found = {
        v: CACHE_V,
        base: '',
        addUrls: '',
        addUrl: '',
        shape: '',
        candIndex: -1,
        note: '',
        raw: [],
      };

      // --- 1. 基础路径 ---------------------------------------------------
      for (const base of ['/api/v2', '/api']) {
        try {
          const r = await this.req(base + '/library/info', { timeout: 8000 });
          found.raw.push(`GET ${base}/library/info → ${r.status} ${rawHead(r.text, 160)}`);
          if (r.status === 200) {
            found.base = base;
            break;
          }
        } catch (e) {
          found.raw.push(`GET ${base}/library/info → 异常 ${e.message}`);
        }
      }
      if (!found.base) {
        found.note = '连不上 Eagle 本地 API（127.0.0.1:41595）。请确认 Eagle 已启动、且偏好设置 → 开发者 里已打开本地 API。';
        found.raw.forEach((l) => log(l, 'error'));
        log(found.note, 'error');
        this.caps = null;
        return found;
      }

      // --- 2. 对照：一个必然不存在的路径，用来看清 Eagle 对未知路由的返回长相 ---
      try {
        const ctrl = found.base + '/__ebc_no_such_route__';
        const r = await this.req(ctrl, { method: 'POST', body: {}, timeout: 8000 });
        found.raw.push(`对照（必然不存在）POST ${ctrl} → ${r.status} ${rawHead(r.text, 160)}`);
      } catch (e) {
        found.raw.push(`对照路径异常：${e.message}`);
      }

      // --- 3. 候选逐个探活（空请求体，零写入） ----------------------------
      //
      // ★ 判据必须排除 405：405 = 「路由在、方法不对」，那是一条**错误**的路，
      //   不是活着的路。之前只排除 404，就把 405 当成了通过，于是整轮推送全打在
      //   一个方法不对的路由上（用户实测：HTTP 405 method not allowed）。
      //
      // ★ 不做 base 过滤：v2 与旧版路由在同一个 server 上，/api/v2/library/info
      //   打得通不代表 /api/item/addFromURLs 不能用。全矩阵都试。
      const DEAD = [404, 405, 501]; // 不存在 / 方法不对 / 未实现：都算这条路不通
      for (let i = 0; i < ADD_CANDIDATES.length; i++) {
        const c = ADD_CANDIDATES[i];
        try {
          const r = await this.req(c.base + c.path, { method: c.method, body: {}, timeout: 10000 });
          const allow = allowHeader(r);
          found.raw.push(
            `探测 ${c.label} → ${r.status}${allow ? '（Allow: ' + allow + '）' : ''} ${rawHead(r.text, 160)}`
          );
          if (r.status > 0 && DEAD.indexOf(r.status) < 0) {
            found.candIndex = i;
            found.shape = c.shape;
            if (c.shape === 'items' || c.shape === 'urls') found.addUrls = c.path;
            else found.addUrl = c.path;
            break;
          }
          if (r.status === 405) {
            found.raw.push(
              allow
                ? `   ↳ 该方法不被允许；Eagle 说这个路由允许：${allow}`
                : '   ↳ 405 = 路由存在但方法不对，换下一个候选。'
            );
          }
        } catch (e) {
          found.raw.push(`探测 ${c.label} → 异常 ${e.message}`);
        }
      }

      found.raw.forEach((l) => log(l, 'info'));

      if (found.candIndex < 0) {
        found.note = `基础路径 ${found.base} 打得通，但没探到任何加素材端点（405 = 方法不对，404 = 路由不存在）。请把上面几行原始响应发我。`;
        log(found.note, 'error');
        this.caps = null;
        return found;
      }

      log(`✅ 加素材端点：${ADD_CANDIDATES[found.candIndex].label}`, 'ok');
      this.caps = found;
      store.set('eagleCaps', found);
      return found;
    },

    async listFolders() {
      const caps = await this.probe();
      if (!caps.base) return [];
      try {
        const r = await this.req(caps.base + '/library/info', { timeout: 12000 });
        const folders = r.json && r.json.data && r.json.data.folders;
        if (Array.isArray(folders)) return folders;
      } catch (e) {
        /* 退到 folder/list */
      }
      for (const p of ['/folder/list', '/folders']) {
        try {
          const r = await this.req(caps.base + p, { timeout: 12000 });
          const d = r.json && (r.json.data || r.json);
          if (Array.isArray(d)) return d;
        } catch (e) {
          /* 继续 */
        }
      }
      return [];
    },

    // 串行小批量推送。Eagle 把 HTTP API(41595) 和 MCP(41596) 放在同一个单线程事件循环里，
    // 高负载下 41595 会被饿死到完全不响应（.eagle-mcp/NOTES-http-api-starved.md）—— 别并发。
    //
    // ★ 失败策略：**绝不重试一个可能已经部分成功的批次**。
    //   Eagle 没有幂等键，重试就会塞进重复素材。所以这里锁定探测出的那一个候选，
    //   第一个失败批次就整轮停下，并把原始响应打出来给用户。
    async push(items, onProgress) {
      const caps = await this.probe();
      if (caps.candIndex < 0) throw new Error(caps.note || 'Eagle API 不可用');
      const c = ADD_CANDIDATES[caps.candIndex];

      const tags = settings.tags ? String(settings.tags).split(/[,\s，、]+/).filter(Boolean) : [];
      const folderId = settings.folderId || undefined;

      // folderId 同时放顶层（旧版 addFromURL(s) 的官方字段）和条目里的 folders 数组
      // （Eagle 插件 SDK 的 addFromPath 用的就是 folders）。Eagle 会忽略多余的字段。
      // 兜底：上游没给 name（老缓存、外部调用）时再从原图地址派生一次。
      // 传空字符串 = Eagle 拿素材 id 当名字 = 库里出现 `MUMT12OZPMAVP` 那种乱码。
      const payloadItems = items.map((it, i) => ({
        url: it.url,
        name: sanitizeName(it.name) || buildItemName(it, it.url, i),
        website: it.website || location.href,
        tags,
        ...(folderId ? { folders: [folderId] } : {}),
      }));

      const okStatus = (r) =>
        r.status >= 200 &&
        r.status < 300 &&
        !(r.json && String(r.json.status || '').toLowerCase() === 'error');

      // 按探测出的 shape 组装请求体。四种形状的差别是真实存在的，不是保险起见：
      //   items → v2 批量：{ items: [...], folderId, tags }
      //   item  → v2 单条：条目对象本身
      //   urls  → 旧版批量：{ urls: ["...", ...], folderId, tags }
      //   url   → 旧版单条：{ url, name, website, tags, folderId }
      const bodyFor = (one, batch) => {
        if (c.shape === 'items') return { items: batch, folderId, tags };
        if (c.shape === 'item') return one;
        if (c.shape === 'urls') {
          return { urls: batch.map((x) => x.url), website: location.href, tags, folderId };
        }
        return {
          url: one.url,
          name: one.name || '',
          website: one.website || location.href,
          tags,
          folderId,
        };
      };
      const isBatch = c.shape === 'items' || c.shape === 'urls';

      let ok = 0;
      let failed = 0;
      let aborted = false;
      const size = Math.max(1, settings.batchSize | 0);

      log(
        `加素材端点：${c.label}；共 ${payloadItems.length} 张，每批 ${size}${folderId ? '，folderId=' + folderId : ''}`,
        'info'
      );
      log(`实际请求：${buildApiUrl(settings.eagleOrigin, c.base + c.path)}`, 'info');

      for (let i = 0; i < payloadItems.length; i += size) {
        const batch = payloadItems.slice(i, i + size);
        try {
          if (isBatch) {
            const r = await this.req(c.base + c.path, {
              method: c.method,
              body: bodyFor(null, batch),
              timeout: 60000,
            });
            if (okStatus(r)) {
              ok += batch.length;
            } else {
              log(`❌ 批次 ${i / size + 1} 失败：${httpNote(r)} ${rawHead(r.text, 400)}`, 'error');
              failed += batch.length;
              aborted = true;
            }
          } else {
            let n = 0;
            for (const one of batch) {
              const r = await this.req(c.base + c.path, {
                method: c.method,
                body: bodyFor(one, [one]),
                timeout: 60000,
              });
              if (okStatus(r)) {
                n++;
              } else {
                log(`❌ 单条失败：${httpNote(r)} ${rawHead(r.text, 400)}`, 'error');
                break;
              }
              await sleep(120);
            }
            ok += n;
            if (n < batch.length) {
              failed += batch.length - n;
              aborted = true; // 已成功的条目绝不重试，避免重复入库
            }
          }
        } catch (e) {
          log(`❌ 批次 ${i / size + 1} 请求异常：${e.message}`, 'error');
          failed += batch.length;
          aborted = true;
        }
        if (onProgress) onProgress(Math.min(i + size, payloadItems.length), payloadItems.length, ok, failed);
        if (aborted) {
          log('已停止：第一个失败批次之后不再继续，避免重复入库。请把上面的原始响应发我。', 'error');
          break;
        }
        await sleep(settings.batchDelayMs);
      }
      return { ok, failed };
    },
  };

  /* ============================================================
   * 7. UI 面板（Shadow DOM 隔离样式）
   * ============================================================ */

  let ui = null;
  let currentRule = null;
  let resolvedCache = [];   // [{ url, via, thumb, name, website, status }]
  // 跨多次「扫描本页」累计的条目表 + 已经成功送进 Eagle 的 URL。
  // 虚拟化列表每次扫描只看得到当前挂载的 ~20 个 tile，所以重扫必须**累加**
  // 而不是覆盖 —— 否则数字永远在 20 左右跳动，滚过去的图全丢。
  let accum = { scope: '', map: new Map() };
  const sentUrls = new Set();   // 已成功推送过的原图 URL：重扫时保持「已发送」，不重推
  let observer = null;
  let autoScanned = false;
  // —— 跟随滚动 / 可中断扫描的状态 ——
  let scanRunning = false;                 // 完整 scan 进行中时，follow 采集器让路
  let scanAbort = false;                   // 「停止」按钮：中断自动滚动
  let resolvedByKey = new Map();           // itemKey → 解析记录，增量解析的依据
  let followState = { refDir: '' };        // follow 模式复用的 resolve state
  let followBound = false;                 // scroll 监听只挂一次

  const shortUrl = (u) => {
    try {
      const x = new URL(u);
      const p = x.pathname;
      return x.hostname.replace(/^www\./, '') + (p.length > 46 ? p.slice(0, 22) + '…' + p.slice(-22) : p);
    } catch (e) {
      return String(u).slice(0, 60);
    }
  };

  function buildUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.id = 'ebc-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:16px;right:16px;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:-apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
        .p{width:352px;background:#1b1d21;color:#e6e6e6;border:1px solid #33383f;border-radius:10px;
           box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:12px;overflow:hidden}
        .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#22262b;cursor:move;user-select:none}
        .hd b{font-size:12px;font-weight:600;flex:1}
        .hd .v{color:#6b7280;font-size:10px}
        .hd button{background:none;border:0;color:#9aa2ad;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}
        .hd button:hover{color:#fff}
        .bd{padding:10px;display:flex;flex-direction:column;gap:8px;max-height:70vh;overflow:auto}
        .st{display:flex;align-items:center;gap:6px;color:#9aa2ad;font-size:11px;line-height:1.5}
        .tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;background:#2d333b;color:#a9b4c0}
        .tag.ok{background:#17361f;color:#6ee7a0}
        .tag.warn{background:#3a2f14;color:#f0c674}
        .tag.err{background:#3a1a1a;color:#f08080}
        .row{display:flex;gap:6px;flex-wrap:wrap}
        button.b{flex:1;min-width:96px;padding:6px 8px;border-radius:6px;border:1px solid #3a4048;
                 background:#2a2f36;color:#dfe4ea;cursor:pointer;font-size:11px}
        button.b:hover{background:#333a43;border-color:#4a525c}
        button.b:disabled{opacity:.45;cursor:not-allowed}
        button.b.pri{background:#2f6fed;border-color:#2f6fed;color:#fff}
        button.b.pri:hover{background:#3d7bf5}
        ul.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:210px;overflow:auto}
        ul.list li{display:flex;align-items:center;gap:7px;padding:4px;background:#21252a;border-radius:5px}
        ul.list img{width:38px;height:38px;object-fit:cover;border-radius:4px;background:#000;flex:0 0 auto}
        ul.list .m{flex:1;min-width:0}
        ul.list .u{font-size:10px;color:#c3cad3;word-break:break-all;line-height:1.35}
        ul.list .v{font-size:9px;color:#6b7280;margin-top:2px}
        .log{font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:1.55;color:#9aa2ad;
             background:#16181b;border-radius:6px;padding:6px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all}
        .log .ok{color:#6ee7a0}.log .warn{color:#f0c674}
        .log .err,.log .error{color:#f08080}
        .log .info{color:#9aa2ad}
        input,select{width:100%;padding:5px 7px;border-radius:5px;border:1px solid #3a4048;background:#22262b;color:#e6e6e6;font-size:11px}
        label{display:block;color:#9aa2ad;font-size:10px;margin:6px 0 2px}
        .fill{color:#c3cad3;font-size:10px;line-height:1.5}
        .hide{display:none!important}
      </style>
      <div class="p">
        <div class="hd">
          <b>Eagle 大图批量收藏</b>
          <span class="v">v${VERSION}</span>
          <button id="min" title="折叠">—</button>
          <button id="cls" title="隐藏（用油猴菜单重新打开）">×</button>
        </div>
        <div class="bd" id="bd">
          <div class="st" id="st">正在检测…</div>
          <div class="row">
            <button class="b" id="scan">扫描本页</button>
            <button class="b hide" id="stop" title="中断正在进行的自动滚动">停止滚动</button>
            <button class="b" id="rescan-clear" title="丢掉跨次扫描累计的条目，从头重新收集">重收</button>
            <button class="b pri" id="send">发送到 Eagle</button>
          </div>
          <div class="row">
            <button class="b" id="replace">替换页面图片</button>
            <button class="b" id="learn">学习模式</button>
            <button class="b" id="set">设置</button>
          </div>
          <ul class="list" id="list"></ul>
          <div class="log" id="log"></div>
          <div id="settings" class="hide">
            <label>订阅规则表 URL（留空=只用内置）</label>
            <input id="s-sub" placeholder="https://raw.githubusercontent.com/.../default.json">
            <label>Eagle 地址</label>
            <input id="s-org" placeholder="http://127.0.0.1:41595">
            <label>目标文件夹</label>
            <select id="s-fold"><option value="">（不指定）</option></select>
            <label>附加标签（逗号分隔）</label>
            <input id="s-tags" placeholder="原图, 收藏">
            <label>素材名模板（{basename} 原图文件名｜{alt} 图片说明｜{page} 页面标题｜{host} 域名｜{id} 条目 id｜{n} 序号）</label>
            <input id="s-name" placeholder="{basename}">
            <label>每批条数 / 批次间隔 ms（Eagle 事件循环脆弱，别调太大）</label>
            <input id="s-batch" type="number" min="1" max="50">
            <label>resolve 并发 / 请求间隔 ms</label>
            <input id="s-conc" type="number" min="1" max="16">
            <label>单页最多累计条数（0 = 不封顶；瀑布流/画廊用）</label>
            <input id="s-max" type="number" min="0" max="100000">
            <label>采集方式</label>
            <select id="s-mode">
              <option value="follow">跟随我的滚动（默认，不抢滚动条）</option>
              <option value="auto">自动一路滚到底（会夺走滚动控制权）</option>
            </select>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input id="s-autorep" type="checkbox" style="width:auto;margin:0;flex:none">
              跟随滚动时把缩略图就地换成原图（配 Eagle 官方扩展挑选）
            </label>
            <div class="row" style="margin-top:8px">
              <button class="b pri" id="s-save">保存</button>
              <button class="b" id="s-sub-refresh">更新订阅</button>
              <button class="b" id="s-caps">重测 Eagle</button>
              <button class="b" id="s-diag">诊断接口</button>
              <button class="b" id="s-verify">验证原图</button>
            </div>
            <div class="fill" id="s-note" style="margin-top:6px"></div>
          </div>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    const $ = (id) => sh.getElementById(id);
    const els = {
      root: host, sh, st: $('st'), list: $('list'), log: $('log'),
      settings: $('settings'), bd: $('bd'),
    };
    ui = els;

    // 拖动
    let drag = null;
    $('bd').addEventListener('mousedown', () => {});
    const hd = sh.querySelector('.hd');
    hd.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = { x: e.clientX, y: e.clientY, r: host.getBoundingClientRect() };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      host.style.left = drag.r.left + (e.clientX - drag.x) + 'px';
      host.style.top = drag.r.top + (e.clientY - drag.y) + 'px';
      host.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => (drag = null));

    $('min').onclick = () => els.bd.classList.toggle('hide');
    $('cls').onclick = () => (host.style.display = 'none');
    $('scan').onclick = () => scan();
    // 「停止滚动」：自动模式下中断 collectAll（当前这一轮跑完就停），
    // 已经收下来的条目不会丢，可以接着用。
    $('stop').onclick = () => {
      scanAbort = true;
      log('已请求停止滚动：当前这一轮结束后停下，已收集的条目会保留。', 'warn');
    };
    // 「重收」：丢掉跨次扫描累计的条目表，从头收集。
    // 已成功推送过的 URL 记在 sentUrls 里，所以不会把已经进 Eagle 的图重推一遍。
    $('rescan-clear').onclick = () => {
      const n = accum.map.size;
      accum = { scope: accum.scope, map: new Map() };
      resolvedCache = [];
      log(`已清空累计的 ${n} 条，下次「扫描本页」从头收集。（已发送记录保留，不会重推）`, 'info');
      renderList();
      renderStatus();
    };
    $('send').onclick = () => sendToEagle();
    $('replace').onclick = () => replacePageImages();
    $('learn').onclick = () => toggleLearn();
    $('set').onclick = () => {
      els.settings.classList.toggle('hide');
      if (!els.settings.classList.contains('hide')) fillSettings();
    };
    $('s-save').onclick = () => {
      saveSettings({
        subscriptionUrl: $('s-sub').value.trim(),
        eagleOrigin: $('s-org').value.trim() || DEFAULT_SETTINGS.eagleOrigin,
        folderId: $('s-fold').value,
        tags: $('s-tags').value.trim(),
        batchSize: Math.max(1, Math.min(50, parseInt($('s-batch').value, 10) || 8)),
        concurrency: Math.max(1, Math.min(16, parseInt($('s-conc').value, 10) || 5)),
        maxItems: (() => {
          const n = parseInt($('s-max').value, 10);
          return isNaN(n) ? DEFAULT_SETTINGS.maxItems : Math.max(0, Math.min(100000, n));
        })(),
        scanMode: $('s-mode').value === 'auto' ? 'auto' : 'follow',
        autoReplace: !!$('s-autorep').checked,
        // 空模板 = 用默认。不允许存成空字符串，否则素材名会退回 Eagle 的素材 id。
        nameTemplate: $('s-name').value.trim() || DEFAULT_SETTINGS.nameTemplate,
      });
      eagle.caps = null;
      log('设置已保存。', 'ok');
      renderStatus();
    };
    $('s-sub-refresh').onclick = async () => {
      saveSettings({ subscriptionUrl: $('s-sub').value.trim() });
      log('正在拉取订阅…');
      await loadSubscription();
      renderStatus();
    };
    $('s-caps').onclick = async () => {
      log('正在重测 Eagle API…');
      const c = await eagle.probe(true); // probe 自己会把每步原始响应打进日志
      if (c.candIndex >= 0) {
        const cand = ADD_CANDIDATES[c.candIndex];
        log(`探测成功：${c.base}${cand.path}（${cand.label}）`, 'ok');
      } else {
        log(`探测失败：${c.note}`, 'error');
      }
    };

    // 诊断：把「方法 × 路径」的组合全打一遍，原始响应（含 Allow 头）摊在日志里。
    // 这个按钮只为取证存在，**不发素材、不写库**：请求体一律是 {}，
    // Eagle 会用「没有来源」把它拒掉（官方自测用例 [14c] 就是这个行为）。
    $('s-diag').onclick = async () => {
      log(`Eagle 地址：${settings.eagleOrigin}`);
      // 先把拼出来的真实 URL 打出来。凡是「端点找不到/方法不对」的怪现象，
      // 第一件该看的就是这里 —— URL 拼坏了会伪装成端点名写错。
      log(`拼出的基址示例：${buildApiUrl(settings.eagleOrigin, '/api/v2/library/info')}`);
      const paths = [
        '/api/v2/library/info',
        '/api/library/info',
        '/api/v2/item/add',
        '/api/item/addFromURLs',
        '/api/item/addFromURL',
      ];
      for (const p of paths) {
        for (const m of ['GET', 'POST']) {
          try {
            // ★ 注意这里是 eagle.req 不是 this.req：箭头函数里的 this 不是 eagle，
            //   写成 this.req 会让每一次诊断都抛 "Cannot read properties of undefined"。
            const r = await eagle.req(p, { method: m, body: m === 'POST' ? {} : null, timeout: 8000 });
            const allow = allowHeader(r);
            log(
              `诊断 ${m} ${p} → ${r.status}${allow ? '（Allow: ' + allow + '）' : ''} ${rawHead(r.text, 200)}`,
              r.status >= 400 ? 'warn' : 'info'
            );
            log(`  ↳ ${r.url}`, 'info');
          } catch (e) {
            log(`诊断 ${m} ${p} → 异常 ${e.message}`, 'error');
          }
        }
      }
      log('诊断结束：405 = 路由在但方法不对；404 = 路由不存在；2xx/4xx 带正文 = 路由活着。', 'info');
    };

    // 「验证原图」：真的把第一张原图下下来，看服务端到底回了什么字节、多大、多少像素。
    // 目的只有一个 —— 区分「地址解析错了」与「地址对了但被防盗链挡住」。
    // 这两件事的修法完全不同，但在上层日志里长得一模一样，所以必须实测字节。
    $('s-verify').onclick = async () => {
      const first = resolvedCache.find((x) => x.url);
      if (!first) {
        log('还没有解析结果。先点「扫描本页」。', 'warn');
        return;
      }
      log(`验证原图（解析来源 ${first.via || '未知'}）：`);
      log(`  ${first.url}`);
      const tries = [
        { label: '带 Referer（= 本站页）', headers: { Referer: location.href } },
        { label: '不带 Referer（≈ Eagle 自己下）', headers: {} },
      ];
      const seen = [];
      for (const t of tries) {
        try {
          const r = await gmGet(first.url, { headers: t.headers, responseType: 'blob', timeout: 25000 });
          const blob = r.response;
          const size = blob && blob.size ? blob.size : 0;
          const ct = headerValue(r, 'content-type') || (blob && blob.type) || '(未知类型)';
          const level = r.status >= 200 && r.status < 300 && size > 20000 ? 'ok' : 'warn';
          log(`${t.label} → HTTP ${r.status}｜${ct}｜${size} 字节`, level);
          let dim = null;
          if (blob && blob.size && /image\//i.test(ct)) {
            dim = await imageSize(blob);
            log(`  ↳ 实际像素 ${dim.w}×${dim.h}`, dim.w >= 700 ? 'ok' : 'error');
          }
          seen.push({ label: t.label, status: r.status, size, dim });
        } catch (e) {
          log(`${t.label} → 异常 ${e.message}`, 'error');
          seen.push({ label: t.label, err: e.message });
        }
      }
      // 判读必须**两种都看**才能定性。2026-10-05 实测 imagetwist 属于第三支：
      // 带本站 Referer → HTTP 200 + 177x142 占位图（能正常解码，不报错），
      // 不带 Referer → 4080x2723 原图。只看「加载成功/字节数」会完全看错。
      const big = (x) => !!(x && x.dim && x.dim.w >= 700 && x.dim.h >= 700);
      const [withRef, withoutRef] = seen;
      log('判读：', 'info');
      if (big(withRef) && big(withoutRef)) {
        log('  · 两种都拿到大尺寸图 → 地址没问题，问题在 Eagle 侧。', 'info');
      } else if (!big(withRef) && big(withoutRef)) {
        log(
          '  · 只有**不带** Referer 才是大图 —— 图床防盗链（带外来 Referer 会回一张同样能解码的占位图，' +
            'HTTP 200，完全不报错）。推 Eagle 不受影响（Eagle 下载不带 Referer）；' +
            '但「替换页面图片」必须给 img 设 referrerPolicy=no-referrer。' +
            '图床表里标了 referrer 的图床，脚本替换时会自动设。',
          'warn'
        );
      } else if (big(withRef) && !big(withoutRef)) {
        log('  · 只有**带** Referer 才是大图 → 防盗链，得让下载端带上 Referer。', 'warn');
      } else {
        log(
          '  · 两种都拿不到大图 → 多半是地址解析错了，或者这个主机号上根本没有这张图。',
          'error'
        );
      }
    };

    return els;
  }

  function log(msg, level) {
    const els = ui || buildUI();
    const line = document.createElement('div');
    if (level) line.className = level;
    const t = new Date().toTimeString().slice(0, 8);
    line.textContent = `[${t}] ${msg}`;
    els.log.appendChild(line);
    els.log.scrollTop = els.log.scrollHeight;
    console.log('[EBC]', msg);
    while (els.log.childElementCount > 400) els.log.removeChild(els.log.firstChild);
  }

  function toggleStopBtn(show) {
    if (!ui || !ui.sh) return;
    const b = ui.sh.getElementById('stop');
    if (b) b.classList.toggle('hide', !show);
  }

  function renderStatus() {
    if (!ui) return;
    const n = resolvedCache.filter((x) => x.url).length;
    const badge = currentRule
      ? `<span class="tag ok">${currentRule.name}</span>`
      : `<span class="tag warn">无匹配规则</span>`;
    const src = ruleset.remote ? '订阅' : '内置';
    ui.st.innerHTML =
      `规则 ${activeRules().length} 条（${src}）　${badge}<br>` +
      `已解析原图 <b>${n}</b> 张　` +
      (settings.learnMode ? '<span class="tag warn">学习模式开</span>' : '');
  }

  function renderList() {
    if (!ui) return;
    ui.list.innerHTML = '';
    for (const it of resolvedCache) {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.src = it.thumb || it.url;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      const m = document.createElement('div');
      m.className = 'm';
      const u = document.createElement('div');
      u.className = 'u';
      u.textContent = it.url ? shortUrl(it.url) : '(未解析)';
      const v = document.createElement('div');
      v.className = 'v';
      v.textContent = (it.via ? it.via + ' · ' : '') + (it.status || '');
      m.appendChild(u);
      m.appendChild(v);
      li.appendChild(img);
      li.appendChild(m);
      ui.list.appendChild(li);
    }
  }

  function fillSettings() {
    const sh = ui.sh;
    // 显示**实际生效**的地址：老版本存下的空值会被 subscriptionUrlOf() 补成官方默认，
    // 这里如实反映出来，用户才不会以为「我明明是空的，凭什么在联网」。
    sh.getElementById('s-sub').value = subscriptionUrlOf();
    sh.getElementById('s-org').value = settings.eagleOrigin || '';
    sh.getElementById('s-tags').value = settings.tags || '';
    sh.getElementById('s-name').value = settings.nameTemplate || DEFAULT_SETTINGS.nameTemplate;
    sh.getElementById('s-batch').value = settings.batchSize;
    sh.getElementById('s-conc').value = settings.concurrency;
    sh.getElementById('s-max').value = settings.maxItems;
    const modeSel = sh.getElementById('s-mode');
    if (modeSel) modeSel.value = settings.scanMode === 'auto' ? 'auto' : 'follow';
    const repBox = sh.getElementById('s-autorep');
    if (repBox) repBox.checked = !!settings.autoReplace;
    sh.getElementById('s-note').textContent = '';
    (async () => {
      const folders = await eagle.listFolders();
      const sel = sh.getElementById('s-fold');
      sel.innerHTML = '<option value="">（不指定）</option>';
      const flat = [];
      const walk = (arr, depth) => {
        for (const f of arr || []) {
          flat.push({ id: f.id, label: '　'.repeat(depth) + (f.name || f.id) });
          if (f.children) walk(f.children, depth + 1);
        }
      };
      walk(folders, 0);
      if (!flat.length) {
        sh.getElementById('s-note').textContent =
          '没读到文件夹列表 —— 请确认 Eagle 已启动，并在「偏好设置 → 开发者」里打开本地 API。';
      }
      for (const f of flat) {
        const o = document.createElement('option');
        o.value = f.id;
        o.textContent = f.label;
        if (f.id === settings.folderId) o.selected = true;
        sel.appendChild(o);
      }
    })();
  }

  /* ============================================================
   * 8. 主流程
   * ============================================================ */

  async function scan() {
    const els = ui || buildUI();
    currentRule = findRuleFor(location.href);
    if (!currentRule) {
      log('本页没有匹配的规则。可以先「设置 → 订阅规则表」，或用「学习模式」现场生成一条规则。', 'warn');
      renderStatus();
      return;
    }
    log(`命中规则「${currentRule.name}」，开始收集条目…`);
    // 虚拟化列表（瀑布流/画廊）只挂载视口附近的 tile，滚出视野的会被卸载 ——
    // 所以「滚到底 → 滚回来 → 最后重收一次」几乎什么也拿不到。改成边走边收，
    // 并且跨多次「扫描本页」继续累计。
    const scope = currentRule.id + '|' + location.origin + location.pathname;
    if (accum.scope !== scope) {
      if (accum.scope) log(`页面/规则变了，丢掉上一页累计的 ${accum.map.size} 条，重新开始。`, 'info');
      accum = { scope, map: new Map() };
      resolvedByKey = new Map();
      followState = { refDir: '' };
    }
    const before = accum.map.size;
    // 自动滚动只在 auto 模式下会跑，所以「停止滚动」按钮也只在那时露面
    scanAbort = false;
    scanRunning = true;
    toggleStopBtn(settings.scanMode === 'auto');
    let col;
    try {
      col = await collectAll(
        currentRule,
        (round, total, added) => {
          els.st.textContent = `滚动收集 第 ${round} 轮｜累计 ${total} 条…`;
          if (added) log(`第 ${round} 轮：新增 ${added} 条，累计 ${total} 条。`, 'info');
        },
        (page, url, total, added) => {
          els.st.textContent = `分页收集第 ${page} 页｜累计 ${total} 条…`;
          log(`分页 ${page}：新增 ${added} 条，累计 ${total} 条（${shortUrl(url)}）。`, 'info');
        }
      );
    } finally {
      scanRunning = false;
      toggleStopBtn(false);
    }
    if (col.aborted) {
      log(`已停止滚动（你按了「停止滚动」）。已收集 ${col.items.length} 条，可以接着用。`, 'warn');
    }
    mergeItems(accum.map, col.items);
    const items = [...accum.map.values()];

    if (col.pagesFetched) {
      log(`分页收集结束：读取了 ${col.pagesFetched} 个分页，本次得到 ${col.items.length} 条。`, 'info');
    }
    if (col.paginationAborted) {
      log('分页收集已停止（你按了「停止滚动」）。已收集的分页条目会保留。', 'warn');
    }
    if (col.scrolled) log(`滚动收集结束：滚了 ${col.rounds} 轮。`, 'info');
    if (col.capped) {
      log(
        `已达累计上限 ${settings.maxItems} 条，停止滚动。想继续收：把设置里的「单页最多累计」调大，` +
          '或往下滚一段再点「扫描本页」（会接着累计，不会丢）。',
        'warn'
      );
    }
    if (col.timedOut) {
      log(
        `滚动收集到达时间上限（${Math.round(SCROLL.budgetMs / 1000)}s）已停止。` +
          `已累计 ${items.length} 条；往下滚一段再点「扫描本页」会接着累计。`,
        'warn'
      );
    }
    if (items.length > before) {
      log(`本次新增 ${items.length - before} 条，累计 ${items.length} 条。`);
    } else {
      log(`页面上找到 ${items.length} 个候选条目（本次没有新增）。`, 'info');
    }
    if (!items.length) {
      log('没找到条目 —— 检查规则的 collect.item 选择器是否对得上这个站点的 DOM。', 'warn');
      return;
    }

    // 记下本页缩略图所在的目录，供那些还没懒加载出来、没有 thumb 的条目借用
    const state = { refDir: '' };
    for (const it of items) {
      if (it.thumb && /^https?:/i.test(it.thumb)) {
        state.refDir = pathDir(it.thumb);
        break;
      }
    }
    const conc = currentRule.concurrency || settings.concurrency;

    // 规则声明了 endpoint 就先一次性把索引建好 —— 比让几十个 worker 去抢同一个
    // 请求干净（虽然有 promise 去重，但先建好日志顺序更清楚，也能提早暴露接口失效）
    const epStep = (currentRule.resolve || []).find((s) => s.type === 'endpoint');
    if (epStep) {
      els.st.textContent = '正在请求整组数据…';
      await buildEndpointIndex(epStep, state);
    }
    let finished = 0;
    const results = await pool(
      items,
      conc,
      (it) => resolveItem(it, currentRule, state),
      (d, t) => {
        finished = d;
        if (d % 5 === 0 || d === t) els.st.textContent = `解析中 ${d}/${t}…`;
      }
    );

    resolvedCache = results.map((r, i) => {
      const key = itemKey(items[i]);
      const u = r && r.url ? r.url : '';
      const rec = {
        url: u,
        via: r && r.via ? r.via : '',
        // key 是「就地替换」能不能对齐回 DOM 的关键：虚拟化会把 tile 卸载再挂载成
        // 新节点，只有 id / 详情页链接这种稳定身份才能把原图认回正确的 tile。
        key,
        thumb: items[i].thumb,
        // 素材名派生自**原图地址**（带 slug 的那个），不是缩略图。
        name: buildItemName(items[i], u, i),
        website: items[i].link || location.href,
        status: u ? (sentUrls.has(u) ? '已发送' : '就绪') : r && r.error ? r.error : '未解析',
      };
      if (key) resolvedByKey.set(key, rec);
      return rec;
    });
    const ok = resolvedCache.filter((x) => x.url).length;
    log(`解析完成：${ok}/${items.length} 张拿到原图。`, ok ? 'ok' : 'warn');

    // ★ 自检：一批条目全部解析到同一个 URL，几乎一定是规则的 attr 选择器退化到了
    //   整页匹配（把站点图标/占位图当成了原图）。这种失败**不会报错**，日志还会显示
    //   100% 成功，只有到了 Eagle 里才发现 106 张是同一张小图 —— 所以必须在这里拦住。
    {
      const urls = resolvedCache.filter((x) => x.url).map((x) => x.url);
      const uniq = new Set(urls);
      if (urls.length >= 3 && uniq.size === 1) {
        log(`⚠️ 所有 ${urls.length} 个条目都解析到了同一个地址：${urls[0]}`, 'error');
        log(
          '这几乎一定是 attr 选择器退化到了整页匹配（拿到了站点图标或占位图）。' +
            '请检查该站点的规则：attr 步骤不该命中全页第一张图。',
          'error'
        );
      }
    }
    if (!ok) {
      const kinds = (currentRule.resolve || []).map((s) => s.type);
      if (kinds.includes('pagedata')) {
        log(
          '一张都没解析出来。这个站点的原图地址藏在页内 viewer 的数据里 —— ' +
            '请点开任意一张大图（让 viewer 把数据请求发出去），然后**再点一次「扫描本页」**。' +
            '脚本已经挂钩了 XHR/fetch，那一次响应里的整组原图地址都会被拿到。',
          'warn'
        );
      } else {
        log('这张页面可能需要一条新规则。开「学习模式」点开一张大图，我来生成规则。', 'warn');
      }
    }
    renderList();
    renderStatus();
  }

  async function sendToEagle() {
    buildUI();
    if (!resolvedCache.length) {
      await scan();
    }
    const ready = resolvedCache.filter((x) => x.url && x.status !== '已发送');
    if (!ready.length) {
      log('没有待发送的原图。先「扫描本页」。', 'warn');
      return;
    }
    // 发送前先把「到底要发哪些 URL」摊开。用户实测里 Eagle 里 106 张变成了同一张小图，
    // 而「解析器把 106 条都解析成同一个 URL」和「URL 各不相同但被 Eagle/站点搞成一张」
    // 这两种情况的修法完全不同 —— 这行日志一眼就能分开。
    {
      const uniq = new Set(ready.map((x) => x.url));
      if (ready.length > 1 && uniq.size === 1) {
        log(`⚠️ 所有 ${ready.length} 个条目都解析到了同一个地址：${ready[0].url}`, 'error');
        log('这是解析器的 bug，不是 Eagle 的问题：检查该站点规则的 attr 选择器。', 'error');
      }
    }
    // ★ 同一个原图地址只发一次。页面条目数可能多于画廊的实际照片数
    //   （实测 eporner：106 个条目 → 85 张照片），不去重就会在 Eagle 里
    //   塞进 21 组重复素材，而日志和计数看起来完全正常。
    const { unique: pending, dupes } = dedupeByUrl(ready);
    for (const d of dupes) d.status = '重复，已跳过';
    if (dupes.length) {
      log(
        `有 ${dupes.length} 个条目与前面的条目指向同一张原图，已跳过（避免 Eagle 里出现重复素材）。`,
        'warn'
      );
    }
    const caps = await eagle.probe();
    if (caps.candIndex < 0) {
      log(caps.note || 'Eagle API 不可用。', 'error');
      log('可以改用「替换页面图片」，然后用 Eagle 官方扩展的批量收藏。', 'warn');
      return;
    }
    log(`推送到 Eagle（${ADD_CANDIDATES[caps.candIndex].label}），共 ${pending.length} 张（已按 URL 去重）…`);
    pending.slice(0, 3).forEach((x, i) => log(`  样例 ${i + 1}：${x.url}`, 'info'));
    try {
      const r = await eagle.push(pending, (done, total, ok, failed) => {
        ui.st.textContent = `推送中 ${done}/${total}（成功 ${ok} 失败 ${failed}）`;
      });
      for (const p of pending) { p.status = '已发送'; sentUrls.add(p.url); }
      log(`推送结束：成功 ${r.ok}，失败 ${r.failed}。`, r.failed ? 'warn' : 'ok');
    } catch (e) {
      log('推送失败：' + e.message, 'error');
    }
    renderList();
    renderStatus();
  }

  // 把页面上的缩略图就地换成原图 —— 之后 Eagle 官方扩展的「批量收藏」抓到的就是原图
  /**
   * 把当前 DOM 里已经解析出原图的 tile **就地**换成原图。
   *
   * 两个要点 —— 这是用户实测「377 条里只替换了 16 张」那个 bug 的教训：
   *
   *  1. **对齐靠 key，不靠 thumb**。虚拟化列表会把 tile 卸载再挂载成新节点；
   *     老实现重新 collectItems 之后用 thumb 对齐，而 Pinterest 重挂载后同一张图的
   *     thumb 常常变成另一个尺寸的候选地址 → 匹配不上 → 只有恰好从没被卸载过的
   *     那十几个能对上（实测 377 条只换了 16 张，正好是视口附近那一屏）。
   *     itemKey（id / 详情页链接）在重挂载之间是稳定的，才对得上。
   *
   *  2. **必须反复调用**。任何一次快照都只有当前挂载的十几个 tile，
   *     所以真正好用的形态是配合跟随滚动：你滚，它换（followPass 里调）。
   */
  function applyReplacements({ quiet = false } = {}) {
    if (!resolvedCache.length) return { n: 0, dupes: 0, scanned: 0 };
    const items = collectItems(currentRule || { collect: {} });
    const byKey = new Map();
    const byThumb = new Map();
    for (const r of resolvedCache) {
      if (!r.url) continue;
      if (r.key) byKey.set(r.key, r.url);
      if (r.thumb) byThumb.set(r.thumb, r.url); // 老记录没有 key 时的兜底
    }
    let n = 0;
    let dupes = 0;
    let noRef = 0;
    const usedUrl = new Set();
    for (const it of items) {
      if (!it.img) continue;
      let url = byKey.get(itemKey(it));
      if (!url && it.thumb) url = byThumb.get(it.thumb);
      if (!url) continue;
      // 同一张原图被页面上两个 tile 指着 —— Pinterest 的推荐流确实会重复推同一个 pin
      if (usedUrl.has(url)) dupes++;
      usedUrl.add(url);
      if (it.img.getAttribute('data-ebc-full') === url) continue; // 已经换过，别反复动它
      try {
        it.img.removeAttribute('srcset');
        it.img.removeAttribute('data-srcset');
        it.img.removeAttribute('data-src');
        it.img.removeAttribute('sizes');
        // ★ 防盗链图床：浏览器默认策略会给跨域图片请求带上本站 origin 当 Referer。
        //   而 imagetwist 实测「带外来 Referer → HTTP 200 + 177x142 占位图，
        //   不带 Referer → 4080x2723 原图」。所以对这类图床必须显式声明
        //   no-referrer，否则「替换页面图片」这条路会当场把缩略图换成占位图 ——
        //   而且不报任何错。判据从**原图 URL** 反查图床表，host / detail 两条路都覆盖。
        const h = findHost(url);
        if (h && h.referrer) {
          it.img.referrerPolicy = h.referrer;
          noRef++;
        }
        it.img.loading = 'eager';
        it.img.src = url;
        it.img.setAttribute('data-ebc-full', url);
        n++;
      } catch (e) {
        /* ignore */
      }
    }
    if (!quiet) {
      if (n) {
        log(`已把 ${n} 张缩略图替换为原图。现在用 Eagle 官方扩展的「批量收藏」即可。`, 'ok');
        if (noRef) {
          log(
            `其中 ${noRef} 张来自防盗链图床，已把 img.referrerPolicy 设成 no-referrer ——` +
              '这类图床只要请求带上本站 Referer 就回占位图（HTTP 200，不报错）。',
            'info'
          );
        }
        if (dupes) {
          log(
            `其中 ${dupes} 个 tile 与别的 tile 指向**同一张原图**（Pinterest 推荐流会重复推同一个 pin）——` +
              '用 Eagle 扩展收藏时它们会各进一份，挑的时候留意。',
            'info'
          );
        }
      } else {
        log(
          '当前页面上没有可替换的 tile —— 虚拟化列表只挂载视口附近那十几个。' +
            '往下滚一段再点一次，或者把「采集方式」设成「跟随我的滚动」，脚本会边滚边换。',
          'warn'
        );
      }
    }
    return { n, dupes, scanned: items.length };
  }

  async function replacePageImages() {
    buildUI();
    if (!resolvedCache.length) await scan();
    applyReplacements();
  }

  /* ============================================================
   * 9. 学习模式：记录 缩略图→原图 配对，自动生成 rewrite 规则
   * ============================================================ */

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function commonAffix(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return [a.slice(0, p), s ? a.slice(a.length - s) : ''];
  }

  // 把 236x / 474x 这类尺寸 token 泛化成 \d+x\d*
  function generalizeToken(mid) {
    if (/^\d+x\d*$/.test(mid)) return '(?:\\d+x\\d*)';
    return esc(mid);
  }

  /**
   * 从一对 (缩略图, 原图) 合成 rewrite 规则。
   * 只有当两者的 basename 一致（或仅差尺寸后缀）时才敢泛化 —— 否则文件名完全不同，
   * 改写无法通用，必须走 detail 策略。
   */
  function synthesizeRewrite(thumb, full) {
    let t, f;
    try {
      t = new URL(thumb);
      f = new URL(full);
    } catch (e) {
      return { ok: false, why: 'URL 解析失败' };
    }
    const baseOf = (u) => u.pathname.split('/').pop() || '';
    const tb = baseOf(t);
    const fb = baseOf(f);
    const stem = (s) => s.replace(/\.[a-z0-9]+$/i, '');
    if (tb !== fb && stem(tb) !== stem(fb)) {
      return {
        ok: false,
        why: `文件名不同（缩略图 ${tb} vs 原图 ${fb}），无法用改写通用化 —— 应使用 detail 策略抓详情页。`,
      };
    }
    const [pre, suf] = commonAffix(thumb, full);
    const tMid = thumb.slice(pre.length, thumb.length - suf.length);
    const fMid = full.slice(pre.length, full.length - suf.length);
    if (!tMid && !fMid) return { ok: false, why: '两个地址完全相同，无需改写。' };
    if (!tMid) {
      return { ok: false, why: '原图地址比缩略图多出内容，无法用简单的正则改写表达（可考虑 detail 策略）。' };
    }
    const re = esc(pre) + generalizeToken(tMid) + esc(suf);
    const to = pre + fMid + suf;
    return {
      ok: true,
      rule: { re, to },
      confidence: /^\d+x\d*$/.test(tMid) ? 'high' : 'medium',
      explain: `把 ${JSON.stringify(tMid)} 这一段替换为 ${JSON.stringify(fMid)}`,
    };
  }

  const LEARN = {
    recordPair(thumb, full) {
      if (!thumb || !full || thumb === full) return null;
      const pairs = store.get('learnPairs', []);
      const rec = { host: location.hostname, thumb, full, at: Date.now(), page: location.href };
      if (pairs.some((p) => p.thumb === thumb && p.full === full)) return null;
      pairs.push(rec);
      while (pairs.length > 400) pairs.shift();
      store.set('learnPairs', pairs);
      return synthesizeRewrite(thumb, full);
    },
    // 扫描页面，把「小图」与「大图」配对
    scanPage() {
      const found = [];
      const all = Array.from(document.querySelectorAll('img'));
      const solids = [];
      for (const img of all) {
        const w = img.naturalWidth || img.width || 0;
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        if (!src || !/^https?:/i.test(src)) continue;
        if (w >= 700) solids.push(src);
      }
      if (!solids.length) return found;
      // 与本页任何缩略图候选配对：取 pathname 尺寸 token 相似者优先
      const thumbs = all
        .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter((s) => s && /^https?:/i.test(s));
      for (const full of solids) {
        for (const thumb of thumbs) {
          if (thumb === full) continue;
          const res = LEARN.recordPair(thumb, full);
          if (res && res.ok) found.push({ thumb, full, res });
        }
      }
      return found;
    },
    lastRun: store.get('learnPairs', []),
  };

  function toggleLearn() {
    saveSettings({ learnMode: !settings.learnMode });
    log(settings.learnMode ? '学习模式已开启：现在去点开一张大图。' : '学习模式已关闭。', 'ok');
    renderStatus();
    if (settings.learnMode) LEARN.scanPage();
  }

  // 学习模式运行时：大图一出现就配对
  function startLearnWatcher() {
    if (!settings.learnMode) return;
    const tick = () => {
      if (!settings.learnMode) return;
      const found = LEARN.scanPage();
      for (const f of found) {
        const r = f.res.rule;
        log(`学到一对映射（置信度 ${f.res.confidence}）：${f.res.explain}`, 'ok');
        log('生成规则：' + JSON.stringify({ type: 'rewrite', rules: [r] }), 'ok');
        const local = store.get('localRules', []);
        const id = 'learned-' + location.hostname.replace(/[^a-z0-9]+/gi, '-');
        const existing = local.findIndex((x) => x.id === id);
        const ruleObj = {
          id,
          name: '（学习）' + location.hostname,
          enabled: true,
          match: [`*://*.${location.hostname.replace(/^www\./, '')}/*`],
          referer: location.origin + '/',
          collect: { item: '', img: 'img', link: '' },
          resolve: [
            { type: 'attr', selectors: ['img@data-src', 'img@data-full', 'img@srcset:last', 'img@src'] },
            { type: 'rewrite', rules: [r] },
            { type: 'detail', selectors: ["meta[property='og:image']@content", 'img@src'], excludeThumb: true },
          ],
        };
        if (existing >= 0) local[existing] = Object.assign({}, local[existing], ruleObj);
        else local.push(ruleObj);
        store.set('localRules', local);
        ruleset.rules = mergeRules(ruleset.remote ? ruleset.remote.rules : BUILTIN_RULES, local);
        renderStatus();
      }
    };
    setInterval(tick, 2500);
    log('学习监听已启动（每 2.5s 扫一次页面上的大图）。', 'ok');
  }

  /* ============================================================
   * 10. 启动
   * ============================================================ */

  // SPA（Pinterest 等无限滚动）跟踪新增图
  function startSpaObserver() {
    if (!currentRule || !currentRule.spa) return;
    if (observer) observer.disconnect();
    let timer = null;
    observer = new MutationObserver(() => {
      if (timer) return;
      // 跟随模式下这里**不吭声**：直接把新挂载的 tile 静默收进来并解析，
      // 不再每隔几秒往日志里刷一行「可点扫描本页」。
      const follow = settings.scanMode === 'follow' && (currentRule.collect || {}).scrollToLoad;
      timer = setTimeout(
        () => {
          timer = null;
          if (follow) {
            followPass();
            return;
          }
          log('页面有新图加载（无限滚动），可点「扫描本页」增量收集。');
        },
        follow ? 1200 : 4000
      );
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ============================================================
   * 11. 通用图床论坛模式：不认站点，只认图床
   * ============================================================ */

  // 页面上至少要有这么多张「来自已知图床」的图，才自动启用。
  // 宁可漏，也绝不在随便哪个网站上乱弹面板。
  const HOST_AUTODETECT_MIN = 3;

  /**
   * 一条「不认站点、只认图床」的规则。
   *
   * 用户实测的场景（kitty-kats 这类「用户可以自由发图的论坛」）：帖子里的图是
   * 用户从各种免费图床贴进来的，所以**没法为每家图床写一条站点规则** —— 甚至
   * 同一个帖子就混用好几家。这里的做法是反过来：不认站点，只认图床表。
   *
   *   collect：`a[href] > img` —— 缩略图外面套着图床的分享页链接（论坛贴图的标准形态）
   *   resolve：① host   查图床表 → 零请求改写（已知图床）
   *            ② detail 抓那个分享页，从里面读出原图直链（未知图床的兜底）
   *
   * ② 是万能的：不管哪家图床，它的分享页里一定有原图直链（实测 imagetwist 的
   * 分享页就含 <img class="pic" src="https://img69.imagetwist.com/i/…">），
   * 代价是每张图多一次请求。所以已知图床走 ①，只有 ① 不认识时才回落到 ②。
   */
  function genericGalleryRule() {
    return {
      id: '__auto-gallery',
      name: '通用图床论坛页（按图床识别）',
      enabled: true,
      match: ['*://*/*'],
      collect: { item: 'a[href] > img', img: 'self' },
      resolve: [
        { type: 'host' },
        {
          type: 'detail',
          excludeThumb: true,
          externalOnly: true,
          selectors: HOST_GALLERY_DETAIL_SELECTORS,
        },
      ],
      delayMs: 150,
    };
  }

  /**
   * 这个页面上有没有「一批来自已知图床的缩略图」。
   * 这是自动启用通用模式的唯一依据 —— 只认图床表，不猜站点结构。
   */
  let detectedHostIds = [];
  function detectHostGallery() {
    if (settings.autoDetectHosts === false) return null;
    if (!activeHosts().length) return null;
    const seen = new Set();
    const ids = new Set();
    let hits = 0;
    for (const img of document.querySelectorAll('a[href] > img')) {
      const u =
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.currentSrc ||
        img.src ||
        '';
      if (!/^https?:/i.test(u) || seen.has(u)) continue;
      seen.add(u);
      const h = findHost(u);
      if (h) {
        ids.add(h.id);
        hits++; // ★ 门槛数的是**图**，不是图床数 —— 用户那个帖子 117 张全是 imagetwist
      }
      if (hits >= HOST_AUTODETECT_MIN) {
        detectedHostIds = Array.from(ids);
        return genericGalleryRule();
      }
    }
    return null;
  }

  function boot() {
    // 尽早挂钩网络请求，才能抓到页内 viewer 自己发的数据请求
    sniff.install();
    // 先把订阅规则拉起来（有缓存就先用缓存）
    const cached = store.get('subCache', null);
    if (cached && cached.data && Array.isArray(cached.data.rules)) {
      ruleset.remote = cached.data;
      ruleset.rules = mergeRules(cached.data.rules, store.get('localRules', []));
      applyRemoteHosts(cached.data);
    }
    loadSubscription(true);

    currentRule = findRuleFor(location.href);

    // 站点规则没命中时退一步：按**图床**认（见 11 节）。
    // 论坛里用户从各种免费图床贴图，"为这个站点写规则"从根上不成立。
    let autoDetected = false;
    if (!currentRule && !settings.learnMode) {
      const auto = detectHostGallery();
      if (auto) {
        currentRule = auto;
        autoDetected = true;
      }
    }

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('打开 Eagle 大图采集面板', () => {
        const els = buildUI();
        els.root.style.display = '';
        els.bd.classList.remove('hide');
      });
      GM_registerMenuCommand('扫描本页并解析原图', async () => {
        buildUI();
        await scan();
      });
      GM_registerMenuCommand('学习模式：开/关', () => {
        buildUI();
        toggleLearn();
      });
      // 页面上的图床还没进「图床表」时，用这个手动开一把：
      // 已知图床零请求改写，没收录的会去抓分享页（每张一次请求，慢但能拿到）。
      GM_registerMenuCommand('通用图床论坛模式：在本页强开', () => {
        currentRule = genericGalleryRule();
        buildUI();
        renderStatus();
        log(
          '已强制启用「通用图床论坛页」模式：采集 a[href] > img —— 先查图床表（零请求），' +
            '表格里没有的图床会去抓分享页取原图。',
          'info'
        );
        scan();
      });
    }

    // 只在命中规则、或开了学习模式时才自动弹面板 —— 避免污染所有网站
    if (currentRule || settings.learnMode) {
      if (settings.autoOpenPanel || settings.learnMode) {
        buildUI();
        log(
          `Eagle 大图采集 v${VERSION} 就绪。${
            currentRule
              ? (autoDetected ? '按图床自动识别：' : '命中规则：') + currentRule.name
              : '（未命中规则）'
          }`
        );
        if (autoDetected) {
          log(
            `本页没有站点规则，但有多张来自 ${
              detectedHostIds.length ? detectedHostIds.join('、') : hostNames()
            } 的图 —— 已按图床表接管。` +
              '图床表在 rules/default.json 的 hosts 里，加一行就能多支持一家。',
            'ok'
          );
        }
        renderStatus();
        if (!autoScanned && currentRule) {
          autoScanned = true;
          setTimeout(() => scan(), 800);
        }
      }
      startSpaObserver();
      startFollowCollector();
    }
    if (settings.learnMode) startLearnWatcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
