/**
 * 规则表结构校验。
 *
 * 存在的理由：这个项目对外承诺的维护方式就是「你只要改 rules/default.json」。
 * 那句承诺必须有个守门人 —— 否则一条 `match` 拼错、`resolve` 少写一个字段的规则
 * 会被直接合并进 main，然后所有装了脚本的人下次启动都会拉到一份坏规则
 * （脚本会回退到内置规则，但那个站就静默失效了）。
 *
 * 这个脚本**故意不 import 油猴脚本本体** —— 只校验数据，做得越快越好，
 * 这样跑一次 CI 只需要毫秒级，不会让人因为「跑测试太慢」而跳过它。
 * 语义层的行为回归由 resolve-harness.mjs / scroll-harness.mjs 负责。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '..', 'rules', 'default.json');

/** resolve 管线的合法策略。新增策略时必须同步这里，否则新规则会被误判为非法。 */
const STEP_TYPES = new Set(['attr', 'rewrite', 'host', 'endpoint', 'pagedata', 'probe', 'detail']);

/** 每种策略必须带的字段。写在这里，让「少写字段」在 CI 里就红，而不是等到用户报告。 */
const STEP_REQUIRED = {
  attr: ['selectors'],
  rewrite: ['rules'],
  host: [],
  probe: ['candidates'],
  detail: ['selectors'],
  endpoint: ['url', 'vars'],
  pagedata: [],
};

const problems = [];
const warn = [];

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`❌ rules/default.json 不是合法 JSON：${e.message}`);
  process.exit(1);
}

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

if (!Number.isInteger(data.version)) problems.push('顶层 version 必须是整数');
if (!isStr(data.updated)) warn.push('顶层 updated 建议写上日期（形如 2026-09-29），便于用户判断新旧');
if (!Array.isArray(data.rules) || !data.rules.length) {
  problems.push('顶层 rules 必须是非空数组');
}

