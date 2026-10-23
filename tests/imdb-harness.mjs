// IMDb 规则 + collect.api（接口即图库）回归。
//
// 这份测试**不打网络**：把真实接口响应的形状（IMDb GraphQL 的 data.title.images）
// 做成替身，验证 ① 路径解析 ② 游标翻页 ③ 去重 ④ 全尺寸不被降级。
// 真实数字来自 2026-10-23 的实测：total=821、每页 50、末页 21、17 页。
import assert from 'node:assert/strict';
import { loadEbc, El, fakeDocument } from './_load-script.mjs';

let pass = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); process.exitCode = 1; throw new Error(name); }
};

// ---- 替身：按 IMDb 的真实形状造一页 50 条 / total 821 / 17 页 ----
const REAL_FIRST = {
  id: 'rm3952838402',
  url: 'https://m.media-amazon.com/images/M/MV5BMTMxYjZkOTMtNGEwZi00MGE1LWIwYzAtYzNjOWNhNmZiMTVlXkEyXkFqcGc@._V1_.jpg',
  width: 1920,
  height: 818,
  caption: { plainText: 'Katie Leung and Hailee Steinfeld in Arcane (2021)' },
};
const REAL_BIG = {
  id: 'rm2722490625',
  url: 'https://m.media-amazon.com/images/M/MV5BY2FiY2FiZjgtMWIzZS00MGNmLThmM2YtOTg5Njc2MGQ2YTE3XkEyXkFqcGc@._V1_.jpg',
  width: 7640,
  height: 3260,
  caption: { plainText: 'Arcane (2021)' },
};

const TOTAL = 821;
const PAGE = 50;
const PAGES = Math.ceil(TOTAL / PAGE); // 17

function pagePayload(n, after) {
  const start = after ? Number(after) : 0;
  const count = Math.min(PAGE, TOTAL - start);
  const edges = [];
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    const node = idx === 0 ? REAL_FIRST : idx === 1 ? REAL_BIG : {
      id: 'rm' + (100000000 + idx),
      url: `https://m.media-amazon.com/images/M/MV5BFAKE${idx}@._V1_.jpg`,
      width: 1920,
      height: 1080,
      caption: { plainText: `Arcane still #${idx}` },
    };
    edges.push({ position: idx + 1, node });
  }
  const next = start + count;
  return {
    data: {
      title: {
        id: 'tt11126994',
        images: {
          total: TOTAL,
          pageInfo: { hasNextPage: next < TOTAL, endCursor: next < TOTAL ? String(next) : null },
          edges,
        },
      },
    },
  };
}

const IMDB = {
  id: 'imdb',
  name: 'IMDb',
  match: ['*://*.imdb.com/title/*/mediaindex/*'],
  collect: {
    item: "a[data-testid^='mosaic-img-']",
    img: 'img',
    link: 'self',
    api: {
      url: 'https://caching.graphql.imdb.com/',
      method: 'POST',
      headers: {
        'x-imdb-client-name': 'imdb-web-next-localized',
        'x-imdb-user-country': 'US',
        'x-imdb-user-language': 'en-US',
      },
      body: '{"query":"query { title(id: \\"{titleId}\\") { images(first: 50, after: \\"{after}\\") { total pageInfo { hasNextPage endCursor } edges { node { id url width height caption { plainText } } } } } }"}',
      vars: { titleId: ['url:/title/(tt\\d+)/'] },
      images: 'data.title.images.edges[].node',
      imageField: 'url',
      idField: 'id',
      nameField: 'caption.plainText',
      page: 'data.title.images.pageInfo',
      cursor: 'endCursor',
      hasNext: 'hasNextPage',
      cursorIn: 'after',
      pageSize: 50,
      maxPages: 60,
    },
  },
  resolve: [{ type: 'attr', selectors: ['img@src'], allowSameThumb: true }],
};

// 只放一个 logo，证明「DOM 里没有正文图」也能靠接口收满
const doc = fakeDocument({
  body: (() => {
    const b = new El('body');
    b.appendChild(new El('img', { src: 'https://m.media-amazon.com/images/G/logo.png' }));
    return b;
  })(),
});

const calls = [];
const { EBC } = loadEbc({
  document: doc,
  location: { href: 'https://www.imdb.com/title/tt11126994/mediaindex/', hostname: 'www.imdb.com', origin: 'https://www.imdb.com' },
  // 沙箱里的 GM_xmlhttpRequest 是把**整个 opts** 传给 gmGet(opts)，
  // 不是 gmGet(url, opts) —— 写错的话所有请求都会变成 network error。
  gmGet: async (opts) => {
    const body = String((opts && opts.data) || '');
    calls.push({ url: opts && opts.url, opts });
    const m = body.match(/after: \\"([^"]*)\\"/);
    const after = m ? m[1] : '';
    const n = after === '' ? 0 : Number(after);
    return { status: 200, responseText: JSON.stringify(pagePayload(n, after)) };
  },
});

