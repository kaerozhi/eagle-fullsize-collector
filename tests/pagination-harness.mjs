/**
 * 跨页相册回归测试 —— 美图录这类「分页器带省略号」的相册。
 *
 * 真实页面形状：
 *   /item/3006.html     → /item/3006_2.html … /item/3006_6.html、/item/3006_13.html
 *   /item/3006_13.html  再展示 8、9、10、11、12 页
 *
 * 测试真实脚本的 collectAll：从当前页递归发现分页链接、抓取远程 HTML、
 * 合并每页条目，并用远程页面自己的 URL 解析相对图片地址。
 */
import assert from 'node:assert/strict';
import { El, fakeDocument, loadEbc } from './_load-script.mjs';

const ORIGIN = 'https://www.meitulu.me';
const pageUrl = (n) => n === 1 ? `${ORIGIN}/item/3006.html` : `${ORIGIN}/item/3006_${n}.html`;
const imageUrl = (n) => `${ORIGIN}/p/3006-page-${String(n).padStart(2, '0')}.jpg`;

function anchor(href, text) {
  return new El('a', { class: 'page-link', href, 'data-page': text });
}

function makePage(n) {
  const body = new El('body');
  const wrap = new El('div', { class: 'container-inner-fix-m' });
  wrap.appendChild(new El('img', {
    class: 'w-100 h-100',
    src: `/p/3006-page-${String(n).padStart(2, '0')}.jpg`,
    width: '1200',
    height: '1800',
  }));
  body.appendChild(wrap);

  const pages = [];
  if (n === 1) pages.push(2, 13);
  else {
    if (n > 2) pages.push(n - 1);
    if (n < 13) pages.push(n + 1);
    // 模拟真实分页器两端的跳跃链接：不要求链接按顺序或连续。
    if (n === 2) pages.push(13);
    if (n === 13) pages.push(8, 12);
  }
  const pagination = new El('div', { class: 'pagination' });
  for (const p of [...new Set(pages)]) pagination.appendChild(anchor(pageUrl(p), String(p)));
  body.appendChild(pagination);
  return fakeDocument(body);
}

const pages = new Map();
for (let n = 1; n <= 13; n++) pages.set(pageUrl(n), makePage(n));

const current = pages.get(pageUrl(1));
const { EBC, sandbox, requested } = loadEbc({
  document: current,
  location: {
    href: pageUrl(1),
    hostname: 'www.meitulu.me',
    origin: ORIGIN,
    pathname: '/item/3006.html',
    search: '',
  },
  gmGet: async (opts) => {
    assert.ok(pages.has(opts.url), `请求了未准备的分页：${opts.url}`);
    return { status: 200, responseText: opts.url, responseHeaders: 'content-type: text/html' };
  },
});

// 让沙箱里的 DOMParser 把测试响应 URL 映射成假 DOM。
sandbox.DOMParser = class {
  parseFromString(text) {
    const doc = pages.get(text);
    if (!doc) throw new Error(`没有为 ${text} 准备 DOM`);
    return doc;
  }
};

const rule = {
  id: 'meitulu-test',
  name: '美图录测试规则',
  collect: {
    item: '.container-inner-fix-m > img',
    img: 'self',
    pagination: { links: 'a.page-link[href]', maxPages: 20 },
  },
  resolve: [{ type: 'attr', selectors: ['img@src'], allowSameThumb: true }],
};

let pagesSeen = 0;
const col = await EBC.collectAll(
  rule,
  () => {},
  () => { pagesSeen++; }
);

assert.equal(col.items.length, 13, '当前页 + 12 个分页必须合并成 13 条');
assert.equal(col.pagesFetched, 12, '当前页之外正好抓取 12 个分页');
assert.equal(col.paginationCapped, false, '未达到分页安全上限');
assert.equal(pagesSeen, 12, '每个远程分页都触发一次进度回调');
assert.equal(requested.length, 12, '每个分页只请求一次');
assert.equal(new Set(col.items.map((x) => x.pageUrl)).size, 13, '条目保留各自来源页面');
assert.deepEqual(
  new Set(col.items.map((x) => x.thumb)),
  new Set(Array.from({ length: 13 }, (_, i) => imageUrl(i + 1))),
  '远程页面的相对图片地址按各自页面 URL 正确解析'
);

const resolved = [];
for (const item of col.items) {
  const got = await EBC.resolveItem(item, rule, {});
  resolved.push(got.url);
}
assert.equal(new Set(resolved).size, 13, `每页图片都解析成不同的原图 URL：${JSON.stringify(resolved)}`);
assert.ok(resolved.every((u) => /^https:\/\/www\.meitulu\.me\/p\//.test(u)), '解析结果都是绝对图片地址');

console.log(`\n${col.items.length} 条跨页相册条目、${col.pagesFetched} 个分页全部通过。`);
