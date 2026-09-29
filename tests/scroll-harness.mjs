/**
 * 无限滚动（虚拟化列表）回归测试 —— Pinterest 那一类。
 *
 * 复现的真实故障（用户 m00842）：

 *   「只能获取首屏加载的图片，比如19张。然后向下滚动之后的照片似乎也只能
 *     加载到当前阶段获取的图片，因为数字还是在20张左右跳动。」
 *
 * 原因不是「懒加载没触发」，而是**虚拟化**：滚出视野的 tile 会被**卸载**。
 * 所以旧实现（forceLazyLoad 滚到底再滚回来 + `items = collectItems(...)` 覆盖）
 * 拿到的和滚之前差不多 —— 滚过去的全没了。
 *
 * 这里用一个真的会卸载 tile 的假瀑布流，验证新实现 collectAll「边走边收」
 * 能把整个列表收全，并且跨多次扫描会累加而不是覆盖。
 *
 * 跑法：node eagle-batch-collector/tests/scroll-harness.mjs
 */
import assert from 'node:assert/strict';
import { El, fakeDocument, loadEbc } from './_load-script.mjs';

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✅', msg);
};
const eq = (a, b, msg) => {
  assert.equal(a, b, msg);
  pass++;
  console.log('  ✅', msg);
};

/* ---------------- 假的虚拟化瀑布流 ---------------- */

const TOTAL = 25;
const ROW_H = 240;
const VH = 900;
const PAGE_H = TOTAL * ROW_H;

const body = new El('body');
const doc = fakeDocument(body);
doc.documentElement = { scrollHeight: PAGE_H };

let scrollY = 0;
let maxMounted = 0;

const pinNode = (i) => {
  const d = new El('div', { 'data-test-id': 'pin' });
  d.appendChild(new El('a', { href: `/pin/${1000 + i}/` }));
  d.appendChild(new El('img', { src: `https://i.pinimg.com/236x/aa/bb/${1000 + i}.jpg` }));
  return d;
};

// 虚拟化：只挂载与视口（含提前量）重叠的 tile，其余**从 DOM 里移除**。
function mount() {
  const top = Math.max(0, Math.floor(scrollY / ROW_H) - 1);
  const bottom = Math.min(TOTAL - 1, Math.ceil((scrollY + VH + ROW_H * 3) / ROW_H));
  body.children = [];
  for (let i = top; i <= bottom; i++) body.appendChild(pinNode(i));
  maxMounted = Math.max(maxMounted, body.children.length);
}
mount();

const PINTEREST_URL = 'https://www.pinterest.com/board/ebc-test/';
const { EBC, sandbox } = loadEbc({
  document: doc,
  location: {
    href: PINTEREST_URL,
    hostname: 'www.pinterest.com',
    origin: 'https://www.pinterest.com',
    pathname: '/board/ebc-test/',
    search: '',
  },
});

// 把等待时间压到最短，语义不变（真实值是 700ms/6000ms）。
Object.assign(EBC.SCROLL, { settleIdleMs: 1, settleMaxMs: 20, noGrowthStop: 2, maxRounds: 40, budgetMs: 8000 });

// 【1】~【5】测的是 collectAll 的**自动滚动**能力。自动滚动现在是显式选择
// （默认 'follow' 绝不抢滚动条），所以这里先把它打开；【6】再验证 follow 模式。
EBC.settings.scanMode = 'auto';

Object.defineProperty(sandbox, 'scrollY', { get: () => scrollY, configurable: true });
sandbox.innerHeight = VH;
sandbox.scrollTo = (_x, y) => {
  scrollY = Math.max(0, Math.min(y, PAGE_H - VH));
  mount();
};

/* ---------------- 断言 ---------------- */

console.log('\n【0】规则本身');
const rule = EBC.BUILTIN_RULES.find((r) => r.id === 'pinterest');
ok(rule, '内置规则里有 pinterest');
eq(rule && rule.collect.scrollToLoad, true, 'pinterest 规则必须开 scrollToLoad（否则永远只收单次快照）');
const found = EBC.findRuleFor(PINTEREST_URL);
ok(found, 'findRuleFor 能匹配 Pinterest 页面 URL');
eq(found && found.id, 'pinterest', '匹配到的就是 pinterest 规则');