console.log('\n== A. 路径解析：images 里的 [] 展开 ==');
{
  const payload = pagePayload(0, '');
  const nodes = EBC.apiCollectNodes(payload, 'data.title.images.edges[].node');
  ok('data.title.images.edges[].node 解析出 50 个节点', nodes.length === 50, String(nodes.length));
  ok('节点就是 node 本身（不是 edge 包装）', nodes[0].id === REAL_FIRST.id, nodes[0] && nodes[0].id);
  ok('apiPathGet 取 caption.plainText', EBC.apiPathGet(nodes[0], 'caption.plainText') === REAL_FIRST.caption.plainText);
  ok('apiPathGet 取 pageInfo.endCursor', EBC.apiPathGet(payload, 'data.title.images.pageInfo') !== undefined);
  ok('不存在的路径返回 undefined', EBC.apiPathGet(payload, 'data.nope.deeper') === undefined);
  ok('apiFillTemplate 会替换 {var}', EBC.apiFillTemplate('a={x}&b={y}', { x: 1, y: 'z' }) === 'a=1&b=z');
  ok('apiFillTemplate 缺变量时留原样', EBC.apiFillTemplate('a={x}', {}) === 'a={x}');
}

console.log('\n== B. 游标翻页：17 页拿满 821，且不重复 ==');
{
  calls.length = 0;
  const map = new Map();
  const seen = [];
  const res = await EBC.collectFromApi(IMDB, map, (p, total, added) => seen.push([p, total, added]));
  ok('一共翻了 17 页', res.apiPages === PAGES, String(res.apiPages));
  ok('没有失败', res.apiFailed === false);
  ok('累计拿到 821 条', map.size === TOTAL, String(map.size));
  ok('发出 17 次请求', calls.length === PAGES, String(calls.length));
  ok('每页都往 https://caching.graphql.imdb.com/ 发', calls.every((c) => c.url === 'https://caching.graphql.imdb.com/'));
  ok('全部是 POST', calls.every((c) => String(c.opts.method).toUpperCase() === 'POST'));
  ok('带上了三个 x-imdb 头（过 WAF 的关键）',
    ['x-imdb-client-name', 'x-imdb-user-country', 'x-imdb-user-language'].every((k) => calls[0].opts.headers[k]));
  ok('Content-Type 自动补成 application/json', calls[0].opts.headers['Content-Type'] === 'application/json');
  ok('titleId 从 URL 抠出来了', String(calls[0].opts.data).includes('tt11126994'));
  ok('首轮 after 是空串（GraphQL 语义 = 从头开始）', /after: \\"\\"/.test(String(calls[0].opts.data)), String(calls[0].opts.data).slice(0, 160));
  ok('第二轮 after 是上一页的 endCursor', /after: \\"50\\"/.test(String(calls[1].opts.data)), String(calls[1].opts.data).slice(0, 160));
  ok('末页只有 21 条', seen[seen.length - 1][2] === 21, String(seen[seen.length - 1][2]));
  // 去重
  const urls = [...map.values()].map((x) => x.thumb);
  ok('821 条 URL 互不相同', new Set(urls).size === TOTAL, String(new Set(urls).size));
  // 全尺寸不被降级
  ok('全部已是 ._V1_ 全尺寸', urls.every((u) => /\._V1_\.(jpg|png)$/.test(u)));
  ok('没有一条带 _UX/_SX/_CR 尺寸修饰符',
    !urls.some((u) => /_UX\d+_|_SX\d+_|_CR\d/.test(u)),
    urls.find((u) => /_UX\d+_|_SX\d+_|_CR\d/.test(u)));
  // 条目字段
  const first = [...map.values()].find((x) => x.externalId === REAL_FIRST.id);
  ok('externalId 用的是 rm id', !!first);
  ok('alt 带上了 caption', first && first.alt === REAL_FIRST.caption.plainText, first && first.alt);
  ok('条目带 fromApi 标记', first && first.fromApi === true);
  ok('最大的那张 7640x3260 也在', urls.includes(REAL_BIG.url));
}

