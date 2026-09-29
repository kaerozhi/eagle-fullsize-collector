/**
 * 实机验证：素材名真的落进了 Eagle。
 *
 * 用法：node eagle-batch-collector/tests/live-naming.mjs
 * 前置：Eagle 正在运行（本地 API http://127.0.0.1:41595，无需 token）。
 *
 * ★ 这个脚本会**真的往素材库写 3 条测试素材**，跑完立即用旧版 API
 *   `/api/item/moveToTrash` 移进回收站。
 *
 * 验证分两层，因为这两件事失败起来完全不一样：
 *   ① 客户端：真实 push() 发出去的请求体里，name 是不是我们算的那个。
 *      —— 从网络替身抓下来的原始请求体看，不靠「我以为我发了」。
 *   ② 服务端：Eagle 落库后 item/get 读回来的 name 是不是同一个。
 *      —— 这才是用户真正看到的。已经实测过 Eagle 认 name（传什么读回什么）。
 *
 * 读回要带重试：Eagle 建了素材不等于马上可查（它要去下载原图），
 * 第一版没重试，把「还没写完」误判成了「名字错了」。
 */
import { loadEbc } from './_load-script.mjs';

const EA = 'http://127.0.0.1:41595';
const ICON = 'https://static-ca-cdn.eporner.com/catimg/3_small.jpg';

const addedIds = [];
const addCalls = []; // { url, method, data, status }

/**
 * 网络替身。注意签名：脚本里的 gmGet 组装好一个 opts 对象后调用
 * `GM_xmlhttpRequest(opts)`，沙箱把这个**单参数对象**原样转给我们 ——
 * 不是 (url, options)。第一版写成 (url, opts) 导致 fetch 收到一个对象，
 * 报「Failed to parse URL」，看起来却像 Eagle 没启动。
 */
async function netGet(opts) {
  const res = await fetch(opts.url, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.data || undefined,
  });
  const text = await res.text();
  if (/\/item\/add$|addFromURL/.test(opts.url) && opts.method === 'POST') {
    addCalls.push({ url: opts.url, method: 'POST', data: opts.data || '', status: res.status });
  }
  try {
    const j = JSON.parse(text);
    if (j && j.data && Array.isArray(j.data.ids) && j.data.ids.length) addedIds.push(...j.data.ids);
  } catch (e) {
    /* 非 JSON */
  }
  return {
    status: res.status,
    responseText: text,
    responseHeaders: [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n'),
  };
}

const { EBC, sandbox } = loadEbc({ gmGet: netGet });
sandbox.document.title = 'Shoko Takahashi, Yua Mikami - Meganekko Beautiful Breasts Sisters - Eporner';
EBC.settings.eagleOrigin = EA;

// 故意让 name 全空 —— 这样验证的是 push() 自己的兜底，不是测试脚本先算好的
const items = [
  { url: ICON, name: '', website: 'https://www.eporner.com/gallery/5IUmqWloQOl/x/', alt: '', externalId: '10574489' },
  {
    url: 'https://static-ca-cdn.eporner.com/gallery/Ol/oQ/5IUmqWloQOl/10574489-gao-qiaoshou-zi-san-nude.jpg',
    name: '',
    website: 'https://www.eporner.com/gallery/5IUmqWloQOl/x/',
    alt: '',
    externalId: '10574490',
  },
  {
    url: 'https://i.pinimg.com/originals/ab/cd/ef/abcdef0123456789abcdef0123456789.jpg',
    name: '',
    website: 'https://www.pinterest.com/',
    alt: '',
    externalId: '',
  },
];

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('=== 1. probe()：找加素材端点 ===');
const caps = await EBC.eagle.probe(true);
console.log(`  candIndex=${caps.candIndex}  base=${caps.base}  shape=${caps.shape}`);
if (caps.candIndex < 0) {
  console.error('  ❌ 探测失败：' + caps.note);
  process.exit(1);
}

console.log('\n=== 2. 本地先算出期望的名字 ===');
const expected = items.map((it, i) => EBC.buildItemName(it, it.url, i));
expected.forEach((n, i) => console.log(`  ${i}: ${n}`));

console.log('\n=== 3. push()（真的写库）===');
const r = await EBC.eagle.push(items, (d, t, o, f) => console.log(`  进度 ${d}/${t}  ok=${o} failed=${f}`));
console.log('  push 返回：', JSON.stringify(r));

