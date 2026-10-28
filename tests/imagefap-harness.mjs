/**
 * ImageFap 回归 —— detail 的 {id} 占位符 + harvestStrip（条带顺带收获）。
 *
 * 真实站点形状（2026-10-28 实测，/pictures/12884638/ 共 668 张）：
 *   列表页条目  <a name="733468870" href="/photo/733468870/?pgid=&gid=…&page=0">
 *               <img src="…/images/thumb/116/733/733468870.jpg?secure=A">
 *   分页器      ?gid=…&page=N&view=0（滑动窗口，/photo/ 链接不带 view=）
 *   详情页      ul.thumbs 条带里每个 <li> 的 <a href> 直接是该图 /full/ 原图直链，
 *               且带 imageid / dimension 属性 —— 24 个 li 形态完全相同，
 *               唯一能定位当前图的就是 imageid。
 *
 * 测试不打网络：列表页/详情页都是假 DOM，按 URL 映射。
 */
import assert from 'node:assert/strict';
import { El, fakeDocument, loadEbc } from './_load-script.mjs';

const ORIGIN = 'https://www.imagefap.com';
const gid = 12884638;
const PAGES = 6;            // 6 个分页窗口
const PER = 3;              // 每页 3 张（真实是 24，测试缩小）
const TOTAL = PAGES * PER;  // 18 张

// ★ 与真实站点一致：/pictures/<gid>/<标题> 后面直接接 ?gid=…，没有斜杠。
const galleryUrl = (n) => `${ORIGIN}/pictures/${gid}/Some%20Gallery` + (n === 0 ? '' : `?gid=${gid}&page=${n}&view=0`);
const photoId = (p, k) => 1000 + p * PER + k;   // 全局唯一图片 id
const thumbUrl = (id) => `${ORIGIN.replace('www', 'cdnc')}/images/thumb/116/733/${id}.jpg?secure=THUMB_${id}`;
const fullUrl = (id) => `${ORIGIN.replace('www', 'cdnc')}/images/full/116/733/${id}.jpg?secure=FULL_${id}`;
// ★ 忠实还原真实 DOM：href 属性是**相对**的（真实站点如此，浏览器才会显示成绝对）。
//   夹具若写绝对地址，a[href^='/photo/'] 就匹配不上 —— 那是夹具错了，不是规则错了。
const photoUrl = (id, p) => `/photo/${id}/?pgid=&gid=${gid}&page=${p}`;

/** 列表页：3 个条目 + 滑动窗口分页器（只往前看 2 页）+ 噪音（头像图、懒加载占位符） */
function makeGalleryPage(p) {
  const body = new El('body');
  for (let k = 0; k < PER; k++) {
    const id = photoId(p, k);
    const a = new El('a', { name: String(id), href: photoUrl(id, p) });
    a.appendChild(new El('img', {
      class: '_lazy',
      src: thumbUrl(id),
      width: '160',
      height: '105',
      alt: `Free porn pics of Some Gallery ${p * PER + k + 1} of ${TOTAL} pics`,
    }));
    body.appendChild(a);
  }
  // 噪音：上传者头像（cdnc thumb 但不在 /photo/ 锚点里）+ 懒加载占位符
  body.appendChild(new El('img', { src: thumbUrl(9999), width: '65', height: '65' }));
  body.appendChild(new El('img', { src: '/img/ajax-loader.gif' }));
  // 分页器：滑动窗口，page=0 只露出 1、2；page=1 露出 0、2、3……
  const pager = new El('div', { class: 'pager' });
  const want = new Set();
  for (let d = 1; d <= 2; d++) if (p + d < PAGES) want.add(p + d);
  if (p > 0) want.add(p - 1);
  for (const q of want) {
    pager.appendChild(new El('a', { href: `?gid=${gid}&page=${q}&view=0` }));
  }
  body.appendChild(pager);
  return fakeDocument(body);
}

/** 详情页：ul.thumbs 条带带本窗口全部 3 张的 full 直链（形态完全相同的 li） */
function makeDetailPage(p) {
  const body = new El('body');
  const ul = new El('ul', { class: 'thumbs' });
  for (let k = 0; k < PER; k++) {
    const id = photoId(p, k);
    const a = new El('a', {
      href: fullUrl(id),
      original: fullUrl(id),
      framed: thumbUrl(id),
      dimension: '2700x1756',
      imageid: String(id),
      views: '427',
    });
    a.appendChild(new El('img', { src: thumbUrl(id).replace('/thumb/', '/mini/') }));
    const li = new El('li');
    li.appendChild(a);
    ul.appendChild(li);
  }
  body.appendChild(ul);
  return fakeDocument(body);
}

