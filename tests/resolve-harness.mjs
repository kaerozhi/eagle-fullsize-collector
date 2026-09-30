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
import { El, fakeDocument, loadEbc, epornerRule, pornpicsRule, kittyKatsRule } from './_load-script.mjs';

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

// ============================================================
// 【pornpics】rewrite 必须重建出页面自己写着的 href
// ============================================================
// 真实画廊页的每一条：
//   <a class='rel-link' href='…/1280/…_002_f6a3.jpg' data-tid="002">
//     <img src='…/static.pornpics.com/style/img/1px.png'
//          data-src='…/460/…_002_f6a3.jpg'>
//   </a>
// 线上把每条 data-src 的 460 改写成 1280 后，与**同一锚点自身的 href** 比对是 20/20。
// 所以规则不是在猜原图地址，而是在重建页面已经写着的地址。
{
  const PP = pornpicsRule(EBC);
  const GAL = '7/658/25875390';
  const NUMS = ['002', '005', '011'];
  const PX = 'https://static.pornpics.com/style/img/1px.png';
  const ppThumb = (n) => `https://cdni.pornpics.com/460/${GAL}/25875390_${n}_f6a3.jpg`;
  const ppOrig = (n) => `https://cdni.pornpics.com/1280/${GAL}/25875390_${n}_f6a3.jpg`;

  const makePp = ({ withDataSrc = true } = {}) => {
    const body = new El('body');
    const anchors = [];
    for (const n of NUMS) {
      const a = new El('a', { class: 'rel-link', href: ppOrig(n), 'data-tid': n });
      const imgAttrs = { src: PX, alt: 'Emma White' };
      if (withDataSrc) imgAttrs['data-src'] = ppThumb(n);
      const img = new El('img', imgAttrs);
      a.appendChild(img);
      body.appendChild(a);
      anchors.push(a);
    }
    return { body, anchors };
  };

  const ppItem = (page, i) => ({
    el: page.anchors[i],
    img: page.anchors[i].children[0],
    thumb: page.anchors[i].children[0].getAttribute('data-src') || '',
    link: page.anchors[i].href,
    externalId: '',
  });

  console.log('\n== 13. pornpics：选择器与缩略图来源 ==');
  {
    const page = makePp();
    usePage(page);
    const items = EBC.collectItems(PP);
    ok('a.rel-link, a[data-tid] 这个选择器组能选中 3 条', items.length === 3, String(items.length));
    ok(
      'thumb 取的是 data-src 的 460 图，不是 1px 占位图',
      items.length === 3 && items.every((it, i) => it.thumb === ppThumb(NUMS[i])),
      JSON.stringify(items.map((it) => it.thumb))
    );
    ok(
      '没有采集 externalId（规则里故意不写 idAttr）',
      items.every((it) => !it.externalId),
      JSON.stringify(items.map((it) => it.externalId))
    );
  }

  console.log('\n== 14. pornpics：rewrite 重建出页面自己的 href ==');
  {
    const page = makePp();
    usePage(page);
    const all = [];
    for (let i = 0; i < NUMS.length; i++) {
      const r = await EBC.resolveItem(ppItem(page, i), PP, freshState());
      ok(`第 ${i + 1} 条解析来源是 rewrite`, r && r.via === 'rewrite', JSON.stringify(r && r.via));
      ok(`第 ${i + 1} 条结果 === 锚点自己的 href`, r && r.url === page.anchors[i].href, r && r.url);
      ok(`第 ${i + 1} 条不再带 460 段`, r && !/\/460\//.test(r.url), r && r.url);
      if (r) all.push(r.url);
    }
    ok('3 条互不相同（不会塌缩成同一张）', new Set(all).size === 3, JSON.stringify(all));
  }

  console.log('\n== 15. pornpics：负例 —— 为什么规则里绝对不能有 attr 步骤 ==');
  {
    const page = makePp();
    usePage(page);
    const TRAP = { ...PP, resolve: [{ type: 'attr', selectors: ['img@src'] }] };
    const r = await EBC.resolveItem(ppItem(page, 0), TRAP, freshState());
    ok('attr:img@src 确实会把 1x1 占位图当成原图返回', r && r.url === PX, r && r.url);
    ok(
      '而且它和缩略图不同，能通过 got !== thumb 守卫 —— 这就是事故成因',
      r && r.url !== page.anchors[0].children[0].getAttribute('data-src')
    );
    const good = await EBC.resolveItem(ppItem(page, 0), PP, freshState());
    ok('真实规则在同一条目上给出 /1280/', good && good.url === ppOrig(NUMS[0]), good && good.url);
  }

  console.log('\n== 16. pornpics：多画廊页面不能塌缩（idAttr 陷阱的反证） ==');
  {
    // 两个画廊各自都有 002。规则若写了 idAttr: self@data-tid，itemKey 会让
    // externalId 优先，两条 002 就会被当成同一条。
    const body = new El('body');
    const mk = (gal, n) => {
      const a = new El('a', {
        class: 'rel-link',
        href: `https://cdni.pornpics.com/1280/${gal}/x_${n}_aa.jpg`,
        'data-tid': n,
      });
      a.appendChild(
        new El('img', { src: PX, 'data-src': `https://cdni.pornpics.com/460/${gal}/x_${n}_aa.jpg` })
      );
      body.appendChild(a);
    };
    mk('7/658/25875390', '002');
    mk('7/658/99999999', '002');
    usePage({ body });
    const items = EBC.collectItems(PP);
    const keys = items.map((it) => EBC.itemKey(it));
    ok('两个画登记 2 条', items.length === 2, String(items.length));
    ok('两条的 itemKey 不相同（去重落在锚点 href 上）', new Set(keys).size === 2, JSON.stringify(keys));
    ok('itemKey 用的是 link: 前缀而不是 id:', keys.every((k) => k.startsWith('link:')), JSON.stringify(keys));
  }
}

// ============================================================
// 【kitty-kats】pixhost 图床：thumb → 原图只能靠 rewrite，绝不能碰 probe
// ============================================================
// 真实帖子（用户从浏览器导出）里的每一条：
//   <a href='https://pixhost.cc/show/9569/<id>_<name>.jpg'>
//     <img class='bbImage' src='https://t2.pixhost.cc/thumbs/9569/<id>_<name>.jpg'
//          data-url='…同一个缩略图地址'>
//   </a>
// show 页里的真身是 https://img2.pixhost.cc/images/9569/<id>_<name>.jpg（2811x4000），
// 而缩略图是 210x300。
// ★★ 主机号写错**不会 404**：img1 / img3 / img4 与 t1 / t3 全部返回 200 + image/png，
//    而且都是同一个 16138 字节、257x126 的占位图（多个地址 sha 去重后只剩一个）。
//    占位图能正常 onload，所以 probe 若用 Image() 判成功，在此站**必然误判成功**，
//    把整页推成一堆一模一样的占位图，日志还报「N/N 张拿到原图」。
//    → 本规则只有 rewrite 一条策略，下面 19 用结构性断言把这条钉死。
{
  const KK = kittyKatsRule(EBC);
  const SHOW = (id, name) => `https://pixhost.cc/show/9569/${id}_${name}.jpg`;
  const THUMB2 = (id, name) => `https://t2.pixhost.cc/thumbs/9569/${id}_${name}.jpg`;
  const FULL2 = (id, name) => `https://img2.pixhost.cc/images/9569/${id}_${name}.jpg`;
  const SAMPLES = [
    ['751781467', '_ra-petalsvol54-cover'],
    ['751781468', '_ra-petalsvol54-cover-clean'],
    ['751781495', '_ra_petalsvol54_domini_high_0001'],
  ];

  const makeKK = () => {
    const body = new El('body');
    // 头像也有「外层 a + img」，必须被排除
    const av = new El('a', { href: '/members/xericx.10184915/' });
    av.appendChild(
      new El('img', { src: '/data/avatars/m/10184/10184915.jpg?1671694632', class: 'avatar-u10184915-m' })
    );
    body.appendChild(av);
    const anchors = [];
    for (const [id, name] of SAMPLES) {
      const a = new El('a', { href: SHOW(id, name) });
      a.appendChild(
        new El('img', { class: 'bbImage', src: THUMB2(id, name), 'data-url': THUMB2(id, name), alt: '' })
      );
      body.appendChild(a);
      anchors.push(a);
    }
    return { body, anchors };
  };

  const kkItem = (page, i) => ({
    el: page.anchors[i],
    img: page.anchors[i].children[0],
    thumb: page.anchors[i].children[0].getAttribute('src') || '',
    link: page.anchors[i].href,
    externalId: '',
  });

  // 只关心 thumb 的最小条目（给「主机号不写死」那几条用）
  const bare = (thumb) => ({ el: null, img: new El('img', {}), thumb, link: '', externalId: '' });

  console.log('\n== 17. kitty-kats：collect 收的是 a[href] > img（连头像一起），噪音留给 resolve 滤 ==');
  {
    const page = makeKK();
    usePage(page);
    const items = EBC.collectItems(KK);
    // v0.5 起 collect 故意放宽成 a[href] > img —— 实测同一个论坛里用户混用多家
    // 图床（另一个帖子 117 张全是 imagetwist），再按图床名筛就漏了。
    // 代价是把头像这种「外层 a + img」也收进来，噪音由 detail 的 externalOnly
    // 在 resolve 阶段挡掉（头像的 a 指向 /members/…，是站内链接）—— 见 19。
    ok('收到 4 条（3 张帖子图 + 1 个头像）', items.length === 4, String(items.length));
    const posts = items.filter((it) => /pixhost\.cc\/show\//.test(it.link || ''));
    ok(
      '其中 3 条是帖子图，thumb 取的是 t2 的 thumbs 图（页面没有 data-src 系列，落在 src 上）',
      posts.length === 3 && posts.every((it, i) => it.thumb === THUMB2(...SAMPLES[i])),
      JSON.stringify(posts.map((it) => it.thumb))
    );
    ok(
      'link 是 pixhost 的 show 页（不是图片直链，用来去重）',
      posts.length === 3 && posts.every((it, i) => it.link === SHOW(...SAMPLES[i])),
      JSON.stringify(posts.map((it) => it.link))
    );
    ok('3 条 itemKey 互不相同', new Set(posts.map((it) => EBC.itemKey(it))).size === 3);
    const av = items.find((it) => /\/members\//.test(it.link || ''));
    ok(
      '头像那条的 link 是站内链接 —— detail 的 externalOnly 会据此跳过它',
      !!av && av.link === '/members/xericx.10184915/',
      av && av.link
    );
  }

  console.log('\n== 18. kitty-kats：host 策略查图床表，pixhost / imagetwist 都改写成原图 ==');
  {
    const page = makeKK();
    usePage(page);
    const all = [];
    for (let i = 0; i < SAMPLES.length; i++) {
      const r = await EBC.resolveItem(kkItem(page, i), KK, freshState());
      ok(`第 ${i + 1} 条来源是 host:pixhost`, r && r.via === 'host:pixhost', JSON.stringify(r && r.via));
      ok(`第 ${i + 1} 条 === show 页里的 img2 地址`, r && r.url === FULL2(...SAMPLES[i]), r && r.url);
      ok(`第 ${i + 1} 条不再带 thumbs 段`, r && !/\/thumbs\//.test(r.url), r && r.url);
      if (r) all.push(r.url);
    }
    ok('3 条互不相同（不会塌缩成同一张）', new Set(all).size === 3, JSON.stringify(all));

    const r9 = await EBC.resolveItem(bare('https://t9.pixhost.cc/thumbs/9569/x_1.jpg'), KK, freshState());
    ok(
      't9 → img9：主机号是捕获组，不是写死的 img2',
      r9 && r9.url === 'https://img9.pixhost.cc/images/9569/x_1.jpg',
      r9 && r9.url
    );

    const rto = await EBC.resolveItem(bare('https://t3.pixhost.to/thumbs/9569/y_2.jpg'), KK, freshState());
    ok(
      'pixhost.to 域名整体保留（tld 也是捕获组）',
      rto && rto.url === 'https://img3.pixhost.to/images/9569/y_2.jpg',
      rto && rto.url
    );

    // ---- imagetwist：用户给的 kitty-kats 帖子 117 张全是它 ----
    const itw = await EBC.resolveItem(
      bare('https://img69.imagetwist.com/th/71393/jsgmyvo51tmd.jpg'),
      KK,
      freshState()
    );
    ok(
      'imagetwist：/th/ → /i/，主机 img69 原样保留',
      itw && itw.url === 'https://img69.imagetwist.com/i/71393/jsgmyvo51tmd.jpg',
      itw && itw.url
    );
    const itwS = await EBC.resolveItem(
      bare('https://s10.imagetwist.com/th/71393/jpgx4n11m5n1.jpg'),
      KK,
      freshState()
    );
    ok(
      's<N> 形态也保留（s10 → s10，绝不能猜成 img10 —— 实测 s10 上确实有它的原图）',
      itwS && itwS.url === 'https://s10.imagetwist.com/i/71393/jpgx4n11m5n1.jpg',
      itwS && itwS.url
    );
    const itw202 = await EBC.resolveItem(
      bare('https://img202.imagetwist.com/th/71393/5isyrqx9svfh.jpg'),
      KK,
      freshState()
    );
    ok(
      '三位数主机号也原样保留（img202 → img202）',
      itw202 && itw202.url === 'https://img202.imagetwist.com/i/71393/5isyrqx9svfh.jpg',
      itw202 && itw202.url
    );
    const done = await EBC.resolveItem(bare('https://img69.imagetwist.com/i/71393/x.jpg'), KK, freshState());
    ok(
      '已经是 /i/ 的地址不会再被改一次（没有 /th/ 段就不匹配）',
      !done.url || done.url === 'https://img69.imagetwist.com/i/71393/x.jpg',
      JSON.stringify(done.url)
    );

    const rnon = await EBC.resolveItem(bare('https://example.com/thumbs/9569/z.jpg'), KK, freshState());
    ok(
      '图床表里没有的域名不会被误改（改写只认表，不猜）',
      rnon && !/pixhost|imagetwist/.test(rnon.url || ''),
      JSON.stringify(rnon.url)
    );
  }

  console.log('\n== 19. kitty-kats：占位图陷阱 + 只抓外链 ==');
  {
    const types = KK.resolve.map((s) => s.type);
    ok('策略是 host → detail 两条', types.join(' → ') === 'host → detail', JSON.stringify(types));
    ok(
      '没有 probe 步骤（占位图能正常 onload，probe 在此站必然误判成功）',
      !types.includes('probe')
    );
    ok(
      '没有 attr 步骤（img 的 src / data-url 都是缩略图，读出来还是缩略图）',
      !types.includes('attr')
    );

    const detail = KK.resolve.find((s) => s.type === 'detail');
    ok('detail 开了 externalOnly（头像/引用全是站内链接，必须跳过）', detail.externalOnly === true);
    ok(
      'detail 的候选里同时有 imagetwist 的 img.pic 与 pixhost 的 img#image',
      detail.selectors.includes('img.pic@src') && detail.selectors.includes('img#image@src')
    );
    ok(
      '规则不再自带 referer（实测 imagetwist / pixhost 的分享页都不挑 Referer）',
      KK.referer === undefined,
      String(KK.referer)
    );

    // 说明：probeImage 只看 Image 的 onload，而「占位图 onload 成功」这件事需要一张
    // 真实网络响应才能复现；沙箱里的 Image 是空壳（既不 onload 也不 onerror），
    // 所以这里用结构性断言钉死不变量，而不是假装跑了一遍网络。
    const r1 = await EBC.resolveItem(bare('https://t1.pixhost.cc/thumbs/9569/z.jpg'), KK, freshState());
    ok(
      '主机号写错时不纠错（t1 → img1，那本身就是占位图；图床表只负责按规律改写）',
      r1 && r1.url === 'https://img1.pixhost.cc/images/9569/z.jpg',
      r1 && r1.url
    );

    // 头像那种站内链接必须真的被 externalOnly 跳掉（不是只写在规则里好看）
    const avHtml = { el: null, img: new El('img', {}), thumb: '', link: '/members/xericx.10184915/', externalId: '' };
    const rav = await EBC.resolveItem(avHtml, KK, freshState());
    ok('站内链接的头像条目解析不出任何东西（externalOnly 生效）', !rav.url, JSON.stringify(rav.url));
  }

  console.log('\n== 19b. 图床表本身：防盗链标记、verified 日期、按图片 URL 查表 ==');
  {
    const hosts = EBC.BUILTIN_HOSTS;
    const itw = hosts.find((h) => h.id === 'imagetwist');
    const px = hosts.find((h) => h.id === 'pixhost');
    ok('imagetwist 标了 referrer: no-referrer（带外来 Referer 会拿到占位图）', !!itw && itw.referrer === 'no-referrer');
    ok('pixhost 没标 referrer（实测它不挑 Referer）', !!px && px.referrer === undefined);
    ok('两条都写了 verified 日期（没实测过的规律不该进表）', !!(itw.verified && px.verified));
    ok(
      'findHost 认 imagetwist 的两种主机形态 img<N> / s<N>',
      !!EBC.findHost('https://s10.imagetwist.com/th/71393/a.jpg') &&
        !!EBC.findHost('https://img202.imagetwist.com/th/71393/a.jpg')
    );
    ok(
      'findHost 认 pixhost 的三个 tld',
      ['cc', 'to', 'org'].every((t) => !!EBC.findHost(`https://t2.pixhost.${t}/thumbs/9569/a.jpg`))
    );
    ok('findHost 不认无关域名', EBC.findHost('https://example.com/a.jpg') === null);
    ok('findHost 能接受空 url（不炸）', EBC.findHost('') === null);
    // 分层是否真的做到了：站点规则里不该再留一份内联的改写规律
    const kkStr = JSON.stringify(KK);
    ok(
      'kitty-kats 规则里已经没有内联的 rewrite（规律全部收进 hosts 表）',
      !kkStr.includes('img$1') && !kkStr.includes('pixhost.cc/images'),
      kkStr.slice(0, 120)
    );
  }

  console.log('\n== 19c. 通用图床论坛模式：不认站点，只认图床 ==');
  {
    const g = EBC.genericGalleryRule();
    ok(
      '通用规则也是先查表、再抓分享页',
      g.resolve.map((s) => s.type).join(' → ') === 'host → detail',
      JSON.stringify(g.resolve.map((s) => s.type))
    );
    ok('通用规则的 collect 是 a[href] > img', g.collect.item === 'a[href] > img');
    ok('通用规则的 detail 也开 externalOnly', g.resolve[1].externalOnly === true);
    ok(
      '通用规则不含任何站点专属 match（就是 *://*/*，靠图床而非域名触发）',
      JSON.stringify(g.match) === JSON.stringify(['*://*/*'])
    );

    // 「页面上 ≥3 张已知图床的图」是自动启用**唯一**的依据：
    // 门槛太低会在随便哪个网站上乱弹面板，太高则漏掉小帖子。
    const mkGallery = (n, urlOf) => {
      const b = new El('body');
      for (let i = 0; i < n; i++) {
        const a = new El('a', { href: `https://imagetwist.com/x${i}` });
        a.appendChild(new El('img', { src: urlOf(i) }));
        b.appendChild(a);
      }
      return { body: b, anchors: [] };
    };
    usePage(mkGallery(3, (i) => `https://img69.imagetwist.com/th/71393/a${i}.jpg`));
    ok('3 张已知图床的图 → 自动启用', !!EBC.detectHostGallery());
    // ★ 门槛数的是**图**不是**图床**：用户那个帖子的 117 张全是同一家（imagetwist），
    //   若按「至少 3 家不同图床」算，最典型的场景反而永远不会触发。
    usePage(mkGallery(6, (i) => `https://img69.imagetwist.com/th/71393/a${i}.jpg`));
    ok('6 张全是同一家图床也照样启用（门槛数图，不数图床）', !!EBC.detectHostGallery());
    usePage(mkGallery(5, (i) => `https://img69.imagetwist.com/th/71393/a${i}.jpg`));
    ok('5 张也启用', !!EBC.detectHostGallery());
    usePage(mkGallery(2, (i) => `https://img69.imagetwist.com/th/71393/a${i}.jpg`));
    ok('只有 2 张 → 不启用（门槛是 3）', EBC.detectHostGallery() === null);
    usePage(mkGallery(5, (i) => `https://unknown-host.test/th/a${i}.jpg`));
    ok('5 张但图床表里没有 → 不启用（只认表，不猜站点结构）', EBC.detectHostGallery() === null);
    EBC.settings.autoDetectHosts = false;
    usePage(mkGallery(5, (i) => `https://img69.imagetwist.com/th/71393/a${i}.jpg`));
    ok('设置里关掉 autoDetectHosts → 一律不启用', EBC.detectHostGallery() === null);
    EBC.settings.autoDetectHosts = true;
  }
}

console.log('\n== 20. 回归：每条规则的裸域都必须命中（v0.4.1 修的就是这个）==');
{
  // patternToRe 里 "*.example.com 也匹配裸域" 的那次 replace 曾经是死代码：
  // 上一行已经把 . 转义成 \.，所以 /\*\./ 永远匹配不上，编译出来是
  //   ^(?:https?|file)://.*\.example\.com/.*$
  // —— 只认子域，不认裸域。而人访问时敲的几乎都是裸域
  //（https://eporner.com/... 而不是 https://www.eporner.com/...），
  // 症状是「脚本装好了但什么都不发生」，极难往正则上想。
  //
  // 这一节对每条规则把「裸域 / www / 子域」三种写法都钉死，
  // 以后谁再动 patternToRe 都会立刻红。
  const CASES = [
    [
      'pinterest',
      [
        'https://pinterest.com/pin/1/',
        'https://www.pinterest.com/pin/1/',
        'https://ru.pinterest.com/pin/1/',
      ],
    ],
    ['eporner', ['https://eporner.com/gallery/x/', 'https://www.eporner.com/gallery/x/']],
    ['pornpics', ['https://pornpics.com/galleries/x/', 'https://www.pornpics.com/galleries/x/']],
    [
      'kitty-kats',
      [
        'https://kitty-kats.net/threads/x.1/',
        'https://www.kitty-kats.net/threads/x.1/',
        'https://kitty-kats.net/threads/x.1/page-2',
      ],
    ],
  ];
  for (const [want, urls] of CASES) {
    for (const u of urls) {
      const r = EBC.findRuleFor(u);
      ok(`${want}：命中 ${u}`, !!r && r.id === want, r ? r.id : '(无规则)');
    }
  }

  // 放宽子域之后不能反向误伤：域名里出现目标串、但位置不对的，一律不许命中。
  for (const u of [
    'https://example.com/kitty-kats.net/',
    'https://notpornpics.com/galleries/x/',
    'https://pinterest.com.evil.test/pin/1/',
  ]) {
    const r = EBC.findRuleFor(u);
    ok(`不该被误伤：${u}`, !r, r ? r.id : '');
  }
}

console.log(`\n${failed ? '❌' : '✅'} ${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exit(failed ? 1 : 0);
