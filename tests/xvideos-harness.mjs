/**
 * XVideos 相册回归 —— link 步骤（条目 href 本身就是原图直链）。
 *
 * 真实站点形状（2026-10-28 实测，/profiles/…/photos/6240033/ 共 39 张）：
 *   <div class="thumb-block" id="galpic-1">
 *     <a class="embed-responsive-item" href="…/<uuid>/0/full.jpg?secure=<A>" target="_blank">
 *       <picture><img class="gallery-picture" src="…/<uuid>/0/thumb.jpg?secure=<B>"></picture>
 *     </a>
 *   </div>
 *   full.jpg = 750×1000 / 99779B（thumb 270×360 / 18514B）；secure 按完整路径签，
 *   thumb→full 改写 403 —— 但连 detail 都不用：条目 href 就是原图。
 */
import assert from 'node:assert/strict';
import { El, fakeDocument, loadEbc } from './_load-script.mjs';

const ORIGIN = 'https://www.xvideos.com';
const albumUrl = () => `${ORIGIN}/profiles/qin_wei_ying_jie/photos/6240033/_2020_`;

const ITEMS = [
  { uuid: '015299e1-0c35-4756-9262-e865cb942d33', cdn: 'gallery-cdn77' },
  { uuid: '6ac483d1-47fb-49e0-8213-e74d67a48265', cdn: 'gallery-cdn77' },
  { uuid: '9db7c0aa-1122-4e5f-88aa-9a1b2c3d4e5f', cdn: 'gallery-gcore' },
];
const thumbUrl = (it) => `https://${it.cdn}.xvideos-cdn.com/${it.uuid}/0/thumb.jpg?secure=T_${it.uuid.slice(0, 8)}`;
const fullUrl = (it) => `https://${it.cdn}.xvideos-cdn.com/${it.uuid}/0/full.jpg?secure=F_${it.uuid.slice(0, 8)}`;

function makeAlbum() {
  const body = new El('body');
  const moz = new El('div', { class: 'thumb-mozaique mozaique profileslist thumbs-5-cols' });
  ITEMS.forEach((it, i) => {
    const block = new El('div', { class: 'thumb-block img-block no-rotate', id: `galpic-${i + 1}` });
    const inside = new El('div', { class: 'thumb-inside' });
    const thumb = new El('div', { class: 'thumb embed-responsive embed-responsive-4by3' });
    const a = new El('a', { class: 'embed-responsive-item', href: fullUrl(it), target: '_blank', 'data-lg-item': '1' });
    const picture = new El('picture');
    picture.appendChild(new El('img', { class: 'gallery-picture', src: thumbUrl(it) }));
    a.appendChild(picture);
    thumb.appendChild(a);
    inside.appendChild(thumb);
    block.appendChild(inside);
    moz.appendChild(block);
  });
  body.appendChild(moz);
  return fakeDocument(body);
}

const { EBC } = loadEbc({
  document: makeAlbum(),
  location: { href: albumUrl(), hostname: 'www.xvideos.com', origin: ORIGIN, pathname: '/profiles/qin_wei_ying_jie/photos/6240033/_2020_' },
});
const rule = EBC.BUILTIN_RULES.find((r) => r.id === 'xvideos');
assert.ok(rule, '内置规则里必须有 xvideos');

let pass = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); process.exitCode = 1; throw new Error(name); }
};

console.log('\n== A. 采集：条目是 <a>，link 直接是原图，thumb 是内层 img ==');
{
  const items = EBC.collectItems(rule);
  ok(`正好 ${ITEMS.length} 个条目`, items.length === ITEMS.length, String(items.length));
  ok('link = <a href> 的 full.jpg（带自己的签名）', items.every((it) => /\/0\/full\.jpg\?secure=/.test(it.link)));
  ok('thumb = 内层 img 的 thumb.jpg', items.every((it) => /\/0\/thumb\.jpg\?secure=/.test(it.thumb)));
  ok('link 与 thumb 是不同地址（full ≠ thumb）', items.every((it) => it.link !== it.thumb));
  ok('itemKey 唯一（uuid 全局唯一）', new Set(items.map((it) => EBC.itemKey(it))).size === ITEMS.length);
  ok('双 CDN 主机保持原样（cdn77 与 gcore 混用）',
    items.some((it) => /gallery-cdn77/.test(it.link)) && items.some((it) => /gallery-gcore/.test(it.link)));
}

console.log('\n== B. resolve：link 步骤零请求直通原图 ==');
{
  const state = {};
  for (let i = 0; i < ITEMS.length; i++) {
    const items = EBC.collectItems(rule);
    const r = await EBC.resolveItem(items[i], rule, state);
    ok(`第 ${i + 1} 条解析成它自己的 full.jpg`, r.url === fullUrl(ITEMS[i]), r.url);
    ok(`第 ${i + 1} 条 via=link`, r.via === 'link', r.via);
    ok(`第 ${i + 1} 条不是缩略图`, r.url !== thumbUrl(ITEMS[i]) && /full\.jpg/.test(r.url));
  }
}

console.log('\n== C. link 步骤的守卫 ==');
{
  // href === thumb（有的站把缩略图也塞 href 里）→ 默认拒绝，allowSameThumb 放开
  const same = { link: thumbUrl(ITEMS[0]), thumb: thumbUrl(ITEMS[0]), baseUrl: albumUrl() };
  const no = await EBC.resolveItem(same, { resolve: [{ type: 'link' }] }, {});
  ok('href 与 thumb 相同 → 默认拒绝（防把缩略图当原图推）', !no.url && no.error, JSON.stringify(no));
  const yes = await EBC.resolveItem(same, { resolve: [{ type: 'link', allowSameThumb: true }] }, {});
  ok('allowSameThumb: true 时放开（src 本身就是原图的站用）', yes.url === thumbUrl(ITEMS[0]), yes.url);
  // href 不是 http（空、相对、js:）
  const bad = await EBC.resolveItem({ link: 'javascript:void(0)', thumb: '', baseUrl: albumUrl() }, { resolve: [{ type: 'link' }] }, {});
  ok('非 http 的 link 拒绝', !bad.url, JSON.stringify(bad));
  const empty = await EBC.resolveItem({ link: '', thumb: '', baseUrl: albumUrl() }, { resolve: [{ type: 'link' }] }, {});
  ok('空 link 拒绝', !empty.url, JSON.stringify(empty));
}

console.log('\n== D. 规则本身：范围与形态 ==');
{
  ok('命中相册页', EBC.findRuleFor(albumUrl()) === rule);
  ok('命中带尾斜杠/查询的相册页', EBC.findRuleFor(albumUrl() + '/') === rule);
  ok('不误伤视频页', EBC.findRuleFor(`${ORIGIN}/video.12345/some_video`) === null);
  ok('不误伤资料页（无 photos 段）', EBC.findRuleFor(`${ORIGIN}/profiles/qin_wei_ying_jie/`) === null);
  ok('resolve 只有 link 一条', rule.resolve.length === 1 && rule.resolve[0].type === 'link');
  ok('collect.item 认 full.jpg 的锚点', rule.collect.item === "a[href*='/full.jpg']");
  ok('link: self（条目自身是 <a>）', rule.collect.link === 'self');
  ok('全路径稳定 → 不需要 pushedKeyRe（登记表按整条路径）', rule.pushedKeyRe === undefined);
}

console.log(`\n${process.exitCode ? '❌ 有失败' : '✅ 全部通过'}（${pass} 项）\n`);