const galleryDocs = new Map();
const detailDocs = new Map();
const abs = (u) => new URL(u, ORIGIN).href;
for (let p = 0; p < PAGES; p++) {
  galleryDocs.set(galleryUrl(p), makeGalleryPage(p));
  for (let k = 0; k < PER; k++) detailDocs.set(abs(photoUrl(photoId(p, k), p)), makeDetailPage(p));
}

const doc0 = galleryDocs.get(galleryUrl(0));
// 真实站点上「首页」的自引用链接（?gid=…&page=0&view=0）与无参 URL 是同一个
// 页面 —— 都放进来，分页器把它当普通分页抓是预期行为（条目按 id 去重，0 新增）。
galleryDocs.set(`${ORIGIN}/pictures/${gid}/Some%20Gallery?gid=${gid}&page=0&view=0`, doc0);
let detailFetches = 0;
const { EBC, sandbox } = loadEbc({
  document: doc0,
  location: { href: galleryUrl(0), hostname: 'www.imagefap.com', origin: ORIGIN, pathname: `/pictures/${gid}/Some%20Gallery` },
  gmGet: async (opts) => {
    const url = abs(String(opts.url || ''));
    if (detailDocs.has(url)) {
      detailFetches++;
      return { status: 200, responseText: url };
    }
    if (galleryDocs.has(url)) return { status: 200, responseText: url };
    throw new Error('未准备的请求: ' + url);
  },
});
sandbox.DOMParser = class {
  parseFromString(text) {
    const doc = detailDocs.get(text) || galleryDocs.get(text);
    if (!doc) throw new Error('没有为 ' + text + ' 准备 DOM');
    return doc;
  }
};

const rule = EBC.BUILTIN_RULES.find((r) => r.id === 'imagefap');
assert.ok(rule, '内置规则里必须有 imagefap');

let pass = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); process.exitCode = 1; throw new Error(name); }
};