console.log('\n【1】边走边收：虚拟化列表也必须收全');
const snap = EBC.collectItems(rule).length;
eq(snap, body.children.length, '静态快照只拿得到当前挂载的 tile —— 这就是「数字停在 20 左右」的来源');
ok(body.children.length < TOTAL / 2, `假页面确实是虚拟化的：任一时刻只挂载 ${body.children.length}/${TOTAL}`);

const col = await EBC.collectAll(rule, () => {});
eq(col.items.length, TOTAL, `collectAll 收全了全部 ${TOTAL} 条（旧实现只会有 ${snap} 条）`);
eq(col.scrolled, true, '确实滚动了');
ok(col.rounds >= 2, `滚了多轮（rounds=${col.rounds}）`);
eq(col.capped, false, '没有触发条数上限');
eq(col.timedOut, false, '没有超时');
ok(maxMounted < TOTAL, `全程 DOM 里最多只挂载过 ${maxMounted} 个 tile —— 卸载真的发生了`);

console.log('\n【2】稳定 key：同一条目卸载再挂载不能算成两条');
eq(new Set(col.items.map(EBC.itemKey)).size, TOTAL, `${TOTAL} 条 key 互不相同`);
eq(
  EBC.itemKey({ link: 'https://www.pinterest.com/pin/123/?nic_v2=abc#frag' }),
  'link:https://www.pinterest.com/pin/123/',
  '链接 key 会去掉 query（跟踪参数）和 hash'
);
eq(EBC.itemKey({ externalId: '10574489', link: 'https://x/y/' }), 'id:10574489', 'externalId 优先于链接');
eq(EBC.itemKey({ thumb: 'https://i.pinimg.com/236x/aa/bb/9.jpg' }), 'thumb:https://i.pinimg.com/236x/aa/bb/9.jpg', '没有 id/链接时退回用缩略图');

console.log('\n【3】重复合并：同样一批条目并两次，不会翻倍');
const m = new Map();
eq(EBC.mergeItems(m, col.items), TOTAL, `第一次合并进 ${TOTAL} 条`);
eq(EBC.mergeItems(m, col.items), 0, '再合并一次新增 0 条');
eq(m.size, TOTAL, `累计表仍是 ${TOTAL} 条`);

console.log('\n【4】占位符缩略图会被后到的真地址升级');
const m2 = new Map();
EBC.mergeItems(m2, [{ externalId: '7', thumb: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }]);
EBC.mergeItems(m2, [{ externalId: '7', thumb: 'https://i.pinimg.com/236x/aa/bb/7.jpg' }]);
eq(m2.size, 1, '同一个 id 只算一条');
eq(
  [...m2.values()][0].thumb,
  'https://i.pinimg.com/236x/aa/bb/7.jpg',
  'thumb 从 1x1 占位符升级成真地址（否则会推给 Eagle 一堆透明 gif）'
);

console.log('\n【5】跨多次扫描累加（用户「数字在 20 左右跳动」的直接修法）');
const accum = new Map();
const scan1 = await EBC.collectAll(rule, () => {});
scrollY = PAGE_H - VH;
mount(); // 模拟用户自己又滚到了底部
const scan2 = await EBC.collectAll(rule, () => {});
eq(scan1.items.length, TOTAL, `第一次扫描收全 ${TOTAL} 条`);
eq(EBC.collectItems(rule).length < TOTAL, true, '滚到底单收一次，仍然只有当前挂载的少量 tile');
EBC.mergeItems(accum, scan1.items);
EBC.mergeItems(accum, scan2.items);
eq(accum.size, TOTAL, `两次扫描合并去重后仍是 ${TOTAL} 条（覆盖式实现会只剩当前挂载的几条）`);

/* ---------------- 跟随模式（默认）+ 就地替换 ---------------- */

