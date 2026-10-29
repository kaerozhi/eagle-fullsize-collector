/**
 * 秀色女神（xsnvshen）回归 —— 分页相册 + 直推警告标记。
 *
 * 真实站点形状（2026-10-28 实测，/album/44777 共 60 张 / 6 页，每页 10 张）：
 *   内容图 <img src='//img.xsnvshen.com/album/<N>/<相册id>/<NNN>.jpg'>（单引号属性）
 *   封面噪音 //img.xsnvshen.com/thumb_205x308/album/…（相关推荐）
 *   分页 <a href="/album/44777?p=2">2</a> … ?p=6（首页无参数，页面上写「共 60 张」）
 *   src 就是原图 2400×1600（WebP 伪装 .jpg）；
 *   ★ 防盗链按 Referer 校验且必须带相册页 URL —— 直推 Eagle 必死（实测素材不落地），
 *     规则带 directPush: false 让推送时大声警告。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { El, fakeDocument, loadEbc } from './_load-script.mjs';

const ORIGIN = 'https://www.xsnvshen.com';
const ALBUM_ID = '44777';
const albumUrl = (p) => (p === 1 ? `${ORIGIN}/album/${ALBUM_ID}` : `${ORIGIN}/album/${ALBUM_ID}?p=${p}`);
const imgUrl = (n) => `//img.xsnvshen.com/album/0/${ALBUM_ID}/${String(n).padStart(3, '0')}.jpg`;

const PER = 3;        // 测试里每页 3 张（真实是 10）
const PAGES = 3;      // 3 页
const TOTAL = PER * PAGES;

/** 一个相册分页：PER 张内容图 + 封面/图标噪音 + ?p= 分页器 */
function makePage(p) {
  const body = new El('body');
  const box = new El('div', { class: 'show_box' });
  for (let k = 0; k < PER; k++) {
    const n = (p - 1) * PER + k;
    box.appendChild(new El('img', { src: imgUrl(n), loading: 'eager', alt: `[XiuRen] No.10373 第 ${n + 1} 张` }));
  }
  body.appendChild(box);
  // 噪音：相关推荐的封面（thumb_205x308 路径里也有 /album/，但不含 .com/album/）
  body.appendChild(new El('img', { src: `//img.xsnvshen.com/thumb_205x308/album/0/43869/cov.jpg` }));
  // 噪音：站点图标
  body.appendChild(new El('img', { src: '//res.xsnvshen.com/images/navhot.png' }));
  // 分页器：首页无参数，2..PAGES 是 ?p=N；每页都给出全部页码（真实站点如此）
  const pager = new El('div', { class: 'bigpages' });
  pager.appendChild(new El('a', { class: 'a1' })); // 「共 60 张」无 href
  pager.appendChild(new El('a', { class: 'active', href: albumUrl(1) }));
  for (let q = 2; q <= PAGES; q++) pager.appendChild(new El('a', { href: `?p=${q}` }));
  body.appendChild(pager);
  return fakeDocument(body);
}

const pageDocs = new Map();
for (let p = 1; p <= PAGES; p++) pageDocs.set(albumUrl(p), makePage(p));

const { EBC, sandbox } = loadEbc({
  document: pageDocs.get(albumUrl(1)),
  location: { href: albumUrl(1), hostname: 'www.xsnvshen.com', origin: ORIGIN, pathname: `/album/${ALBUM_ID}` },
  gmGet: async (o) => {
    const u = String(o.url || '');
    if (pageDocs.has(u)) return { status: 200, responseText: u };
    throw new Error('未准备的请求: ' + u);
  },
});
// collectPagination 解析远程 HTML 需要 DOMParser（imagefap-harness 同款替身）
sandbox.DOMParser = class {
  parseFromString(text) {
    const doc = pageDocs.get(text);
    if (!doc) throw new Error('没有为 ' + text + ' 准备 DOM');
    return doc;
  }
};
const sandboxErome = null; // 占位：本文件只有一个沙箱
const rule = EBC.BUILTIN_RULES.find((r) => r.id === 'xsnvshen');
assert.ok(rule, '内置规则里必须有 xsnvshen');

let pass = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); process.exitCode = 1; throw new Error(name); }
};

