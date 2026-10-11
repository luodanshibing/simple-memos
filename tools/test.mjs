// Simple Memos —— 纯逻辑单测
//   运行：node tools/test.mjs
//   不依赖 Obsidian：把 require('obsidian') 换成最小桩件。
//   重点覆盖「兼容旧格式」：列表式（日记里 236 条）与 callout 式（.thino.md）。
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

class Plugin {}
class PluginSettingTab {}
class Setting {}
class Notice {}
class TFile {}
class Modal {}
class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
  }
  registerEvent() {}
  registerDomEvent() {}
}
class MarkdownRenderer {}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') {
    return { Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, ItemView, MarkdownRenderer };
  }
  return originalLoad.call(this, request, ...rest);
};

const SimpleMemosPlugin = require('../main.js');
const T = SimpleMemosPlugin.__test;
const SRC = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => {
  if (cond) pass += 1;
  else fails.push(`✗ ${label}`);
};
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass += 1;
  else fails.push(`✗ ${label}\n    实际：${a}\n    期望：${b}`);
};

/* ---------- 0. 启动开销：读源码断言 ---------- */
const onloadBody = (() => {
  const from = SRC.indexOf('async onload()');
  const to = SRC.indexOf('\n  }\n', from);
  return SRC.slice(from, to);
})();
ok(onloadBody.length > 100, '取到 onload 源码片段');
ok(!/getMarkdownFiles\(|getFiles\(|getAllLoadedFiles/.test(onloadBody), 'onload 不遍历库');
ok(!/registerEvent|registerInterval|setInterval|setTimeout/.test(onloadBody), 'onload 不注册事件 / 定时器');
ok(!/vault\.read|readBinary|adapter\./.test(onloadBody), 'onload 不读文件');
ok(!/workspace\.on\(/.test(onloadBody), 'onload 不注册常驻 workspace 监听');
ok(/onLayoutReady/.test(onloadBody), '只在布局就绪时补一次善后（一次性回调，不是常驻监听）');
ok(/onLayoutReady\(\(\) => this\.recoverStaleLeaves\(\)\)/.test(SRC), '布局就绪后自动重建占位标签页');
ok(/recoverStaleLeaves\(\)/.test(SRC), '有占位标签页的善后方法');

/* ---------- 0b. 视图类的方法名不得撞 Obsidian 的 View API（2026-10-11 真机事故） ---------- */
const viewBody = (() => {
  const from = SRC.indexOf('class MemosView extends ItemView');
  if (from < 0) return '';
  const to = SRC.indexOf('\n}\n', from);
  return SRC.slice(from, to);
})();
ok(viewBody.length > 200, '取到视图类源码');
const viewMethods = [];
const methodRe = /^ {2}([A-Za-z_]\w*)\s*\(/gm;
let mm;
while ((mm = methodRe.exec(viewBody)) !== null) viewMethods.push(mm[1]);
const reserved = ['addAction', 'onResize', 'getState', 'setState', 'onPaneMenu', 'onMoreOptionsMenu', 'getEphemeralState', 'setEphemeralState', 'onLoad', 'onUnload'];
const clashes = viewMethods.filter((m) => reserved.indexOf(m) >= 0);
eq(clashes, [], '视图类没有覆盖 Obsidian 的 View API（addAction 等）');
eq(viewMethods.indexOf('addCardButton') >= 0, false, '已删除无用的 addCardButton（卡片改用 … 菜单）');
eq(/this\.addCardButton\(/.test(SRC), false, '卡片改用 … 菜单，不再有文字按钮');

/* ---------- 0c. 单文件：日期标题用二级 + 列表式备忘要挂上日期（2026-10-11 用户反馈） ---------- */
eq(T.appendWithDayHeading('', '- 09:05 x', '2026-10-11'), '## 2026-10-11\n\n- 09:05 x\n', '按天分组用二级标题');
eq(
  T.appendWithDayHeading('# 2026-10-11\n\n- 08:00 旧', '- 09:05 x', '2026-10-11').indexOf('## 2026-10-11'),
  -1,
  '旧文件里已有一级日期标题时不再补'
);
const singleFileDoc = ['## 2026-10-11', '', '- 18:56 再测试一下', '- 19:02 第二条', '', '## 2026-10-10', '', '- 08:00 昨天的'].join('\n');
const sf = T.parseMemos(singleFileDoc);
eq(sf.length, 3, '单文件里 3 条列表式备忘');
eq(sf[0].dateText, '2026-10-11', '列表式备忘挂上上面的日期标题');
eq(sf[2].dateText, '2026-10-10', '换到下一个日期标题后跟着变');
eq(T.memoSortKey(sf[0], ''), '202610111856', '排序键用日期标题，不再沉底');
eq(T.memoSortKey(sf[0], '') > T.memoSortKey(sf[2], ''), true, '新的在前');

/* ---------- 0d. 写入格式自适应（写到 thino 文件就用 callout，Thino 才读得懂） ---------- */
eq(T.effectiveMemoStyle({ memoStyle: 'callout' }, 'x.md', ''), 'callout', '显式选 callout');
eq(T.effectiveMemoStyle({ storageMode: 'single-file' }, '1 Obsidian/Thino/2026.thino.md', ''), 'callout', '目标是 .thino.md → 自动 callout');
eq(T.effectiveMemoStyle({ storageMode: 'single-file' }, 'a.md', '> [!thino] 2025/01/06 …'), 'callout', '文件里已有 thino 块 → 自动 callout');
eq(T.effectiveMemoStyle({ storageMode: 'single-file' }, 'memos.md', ''), 'list', '普通单文件 → 列表式');
eq(T.effectiveMemoStyle({ storageMode: 'daily-end' }, 'a.md', ''), 'list', '日记模式 → 列表式');

/* ---------- 0e. 热力图（纯函数） ---------- */
const heat = T.heatmapCells([{ dateText: '2026-10-11' }, { dateText: '2026-10-11' }, { dateText: '2026-10-10' }], 2, new Date(2026, 9, 11));
eq(heat.length, 14, '两周 = 14 格');
eq(heat[heat.length - 1].date, '2026-10-11', '最后一格是今天');
eq(heat[heat.length - 1].count, 2, '今天两条');
eq(heat[heat.length - 2].count, 1, '昨天一条');
eq(T.heatLevel(0), 0, '等级 0');
eq(T.heatLevel(1), 1, '等级 1');
eq(T.heatLevel(3), 2, '等级 2');
eq(T.heatLevel(5), 3, '等级 3');
eq(T.heatLevel(9), 4, '等级 4');

/* ---------- 0f. 统计与界面（2026-10-11 用户要求"像 Thino 那样像样"） ---------- */
const statMemos = [
  { tags: ['Thino/摘录', 'Obsidian'], dateText: '2026-10-11' },
  { tags: ['Thino/摘录'], dateText: '2026-10-10' },
  { tags: [], fileDay: '2026-10-10' },
  { tags: [] },
];
eq(T.tagCounts(statMemos), [{ tag: 'Thino/摘录', count: 2 }, { tag: 'Obsidian', count: 1 }], '标签计数并多的在前');
eq(T.tagCounts([]), [], '没有标签返回空数组');
eq(T.activeDayCount(statMemos), 2, '有备忘的天数');
eq(T.activeDayCount([]), 0, '空列表 0 天');
ok(/sm-brand/.test(SRC) && /'MEMOS'/.test(SRC), '工具条有标题 MEMOS');
ok(/renderTags\(\)/.test(SRC), '有常用标签条');
ok(/openCardMenu\(/.test(SRC), '卡片有 … 菜单');
ok(/Menu,/.test(SRC) || /Modal, Menu/.test(SRC), 'Menu 已从 obsidian 解构');
ok(/getLeaf\('tab'\)/.test(SRC), '默认开在主区（不再默认右侧栏）');
ok(/registerView/.test(onloadBody), 'onload 只注册视图');
ok(!/setInterval/.test(SRC), '整个源码没有 setInterval');
ok(/registerEvent\(this\.app\.vault\.on/.test(SRC), '文件监听挂在视图上（随视图注销）');
ok(/leaf\.view instanceof MemosView/.test(SRC), '打开视图时区分真视图与占位标签页');
ok(/getDisplayText\(\)\s*\{\s*return 'memos'/.test(SRC), '标签页标题是 memos');
ok(/读取设置失败/.test(SRC), '读设置失败不会让插件加载失败');

/* ---------- 1. 设置 ---------- */
eq(Object.keys(T.DEFAULT_SETTINGS).length, 15, '默认设置 15 项');
eq(T.DEFAULT_SETTINGS.storageMode, 'daily-end', '默认写日记末尾');
eq(T.DEFAULT_SETTINGS.memoStyle, 'list', '默认用列表式（与 Thino 在日记里的写法一致）');
eq(T.DEFAULT_SETTINGS.deleteMode, 'remove', '默认直接删除');
eq(T.DEFAULT_SETTINGS.hideDeleted, true, '默认藏掉已删除');
eq(T.normalizeSettings(null).storageMode, 'daily-end', 'null → 默认');
eq(T.normalizeSettings({ storageMode: '乱写' }).storageMode, 'daily-end', '非法存储模式回退');
eq(T.normalizeSettings({ memoStyle: 'x' }).memoStyle, 'list', '非法格式回退');
eq(T.normalizeSettings({ deleteMode: 'x' }).deleteMode, 'remove', '非法删除方式回退');
eq(T.normalizeSettings({ recentDays: 99999 }).recentDays, 3650, '天数上限夹紧');
eq(T.normalizeSettings({ recentDays: 0 }).recentDays, 1, '天数下限夹紧');
eq('extra' in T.normalizeSettings({ extra: 1 }), false, '未知键丢弃');

/* ---------- 2. 时间 / 日期 ---------- */
eq(T.pad2(5), '05', 'pad2');
eq(T.dayKey(new Date(2026, 9, 11)), '2026-10-11', 'dayKey');
eq(T.timeKey(new Date(2026, 9, 11, 9, 5)), '09:05', 'timeKey');
eq(T.stampId(new Date(2026, 9, 11, 9, 5, 7)), '20261011090507', 'stampId');
eq(T.formatDaily('YYYY-MM-DD', new Date(2026, 9, 11)), '2026-10-11', 'formatDaily 基础');
eq(T.formatDaily('YYYY-MM-DD【日记】', new Date(2026, 9, 11)), '2026-10-11【日记】', 'formatDaily 带前后缀');

/* ---------- 3. 标签与内联字段 ---------- */
eq(T.extractTags('内容 #Thino/摘录'), ['Thino/摘录'], '抽标签');
eq(T.extractTags('a #Thino/想法 b #Obsidian'), ['Thino/想法', 'Obsidian'], '抽多个标签');
eq(T.extractTags('编号 #123 不是标签'), [], '不把 #123 当标签');
eq(T.extractTags('没有标签'), [], '没有标签返回空');
eq(T.parseInlineFields('x [id::abc] [thinoType::JOURNAL] %%'), { id: 'abc', thinoType: 'JOURNAL' }, '解析内联字段');
eq(T.parseInlineFields('[webId::3223289687313485830]'), { webId: '3223289687313485830' }, '解析 webId');

/* ---------- 4. 列表式备忘（你库里 236 条的真实形态） ---------- */
const l1 = T.parseListMemo('- 21:25 《球状闪电》的一段话 #Thino/摘录 ^ecxegr');
eq(l1.time, '21:25', '列表式：时间');
eq(l1.body, '《球状闪电》的一段话 #Thino/摘录 ^ecxegr', '列表式：正文');
eq(l1.tags, ['Thino/摘录'], '列表式：标签');
eq(l1.deleted, false, '列表式：未删除');
const l2 = T.parseListMemo('- 14:30 - 15:00 不要把对你的评价权交给别人！ #Thino/想法');
eq(l2.time + '/' + l2.endTime, '14:30/15:00', '列表式：时间区间');
eq(T.parseListMemo('- 22:18 测试 [deleted::20260917222125]').deleted, true, '列表式：deleted 标记');
eq(T.parseListMemo('- 22:02 x #Thino/想法 [webId::3223289687313485830]').body.indexOf('webId') > 0, true, '列表式：webId 保留在正文');
eq(T.parseListMemo('- 09:06 **先去做**…').body, '**先去做**…', '列表式：加粗内容');
eq(T.parseListMemo('* 08:53 不焦虑+自律').time, '08:53', '列表式：* 号项目也认');
eq(T.parseListMemo('+ 08:53 x').time, '08:53', '列表式：+ 号项目也认');
eq(T.parseListMemo('- 14:19 '), T.parseListMemo('- 14:19 '), '空内容不炸');
eq(T.parseListMemo('普通段落，不是备忘'), null, '没有时间前缀 → 不是备忘');
eq(T.parseListMemo('- [ ] 待办任务'), null, '普通待办不算备忘');
eq(T.splitBlockId('内容 ^ecxegr').blockId, 'ecxegr', '抽出 block id');
eq(T.splitBlockId('内容 ^ecxegr').body, '内容', 'block id 从正文里去掉');
eq(T.splitBlockId('没有 id').blockId, '', '没有 block id');

/* ---------- 5. 混合文档解析（含 callout 与代码块） ---------- */
const doc = [
  '# 2026-10-11【日记】',
  '',
  '## 1 今日总结',
  '',
  '- 13:49 第一条备忘 #Thino/想法',
  '- 14:15 第二条备忘 ^abc123',
  '',
  '```',
  '- 09:99 代码块里的假备忘',
  '```',
  '',
  '> [!thino] 2025/01/06 12:01:24 %% [id::eb5f81fd88067fec] [thinoType::JOURNAL] %%',
  '> callout 式备忘正文',
  '> 第二行',
  '',
  '普通正文。',
].join('\n');
const memos = T.parseMemos(doc);
eq(memos.length, 3, '混合文档里解析出 3 条（代码块里的不算）');
eq(memos[0].kind + '/' + memos[0].time, 'list/13:49', '第 1 条是列表式');
eq(memos[0].startLine + '/' + memos[0].endLine, '4/4', '列表式行号（单行）');
eq(memos[1].startLine, 5, '第 2 条行号');
eq(memos[2].kind, 'callout', '第 3 条是 callout');
eq(memos[2].dateText + '/' + memos[2].time, '2025-01-06/12:01', 'callout 的日期与时间');
eq(memos[2].id, 'eb5f81fd88067fec', 'callout 的 id');
eq(memos[2].body, 'callout 式备忘正文\n第二行', 'callout 正文（多行）');
eq(memos[2].startLine + '/' + memos[2].endLine, '11/13', 'callout 块的起止行（给删除用）');
eq(T.parseMemos('').length, 0, '空文档 0 条');
eq(T.parseMemos('没有任何备忘').length, 0, '纯正文 0 条');
const delDoc = ['> [!thino] 2025-01-17 00:00:43 %% [id::9096408321c9e436] [thinoType::JOURNAL] [deleted::20260917222268] %%', '> 这是2025年的第一条记录！'].join('\n');
eq(T.parseMemos(delDoc)[0].deleted, true, 'callout 的 deleted 标记');

/* ---------- 6. 生成（写入格式与旧数据同构） ---------- */
eq(T.renderListMemo('21:25', '内容'), '- 21:25 内容', '生成列表式');
eq(T.renderListMemo('21:25', '内容   '), '- 21:25 内容', '生成时去掉行尾空白');
const callout = T.renderCalloutMemo('2026-10-11', '09:05', '第一行\n第二行', 'id1');
eq(
  callout.split('\n'),
  ['> [!thino] 2026/10/11 09:05:00 %% [id::id1] [thinoType::JOURNAL] %%', '> 第一行', '> 第二行'],
  '生成 callout 式（与 .thino.md 同构）'
);
eq(T.parseMemos(callout)[0].body, '第一行\n第二行', '自己生成的能被自己读回（往返）');
eq(T.parseMemos(T.renderListMemo('09:05', '自测'))[0].body, '自测', '列表式往返');

/* ---------- 7. 插入位置 ---------- */
eq(T.frontmatterEnd(['---', 'a: 1', '---', 'body']), 3, 'frontmatterEnd');
eq(T.frontmatterEnd(['body']), 0, '没有 frontmatter');
eq(T.frontmatterEnd(['---', 'a: 1']), 0, '未闭合 frontmatter');
eq(T.appendToEnd('正文', '- 09:05 x'), '正文\n\n- 09:05 x\n', '追加到文末');
eq(T.appendToEnd('', '- 09:05 x'), '- 09:05 x\n', '空文件直接写');
const note = ['# 日记', '', '## 1 总结', '', '已有内容。', '', '## 2 记录', '', '旧记录。'].join('\n');
const under = T.insertUnderHeading(note, '- 09:05 新备忘', '2 记录');
eq(under.split('\n').indexOf('- 09:05 新备忘') > under.split('\n').indexOf('旧记录。'), true, '插到指定章节末尾（顺序追加）');
eq(under.indexOf('已有内容。') < under.indexOf('## 2 记录'), true, '不碰前一个小节');
eq(T.insertUnderHeading(note, 'x', '不存在的标题'), null, '标题不存在返回 null');
eq(T.insertUnderHeading(note, 'x', ''), null, '空标题返回 null');
const grouped = T.appendWithDayHeading('# 2025-01-06\n\n> 旧', '- 09:05 x', '2026-10-11');
eq(grouped.indexOf('# 2026-10-11') > 0, true, '单文件按天分组：新的一天补日期标题');
const grouped2 = T.appendWithDayHeading('# 2026-10-11\n\n- 08:00 旧', '- 09:05 x', '2026-10-11');
eq((grouped2.match(/# 2026-10-11/g) || []).length, 1, '同一天不重复补日期标题');

/* ---------- 8. 三种存储模式 → buildInsert ---------- */
const base = ['# 日记', '', '## Journal', '', '旧备忘。'].join('\n');
eq(T.buildInsert(base, '- 09:05 x', { storageMode: 'daily-end' }, '2026-10-11').placed, 'end', '模式：文末');
eq(T.buildInsert(base, '- 09:05 x', { storageMode: 'daily-heading', headingText: 'Journal' }, '2026-10-11').placed, 'heading', '模式：章节下');
eq(
  T.buildInsert(base, '- 09:05 x', { storageMode: 'daily-heading', headingText: '不存在' }, '2026-10-11').placed,
  'end-fallback',
  '章节找不到 → 退回文末并标记'
);
eq(T.buildInsert('', '- 09:05 x', { storageMode: 'single-file' }, '2026-10-11').placed, 'single', '模式：单文件');
eq(T.buildInsert('', '- 09:05 x', { storageMode: 'single-file' }, '2026-10-11').text, '- 09:05 x\n', '单文件（不分组）直接追加');
eq(
  T.buildInsert('', '- 09:05 x', { storageMode: 'single-file', groupByDayInSingleFile: true }, '2026-10-11').text,
  '## 2026-10-11\n\n- 09:05 x\n',
  '单文件（分组）先写二级日期标题'
);

/* ---------- 9. 删除 / 编辑 ---------- */
const threeLines = ['a', '- 09:05 一', '- 09:06 二', 'b'].join('\n');
eq(T.removeLines(threeLines, 1, 1), ['a', '- 09:06 二', 'b'].join('\n'), '删一行');
eq(T.replaceLines(threeLines, 1, 1, ['- 09:05 改过']), ['a', '- 09:05 改过', '- 09:06 二', 'b'].join('\n'), '替换一行');
const calloutDoc2 = ['x', '> [!thino] 2025/01/06 12:01:24 %% [id::a] [thinoType::JOURNAL] %%', '> 正文', '> 二行', 'y'].join('\n');
eq(T.removeLines(calloutDoc2, 1, 3), ['x', 'y'].join('\n'), '删整个 callout 块');

/* ---------- 10. 排序与目标路径 ---------- */
eq(T.memoSortKey({ dateText: '', time: '09:05' }, '2026-10-11'), '202610110905', '排序键（列表式用文件日期）');
eq(T.memoSortKey({ dateText: '2025-01-06', time: '12:01' }, ''), '202501061201', '排序键（callout 用自身日期）');
ok(T.memoSortKey({ time: '10:00' }, '2026-10-11') > T.memoSortKey({ time: '09:00' }, '2026-10-11'), '晚的在前面');
eq(T.resolveTargetPath({}, { folder: 'B Listing/B3 日记清单', format: 'YYYY-MM-DD【日记】' }, new Date(2026, 9, 11)), 'B Listing/B3 日记清单/2026-10-11【日记】.md', '目标路径：跟随核心日记设置');
eq(T.resolveTargetPath({ dailyFolder: 'X', dailyFormat: 'YYYYMMDD' }, { folder: 'Y', format: 'Z' }, new Date(2026, 9, 11)), 'X/20261011.md', '目标路径：设置覆盖生效');
eq(T.resolveTargetPath({ storageMode: 'single-file', singleFilePath: 'memos.md' }, null, new Date(2026, 9, 11)), 'memos.md', '目标路径：单文件');

/* ---------- 11. 导出 ---------- */
ok(typeof SimpleMemosPlugin === 'function', '默认导出是插件类');
eq(SimpleMemosPlugin.VIEW_TYPE, 'simple-memos-view', '视图类型');
ok(Object.keys(SimpleMemosPlugin.__test).length > 20, '导出的纯函数足够多');

if (fails.length === 0) {
  console.log(`\n通过 ${pass} 项，失败 0 项\n全部通过 ✓\n`);
} else {
  console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项\n`);
  for (const f of fails) console.log(f);
  process.exitCode = 1;
}