console.log('\n【6】默认的 follow 模式绝不抢滚动条');
EBC.settings.scanMode = 'follow';
scrollY = 0;
mount();
const yBefore = scrollY;
const snapOnly = await EBC.collectAll(rule, () => {});
eq(scrollY, yBefore, 'follow 模式下 collectAll 一次都没滚动（用户：「这个操作逻辑会有点失控」）');
eq(snapOnly.scrolled, false, 'scrolled = false');
eq(snapOnly.rounds, 0, 'rounds = 0');
eq(snapOnly.items.length, body.children.length, `只取当前挂着的那 ${body.children.length} 条，不多动一下`);

console.log('\n【7】就地替换：按稳定 key 对齐，扛得住虚拟化重挂载');
// 用户实测：377 条里只替换了 16 张。旧实现先 collectItems 再用 **thumb** 对齐，
// 而 Pinterest 把 tile 卸载再挂载之后，同一张图的 thumb 常常变成另一个尺寸的
// 候选地址 → 匹配不上 → 只有恰好没被卸载过的那一屏能对上。
const mkTile = (pin, size) => {
  const d = new El('div', { 'data-test-id': 'pin' });
  d.appendChild(new El('a', { href: `/pin/${pin}/` }));
  d.appendChild(new El('img', { src: `https://i.pinimg.com/${size}/aa/bb/${pin}.jpg` }));
  return d;
};
const rec = (pin, url) => ({
  url,
  via: 'rewrite',
  key: `link:https://www.pinterest.com/pin/${pin}/`,
  thumb: `https://i.pinimg.com/236x/aa/bb/${pin}.jpg`,
  status: '就绪',
});
const ORIG = (pin) => `https://i.pinimg.com/originals/aa/bb/${pin}.jpg`;

EBC.settings.autoReplace = false;
EBC.__set({
  currentRule: rule,
  resolvedCache: [rec(1000, ORIG(1000)), rec(1001, ORIG(1001))],
});
// 关键：挂载出来的 thumb 是 736x，而记录里存的是 236x —— 按 thumb 对齐必然落空。
body.children = [mkTile(1000, '736x'), mkTile(1001, '736x')];
const r1 = EBC.applyReplacements({ quiet: true });
eq(r1.n, 2, '两个 tile 都换成了原图（旧实现按 thumb 对齐，这里会是 0）');
eq(body.children[0].children[1].src, ORIG(1000), 'tile 的 src 已经是原图');
eq(body.children[1].children[1].src, ORIG(1001), '第二个 tile 也是');
eq(
  body.children[0].children[1].getAttribute('data-src'),
  null,
  'data-src 被清掉（否则 Pinterest 重渲染会把缩略图放回来）'
);

eq(EBC.applyReplacements({ quiet: true }).n, 0, '再调一次是幂等的，不会反复动同一个 tile');

console.log('\n【8】边滚边换：后滚进视野的 tile 会被后续调用补上');
scrollY = 1500;
body.children = [mkTile(1002, '474x'), mkTile(1003, '474x')];
EBC.__set({ resolvedCache: [rec(1000, ORIG(1000)), rec(1001, ORIG(1001)), rec(1002, ORIG(1002)), rec(1003, ORIG(1003))] });
const r3 = EBC.applyReplacements({ quiet: true });
eq(r3.n, 2, '新挂载的两个 tile 被替换（这就是「跟随滚动」能滚多远换多远的原因）');
eq(body.children[0].children[1].src, ORIG(1002), 'tile 1002 已换');

console.log('\n【9】同一张原图被两个 tile 指着会被数出来（用户问的「发送了两遍」）');
body.children = [mkTile(2000, '236x'), mkTile(2001, '236x')];
EBC.__set({ currentRule: rule, resolvedCache: [rec(2000, ORIG(2000)), rec(2001, ORIG(2000))] });
const r4 = EBC.applyReplacements({ quiet: true });
eq(r4.dupes, 1, '两个 tile 指向同一张原图 → 报告 1 个重复（Pinterest 推荐流确实会重复推同一个 pin）');
eq(r4.n, 2, '两张都照换（页面上保持所见即所得，重复由用户挑图时决定）');

console.log(`\n${pass} 项断言全部通过。`);