console.log('\n== A. 采集：内容图命中，封面/图标噪音不算 ==');
{
  const items = EBC.collectItems(rule);
  ok(`第 1 页正好 ${PER} 个条目`, items.length === PER, String(items.length));
  ok('thumb 是 /album/ 路径的内容图', items.every((it) => /img\.xsnvshen\.com\/album\/0\/44777\/\d{3}\.jpg$/.test(it.thumb)));
  ok('封面图（thumb_205x308/album/…）没被误收', !items.some((it) => /thumb_205x308/.test(it.thumb)));
  ok('站点图标没被误收', !items.some((it) => /res\.xsnvshen\.com/.test(it.thumb)));
  ok('protocol-relative src 被解析成 https 绝对地址', items.every((it) => /^https:\/\/img\./.test(it.thumb)));
  ok('itemKey 唯一', new Set(items.map((it) => EBC.itemKey(it))).size === PER);
}

console.log('\n== B. resolve：src 本身就是原图（2400×1600），attr 直通 ==');
{
  const items = EBC.collectItems(rule);
  const r = await EBC.resolveItem(items[0], rule, {});
  ok('返回的就是页面 src（站方原图）', r.url === items[0].thumb, r.url);
  ok('via 以 attr 开头', /^attr/.test(r.via), r.via);
}

console.log('\n== C. 分页：?p= 递归走完全部 ' + PAGES + ' 页 ==');
{
  const map = new Map();
  EBC.mergeItems(map, EBC.collectItems(rule));
  const before = map.size;
  // 真规则没有 paginationDelayMs → 回落 delayMs 且 ≥500ms；测试里置 0 免得等几秒
  const fast = JSON.parse(JSON.stringify(rule));
  fast.paginationDelayMs = 0;
  const res = await EBC.collectPagination(fast, map, () => {});
  ok(`抓了 ${PAGES - 1} 个分页`, res.pagesFetched === PAGES - 1, String(res.pagesFetched));
  ok('没有触发熔断', res.paginationStopped === false && res.paginationCapped === false);
  ok(`累计 ${TOTAL} 张（全相册）`, map.size === TOTAL, `before=${before} after=${map.size}`);
  // 编号跨页顺序递增（000-009 / 010-019 / …），不能有重复也不能漏
  const nums = [...map.values()]
    .map((it) => Number(/(\d{3})\.jpg$/.exec(it.thumb)[1]))
    .sort((a, b) => a - b);
  ok('编号 0..' + (TOTAL - 1) + ' 一张不少', nums.every((n, i) => n === i), JSON.stringify(nums));
  ok('翻页抓的是 ?p= 的 HTML（相册页本身没有防盗链）', res.apiPages === undefined);
}

console.log('\n== D. 规则本身：范围与形态 ==');
{
  ok('命中相册首页（无参数）', EBC.findRuleFor(albumUrl(1)) === rule);
  ok('命中带 ?p= 的分页', EBC.findRuleFor(albumUrl(2)) === rule);
  ok('不误伤站点首页', EBC.findRuleFor(`${ORIGIN}/`) === null);
  ok('不误伤其他路径', EBC.findRuleFor(`${ORIGIN}/tags/xxx`) === null);
  ok('resolve 只有 attr 一条', rule.resolve.length === 1 && rule.resolve[0].type === 'attr');
  ok('collect.item 用 .com/album/ 区分封面', rule.collect.item === "img[src*='.com/album/']");
  ok('分页器认 ?p=', rule.collect.pagination.links === "a[href*='?p=']");
}

console.log('\n== E. directPush: false —— 防盗链站的直推警告 ==');
{
  ok('规则声明 directPush: false', rule.directPush === false);
  // 语义验证：directPush 缺省时不警告
  const normal = EBC.BUILTIN_RULES.find((r) => r.id === 'erome');
  ok('其他站（erome）没有这个标记，直推不受影响', normal && normal.directPush === undefined);
  // 脚本源码里：警告条件是 currentRule.directPush === false（结构性断言，
  // 防止条件被写成 truthy 检查导致 erome 这类 undefined 也触发）
  const src = fs.readFileSync(new URL('../eagle-fullsize.user.js', import.meta.url), 'utf8');
  ok('警告只在 === false 时触发（结构性钉死）', /directPush === false/.test(src));
}

console.log(`\n${process.exitCode ? '❌ 有失败' : '✅ 全部通过'}（${pass} 项）\n`);
