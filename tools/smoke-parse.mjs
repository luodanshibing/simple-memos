// Simple Memos —— 真数据冒烟：拿库里真实的备忘文件验证解析
//   用法：node tools/smoke-parse.mjs <文件或目录> [更多...]
//   为什么要有它：合成单测只能证明"格式读对了"，真文件才证明"能干活"
//   （simple-reading 就是靠这一步才发现真书全用 NCX 的）。
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const require = createRequire(import.meta.url);
class Empty {}
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') {
    return {
      Plugin: Empty,
      PluginSettingTab: Empty,
      Setting: Empty,
      Notice: Empty,
      TFile: Empty,
      Modal: Empty,
      ItemView: Empty,
      MarkdownRenderer: Empty,
    };
  }
  return originalLoad.call(this, request, ...rest);
};
const T = require('../main.js').__test;

const targets = process.argv.slice(2);
if (!targets.length) {
  console.log('用法：node tools/smoke-parse.mjs <文件或目录> [...]');
  process.exit(1);
}

const files = [];
for (const t of targets) {
  let st;
  try {
    st = statSync(t);
  } catch (e) {
    console.log('  跳过（读不到）：' + t);
    continue;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(t)) {
      const p = join(t, name);
      if (statSync(p).isFile() && extname(p).toLowerCase() === '.md') files.push(p);
    }
  } else {
    files.push(t);
  }
}

let total = 0;
let listCount = 0;
let calloutCount = 0;
let deletedCount = 0;
let withTags = 0;
let withBlockId = 0;
let withWebId = 0;
let withTimeRange = 0;
const samples = [];
const filesWithMemos = [];

for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch (e) {
    continue;
  }
  const memos = T.parseMemos(text);
  if (!memos.length) continue;
  filesWithMemos.push({ f, n: memos.length });
  for (const m of memos) {
    total += 1;
    if (m.kind === 'callout') calloutCount += 1;
    else listCount += 1;
    if (m.deleted) deletedCount += 1;
    if ((m.tags || []).length) withTags += 1;
    if (/\^[A-Za-z0-9-]+\s*$/.test(m.body)) withBlockId += 1;
    if (m.body.indexOf('[webId::') >= 0) withWebId += 1;
    if (m.endTime) withTimeRange += 1;
    if (samples.length < 5) samples.push({ f, m });
  }
}

console.log(`扫描 ${files.length} 个文件，其中 ${filesWithMemos.length} 个含备忘`);
console.log(`  共解析 ${total} 条`);
console.log(`    列表式 ${listCount} · callout 式 ${calloutCount}`);
console.log(`    带标签 ${withTags} · 带 ^blockId ${withBlockId} · 带 [webId::] ${withWebId} · 时间区间 ${withTimeRange}`);
console.log(`    已删除标记 ${deletedCount}`);
console.log('  样例：');
for (const s of samples) {
  const m = s.m;
  const body = String(m.body || '').replace(/\n/g, ' ⏎ ').slice(0, 46);
  console.log(`    [${m.kind}] ${m.dateText || ''} ${m.time || ''} | ${body}${m.deleted ? ' (deleted)' : ''}`);
}
const top = filesWithMemos.sort((a, b) => b.n - a.n).slice(0, 5);
console.log('  备忘最多的文件：');
for (const t of top) console.log(`    ${t.n.toString().padStart(4)} 条  ${t.f}`);

// 往返自检：自己生成的，自己必须能读回
const rt = T.parseMemos(T.renderListMemo('09:05', '往返自检 #tag'));
const rtOk = rt.length === 1 && rt[0].body === '往返自检 #tag';
const rt2 = T.parseMemos(T.renderCalloutMemo('2026-10-11', '09:05', '往返\n自检', 'id9'));
const rt2Ok = rt2.length === 1 && rt2[0].body === '往返\n自检' && rt2[0].id === 'id9';
console.log(`  往返自检：列表式 ${rtOk ? 'OK' : '失败'} · callout 式 ${rt2Ok ? 'OK' : '失败'}`);

if (total === 0) {
  console.log('\n没有解析到任何备忘 —— 解析链路有问题');
  process.exitCode = 1;
} else if (!rtOk || !rt2Ok) {
  console.log('\n往返自检失败');
  process.exitCode = 1;
} else {
  console.log('\n真数据解析正常 ✓');
}