console.log('\n== C. 游标不前进时必须停（防止无限循环） ==');
{
  const stuck = JSON.parse(JSON.stringify(IMDB));
  const map = new Map();
  let n = 0;
  const res = await (async () => {
    // 每次都返回同一个 endCursor
    const { EBC: E2 } = loadEbc({
      document: fakeDocument(),
      location: { href: 'https://www.imdb.com/title/tt11126994/mediaindex/', hostname: 'www.imdb.com' },
      gmGet: async () => {
        n++;
        const payload = pagePayload(0, '');
        payload.data.title.images.pageInfo.endCursor = 'STUCK';
        payload.data.title.images.pageInfo.hasNextPage = true;
        return { status: 200, responseText: JSON.stringify(payload) };
      },
    });
    return E2.collectFromApi(stuck, map, () => {});
  })();
  ok('游标卡住时只发了 2 次就停（首轮 + 发现重复的那轮）', n === 2, String(n));
  ok('没有无限循环', res.apiPages <= 2, String(res.apiPages));
}

console.log('\n== D. 接口报错 / 路径写错时的行为 ==');
{
  // 403
  const { EBC: E3 } = loadEbc({
    document: fakeDocument(),
    location: { href: 'https://www.imdb.com/title/tt11126994/mediaindex/', hostname: 'www.imdb.com' },
    gmGet: async () => ({ status: 403, responseText: '' }),
  });
  const m3 = new Map();
  const r3 = await E3.collectFromApi(IMDB, m3, () => {});
  ok('HTTP 403 → 标记失败、不抛异常', r3.apiFailed === true && m3.size === 0);

  // GraphQL errors
  const { EBC: E4 } = loadEbc({
    document: fakeDocument(),
    location: { href: 'https://www.imdb.com/title/tt11126994/mediaindex/', hostname: 'www.imdb.com' },
    gmGet: async () => ({ status: 200, responseText: JSON.stringify({ errors: [{ message: 'Cannot query field "all_images"' }] }) }),
  });
  const m4 = new Map();
  const r4 = await E4.collectFromApi(IMDB, m4, () => {});
  ok('GraphQL errors → 标记失败', r4.apiFailed === true && m4.size === 0);

  // images 路径写错
  const bad = JSON.parse(JSON.stringify(IMDB));
  bad.collect.api.images = 'data.title.nope[].node';
  const { EBC: E5 } = loadEbc({
    document: fakeDocument(),
    location: { href: 'https://www.imdb.com/title/tt11126994/mediaindex/', hostname: 'www.imdb.com' },
    gmGet: async () => ({ status: 200, responseText: JSON.stringify(pagePayload(0, '')) }),
  });
  const m5 = new Map();
  const r5 = await E5.collectFromApi(bad, m5, () => {});
  ok('images 路径写错 → 失败而不是静默返回 0 条', r5.apiFailed === true);
}

console.log('\n== E. fromApi 条目短路：不再被 resolve 管线降级 ==');
{
  const item = { thumb: REAL_FIRST.url, fromApi: true, externalId: REAL_FIRST.id, baseUrl: 'https://www.imdb.com/' };
  const r = await EBC.resolveItem(item, IMDB, {});
  ok('resolveItem 直接返回接口给的全尺寸地址', r.url === REAL_FIRST.url, r.url);
  ok('via 标成 api', r.via === 'api', r.via);
  ok('没有被 attr 步骤改成 src 里那种 _QL75_UX513_ 缩略图', !/_UX\d+_/.test(r.url));
}

console.log('\n== F. 规则本身：匹配范围与内置/订阅一致性 ==');
{
  const rule = EBC.BUILTIN_RULES.find((x) => x.id === 'imdb');
  ok('内置规则里有 imdb', !!rule);
  ok('match 只覆盖 mediaindex，不是整个 imdb.com',
    rule.match.every((m) => m.includes('/mediaindex')), JSON.stringify(rule.match));
  ok('命中 mediaindex（带尾斜杠）', EBC.findRuleFor('https://www.imdb.com/title/tt11126994/mediaindex/') === rule);
  ok('命中 mediaindex（不带尾斜杠）', EBC.findRuleFor('https://www.imdb.com/title/tt11126994/mediaindex') === rule);
  ok('不误伤影片主页', EBC.findRuleFor('https://www.imdb.com/title/tt11126994/') === null);
  ok('不误伤影人页', EBC.findRuleFor('https://www.imdb.com/name/nm0000138/') === null);
  ok('collect.api.images 路径正确', rule.collect.api.images === 'data.title.images.edges[].node');
  ok('cursorIn 是 after', rule.collect.api.cursorIn === 'after');
  ok('body 里同时有 titleId 与 after 占位',
    rule.collect.api.body.includes('{titleId}') && rule.collect.api.body.includes('{after}'));
  const parsed = JSON.parse(rule.collect.api.body);
  ok('body 是合法 JSON 且 query 里字段名是 images（不是 all_images）',
    parsed.query.includes('images(first') && !parsed.query.includes('all_images'), parsed.query);
}

console.log(`\n${process.exitCode ? '❌ 有失败' : '✅ 全部通过'}（${pass} 项）\n`);
