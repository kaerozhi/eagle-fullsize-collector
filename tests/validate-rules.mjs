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
const STEP_TYPES = new Set(['attr', 'rewrite', 'endpoint', 'pagedata', 'probe', 'detail']);

/** 每种策略必须带的字段。写在这里，让「少写字段」在 CI 里就红，而不是等到用户报告。 */
const STEP_REQUIRED = {
  attr: ['selectors'],
  rewrite: ['rules'],
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

for (const w of warn) console.log(`  ⚠️  ${w}`);
if (problems.length) {
  console.error(`\n❌ rules/default.json 有 ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(`✅ 规则表 OK：${data.rules.length} 条规则（${[...seen].join(', ')}）`);
