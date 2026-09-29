/**
 * 解析器回归测试 —— 用假 DOM 驱动**真实脚本**里的 resolveItem。
 *
 * 复现的事故（用户实测 + 真实站点取证，2026-09-29）：
 *   eporner 画廊页的条目全部解析成了站点分类图标
 *   https://static-*-cdn.eporner.com/catimg/N_small.jpg（102x75），
 *   Eagle 收到的 106 份字节完全相同，内容去重后只剩一张小图。
 *   根因：resolveItem 的 attr 步骤第 3 层兜底 readSelectorAttr(document, spec)
 *   返回**文档里第一个**带该属性的元素，把 item 级解析静默降级成 page 级。
 *
 * 用法：node eagle-batch-collector/tests/resolve-harness.mjs
 * 沙箱与假 DOM 来自 ./_load-script.mjs
 */
import { El, fakeDocument, loadEbc, epornerRule } from './_load-script.mjs';

const GALLERY_DIR = 'https://static-ca-cdn.eporner.com/gallery/Ol/oQ/5IUmqWloQOl/';
const CATIMG = 'https://static-ca-cdn.eporner.com/catimg/3_small.jpg';
const IDS = ['10574489', '10574490', '10574491'];
const thumbOf = (id) => `${GALLERY_DIR}${id}-${id}_296x1000.jpg`;
const origOf = (id) => `${GALLERY_DIR}${id}-gao-qiaoshou-zi-san-nude.jpg`;
const DATA_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** 造一个 eporner 画廊页骨架 */
function makePage({ iconFirst = true, itemHasDataSrc = true, iconUrl = CATIMG } = {}) {
  const body = new El('body');
  const icon = new El('img', { 'data-src': iconUrl, src: iconUrl });
  const holder = new El('div', { 'data-gallery-id': '5IUmqWloQOl' });
  if (iconFirst) {
    body.appendChild(icon);
    body.appendChild(holder);
  }
  const anchors = [];
  for (const id of IDS) {
    const a = new El('a', {
      'data-photo-id': id,
      'data-gallery-id': '5IUmqWloQOl',
      href: `https://www.eporner.com/gallery/5IUmqWloQOl/x/#gallery-photo=${id}`,
    });
    // 真实情况：未进视口时 src 是 1x1 透明 gif 占位符；
    // data-src 有时是缩略图地址，有时根本没有。
    const img = new El('img', itemHasDataSrc ? { 'data-src': thumbOf(id), src: DATA_GIF } : { src: DATA_GIF });
    a.appendChild(img);
    body.appendChild(a);
    anchors.push(a);
  }
  if (!iconFirst) {
    body.appendChild(icon);
    body.appendChild(holder);
  }
  return { body, anchors, icon };
}

/** endpoint 响应：每个 id 先给缩略图形态、再给原图形态（验证 _WxH 过滤真的生效） */
const endpointBody = () => {
  const slides = [];
  for (const id of IDS) {
    slides.push({ thumb: thumbOf(id) });
    slides.push({ src: origOf(id) });
  }
  return JSON.stringify({ gallery: '5IUmqWloQOl', slides });
};

/* ---------------- 载入真实脚本 ---------------- */
const { EBC, sandbox, requested } = loadEbc({
  gmGet: async () => ({
    status: 200,
    responseText: endpointBody(),
    responseHeaders: 'content-type: application/json',
  }),
});
const EPORNER = epornerRule(EBC);

