/**
 * E-Hentai 回归 —— allowNoImg 条目 + detail 两跳 + 保守限速。
 *
 * 真实站点形状（2026-10-29 实测，/g/2314039/26f9b65dac/ 共 388 张 / 20 页）：
 *   相册条目  <a href="https://e-hentai.org/s/<imgkey>/<gid>-<n>">
 *               <div title="Page 1: <原始文件名>" style="…background:url(thumb)…"></div></a>
 *             —— 条目里【没有 <img>】，缩略图画在 CSS background 上
 *   查看页    <img id="img" src="https://<H@H>:8443/h/…keystamp=…;xres=org/<原始文件名>.jpg">
 *   分页      ?p=1..19 滑动窗口；388 张 = 388 个 /s/ 页，限速是生死线
 */
import assert from 'node:assert/strict';
import { El, fakeDocument, loadEbc } from './_load-script.mjs';

const ORIGIN = 'https://e-hentai.org';
const GID = '2314039';
const TOK = '26f9b65dac';
const galleryUrl = (p) => (p === 0 ? `${ORIGIN}/g/${GID}/${TOK}/` : `${ORIGIN}/g/${GID}/${TOK}/?p=${p}`);
const sPath = (n) => `/s/imgkey${String(n).padStart(6, '0')}/${GID}-${n}`;
const sUrl = (n) => `${ORIGIN}${sPath(n)}`;
const hathUrl = (n) => `https://hath01.hath.network:8443/h/aa${n}bb/keystamp=1793283000-xyz;fileindex=${n};xres=org/xizi1840_album_${GID}_img${n}.jpg`;

const PER = 3;        // 每页 3 条（真实是 20，测试缩小）
const PAGES = 3;      // 3 页
const TOTAL = PER * PAGES;

function makeGalleryPage(p) {
  const body = new El('body');
  const gdt = new El('div', { id: 'gdt', class: 'gt200' });
  for (let k = 0; k < PER; k++) {
    const n = p * PER + k + 1;
    const a = new El('a', { href: sUrl(n) });
    // 真实形态：里面只有一个 div，缩略图画在 style 的 background 上，没有 <img>
    a.appendChild(new El('div', {
      title: `Page ${n}: xizi1840_album_${GID}_img${n}.jpg`,
      style: `width:200px;height:200px;background:transparent url(https://ehgt.org/aa/bb/thumb${n}_l.jpg) 0 0 no-repeat`,
    }));
    gdt.appendChild(a);
  }
  body.appendChild(gdt);
  // 噪音锚点：分页器（?p=）与返回相册的链接 —— 都不能被当成条目
  const pager = new El('table', { class: 'ptt' });
  const tr = new El('tr');
  pager.appendChild(tr);
  tr.appendChild(new El('a', { href: galleryUrl(0) }));
  for (let q = 1; q < PAGES; q++) tr.appendChild(new El('a', { href: `?p=${q}` }));
  body.appendChild(pager);
  return fakeDocument(body);
}

function makeViewerPage(n) {
  const body = new El('body');
  body.appendChild(new El('img', { id: 'img', src: hathUrl(n) }));
  return fakeDocument(body);
}

const pageDocs = new Map();
const viewerDocs = new Map();
const abs = (u) => new URL(u, ORIGIN).href;
for (let p = 0; p < PAGES; p++) {
  pageDocs.set(galleryUrl(p), makeGalleryPage(p));
  for (let k = 0; k < PER; k++) {
    const n = p * PER + k + 1;
    viewerDocs.set(abs(sUrl(n)), makeViewerPage(n));
  }
}

let detailFetches = 0;
const { EBC, sandbox } = loadEbc({
  document: pageDocs.get(galleryUrl(0)),
  location: { href: galleryUrl(0), hostname: 'e-hentai.org', origin: ORIGIN, pathname: `/g/${GID}/${TOK}/` },
  gmGet: async (o) => {
    const u = abs(String(o.url || ''));
    if (viewerDocs.has(u)) { detailFetches++; return { status: 200, responseText: u }; }
    if (pageDocs.has(u)) return { status: 200, responseText: u };
    throw new Error('未准备的请求: ' + u);
  },
});
sandbox.DOMParser = class {
  parseFromString(text) {
    const doc = viewerDocs.get(text) || pageDocs.get(text);
    if (!doc) throw new Error('没有为 ' + text + ' 准备 DOM');
    return doc;
  }
};

const rule = EBC.BUILTIN_RULES.find((r) => r.id === 'ehentai');
assert.ok(rule, '内置规则里必须有 ehentai');

let pass = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); process.exitCode = 1; throw new Error(name); }
};