const seen = new Set();
for (const [i, r] of (Array.isArray(data.rules) ? data.rules : []).entries()) {
  const at = `rules[${i}]${r && isStr(r.id) ? ` (${r.id})` : ''}`;
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    problems.push(`${at}: 必须是对象`);
    continue;
  }

  // --- 身份 ---
  if (!isStr(r.id)) problems.push(`${at}: 缺少非空 id`);
  else if (seen.has(r.id)) problems.push(`${at}: id 与前面的规则重复（本地覆盖会按 id 合并，重复会互相打架）`);
  else seen.add(r.id);

  // --- 匹配 ---
  if (!Array.isArray(r.match) || !r.match.length) problems.push(`${at}: match 必须是非空数组`);
  else {
    for (const [j, m] of r.match.entries()) {
      if (!isStr(m)) problems.push(`${at}.match[${j}]: 必须是非空字符串`);
      else if (!/^(\*|https?|file|ftp):\/\//.test(m)) {
        problems.push(
          `${at}.match[${j}]: ${JSON.stringify(m)} 不像 Tampermonkey @match 模式 —— ` +
            '必须以 *:// 或 https?:// 开头（例：*://*.example.com/*）'
        );
      }
    }
  }
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
    problems.push(`${at}: enabled 只能是 true/false（写字符串 "false" 会被当成真值）`);
  }

  // --- 采集 ---
  const c = r.collect;
  if (!c || typeof c !== 'object') problems.push(`${at}: 缺少 collect`);
  else {
    if (!isStr(c.item)) problems.push(`${at}.collect: 缺少 item 选择器`);
    if (c.link !== undefined && !isStr(c.link)) problems.push(`${at}.collect.link: 必须是非空字符串（'self' 或选择器）`);
    if (c.idAttr !== undefined) {
      if (!isStr(c.idAttr)) problems.push(`${at}.collect.idAttr: 必须是非空字符串`);
      else if (!c.idAttr.includes('@')) {
        problems.push(`${at}.collect.idAttr: 写法必须是 <选择器>@<属性>（如 self@data-photo-id）`);
      }
    }
    if (c.scrollToLoad !== undefined && typeof c.scrollToLoad !== 'boolean') {
      problems.push(`${at}.collect.scrollToLoad: 只能是 true/false`);
    }
  }

  // --- resolve 管线 ---
  if (!Array.isArray(r.resolve) || !r.resolve.length) {
    problems.push(`${at}: resolve 必须是非空数组（至少要有一条策略）`);
  } else {
    for (const [j, s] of r.resolve.entries()) {
      const sat = `${at}.resolve[${j}]`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        problems.push(`${sat}: 必须是对象`);
        continue;
      }
      if (!STEP_TYPES.has(s.type)) {
        problems.push(`${sat}: 未知策略 ${JSON.stringify(s.type)}（合法值：${[...STEP_TYPES].join(' / ')}）`);
        continue;
      }
      for (const k of STEP_REQUIRED[s.type] || []) {
        if (s[k] === undefined) problems.push(`${sat} (${s.type}): 缺少必填字段 ${k}`);
      }
      // 逐策略的细节检查
      if (s.type === 'endpoint') {
        if (!isStr(s.url)) problems.push(`${sat} (endpoint): url 必须是非空字符串`);
        else if (!/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(s.url)) {
          warn.push(`${sat} (endpoint): url 里没有 {变量} 占位符 —— 确认这个接口不需要参数`);
        }
        if (s.vars !== undefined && (typeof s.vars !== 'object' || Array.isArray(s.vars))) {
          problems.push(`${sat} (endpoint): vars 必须是 { 变量名: [取值来源…] } 这样的对象`);
        } else if (s.vars && isStr(s.url)) {
          const need = [...s.url.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
          for (const v of need) {
            const src = s.vars[v];
            if (!Array.isArray(src) || !src.length) {
              problems.push(`${sat} (endpoint): url 用到 {${v}}，但 vars 里没有给它取值来源`);
              continue;
            }
            for (const [k, one] of src.entries()) {
              if (!isStr(one)) problems.push(`${sat} (endpoint).vars.${v}[${k}]: 必须是非空字符串`);
              else if (!/^url:/.test(one) && !one.includes('@')) {
                problems.push(
                  `${sat} (endpoint).vars.${v}[${k}]: 写法必须是 '<选择器>@<属性>' 或 'url:<正则>'`
                );
              }
            }
          }
          for (const v of Object.keys(s.vars)) {
            if (!need.includes(v)) warn.push(`${sat} (endpoint): vars 里的 {${v}} 没被 url 用到，是多余的`);
          }
        }
      }
      for (const key of ['rewrite', 'probe', 'detail']) {
        if (s.type !== key) continue;
        const listKey = key === 'rewrite' ? 'rules' : key === 'probe' ? 'candidates' : null;
        if (!listKey) continue;
        const list = s[listKey];
        if (!Array.isArray(list) || !list.length) {
          problems.push(`${sat} (${key}): ${listKey} 必须是非空数组`);
          continue;
        }
        for (const [k, rw] of list.entries()) {
          const rat = `${sat}.${listKey}[${k}]`;
          if (!rw || !isStr(rw.re) || rw.to === undefined) {
            problems.push(`${rat}: 必须是 { re, to }，且 re 非空`);
            continue;
          }
          try {
            new RegExp(rw.re);
          } catch (e) {
            problems.push(`${rat}: 正则写错了 —— ${e.message}`);
          }
        }
      }
      if (s.type === 'attr' && Array.isArray(s.selectors)) {
        for (const [k, sel] of s.selectors.entries()) {
          if (!isStr(sel)) problems.push(`${sat}.selectors[${k}]: 必须是非空字符串`);
          else if (sel !== 'self' && !sel.includes('@')) {
            problems.push(`${sat}.selectors[${k}]: 写法必须是 '<选择器>@<属性>'（如 img@data-src）`);
          }
        }
      }
    }
  }
}

// ---- 图床表（顶层 hosts）守门人 ----
// 存在的理由：v0.5.0 把「缩略图 → 原图」的改写规律从站点规则里抽出来，做成了
// 所有站点共享的图床表。这张表的每一条都是**实测出来的**（这些图床拿不到原图时
// 不返回 404，而是回一张能正常解码的占位图，所以规律写错不会报错，只会静默地把
// 整页收成占位图）。所以字段缺失 / 正则写坏必须在 CI 里红，而不是等用户发现
// 库里全是一模一样的小图。
const REFERRER_POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

