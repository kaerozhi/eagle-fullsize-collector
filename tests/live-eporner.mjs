/**
 * 真实站点端到端验证（需要能访问 www.eporner.com）。
 *
 * 做两件事：
 *   1. 只统计结构，确认「页面首个 img[data-src] 是站点图标」这个事故前提在真实站点上成立；
 *   2. 把真实响应喂给**脚本自己的 buildEndpointIndex**，验证它真的能建出 85 条原图索引。
 *
 * 只输出结构与计数，不打印站点内容。
 * 用法：node eagle-batch-collector/tests/live-eporner.mjs
 */
import { El, fakeDocument, loadEbc, epornerRule } from './_load-script.mjs';

const GALLERY =
  'https://www.eporner.com/gallery/5IUmqWloQOl/Shoko-Takahashi-Yua-Mikami-Meganekko-Beautiful-Breasts-Sisters-megane-tsu-niang-mei-rushisutazu/';
const XHR = 'https://www.eporner.com/xhr/gallery-slide/5IUmqWloQOl';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const IMG_RE = /https?:\/\/[^"'\s\\)<>,\]]+?\.(?:jpe?g|png|webp|gif|avif)/gi;

async function get(url, extra = {}) {
  const t0 = Date.now();
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9', ...extra },
    redirect: 'follow',
  });
  const text = await r.text();
  return { status: r.status, ms: Date.now() - t0, bytes: Buffer.byteLength(text), text, type: r.headers.get('content-type') };
}

let page;
try {
  page = await get(GALLERY, { referer: 'https://www.eporner.com/' });
} catch (e) {
  console.log('❌ 无法访问画廊页：' + e.message);
  process.exit(2);
}
console.log(`画廊页 → HTTP ${page.status}｜${page.type}｜${page.bytes} 字节｜${page.ms} ms`);

const anchors = page.text.match(/data-photo-id="(\d+)"/g) || [];
console.log(`  服务端 HTML 里 data-photo-id 出现 ${anchors.length} 次（其余 105 个条目由前端 JS 注入）`);
console.log(`  服务端 HTML 里有 data-gallery-id：${/data-gallery-id/.test(page.text) ? '是' : '否'}`);

const dataSrcs = [...page.text.matchAll(/<img[^>]*\sdata-src="([^"]+)"/gi)].map((m) => m[1]);
const uniq = [...new Set(dataSrcs)];
console.log(`  带 data-src 的 <img>：${dataSrcs.length} 个（去重 ${uniq.length} 个）`);
console.log('  去重后前 6 个：');
for (const u of uniq.slice(0, 6)) console.log(`    ${u}`);
const catimg = uniq.filter((u) => /catimg/.test(u));
console.log(`  ★ 其中 catimg 站点图标 ${catimg.length} 个 —— 事故来源：整页兜底会拿到它`);

console.log('');
let xhr;
try {
  xhr = await get(XHR, { referer: GALLERY, 'x-requested-with': 'XMLHttpRequest' });
} catch (e) {
  console.log('❌ 无法访问 XHR 端点：' + e.message);
  process.exit(2);
}
console.log(`XHR /xhr/gallery-slide/5IUmqWloQOl → HTTP ${xhr.status}｜${xhr.type}｜${xhr.bytes} 字节｜${xhr.ms} ms`);

const urls = [...new Set(xhr.text.replace(/\\\//g, '/').match(IMG_RE) || [])];
const thumbs = urls.filter((u) => /_\d+x\d+\./.test(u));
const origs = urls.filter((u) => !/_\d+x\d+\./.test(u));
console.log(`  响应里的图片直链：去重 ${urls.length} 条`);
console.log(`    带 _WxH（缩略图，脚本会剔除）：${thumbs.length} 条`);
console.log(`    不含尺寸后缀（原图）：${origs.length} 条`);

/* ---- 用脚本自己的 buildEndpointIndex 处理真实响应 ---- */
console.log('\n== 把真实响应喂给脚本自己的 buildEndpointIndex ==');

const body = new El('body');
const holder = new El('div', { 'data-gallery-id': '5IUmqWloQOl' });
body.appendChild(holder);
const doc = fakeDocument(body);

let seenUrl = '';
const { EBC } = loadEbc({
  document: doc,
  gmGet: async (opts) => {
    seenUrl = opts.url;
    return { status: 200, responseText: xhr.text, responseHeaders: 'content-type: text/html' };
  },
});
const EPORNER = epornerRule(EBC);
const ep = EPORNER.resolve.find((s) => s.type === 'endpoint');

const map = await EBC.buildEndpointIndex(ep, { refDir: '', endpointIndex: null, endpointPromise: null });
console.log(`  脚本请求的 URL：${seenUrl}`);
console.log(`  与真实端点一致：${seenUrl.includes('/xhr/gallery-slide/5IUmqWloQOl') ? '✅ 是' : '❌ 否'}`);
console.log(`  建出索引条目：${map ? map.size : 0} 条`);

const bad = map ? [...map.values()].filter((u) => /_\d+x\d+\./.test(u)) : [];
const hosts = map ? [...new Set([...map.values()].map((u) => new URL(u).host))] : [];
console.log(`  索引里残留的缩略图：${bad.length} 条 ${bad.length === 0 ? '✅' : '❌'}`);
console.log(`  索引里的 CDN host：${hosts.join(', ')}`);

const keys = map ? [...map.keys()] : [];
console.log(`  索引 key 全部是纯数字 id：${keys.every((k) => /^\d+$/.test(k)) ? '✅' : '❌'}`);
console.log('  样例 3 条：');
for (const [k, v] of (map ? [...map.entries()] : []).slice(0, 3)) console.log(`    ${k} → ${v}`);

const okAll = map && map.size === origs.length && bad.length === 0 && seenUrl.includes('/xhr/gallery-slide/5IUmqWloQOl');
console.log(`\n${okAll ? '✅' : '❌'} 期望索引 ${origs.length} 条、无缩略图残留、URL 正确`);
process.exit(okAll ? 0 : 1);