console.log('\n== A. 列表页采集：只收 /photo/ 条目，id 来自 a[name] ==');
{
  const items = EBC.collectItems(rule);
  ok('正好 3 个条目（头像与懒加载占位符不算）', items.length === PER, String(items.length));
  ok('externalId 来自 a[name]', items.every((it) => /^\d{4}$/.test(it.externalId)), JSON.stringify(items.map((x) => x.externalId)));
  ok('thumb 是 cdnc 缩略图', items.every((it) => /\/images\/thumb\//.test(it.thumb)));
  ok('itemKey 是 id:<id>（跨分页去重稳）', items.every((it) => EBC.itemKey(it) === 'id:' + it.externalId));
  ok('link 指向 /photo/ 详情页', items.every((it) => /\/photo\/\d+\//.test(it.link)));
}

console.log('\n== B. 滑动窗口分页：递归发现走完全部 ' + PAGES + ' 页 ==');
{
  const map = new Map();
  // 镜像 collectAll 的真实顺序：当前页条目先入表，分页再合并
  EBC.mergeItems(map, EBC.collectItems(rule));
  const before = map.size;
  // 真规则每页之间 sleep 1200ms —— 测试里关掉（行为一样，不用等 7 秒）
  const fast = JSON.parse(JSON.stringify(rule));
  fast.paginationDelayMs = 0;
  const res = await EBC.collectPagination(fast, map, () => {});
  // 5 个真分页 + 1 个 page=0 自引用（真实站点行为：分页器有「首页」链接，
  // 与无参 URL 是同一页面，条目按 id 去重后无害）
  ok('抓了 ' + PAGES + ' 个分页（含 1 个自引用）', res.pagesFetched === PAGES, String(res.pagesFetched));
  ok('没有触发上限', res.paginationCapped === false);
  ok('累计 ' + TOTAL + ' 条（全相册）', map.size === TOTAL, String(map.size));
  ok('page=0 自引用那页 0 新增（id:<id> 去重生效）', map.size === before + (TOTAL - PER), `before=${before} after=${map.size}`);
  const ids = new Set([...map.values()].map((x) => x.externalId));
  ok('跨页 id 全局唯一（id:<id> 去重生效）', ids.size === map.size);
  // 滑动窗口必须能走到最后一页
  ok('最后一页的条目在', [...map.values()].some((x) => x.externalId === String(photoId(PAGES - 1, PER - 1))));
}

console.log('\n== C. detail {id} 占位符：定位的是「当前那张」，不是邻居 ==');
{
  const item = { el: null, img: null, thumb: thumbUrl(photoId(0, 0)), link: photoUrl(photoId(0, 0), 0), externalId: String(photoId(0, 0)), baseUrl: galleryUrl(0) };
  const r = await EBC.resolveItem(item, rule, {});
  ok('返回的是 id=' + photoId(0, 0) + ' 的原图', r.url === fullUrl(photoId(0, 0)), r.url);
  ok('via 记录了用哪个选择器命中的', /detail:a\[imageid/.test(r.via), r.via);
  ok('结果不带 /thumb/（excludeThumb 没误放行）', !/\/thumb\//.test(r.url));
  // 邻居验证：换一条条目，必须返回另一张图的 full
  const item2 = { el: null, img: null, thumb: thumbUrl(photoId(0, 2)), link: photoUrl(photoId(0, 2), 0), externalId: String(photoId(0, 2)), baseUrl: galleryUrl(0) };
  const r2 = await EBC.resolveItem(item2, rule, {});
  ok('第二条解析成它自己的原图（不是第一条的）', r2.url === fullUrl(photoId(0, 2)), r2.url);
}

console.log('\n== D. harvestStrip：一个详情页喂饱同窗口的兄弟条目 ==');
{
  detailFetches = 0;
  const state = {};
  // 三条同窗口条目，串行解析（pool 并发下的时序不同，但结果必须一致）
  const out = [];
  for (let k = 0; k < PER; k++) {
    const id = photoId(1, k);
    const item = { el: null, img: null, thumb: thumbUrl(id), link: photoUrl(id, 1), externalId: String(id), baseUrl: galleryUrl(1) };
    out.push(await EBC.resolveItem(item, rule, state));
  }
  ok('只发了 1 次详情请求（第一条收割，后两条命中缓存）', detailFetches === 1, String(detailFetches));
  ok('三条都解析成功', out.every((r) => /\/full\//.test(r.url)), JSON.stringify(out.map((r) => r.url)));
  ok('每条都是它自己的 full 地址', out.every((r, k) => r.url === fullUrl(photoId(1, k))));
  ok('后两条 via=detail:strip（缓存命中可辨识）', out[1].via === 'detail:strip' && out[2].via === 'detail:strip');
  // 隔窗口的条目：缓存里没有，必须真的再发一次
  const farId = photoId(3, 1);
  const far = { el: null, img: null, thumb: thumbUrl(farId), link: photoUrl(farId, 3), externalId: String(farId), baseUrl: galleryUrl(3) };
  const before = detailFetches;
  const rFar = await EBC.resolveItem(far, rule, state);
  ok('跨窗口的条目会重新发请求', detailFetches === before + 1, String(detailFetches));
  ok('并且解析成它自己的原图', rFar.url === fullUrl(farId), rFar.url);
}

console.log('\n== E. {id} 抠不出来时：占位选择器跳过，回落 og:image ==');
{
  const rule2 = JSON.parse(JSON.stringify(rule));
  const st = {};
  // externalId 为空、thumb 里也没有 6 位以上数字 → {id} 无法展开
  const item = { el: null, img: null, thumb: 'https://x.test/a.jpg', link: photoUrl(photoId(0, 0), 0), externalId: '', baseUrl: galleryUrl(0) };
  // 给详情页补一条 og:image（假 DOM 里直接挂 meta）
  const d = detailDocs.get(abs(photoUrl(photoId(0, 0), 0)));
  d.body.appendChild(new El('meta', { property: 'og:image', content: 'https://x.test/og-fallback.jpg' }));
  const r = await EBC.resolveItem(item, rule2, st);
  ok('占位符选择器全部跳过，og:image 兜底生效', r.url === 'https://x.test/og-fallback.jpg', r.url);
  ok('via 显示走的是 og:image 那条', /og:image/.test(r.via), r.via);
}

console.log('\n== F. 规则本身：match 范围 ==');
{
  ok('命中相册列表页', EBC.findRuleFor(galleryUrl(0)) === rule);
  ok('命中带分页参数的列表页', EBC.findRuleFor(`${ORIGIN}/pictures/${gid}/X/?gid=${gid}&page=3&view=0`) === rule);
  ok('不误伤 /photo/ 详情页', EBC.findRuleFor(abs(photoUrl(1000, 0))) === null);
  ok('不误伤站点首页', EBC.findRuleFor(`${ORIGIN}/`) === null);
  ok('harvestStrip 声明为 a[imageid]@imageid', rule.resolve[0].harvestStrip === 'a[imageid]@imageid');
  ok('idFromThumb 是 6 位数字', rule.resolve[0].idFromThumb === '([0-9]{6,})');
  ok('分页器认 view=（/photo/ 链接不带 view=，不会误收）', rule.collect.pagination.links === "a[href*='view=']");
  // ★ 保守步行参数（用户实测被打验证码后定下的）：分页每页之间歇 1.2s，
  //   detail 2 个 worker、每个歇 400ms —— 慢是故意的。
  ok('paginationDelayMs=1200（分页步行节流）', rule.paginationDelayMs === 1200, String(rule.paginationDelayMs));
  ok('concurrency=2（detail 并发压到 2）', rule.concurrency === 2, String(rule.concurrency));
  ok('delayMs=400（detail 间隔）', rule.delayMs === 400, String(rule.delayMs));
}

console.log('\n== G. 保守步行熔断：被限流时必须停，不许把队列打完 ==');
{
  // 场景 1：连续失败。page0 的分页器指向 1..5，其中 1/2/3 返回 403，4/5 本来有货。
  // 老行为会把 4/5 也试一遍（每失败一次还继续），这里必须在第 3 次失败时熔断。
  const g = 999001;
  const base0 = `${ORIGIN}/pictures/${g}/G`;
  const pageDoc = (n) => {
    const b = new El('body');
    for (let k = 0; k < 2; k++) {
      const a = new El('a', { name: String(5000 + n * 10 + k), href: `/photo/${5000 + n * 10 + k}/?gid=${g}&page=${n}` });
      a.appendChild(new El('img', { src: `https://cdnc.imagefap.com/images/thumb/1/2/${5000 + n * 10 + k}.jpg?s=x` }));
      b.appendChild(a);
    }
    const pager = new El('div');
    for (const q of [1, 2, 3, 4, 5]) pager.appendChild(new El('a', { href: `?gid=${g}&page=${q}&view=0` }));
    b.appendChild(pager);
    return fakeDocument(b);
  };
  const hit = new Set();
  const e1 = loadEbc({
    document: pageDoc(0),
    location: { href: base0, hostname: 'www.imagefap.com', origin: ORIGIN },
    gmGet: async (o) => {
      const u = abs(String(o.url));
      hit.add(u);
      const m = String(u).match(/page=(\d+)/);
      const n = m ? Number(m[1]) : 0;
      if (n >= 1 && n <= 3) return { status: 403, responseText: '' };
      return { status: 200, responseText: u };
    },
  });
  e1.sandbox.DOMParser = class { parseFromString(t) { return pageDoc(Number((t.match(/page=(\d+)/) || [0, 0])[1])); } };
  const r1rule = JSON.parse(JSON.stringify(rule));
  r1rule.paginationDelayMs = 0;
  const m1 = new Map();
  e1.EBC.mergeItems(m1, e1.EBC.collectItems(r1rule));
  const res1 = await e1.EBC.collectPagination(r1rule, m1, () => {});
  ok('第 3 次连续失败就熔断', res1.paginationStopped === true, JSON.stringify(res1));
  ok('熔断后不再碰 page=4/5', ![...hit].some((u) => /page=[45]/.test(u)), [...hit].join(' '));

  // 场景 2：连续 0 新增（站点拿重复内容喂你）。11 页全是同样 2 条。
  const g2 = 999002;
  const base2 = `${ORIGIN}/pictures/${g2}/G`;
  const dupDoc = (() => {
    const b = new El('body');
    for (let k = 0; k < 2; k++) {
      const a = new El('a', { name: String(7000 + k), href: `/photo/${7000 + k}/?gid=${g2}&page=0` });
      a.appendChild(new El('img', { src: `https://cdnc.imagefap.com/images/thumb/1/2/${7000 + k}.jpg?s=x` }));
      b.appendChild(a);
    }
    const pager = new El('div');
    for (let q = 1; q <= 11; q++) pager.appendChild(new El('a', { href: `?gid=${g2}&page=${q}&view=0` }));
    b.appendChild(pager);
    return fakeDocument(b);
  })();
  const seen2 = [];
  const e2 = loadEbc({
    document: dupDoc,
    location: { href: base2, hostname: 'www.imagefap.com', origin: ORIGIN },
    gmGet: async (o) => { const u = abs(String(o.url)); seen2.push(u); return { status: 200, responseText: u }; },
  });
  e2.sandbox.DOMParser = class { parseFromString() { return dupDoc; } };
  const r2rule = JSON.parse(JSON.stringify(rule));
  r2rule.paginationDelayMs = 0;
  const m2 = new Map();
  const res2 = await e2.EBC.collectPagination(r2rule, m2, () => {});
  ok('连续 8 页 0 新增 → 熔断', res2.paginationStopped === true, JSON.stringify(res2));
  ok('熔断后剩余分页不再请求（11 页只走了 9 页）', seen2.length === 9, String(seen2.length));
  ok('重复内容只登记一次（id 去重）', m2.size === 2, String(m2.size));
}

console.log('\n== H. 已推送登记表：换签名的同一张图必须被认出来 ==');
{
  // push 时登记的是 resolved URL 的路径；重扫拿到新 token，路径不变
  const old = fullUrl(photoId(0, 0));                       // …/full/116/733/1000.jpg?secure=FULL_1000
  const renewed = old.replace('secure=FULL_1000', 'secure=BRAND_NEW_TOKEN');
  ok('pushedKeyOf 取的是路径（不含 query/token）', EBC.pushedKeyOf(old) === '/images/full/116/733/1000.jpg', EBC.pushedKeyOf(old));
  ok('新旧签名 URL 的路径相同（登记表能认出是同一张）', EBC.pushedKeyOf(renewed) === EBC.pushedKeyOf(old));
  const { fresh, skipped } = EBC.filterAlreadyPushed(
    [{ url: old, status: '就绪' }, { url: renewed, status: '就绪' }, { url: fullUrl(photoId(0, 1)), status: '就绪' }],
    new Set([EBC.pushedKeyOf(old)])
  );
  // 旧签名与新签名是同一张图 —— 两张都该被剔掉，只留没见过的那张
  ok('登记过的被剔掉（新旧签名一起算同一张）', skipped.length === 2, JSON.stringify(skipped.map((x) => x.url)));
  ok('没登记过的保留', fresh.length === 1 && fresh[0].url === fullUrl(photoId(0, 1)), JSON.stringify(fresh.map((x) => x.url)));
  ok('thumb 与 full 路径不同（登记表只对 resolved URL 负责，这正好）', EBC.pushedKeyOf(thumbUrl(photoId(0, 0))) !== EBC.pushedKeyOf(old));
  // rememberPushed/loadPushed 走 GM 存储往返
  const store2 = new Map();
  const again2 = loadEbc({
    document: fakeDocument(),
    location: { href: galleryUrl(0), hostname: 'www.imagefap.com', origin: ORIGIN, pathname: '/pictures/12884638/Some%20Gallery' },
    gmStore: store2,
  });
  again2.EBC.__set({ currentRule: rule });
  const scope = again2.EBC.pushedScopeKey();
  ok('scope 按 规则+画廊 分开', scope === 'pushed:imagefap|https://www.imagefap.com/pictures/12884638/Some%20Gallery', scope);
  again2.EBC.rememberPushed(scope, [EBC.pushedKeyOf(old)]);
  ok('rememberPushed 写入、loadPushed 读回（GM 存储往返）', again2.EBC.loadPushed().has('/images/full/116/733/1000.jpg'));
  again2.EBC.rememberPushed(scope, [EBC.pushedKeyOf(old)]); // 重复登记不炸也不加
  ok('重复登记幂等', again2.EBC.loadPushed().size === 1);
}

console.log(`\n${process.exitCode ? '❌ 有失败' : '✅ 全部通过'}（${pass} 项）\n`);
