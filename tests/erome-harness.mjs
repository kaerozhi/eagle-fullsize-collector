/**
 * Erome 回归 —— 「三无好站」的最简规则 + 登记表稳定键（pushedKeyRe）。
 *
 * 真实站点形状（2026-10-28 实测，/a/G1AFDTsm 共 83 张）：
 *   每张图两个 img（img-front / img-back 悬停切换），src 相同；
 *   无外层 <a>、无分页、无防盗链；src 就是站方最大图（灯箱 data-src 同款）；
 *   URL = s<N>.erome.com/<目录号>/<相册id>/<图片id>.jpeg?v=<ts>，目录号会变。
 */
import assert from 'node:assert/strict';
import { El, fakeDocument, loadEbc } from './_load-script.mjs';

const ORIGIN = 'https://www.erome.com';
const ALBUM = 'G1AFDTsm';
const albumUrl = () => `${ORIGIN}/a/${ALBUM}`;
const imgUrl = (dir, id) => `https://s${4 + (id.charCodeAt(0) % 2)}.erome.com/${dir}/${ALBUM}/${id}.jpeg?v=17903${1000 + id.length}`;

const IDS = ['CIULRTqP', 't0oyW2v3', 'MN4LU7Eu'];

function makeAlbum() {
  const body = new El('body');
  const album = new El('div', { id: `album_${ALBUM}`, class: 'col-sm-12 page-content' });
  for (const id of IDS) {
    const group = new El('div', { class: 'media-group' });
    const imgWrap = new El('div', { class: 'img', 'data-src': imgUrl(1141, id) });
    imgWrap.appendChild(new El('img', { class: 'img-front', src: imgUrl(1141, id), width: '700', height: '700', alt: `qinweiyingjie #${id}` }));
    const blur = new El('div', { class: 'img-blur' });
    blur.appendChild(new El('img', { class: 'img-back', src: imgUrl(1141, id), width: '700', height: '700', alt: `qinweiyingjie #${id}` }));
    imgWrap.appendChild(blur);
    group.appendChild(imgWrap);
    album.appendChild(group);
  }
  body.appendChild(album);
  // 噪音：logo、头像、背景图
  body.appendChild(new El('img', { src: '/img/logo-erome-horizontal.png?v=4' }));
  body.appendChild(new El('img', { src: 'https://avatar.erome.com/a/b/c.jpg' }));
  return fakeDocument(body);
}

const { EBC } = loadEbc({
  document: makeAlbum(),
  location: { href: albumUrl(), hostname: 'www.erome.com', origin: ORIGIN, pathname: `/a/${ALBUM}` },
});
const rule = EBC.BUILTIN_RULES.find((r) => r.id === 'erome');
assert.ok(rule, '内置规则里必须有 erome');

let pass = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); process.exitCode = 1; throw new Error(name); }
};

console.log('\n== A. 采集：img-front 命中，img-back 与噪音不算 ==');
{
  const items = EBC.collectItems(rule);
  ok(`正好 ${IDS.length} 个条目（每图 2 个 img + 3 个噪音）`, items.length === IDS.length, String(items.length));
  ok('thumb 是 s<N>.erome.com 的内容图', items.every((it) => /^https:\/\/s\d\.erome\.com\/\d+\//.test(it.thumb)));
  ok('没有外层 <a>（link 为空，erome 本来就不给链接）', items.every((it) => !it.link));
  ok('itemKey 落在 thumb 路径上（全局唯一）', new Set(items.map((it) => EBC.itemKey(it))).size === IDS.length);
  const keys = items.map((it) => EBC.itemKey(it));
  ok('key 里带图片 id（防串图）', IDS.every((id) => keys.some((k) => k.includes(id))), JSON.stringify(keys));
}

console.log('\n== B. resolve：src 本身就是最大图，attr 直通 ==');
{
  // 用采集出来的真实条目（带 el/img 节点）—— attr 从条目自身的 img 读 src
  const items = EBC.collectItems(rule);
  const item = items.find((x) => x.thumb.includes(IDS[0]));
  const r = await EBC.resolveItem(item, rule, {});
  ok('返回的就是页面 src（站方最大图）', r.url === item.thumb, r.url);
  ok('via 以 attr 开头（记录命中的选择器）', /^attr/.test(r.via), r.via);
  ok('不是 /thumbs/ 小图（那是 250×250）', !/\/thumbs\//.test(r.url));
  ok('三条都能各自解析成自己的 src', (await Promise.all(items.map((x) => EBC.resolveItem(x, rule, {})))).every((r2, i) => r2.url === items[i].thumb));
}

console.log('\n== C. 登记表稳定键：目录号变了也要认得出同一张图 ==');
{
  // 站点自己警告 "Urls can change at any time"：目录号 1141 换成 9999、?v= 换新
  const oldUrl = imgUrl(1141, IDS[0]);
  const movedUrl = imgUrl(9999, IDS[0]).replace('?v=1790310011', '?v=9999999999');
  const kOld = EBC.pushedKeyOf(oldUrl, rule.pushedKeyRe);
  const kNew = EBC.pushedKeyOf(movedUrl, rule.pushedKeyRe);
  ok('pushedKeyRe 抽出 <相册id>/<图id>', kOld === `${ALBUM}/${IDS[0]}.jpeg`, kOld);
  ok('目录号变了，键不变（跨目录识别同一张图）', kNew === kOld, `${kOld} vs ${kNew}`);
  const kOther = EBC.pushedKeyOf(imgUrl(1141, IDS[1]), rule.pushedKeyRe);
  ok('不同图片的键不同', kOther !== kOld, kOther);
  const { fresh, skipped } = EBC.filterAlreadyPushed(
    [{ url: oldUrl, status: '就绪' }, { url: movedUrl, status: '就绪' }, { url: imgUrl(1141, IDS[1]), status: '就绪' }],
    new Set([kOld]),
    rule.pushedKeyRe
  );
  ok('登记过的（新旧目录号）都被剔掉', skipped.length === 2, JSON.stringify(skipped.map((x) => x.url)));
  ok('没登记过的保留', fresh.length === 1 && fresh[0].url === imgUrl(1141, IDS[1]));
  ok('不带 pushedKeyRe 时按整条路径（其他站的默认行为不变）',
    EBC.pushedKeyOf(oldUrl) === new URL(oldUrl).pathname);
}

console.log('\n== D. 规则本身：范围与形态 ==');
{
  ok('命中相册页', EBC.findRuleFor(albumUrl()) === rule);
  ok('命中带 slug 的相册页', EBC.findRuleFor(`${ORIGIN}/a/${ALBUM}/?page=2`) === rule);
  ok('不误伤用户页', EBC.findRuleFor(`${ORIGIN}/users/qinweiyingjie`) === null);
  ok('不误伤主站首页', EBC.findRuleFor(`${ORIGIN}/`) === null);
  ok('resolve 只有 attr 一条（无 detail/rewrite/endpoint）',
    rule.resolve.length === 1 && rule.resolve[0].type === 'attr');
  ok('attr 带 allowSameThumb（src 本身就是原图）', rule.resolve[0].allowSameThumb === true);
  ok('collect.item 只收 img-front', rule.collect.item === 'img.img-front');
  ok('登记表键正则是对的', rule.pushedKeyRe === '/\\d+\\/([^/]+\\/[^/?]+)$');
}

console.log(`\n${process.exitCode ? '❌ 有失败' : '✅ 全部通过'}（${pass} 项）\n`);