// ---- ① 客户端：发出去的请求体 ----
console.log('\n=== 4. 客户端：请求体里带的 name ===');
const sentNames = [];
for (const c of addCalls) {
  if (c.status !== 200) continue;
  let b = null;
  try {
    b = JSON.parse(c.data);
  } catch (e) {
    continue;
  }
  const arr = b.items || (b.url ? [b] : []);
  for (const x of arr) if (x && x.name) sentNames.push(x.name);
  console.log(`  POST ${c.url} → ${c.status}`);
  console.log(`    请求体：${c.data.slice(0, 600)}`);
}
ok('真实 push() 发出的请求体里有 3 个非空 name', sentNames.length === 3, `实得 ${sentNames.length}：${sentNames.join(' | ')}`);
ok('发出的 name 与本地算的一致', sentNames.join('|') === expected.join('|'), `期望 ${expected.join(' | ')}`);
ok('发出的 name 里没有空串（空串 = Eagle 用素材 id 命名）', sentNames.every((n) => n && n.length), sentNames.join(' | '));

// ---- ② 服务端：读回来 ----
console.log('\n=== 5. 服务端：读回来比对（带重试，Eagle 建好不等于立刻可查）===');
async function readItem(id, tries = 20) {
  let raw = null;
  for (let k = 0; k < tries; k++) {
    const res = await fetch(`${EA}/api/v2/item/get?id=${id}`);
    raw = await res.json();
    const arr = raw && raw.data && raw.data.data;
    if (arr && arr.length) return { item: arr[0], raw };
    // 20 × 1000ms = 20 秒。别把这里调小：Eagle 忙着下载原图时 8 秒是不够的，
    // 而「还没写完」被误判成「名字错了」会让这个测试变成喊狼来了（踩过一次）。
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  return { item: null, raw };
}

const got = [];
for (let i = 0; i < addedIds.length; i++) {
  const { item, raw } = await readItem(addedIds[i]);
  got.push({ id: addedIds[i], name: item ? item.name : null, expect: expected[i] });
  console.log(
    `  ${addedIds[i]} → ${item ? JSON.stringify(item.name) : '读不到'}  ` +
      `(期望 ${JSON.stringify(expected[i])})`
  );
  if (!item) console.log(`    原始响应：${JSON.stringify(raw).slice(0, 220)}`);
}

ok('Eagle 至少为其中 1 条建了可查素材', got.some((g) => g.name != null), got.map((g) => `${g.id}:${g.name}`).join(' '));
ok(
  '所有能读回来的素材，名字都与本地算的一致',
  got.filter((g) => g.name != null).every((g) => g.name === g.expect),
  got.filter((g) => g.name != null).map((g) => `${JSON.stringify(g.name)} vs ${JSON.stringify(g.expect)}`).join(' ; ')
);
ok(
  '没有任何一条退化成素材 id',
  got.every((g) => g.name == null || g.name !== g.id),
  got.map((g) => `${g.id}→${g.name}`).join(' ')
);
ok(
  'eporner 那条带上了拼音 slug（用户要的可搜索性）',
  got.some((g) => g.name != null && /gao-qiaoshou-zi-san-nude/.test(g.name)),
  got.map((g) => String(g.name)).join(' | ')
);

// 兜底名的证明走**客户端那一层**，理由是这条链已经闭合：
// ① 上面证明了真实 push() 发出的 name 就是本地算的那个；
// ② item/add 认 name 这事已经实测两次（传 'xxx' 读回来就是 'xxx'）。
// 所以「请求体里不是哈希」⇒「库里也不可能是哈希」。
// 之所以不能用读回来证明它：测试里那条 Pinterest 地址是**编的**，原图 404，
// 而 Eagle 不会把下载失败的素材留在库里（下面那行 ℹ️ 就是这件事）。
ok(
  'Pinterest 哈希 URL 在**请求体**里就已经是标题兜底名，不再是那串哈希',
  sentNames.some((n) => /Meganekko/.test(n) && !/abcdef0123456789/.test(n)),
  sentNames.join(' | ')
);

const dropped = got.filter((g) => g.name == null);
if (dropped.length) {
  console.log(
    `  ℹ️ 有 ${dropped.length} 条 Eagle 回了 id、但 item/get 重试 20 秒仍是 total:0 —— ` +
      '下载失败的原图不会留在素材库里（这是新查明的 Eagle 行为，不是 bug）。'
  );
}

console.log('\n=== 6. 清理：移进回收站 ===');
for (const id of addedIds) {
  const res = await fetch(`${EA}/api/item/moveToTrash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds: [id] }),
  });
  console.log(`  ${id} → HTTP ${res.status} ${(await res.text()).slice(0, 60)}`);
}
let leftover = 0;
for (const id of addedIds) {
  const res = await fetch(`${EA}/api/v2/item/get?id=${id}`);
  const j = await res.json();
  const n = j && j.data && j.data.data ? j.data.data.length : 0;
  if (n) leftover++;
}
ok('测试素材都已不在库中', leftover === 0, `还剩 ${leftover} 条`);

console.log(`\n${failed ? '❌ ' + failed + ' 项失败' : '✅ 实机验证全部通过'}\n`);
process.exit(failed ? 1 : 0);