const hostIds = new Set();
if (data.hosts !== undefined) {
  if (!Array.isArray(data.hosts) || !data.hosts.length) {
    problems.push('顶层 hosts 若存在，必须是非空数组');
  } else {
    for (const [i, h] of data.hosts.entries()) {
      const at = `hosts[${i}]${h && isStr(h.id) ? ` (${h.id})` : ''}`;
      if (!h || typeof h !== 'object' || Array.isArray(h)) {
        problems.push(`${at}: 必须是对象`);
        continue;
      }
      if (!isStr(h.id)) problems.push(`${at}: 缺少非空 id`);
      else if (hostIds.has(h.id)) problems.push(`${at}: id 与前面的图床重复`);
      else hostIds.add(h.id);

      if (!isStr(h.name)) warn.push(`${at}: 建议补 name（面板/日志里显示它）`);

      // match：命中该图床**图片 URL** 的 glob
      if (!Array.isArray(h.match) || !h.match.length) {
        problems.push(`${at}: match 必须是非空数组（匹配图片 URL，语法同站点规则）`);
      } else {
        for (const [j, m] of h.match.entries()) {
          if (!isStr(m)) problems.push(`${at}.match[${j}]: 必须是非空字符串`);
          else if (!/^(\*|https?|file):\/\//.test(m)) {
            problems.push(`${at}.match[${j}]: 必须以 *:// 或 http(s):// 开头（现在是 ${JSON.stringify(m)}）`);
          }
        }
      }

      // thumbRe / fullTo
      if (!isStr(h.thumbRe)) problems.push(`${at}: 缺少 thumbRe`);
      else {
        try {
          new RegExp(h.thumbRe);
        } catch (e) {
          problems.push(`${at}.thumbRe: 不是合法正则（${e.message}）`);
        }
      }
      if (!isStr(h.fullTo)) problems.push(`${at}: 缺少 fullTo`);
      // fullTo 用了 $1 就必须真有捕获组，否则 $1 会字面出现在 URL 里 ——
      // 那是个**静默失败**：地址看着对，实际 404 或拿到占位图。
      if (isStr(h.fullTo) && /\$\d/.test(h.fullTo) && isStr(h.thumbRe)) {
        if (!/\((?!\?:)/.test(h.thumbRe)) {
          problems.push(`${at}: fullTo 用了 $1 但 thumbRe 里没有捕获组`);
        }
      }

      if (h.referrer !== undefined && !REFERRER_POLICIES.has(h.referrer)) {
        problems.push(`${at}.referrer: ${JSON.stringify(h.referrer)} 不是合法的 ReferrerPolicy`);
      }
      if (!isStr(h.verified)) {
        warn.push(`${at}: 没写 verified 日期 —— 没实测过的规律别当真`);
      }
    }
  }
} else {
  problems.push('顶层缺少 hosts 图床表');
}

// 站点规则里的 host 步骤要有表可查
for (const [i, r] of (Array.isArray(data.rules) ? data.rules : []).entries()) {
  for (const [j, s] of (Array.isArray(r && r.resolve) ? r.resolve : []).entries()) {
    if (s && s.type === 'host' && !hostIds.size) {
      problems.push(`rules[${i}].resolve[${j}]: 用了 host 策略，但 hosts 表是空的`);
    }
  }
}

// 内置表与订阅表不能漂移：订阅里新加的图床，脚本里的 BUILTIN_HOSTS 也得有一份
// （否则拉不到订阅的离线场景下，那条 host 步骤就静默失效）。
try {
  const src = readFileSync(resolve(here, '..', 'eagle-fullsize.user.js'), 'utf8');
  for (const id of hostIds) {
    if (!src.includes(`id: '${id}'`)) {
      problems.push(
        `图床 ${id} 只在 rules/default.json 里，eagle-fullsize.user.js 的 BUILTIN_HOSTS 里没有 —— ` +
          '拉不到订阅时它会静默失效。两处都要加。'
      );
    }
  }
  if (!/const BUILTIN_HOSTS = \[/.test(src)) problems.push('userscript 里找不到 BUILTIN_HOSTS');
} catch (e) {
  problems.push(`读不到 eagle-fullsize.user.js（校验 BUILTIN_HOSTS）：${e.message}`);
}

// ---- 版本漂移守门人 ----
// 为什么要有这一段：Tampermonkey **只看 `@version`** 决定要不要给用户推送更新。
// 改完代码忘了动 `@version`，用户就永远收不到这个版本 —— 而且没有任何报错，
// 表现得就像「推送了但没人更新」。发布 v0.2.0 时就真踩了一次（代码写了 0.2.0、
// 头部还是 0.1.0）。只读头几行文本，不做 VM 加载，所以不影响这个脚本「毫秒级」的定位。
try {
  const src = readFileSync(resolve(here, '..', 'eagle-fullsize.user.js'), 'utf8');
  const header = /^\/\/\s*@version\s+(\S+)\s*$/m.exec(src);
  // 注意 `^\s*`：这行是**缩进过的**（`  const VERSION = '0.2.0';`，在 try 块里）。
  // 第一版写成 `^const VERSION` 恒不匹配，于是守门人永远报「找不到 const VERSION」——
  // 看起来像拦下了问题，其实是在喊狼来了。负例测试必须验证「因为漂移而失败」，
  // 而不是「因为正则写错而失败」。
  const konst = /^\s*const VERSION\s*=\s*'([^']+)';/m.exec(src);
  if (!header) problems.push('userscript 头部找不到 @version');
  else if (!konst) problems.push('userscript 里找不到 const VERSION = \'...\'');
  else if (header[1] !== konst[1]) {
    problems.push(
      `版本号漂移：@version 是 ${header[1]}，而 const VERSION 是 ${konst[1]}。` +
        'Tampermonkey 只认 @version，不同步的话用户收不到这次更新。'
    );
  } else {
    warn.push(`版本号一致：${header[1]}`);
  }
} catch (e) {
  problems.push(`读不到 eagle-fullsize.user.js：${e.message}`);
}

