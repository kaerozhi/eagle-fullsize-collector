// xvideos 取证 第 4 步：viewer 机制 —— 大图从哪来
import fs from 'node:fs';
const html = fs.readFileSync(process.argv[2], 'utf8');

// 第一个 gallery-picture 周围 1500 字
const i = html.indexOf('gallery-picture');
console.log('=== 第一个 gallery-picture 前后 1500 字 ===');
console.log(html.slice(Math.max(0, i - 900), i + 900).replace(/\s+/g, ' '));

// 相册相关的 script 块
console.log('\n\n=== 含 gallery/photo/lightbox 的内联 script ===');
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]{0,100000}?)<\/script>/g)].map((m) => m[1]);
scripts.forEach((s, si) => {
  if (/gallery|lightbox|photoswipe|viewer/i.test(s) && s.length > 100) {
    console.log(`\n--- script[${si}] (${s.length} chars) ---`);
    console.log(s.replace(/\s+/g, ' ').slice(0, 1500));
  }
});
