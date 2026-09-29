/**
 * 共用的「加载真实脚本」沙箱。
 *
 * 测试不拷贝逻辑，而是把 eagle-fullsize.user.js 本体载入 vm 沙箱，
 * 只替换两处 I/O：UI 日志函数、以及由调用方提供的 GM_xmlhttpRequest。
 * 每处替换都带断言，避免源码结构变动后测试静默失效。
 *
 * 关键点：document.readyState 固定为 'loading'，boot() 因此永不执行。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.resolve(here, '..', 'eagle-fullsize.user.js');

/* ---------------- 极简假 DOM ---------------- */

export function matchesSel(el, sel) {
  // 支持逗号分隔的选择器组，以及 [attr]、[attr=v]、[attr*=v]、[attr^=v]、[attr$=v]。
  // Pinterest 的真实规则用到了 "div[data-test-id='pin'], div[data-grid-item]"
  // 和 "a[href*='/pin/']" —— 不支持这两样就测不了真规则，只能测个假规则。
  return String(sel)
    .split(',')
    .some((one) => matchesOne(el, one.trim()));
}

function matchesOne(el, sel) {
  const m = /^([a-zA-Z]*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  const tag = m[1];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const attrs = m[2] ? m[2].match(/\[[^\]]+\]/g) || [] : [];
  for (const a of attrs) {
    const am = /^([^\]=*^$~|]+)\s*(\*=|\^=|\$=|=)?\s*(.*)$/.exec(a.slice(1, -1));
    if (!am) return false;
    const [, name, op, rawVal] = am;
    const want = String(rawVal).replace(/^["']|["']$/g, '');
    const have = el.getAttribute(name);
    if (have === null || have === undefined) return false;
    if (!op) continue;
    const s = String(have);
    if (op === '=' && s !== want) return false;
    if (op === '*=' && !s.includes(want)) return false;
    if (op === '^=' && !s.startsWith(want)) return false;
    if (op === '$=' && !s.endsWith(want)) return false;
  }
  return true;
}

export class El {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this._a = Object.assign({}, attrs);
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
    this.className = '';
    this.style = {};
    this.value = '';
    this.naturalWidth = 0;
    this.childElementCount = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  getAttribute(n) {
    return n in this._a ? String(this._a[n]) : null;
  }
  setAttribute(n, v) {
    this._a[n] = v;
  }
  removeAttribute(n) {
    delete this._a[n];
  }
  // 必须有 setter：真 DOM 里 `img.src = url` 是标准写法，
  // 只有 getter 的话赋值会抛 "has only a getter"，而生产代码里那层
  // try/catch 会把它吞掉 —— 测试就会「替换了 0 张」而看不出原因。
  get src() {
    return this._a.src || '';
  }
  set src(v) {
    this._a.src = v;
  }
  get currentSrc() {
    return this._a.currentSrc || this._a.src || '';
  }
  get href() {
    return this._a.href || '';
  }
  set href(v) {
    this._a.href = v;
  }
  matches(sel) {
    return matchesSel(this, sel);
  }
  appendChild(c) {
    c.parentElement = this;
    this.children.push(c);
    this.childElementCount = this.children.length;
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    this.childElementCount = this.children.length;
    return c;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  _all() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    return this._all().filter((e) => matchesSel(e, sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

export function fakeDocument(body = new El('body')) {
  const doc = new El('#document');
  // ★ 必须真的把 body 挂成子节点：querySelectorAll 遍历的是 children 树，
  //   只写 doc.body = body 是访问不到的（这个坑让 3 项断言假红过一次）。
  doc.appendChild(body);
  // 注意：绝不能在这里覆盖 querySelector/querySelectorAll —— El 的原型方法才是
  // 真正会遍历这棵假树的东西，覆盖成 no-op 会让所有选择器测试变成假绿/假红。
  return Object.assign(doc, {
    readyState: 'loading',
    addEventListener() {},
    createElement: (t) => new El(t),
    getElementById: () => new El('div'),
    body,
    head: new El('head'),
  });
}

/* ---------------- 加载 ---------------- */

/**
 * @param {object} o
 * @param {function} [o.gmGet]  GM_xmlhttpRequest 替身；省略则任何请求都失败
 * @param {object}   [o.document]  初始 document
 * @param {object}   [o.location]
 * @returns {{ EBC:object, sandbox:object, requested:string[] }}
 */
export function loadEbc({ gmGet, document: doc, location: loc } = {}) {
  let src = fs.readFileSync(SCRIPT, 'utf8');

  const LOG_SIG = '  function log(msg, level) {\n    const els = ui || buildUI();';
  if (!src.includes(LOG_SIG)) throw new Error('log() 替换失败：源码结构变了，测试替身需要更新');
  const logEnd = src.indexOf('\n  }\n', src.indexOf(LOG_SIG));
  if (logEnd < 0) throw new Error('log() 结束位置没找到');
  src =
    src.slice(0, src.indexOf(LOG_SIG)) +
    '  function log(msg) { try { console.log("[EBC]", msg); } catch (e) {} }' +
    src.slice(logEnd + '\n  }'.length);

  const CLOSER = '})();';
  const ci = src.lastIndexOf(CLOSER);
  if (ci < 0) throw new Error('找不到 IIFE 结尾');
  src =
    src.slice(0, ci) +
    '\n  globalThis.__EBC__ = { resolveItem, readSelectorAttr, buildEndpointIndex, collectItems, pathDir, dedupeByUrl, BUILTIN_RULES, collectAll, mergeItems, itemKey, usableUrl, SCROLL, findRuleFor, applyReplacements, followPass, settings,' +
    '\n    __set: (o) => { if ("resolvedCache" in o) resolvedCache = o.resolvedCache; if ("currentRule" in o) currentRule = o.currentRule; if ("accum" in o) accum = o.accum; if ("scanAbort" in o) scanAbort = o.scanAbort; },' +
    '\n    __get: () => ({ resolvedCache, accum, resolvedByKey, sentUrls, followFilled }) };\n' +
    src.slice(ci);

  const requested = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    RegExp,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    Map,
    Set,
    Promise,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    document: doc || fakeDocument(),
    location:
      loc ||
      {
        href: 'https://www.eporner.com/gallery/5IUmqWloQOl/x/',
        hostname: 'www.eporner.com',
        origin: 'https://www.eporner.com',
        pathname: '/gallery/5IUmqWloQOl/x/',
        search: '',
      },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    GM_getValue: (_k, d) => d,
    GM_setValue() {},
    GM_registerMenuCommand() {},
    GM_addStyle() {},
    GM_notification() {},
    GM_download() {},
    XMLHttpRequest: function () {},
    MutationObserver: function () {
      return { observe() {}, disconnect() {} };
    },
    Image: function () {},
    GM_xmlhttpRequest(opts) {
      requested.push(opts.url);
      if (!gmGet) {
        setTimeout(() => opts.onerror({ error: 'no network in sandbox' }), 0);
        return;
      }
      Promise.resolve()
        .then(() => gmGet(opts))
        .then(
          (r) => setTimeout(() => opts.onload(r), 0),
          (e) => setTimeout(() => opts.onerror(e), 0)
        );
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'eagle-fullsize.user.js' });
  const EBC = sandbox.__EBC__;
  if (!EBC) throw new Error('沙箱导出失败');
  return { EBC, sandbox, requested };
}

/** 找到内置的 eporner 规则 */
export function epornerRule(EBC) {
  const r = EBC.BUILTIN_RULES.find((x) => /eporner/i.test(JSON.stringify(x)));
  if (!r) throw new Error('内置规则里找不到 eporner');
  return r;
}