console.log('\n== A. 采集：无 <img> 的条目（缩略图是 CSS 背景）==');
{
  const items = EBC.collectItems(rule);
  ok(`第 1 页正好 ${PER} 个条目（allowNoImg 生效）`, items.length === PER, String(items.length));
  ok('link 是 /s/ 查看页', items.every((it) => /^https:\/\/e-hentai\.org\/s\/imgkey\d+\/2314039-\d+$/.test(it.link)));
  ok('thumb 为空（没有 <img> 可读）', items.every((it) => it.thumb === ''));
  ok('分页器锚点（?p=）没被误收', items.every((it) => !/\?p=/.test(it.link)));
  ok('itemKey 落在 link 上（去重稳）', items.every((it) => EBC.itemKey(it) === 'link:' + it.link.replace(/\?$/, '')) || new Set(items.map((x) => EBC.itemKey(x))).size === PER);
  ok('itemKey 全局唯一', new Set(items.map((it) => EBC.itemKey(it))).size === PER);
}

console.log('\n== B. 分页：?p= 递归走完 ' + PAGES + ' 页 ==');
{
  const map = new Map();
  EBC.mergeItems(map, EBC.collectItems(rule));
  const fast = JSON.parse(JSON.stringify(rule));
  fast.paginationDelayMs = 0;
  const res = await EBC.collectPagination(fast, map, () => {});
  ok(`抓了 ${PAGES - 1} 个分页`, res.pagesFetched === PAGES - 1, String(res.pagesFetched));
  ok('没有触发熔断', res.paginationStopped === false);
  ok(`累计 ${TOTAL} 条（全相册）`, map.size === TOTAL, String(map.size));
  const nums = [...map.values()].map((it) => Number(/-(\d+)$/.exec(it.link)[1])).sort((a, b) => a - b);
  ok('页号 1..' + TOTAL + ' 一张不少', nums.every((n, i) => n === i + 1), JSON.stringify(nums));
}

console.log('\n== C. detail 两跳：/s/ 页取 img#img ==');
{
  detailFetches = 0;
  const state = {};
  const map = new Map();
  EBC.mergeItems(map, EBC.collectItems(rule));
  const items = [...map.values()].slice(0, 2);
  const out = [];
  for (const it of items) out.push(await EBC.resolveItem(it, rule, state));
  ok('第一条解析成自己的 hath 大图', out[0].url === hathUrl(Number(/-(\d+)$/.exec(items[0].link)[1])), out[0].url);
  ok('第二条解析成自己的（不串图）', out[1].url === hathUrl(Number(/-(\d+)$/.exec(items[1].link)[1])), out[1].url);
  ok('via 以 detail 开头', out.every((r) => /^detail:/.test(r.via)), JSON.stringify(out.map((r) => r.via)));
  ok('每条 /s/ 页都真实抓取了一次', detailFetches === 2, String(detailFetches));
  // 命名：URL basename 就是原始文件名 —— buildItemName 不需要兜底
  // （脚本刻意去掉扩展名，Eagle 按内容自己定）
  const name = EBC.buildItemName(items[0], out[0].url, 0);
  ok('素材名 = 原始文件名（URL basename 白送，去扩展名）', name === `xizi1840_album_${GID}_img1`, name);
}

console.log('\n== D. 规则本身：范围、保守限速、登记表 ==');
{
  ok('命中 e-hentai 相册', EBC.findRuleFor(galleryUrl(0)) === rule);
  ok('命中带 ?p= 的分页', EBC.findRuleFor(galleryUrl(2)) === rule);
  ok('命中 exhentai（同一引擎）', EBC.findRuleFor('https://exhentai.org/g/999/abcdef/') === rule);
  ok('不误伤主站首页', EBC.findRuleFor(`${ORIGIN}/`) === null);
  ok('不误伤论坛', EBC.findRuleFor(`${ORIGIN}/forums/`) === null);
  ok('collect.allowNoImg = true', rule.collect.allowNoImg === true);
  ok('resolve 是 detail + img[id=img] 选择器',
    rule.resolve[0].type === 'detail' && rule.resolve[0].selectors.includes("img[id='img']@src"));
  ok('保守限速三件套：delayMs=600 / concurrency=2 / paginationDelayMs=1000',
    rule.delayMs === 600 && rule.concurrency === 2 && rule.paginationDelayMs === 1000,
    `${rule.delayMs}/${rule.concurrency}/${rule.paginationDelayMs}`);
  ok('登记表按文件名登记（keystamp 在路径里会变）', rule.pushedKeyRe === '([^/?]+)$');
  const k1 = EBC.pushedKeyOf(hathUrl(1), rule.pushedKeyRe);
  const k2 = EBC.pushedKeyOf(hathUrl(1).replace('keystamp=1793283000-xyz', 'keystamp=9999999999-abc'), rule.pushedKeyRe);
  ok('keystamp 变了键不变（按原始文件名）', k1 === k2 && k1 === `xizi1840_album_${GID}_img1.jpg`, `${k1} vs ${k2}`);
}

console.log(`\n${process.exitCode ? '❌ 有失败' : '✅ 全部通过'}（${pass} 项）\n`);