/* ---------------- 断言 ---------------- */
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`);
  }
};

function usePage(page) {
  // 用 fakeDocument 而不是就地 Object.assign：它会真的把 body 挂成子节点，
  // 否则 querySelectorAll 遍历不到任何东西（选择器断言会假红/假绿）。
  sandbox.document = fakeDocument(page.body);
}

const freshState = () => ({ refDir: '', endpointIndex: null, endpointPromise: null });
const itemFor = (page, i, thumbOverride) => ({
  el: page.anchors[i],
  img: page.anchors[i].children[0],
  thumb:
    thumbOverride !== undefined
      ? thumbOverride
      : page.anchors[i].children[0].getAttribute('data-src') || '',
  link: '',
  externalId: IDS[i],
});

console.log('\n== 0. 规则自检 ==');
ok('endpoint 是 eporner 的第一条策略', EPORNER.resolve[0].type === 'endpoint', EPORNER.resolve.map((s) => s.type).join(' → '));
ok('attr 不再是第一条', EPORNER.resolve[0].type !== 'attr');
ok('attr 步骤没有开启 allowDocument', !EPORNER.resolve.some((s) => s.type === 'attr' && s.allowDocument === true));

console.log('\n== 1. 站点图标确实会被整页兜底选中（事故源头） ==');
{
  usePage(makePage({ itemHasDataSrc: true }));
  const got = EBC.readSelectorAttr(sandbox.document, 'img@data-src');
  ok('readSelectorAttr(document, "img@data-src") === 站点图标', got === CATIMG, got);
}

console.log('\n== 2. 同目录守卫会否掉站点图标 ==');
ok(
  'pathDir(图标) !== pathDir(缩略图)',
  EBC.pathDir(CATIMG) !== EBC.pathDir(thumbOf(IDS[0])),
  `${EBC.pathDir(CATIMG)} vs ${EBC.pathDir(thumbOf(IDS[0]))}`
);

console.log('\n== 2b. collectItems 能认出条目锚点 ==');
{
  const page = makePage({ itemHasDataSrc: true });
  usePage(page);
  // collectItems(rule) 收的是**整条规则**，内部自己读 rule.collect
  const items = EBC.collectItems(EPORNER);
  ok('收集到 3 个条目（不含站点图标）', items.length === 3, String(items.length));
  ok(
    '每个条目都带上了外部 id（来自 data-photo-id）',
    items.length === 3 && items.every((it) => !!it.externalId),
    JSON.stringify(items.map((i) => i.externalId))
  );
  ok(
    '条目 id 与锚点一致',
    JSON.stringify(items.map((i) => i.externalId)) === JSON.stringify(IDS),
    JSON.stringify(items.map((i) => i.externalId))
  );
}

console.log('\n== 3. 真实规则：条目带 data-src（缩略图） ==');
{
  const page = makePage({ itemHasDataSrc: true });
  usePage(page);
  const r = await EBC.resolveItem(itemFor(page, 0), EPORNER, freshState());
  ok('解析来源是 endpoint', r && r.via === 'endpoint', JSON.stringify(r && r.via));
  ok('拿到的是原图而不是站点图标', r && r.url === origOf(IDS[0]), r && r.url);
  ok('不是 catimg 站点图标', r && !/catimg/.test(r.url), r && r.url);
}

console.log('\n== 4. 真实规则：条目只有 1x1 占位 gif，没有 data-src ==');
{
  const page = makePage({ itemHasDataSrc: false });
  usePage(page);
  const r = await EBC.resolveItem(itemFor(page, 1), EPORNER, freshState());
  ok('解析来源是 endpoint', r && r.via === 'endpoint', JSON.stringify(r && r.via));
  ok('拿到的是原图', r && r.url === origOf(IDS[1]), r && r.url);
}

console.log('\n== 5. endpoint 索引建设：_WxH 缩略图必须被剔除 ==');
{
  usePage(makePage({ itemHasDataSrc: true }));
  const ep = EPORNER.resolve.find((s) => s.type === 'endpoint');
  const before = requested.length;
  const map = await EBC.buildEndpointIndex(ep, freshState());
  ok('索引里有 3 条', map && map.size === 3, map && String(map.size));
  ok(
    '索引值全是原图（没有 _296x1000）',
    map && ![...map.values()].some((u) => /_\d+x\d+\./.test(u)),
    map && JSON.stringify([...map.values()])
  );
  ok('id 10574489 → 原图', map && map.get('10574489') === origOf('10574489'), map && map.get('10574489'));
  ok('建索引只发了 1 次请求', requested.length - before === 1, String(requested.length - before));
}

console.log('\n== 6. 负例对照：默认禁止整页兜底（旧行为必须消失） ==');
{
  const page = makePage({ itemHasDataSrc: true });
  usePage(page);
  const rule = { id: 'neg', name: 'neg', resolve: [{ type: 'attr', selectors: ['img@data-src'] }] };
  const r = await EBC.resolveItem(itemFor(page, 0), rule, freshState());
  ok('没有返回站点图标', !(r && r.url === CATIMG), r && r.url);
  ok('没有走任何策略（via 为空）', !!r && r.via === '', JSON.stringify(r && r.via));
  // resolveItem 失败时返回 { url:'', via:'', thumb, error }，不是 null；
  // scan() 用 filter(x => x.url) 过滤，空 url 不会计入也不会推送。
  ok('url 为空（不会被推送）', !!r && r.url === '', JSON.stringify(r));
  ok('失败原因被记录', !!r && /未解析出原图/.test(r.error || ''), r && r.error);
}

console.log('\n== 7. 正例对照：显式 allowDocument + 同目录，兜底仍然可用 ==');
{
  const sameDir = `${GALLERY_DIR}shared-poster.jpg`;
  const page = makePage({ itemHasDataSrc: false, iconUrl: sameDir });
  usePage(page);
  const rule = { id: 'pos', name: 'pos', resolve: [{ type: 'attr', selectors: ['img@data-src'], allowDocument: true }] };
  // thumb 必须给出来：同目录守卫是靠「兜底结果与 thumb 同目录」才放行的
  const r = await EBC.resolveItem(itemFor(page, 0, thumbOf(IDS[0])), rule, freshState());
  ok('同目录兜底生效', r && r.url === sameDir, r && r.url);
}

console.log('\n== 8. 负例：allowDocument 开启但**不同目录**，仍必须拒绝 ==');
{
  const page = makePage({ itemHasDataSrc: false, iconUrl: CATIMG });
  usePage(page);
  const rule = { id: 'neg2', name: 'neg2', resolve: [{ type: 'attr', selectors: ['img@data-src'], allowDocument: true }] };
  const r = await EBC.resolveItem(itemFor(page, 0, thumbOf(IDS[0])), rule, freshState());
  ok('跨目录兜底被拒绝（拿到站点图标）', !!r && r.url === '', JSON.stringify(r && r.url));
}

console.log('\n== 9. 按 URL 去重（106 个条目 → 85 张照片 的那个缺口） ==');
{
  const list = [
    { url: 'a' },
    { url: 'b' },
    { url: 'a' },
    { url: 'c' },
    { url: 'b' },
  ];
  const { unique, dupes } = EBC.dedupeByUrl(list);
  ok('去重后 3 条', unique.length === 3, String(unique.length));
  ok('重复 2 条', dupes.length === 2, String(dupes.length));
  ok('保留第一次出现（顺序稳定）', unique.map((x) => x.url).join('') === 'abc', unique.map((x) => x.url).join(''));
  ok(
    '重复项被归入 dupes 而不是被丢弃',
    dupes.map((x) => x.url).join('') === 'ab',
    dupes.map((x) => x.url).join('')
  );

  // 用户实测的真实形状：106 个条目，但画廊只有 85 张照片
  const many = [];
  for (let i = 0; i < 85; i++) many.push({ url: 'u' + i });
  for (let i = 0; i < 21; i++) many.push({ url: 'u' + i });
  const r = EBC.dedupeByUrl(many);
  ok('106 个条目 → 只发 85 张', r.unique.length === 85, String(r.unique.length));
  ok('21 个重复被拦下', r.dupes.length === 21, String(r.dupes.length));

  // 全等场景（旧的自检只覆盖这一种）：去重后应只剩 1 条
  const allSame = EBC.dedupeByUrl([{ url: 'x' }, { url: 'x' }, { url: 'x' }]);
  ok('全部同址时只剩 1 条待发', allSame.unique.length === 1, String(allSame.unique.length));
}

// ============================================================
// 【订阅地址归一化】空字符串必须等于「跟随官方订阅表」
// ============================================================
// 这不是洁癖。老版本在这套 GM 存储里留下过一份 `subscriptionUrl: ''`，
// 而 `Object.assign({}, DEFAULT_SETTINGS, stored)` 会让存下来的旧值盖掉新默认值 ——
// 结果是「脚本升级了，却永远收不到规则更新」，而且这个失败**完全静默**。
// 而「改规则不用重装脚本」正是这个项目对外的核心承诺，所以它必须有断言看着。
{
  const OFFICIAL = EBC.DEFAULT_SETTINGS.subscriptionUrl;
  if (!OFFICIAL) throw new Error('DEFAULT_SETTINGS.subscriptionUrl 是空的 —— 归一化就没有意义了');

  const saved = EBC.settings.subscriptionUrl;
  const t = (label, input, expect) => {
    EBC.settings.subscriptionUrl = input;
    let got;
    try {
      got = EBC.subscriptionUrlOf();
    } catch (e) {
      got = 'throw: ' + e.message;
    }
    ok(label, got === expect, `期望 ${JSON.stringify(expect)}，实得 ${JSON.stringify(got)}`);
  };

  t('空字符串 → 回落到官方订阅表（老存储的关键修复）', '', OFFICIAL);
  t('null 同样回落', null, OFFICIAL);
  t('undefined 同样回落', undefined, OFFICIAL);
  t('纯空白也回落', '   ', OFFICIAL);
  t('自定义地址原样生效', 'https://example.com/my.json', 'https://example.com/my.json');
  t('两侧空白被裁掉', '  https://example.com/a.json  ', 'https://example.com/a.json');
  t('none → 明确关闭（返回空串，不再联网）', 'none', '');
  t('off → 明确关闭', 'off', '');
  t('NONE 大小写不敏感', 'NONE', '');
  t('地址里含 none 字样不会被误判成关闭', 'https://example.com/none.json', 'https://example.com/none.json');

  EBC.settings.subscriptionUrl = saved;
}

// ============================================================
// 【素材名】送进 Eagle 的 name 必须有信息量
// ============================================================
// 用户反馈：「发送到 eagle 之后，文件名都是同样的 MUMT12OZPMAVP，完全没有任何意义」。
// 实测 `POST /api/v2/item/add` 是认 name 的（传 'xxx' 读回来就是 'xxx'），所以这是
// 纯客户端问题 —— 脚本一直传空字符串，Eagle 就退化成拿素材 id 当名字。
{
  const savedTpl = EBC.settings.nameTemplate;
  const savedTitle = sandbox.document.title;
  const SLUG = '10574489-gao-qiaoshou-zi-san-nude';
  const PAGE = 'Shoko Takahashi ... - Eporner';

  ok('eporner 原图 URL 取出拼音 slug（这才是能在库里搜到的词）',
    EBC.baseNameOfUrl(origOf(IDS[0])) === SLUG, EBC.baseNameOfUrl(origOf(IDS[0])));
  ok('缩略图的 basename 是 id+尺寸 —— 所以名字必须从**原图**地址取，不能从缩略图取',
    EBC.baseNameOfUrl(thumbOf(IDS[0])) === '10574489-10574489_296x1000',
    EBC.baseNameOfUrl(thumbOf(IDS[0])));
  ok('query / hash 不影响 basename',
    EBC.baseNameOfUrl(origOf(IDS[0]) + '?v=2#x') === SLUG, EBC.baseNameOfUrl(origOf(IDS[0]) + '?v=2#x'));
  ok('URL 编码的 basename 会被解码',
    EBC.baseNameOfUrl('https://x.test/a/%E4%B8%AD%E6%96%87.jpg') === '中文',
    EBC.baseNameOfUrl('https://x.test/a/%E4%B8%AD%E6%96%87.jpg'));

  // isWeakBase 真值表：命中的名字进库等于没名字，必须换来源
  ok('纯哈希算弱名（Pinterest 就是 originals/ab/cd/ab12…）', EBC.isWeakBase('abcdef0123456789') === true);
  ok('纯数字算弱名', EBC.isWeakBase('10574489') === true);
  ok('image / photo 这类通用名算弱名', EBC.isWeakBase('image') === true && EBC.isWeakBase('photo') === true);
  ok('太短算弱名', EBC.isWeakBase('a1') === true);
  ok('一个字母都没有算弱名', EBC.isWeakBase('123-456') === true);
  ok('人写的 slug 不算弱名', EBC.isWeakBase(SLUG) === false);
  ok('中文文件名不算弱名', EBC.isWeakBase('风景照片') === false);

  // sanitizeName：素材名会进 UI 和搜索，也可能被导出成文件名
  ok('斜杠/冒号/星号被清掉', EBC.sanitizeName('a/b:c*d?e') === 'a b c d e', EBC.sanitizeName('a/b:c*d?e'));
  ok('控制字符被清掉', EBC.sanitizeName('a\u0000b\nc') === 'a b c', EBC.sanitizeName('a\u0000b\nc'));
  ok('首尾的点和空格被裁掉', EBC.sanitizeName('  ..a..  ') === 'a', EBC.sanitizeName('  ..a..  '));
  ok('超长名被截断（不会塞爆 Eagle 的字段）', EBC.sanitizeName('x'.repeat(500)).length <= 120);

  // 默认模板 = {basename}，正是用户想要的「原图文件名」
  EBC.settings.nameTemplate = '{basename}';
  sandbox.document.title = PAGE;
  ok('默认模板取到原图 slug',
    EBC.buildItemName({ alt: '' }, origOf(IDS[0]), 0) === SLUG,
    EBC.buildItemName({ alt: '' }, origOf(IDS[0]), 0));

  // ★ 核心 1：弱名必须兜底
  const PIN_HASH = 'https://i.pinimg.com/originals/ab/cd/ef/abcdef0123456789abcdef0123456789.jpg';
  const pinName = EBC.buildItemName({ alt: '' }, PIN_HASH, 2);
  ok('Pinterest 的哈希 basename 触发兜底（名字里不再只剩那串哈希）',
    pinName.indexOf('abcdef0123456789') < 0, pinName);
  ok('兜底改用页面标题', pinName.indexOf('Shoko Takahashi') === 0, pinName);
  ok('兜底带序号（{n} 从 1 开始，index 2 → 03）', /-03$/.test(pinName), pinName);
  ok('同一页的相邻条目名字互不相同',
    EBC.buildItemName({}, PIN_HASH, 0) !== EBC.buildItemName({}, PIN_HASH, 1));

  // ★ 核心 2：永不返回空串。空串 = Eagle 拿素材 id 命名 = 用户看到的那串乱码。
  ok('URL 完全拿不到时也不返回空串',
    EBC.buildItemName({}, '', 0).length > 0, JSON.stringify(EBC.buildItemName({}, '', 0)));
  sandbox.document.title = '';
  const altName = EBC.buildItemName({ alt: 'Sunset over the bay' }, PIN_HASH, 0);
  ok('页面标题也没有时用图片说明兜底', altName.indexOf('Sunset over the bay') === 0, altName);
  sandbox.document.title = PAGE;

  // 模板可自定义
  EBC.settings.nameTemplate = '{page}-{n}';
  ok('自定义模板 {page}-{n} 生效（index 4 → 05）',
    EBC.buildItemName({}, origOf(IDS[0]), 4) === PAGE + '-05',
    EBC.buildItemName({}, origOf(IDS[0]), 4));

  // 用户把模板设成空 → 回落默认，仍然不允许出现空名
  EBC.settings.nameTemplate = '';
  ok('模板留空时回落 {basename}',
    EBC.buildItemName({}, origOf(IDS[0]), 0) === SLUG,
    EBC.buildItemName({}, origOf(IDS[0]), 0));

  // ★ 核心 3：真正被抓进 item 的 alt 也要能被用到（collectItems 必须采集它）
  {
    const page = makePage({ itemHasDataSrc: true });
    page.anchors[0].children[0].setAttribute('alt', 'Photos of Shoko');
    usePage(page);
    const items = EBC.collectItems(EPORNER);
    ok('collectItems 采集了 img 的 alt（否者 alt 兜底永远是空的）',
      items.length > 0 && items[0].alt === 'Photos of Shoko',
      JSON.stringify(items[0] && items[0].alt));
  }

  EBC.settings.nameTemplate = savedTpl;
  sandbox.document.title = savedTitle;
}

console.log(`\n${failed ? '❌' : '✅'} ${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exit(failed ? 1 : 0);