// ---- 编码污染守门人 ----
// 为什么要有这一段：`node --check` 只能抓「乱码破坏了语法」的那种。
// 现实里更阴的是**引号完好、只有正文变成乱码** —— 语法照样通过，CI 全绿，
// 但用户界面上的中文全成了「两个字节拼一个生僻字」的样子。
// 肇事者是 PowerShell 的 `Get-Content -Raw` / `Set-Content`：它们按**系统 ANSI
// 代码页**（简中机器上是 GBK）读写，于是 UTF-8 的中文被逐字节重解释后再存回去。
// 发布 v0.2.0 时把我自己坑了一次：用它做「负例测试」的临时改写，600 处中文被毁，
// 而且写回时还吃掉了收尾的引号。**改这个仓库的任何文件，一律用 UTF-8 工具，
// 不要用 PowerShell 的字符串管道。**
//
// 用 \u 转义写这组字符，是为了让本文件自己不含乱码字符 —— 这样它也能进扫描名单。
// 只挑几乎不可能合法出现的那几个生僻字（见下面的 \u 转义表）。
const MOJIBAKE_RE = /[\u940E\u9225\u950B\u93C2\u938C\u9420\u9411\u947B]/;
for (const rel of ['eagle-fullsize.user.js', 'README.md', 'rules/default.json', 'tests/validate-rules.mjs']) {
  let text;
  try {
    text = readFileSync(resolve(here, '..', rel), 'utf8');
  } catch (e) {
    problems.push(`读不到 ${rel}：${e.message}`);
    continue;
  }
  if (text.includes('\uFFFD')) {
    problems.push(`${rel}: 含替换字符 U+FFFD —— 文件已经不是合法 UTF-8，编码被写坏了`);
  }
  const hit = MOJIBAKE_RE.exec(text);
  if (hit) {
    problems.push(
      `${rel}: 出现乱码字符「${hit[0]}」（U+${hit[0].codePointAt(0).toString(16).toUpperCase()}）—— ` +
        '这个文件八成被 PowerShell 的 Get-Content/Set-Content 处理过（它按系统 ANSI 代码页读写）。' +
        '请从 git 里 checkout 回来，然后用 UTF-8 工具重做改动。'
    );
  }
}

for (const w of warn) console.log(`  ⚠️  ${w}`);
if (problems.length) {
  console.error(`\n❌ rules/default.json 有 ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(`✅ 规则表 OK：${data.rules.length} 条规则（${[...seen].join(', ')}）`);
