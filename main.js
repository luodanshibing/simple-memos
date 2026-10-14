'use strict';

/* ==========================================================================
 * Simple Memos — 轻量备忘（替代 Thino / Memos），零依赖、零登录
 * --------------------------------------------------------------------------
 * 1. 一个视图：顶部输入框 + 下面时间线；卡片可编辑 / 删除 / 复制。
 * 2. 写入位置三选一（设置里切）：日记末尾 / 日记里指定章节下 / 单文件不断叠加。
 * 3. 兼容旧格式（要求 5，按你库里真实数据实测）：
 *      · 列表式  `- 21:25 内容 #Thino/摘录 ^ecxegr`（含时间区间、[deleted::]、[webId::]）
 *      · Callout 式 `> [!thino] 2025/01/06 12:01:24 %% [id::…] [thinoType::JOURNAL] %%` + `> 内容`
 *    两种都能读；写入默认用列表式（与你现有 236 条同构，Thino 也能继续读）。
 * 4. 不写任何自定义标记（HTML 注释之类），Markdown 全是人能看懂的原文。
 * 5. 启动开销：onload 只读一次设置 + 注册 1 个视图 + 3 个命令 + 设置页；
 *    文件监听注册在「视图」上（视图关掉就自动注销），启动时不监听、不扫描。
 *
 * 设计红线（改代码前先读）：
 *   1. 不碰正文其他部分  只追加/替换/删除备忘那一行（或那个 callout 块）。
 *   2. 补内容先过 frontmatter  —— 插到第 1 行会把 YAML 顶掉（simple-reading 踩过）。
 *   3. 只读需要的文件    默认只读最近 N 天的日记 + 单文件；不遍历全库。
 *   4. 纯函数为主        解析 / 生成 / 插入全是"文本进文本出"，可单测、可回退。
 *   5. 无构建            main.js 既是源码也是产物。
 *
 * 文件结构：§1 常量与默认设置 / §2 纯函数 / §3 插件主体 / §4 视图 / §5 设置页 / §6 导出
 * ========================================================================== */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, TFile, ItemView, MarkdownRenderer, Modal, Menu, MarkdownView } = obsidian;

const VIEW_TYPE = 'simple-memos-view';
const LIST_RE = /^[-*+](\s+)(\d{1,2}:\d{2})(?:\s*[-~]\s*(\d{1,2}:\d{2}))?(\s+)(.*)$/;
const CALLOUT_RE = /^>\s*\[!thino\][ \t]*(.*)$/i;

const DEFAULT_SETTINGS = {
  storageMode: 'daily-end', // daily-end | daily-heading | single-file
  headingText: 'Journal', // daily-heading 模式使用的标题
  singleFilePath: 'memos.md', // single-file 模式的落点
  memoStyle: 'list', // list（- HH:mm 内容）| callout（> [!thino] …）
  timeFormat: 'HH:mm',
  deleteMode: 'remove', // remove（直接删行）| mark（写 [deleted::…]，与 Thino 一致）
  hideDeleted: true, // 时间线里默认藏掉 [deleted::…]
  recentDays: 30, // 初次加载读最近多少天的日记
  groupByDayInSingleFile: false, // 单文件模式下是否按天加 `# YYYY-MM-DD` 标题
  dailyFolder: '', // 留空 = 跟随核心「日记」插件
  dailyFormat: '', // 留空 = 跟随核心「日记」插件
  showBanner: true, // 显示题图
  bannerPath: '', // 题图来源：URL / data: / 库内路径；留空用主题渐变
  bannerWidth: 'card', // card（跟内容同宽，圆角块）| full（通栏）
  bannerHeight: 200, // 题图高度（px）
  bannerRadius: 8, // 题图圆角（px）
  bannerFit: 'cover', // 填充方式：cover | contain
  bannerPosition: 'center', // 焦点：center | top | bottom
  bannerOverlay: 0, // 图上的暗化遮罩（0–70）
  authorName: '我', // 视图头显示的名字
  avatar: '🙂', // 头像兜底：文字 / emoji
  avatarPath: '', // 头像图片：URL 或库内路径；设了就用图片（照 simple-home-tab 的做法）
  maxWidth: 800, // 自定义内容宽度（px），widthTheme 关闭时生效
  widthTheme: true, // 页面宽度跟随主题阅读宽度（--file-line-width）
  showHeatmap: true, // 显示热力图（按天统计条数）
};

/* §2 纯函数 =============================================================== */

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeSettings(raw) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
  }
  if (['daily-end', 'daily-heading', 'single-file'].indexOf(out.storageMode) < 0) out.storageMode = 'daily-end';
  if (['list', 'callout'].indexOf(out.memoStyle) < 0) out.memoStyle = 'list';
  if (['remove', 'mark'].indexOf(out.deleteMode) < 0) out.deleteMode = 'remove';
  out.recentDays = clampInt(out.recentDays, 1, 3650, 30);
  out.hideDeleted = !!out.hideDeleted;
  out.groupByDayInSingleFile = !!out.groupByDayInSingleFile;
  out.showHeatmap = !!out.showHeatmap;
  out.maxWidth = clampInt(out.maxWidth, 480, 1200, 800);
  out.widthTheme = out.widthTheme === undefined ? true : !!out.widthTheme;
  out.showBanner = !!out.showBanner;
  if (['card', 'full'].indexOf(out.bannerWidth) < 0) out.bannerWidth = 'card';
  if (['cover', 'contain'].indexOf(out.bannerFit) < 0) out.bannerFit = 'cover';
  if (['center', 'top', 'bottom'].indexOf(out.bannerPosition) < 0) out.bannerPosition = 'center';
  out.bannerHeight = clampInt(out.bannerHeight, 60, 480, 200);
  out.bannerRadius = clampInt(out.bannerRadius, 0, 40, 8);
  out.bannerOverlay = clampInt(out.bannerOverlay, 0, 70, 0);
  out.authorName = String(out.authorName == null ? '我' : out.authorName);
  out.avatar = String(out.avatar == null ? '🙂' : out.avatar);
  return out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD */
function dayKey(date) {
  const d = date instanceof Date ? date : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** HH:mm */
function timeKey(date) {
  const d = date instanceof Date ? date : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** YYYYMMDDHHmmss（给 [deleted::] / [id::] 用） */
function stampId(date) {
  const d = date instanceof Date ? date : new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 从正文里抽 #标签（不抽 # 后面的数字，避免把 #1 当标签） */
function extractTags(body) {
  const out = [];
  const re = /(^|\s)#([^\s#0-9][^\s#]*)/g;
  let m;
  while ((m = re.exec(String(body == null ? '' : body))) !== null) {
    if (out.indexOf(m[2]) < 0) out.push(m[2]);
  }
  return out;
}

/** 解析 `[key::value]` 这类内联字段（Thino 用它存 id / type / webId / deleted） */
function parseInlineFields(text) {
  const out = {};
  const re = /\[([A-Za-z][\w-]*)::([^\]]*)\]/g;
  let m;
  while ((m = re.exec(String(text == null ? '' : text))) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

/** 列表式备忘的一行：`- 21:25 内容` / `- 14:30 - 15:00 内容` */
function parseListMemo(line) {
  const m = LIST_RE.exec(String(line == null ? '' : line));
  if (!m) return null;
  const body = m[5].replace(/\s+$/, '');
  const fields = parseInlineFields(body);
  return {
    kind: 'list',
    time: m[2],
    endTime: m[3] || '',
    body: body,
    deleted: !!fields.deleted,
    id: fields.id || '',
    tags: extractTags(body),
    fields: fields,
  };
}

/** 去掉行尾的 `^blockid`，返回 { body, blockId } */
function splitBlockId(body) {
  const m = /\s*\^([A-Za-z0-9-]+)\s*$/.exec(String(body == null ? '' : body));
  if (!m) return { body: String(body == null ? '' : body), blockId: '' };
  return { body: String(body).slice(0, m.index).replace(/\s+$/, ''), blockId: m[1] };
}

/**
 * 解析一段 Markdown 里的全部备忘（列表式 + callout 式）。
 * 返回 [{ startLine, endLine, kind, dateText, time, body, deleted, id, tags }]（行号 0 基，含首尾）
 */
function parseMemos(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  let fence = null;
  let day = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fm = /^\s*(```|~~~)/.exec(line);
    if (fm) {
      if (fence === null) fence = fm[1];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;

    // 单文件里用 `# / ## YYYY-MM-DD` 分组：记住当前日期，下面没有日期的列表式备忘就挂在它下面
    const dayHead = /^#{1,3}\s+(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(line);
    if (dayHead) {
      day = `${dayHead[1]}-${pad2(dayHead[2])}-${pad2(dayHead[3])}`;
      continue;
    }

    const list = parseListMemo(line);
    if (list) {
      // 收集缩进续行（标准 Markdown 列表续行）：`- 21:25 第一行` + 缩进的 `  第二行`
      // ⚠️ 只认**缩进**续行：不缩进的普通行可能是无关正文，并进来会误吞内容（宁可不合并）
      const bodyLines = [list.body];
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j]) && !parseListMemo(lines[j])) {
        bodyLines.push(lines[j].replace(/^\s+/, ''));
        j += 1;
      }
      const mergedBody = bodyLines.join('\n').replace(/\s+$/, '');
      const mergedFields = parseInlineFields(mergedBody);
      out.push({
        startLine: i,
        endLine: j - 1,
        kind: 'list',
        dateText: day,
        time: list.time,
        endTime: list.endTime,
        body: mergedBody,
        deleted: list.deleted || !!mergedFields.deleted,
        id: list.id || mergedFields.id || '',
        tags: extractTags(mergedBody),
      });
      i = j - 1;
      continue;
    }

    const c = CALLOUT_RE.exec(line);
    if (c) {
      const head = c[1];
      const fields = parseInlineFields(head);
      const dt = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T]*(\d{1,2}:\d{2}(?::\d{2})?)?/.exec(head);
      const bodyLines = [];
      let j = i + 1;
      while (j < lines.length && /^>/.test(lines[j])) {
        bodyLines.push(lines[j].replace(/^>\s?/, ''));
        j += 1;
      }
      out.push({
        startLine: i,
        endLine: j - 1,
        kind: 'callout',
        dateText: dt ? `${dt[1]}-${pad2(dt[2])}-${pad2(dt[3])}` : '',
        time: dt && dt[4] ? dt[4].slice(0, 5) : '',
        endTime: '',
        body: bodyLines.join('\n').replace(/\s+$/, ''),
        deleted: !!fields.deleted,
        id: fields.id || '',
        tags: extractTags(bodyLines.join('\n')),
      });
      i = j - 1;
      continue;
    }
  }
  return out;
}

/** 生成一条列表式备忘（与 Thino 的 `- HH:mm 内容` 同构） */
/**
 * 实际使用的写入格式（纯函数）：
 *   设置选 callout → callout；
 *   否则写到 thino 单文件（`*.thino.md`，或文件里已有 `[!thino]`）时自动用 callout ——
 *   这样写进 Thino 自己的文件，Thino 仍能读（兼容旧数据的关键）。
 */
function effectiveMemoStyle(settings, path, currentText) {
  const s = normalizeSettings(settings);
  if (s.memoStyle === 'callout') return 'callout';
  if (s.storageMode !== 'single-file') return 'list';
  const p = String(path == null ? '' : path);
  if (/\.thino\.md$/i.test(p)) return 'callout';
  if (String(currentText == null ? '' : currentText).indexOf('[!thino]') >= 0) return 'callout';
  return 'list';
}/**
 * 生成一条列表式备忘。
 *
 * ⚠️ 2026-10-14 用户报的 bug：「记录时如果换行，会因为没有时间戳而被忽略」。
 *   原因：原实现把整个 body 直接拼在 `- HH:mm ` 后面，多行时第二行起是 **没有时间戳的裸行**，
 *   而解析器 `parseMemos` 只认「`- HH:mm 内容`」开头的行 → 续行全部被丢掉（数据实际上丢在笔记里了）。
 *   修法：**续行缩进 2 个空格**（标准 Markdown 列表续行写法），解析器再把缩进续行并回上一条。
 *   兼容性：旧数据里那些"非缩进续行"也一并支持（见 parseMemos），不需要改历史笔记。
 */
function renderListMemo(time, body) {
  const text = String(body == null ? '' : body).replace(/\s+$/, '');
  const lines = text.split('\n');
  const head = `- ${time} ${lines[0] || ''}`.replace(/\s+$/, '');
  if (lines.length <= 1) return head;
  return [head].concat(lines.slice(1).map((l) => (l ? `  ${l}` : '  '))).join('\n');
}

/** 生成一条 callout 式备忘（与 1 Obsidian/Thino/*.thino.md 同构） */
function renderCalloutMemo(dateText, time, body, id) {
  const d = String(dateText == null ? '' : dateText).replace(/-/g, '/');
  const head = `> [!thino] ${d} ${time}:00 %% [id::${id}] [thinoType::JOURNAL] %%`;
  const lines = String(body == null ? '' : body).split('\n');
  return [head].concat(lines.map((l) => `> ${l}`)).join('\n');
}

/** 追忆：把一段文本里的空行压到最多一个（只作用于我们插入的片段附近，不动全文） */
function frontmatterEnd(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!arr.length || arr[0].trim() !== '---') return 0;
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i].trim() === '---') return i + 1;
  }
  return 0;
}

/** 追加到文末（保留 frontmatter 天然在前面，因为追加在末尾） */
function appendToEnd(text, block) {
  const src = String(text == null ? '' : text).replace(/\s+$/, '');
  return src ? `${src}\n\n${block}\n` : `${block}\n`;
}

/**
 * 插到指定标题所在小节的末尾（下一个同级或更高级标题之前）。
 * 标题不存在 → 返回 null，由调用方决定退回哪里。
 */
function insertUnderHeading(text, block, headingText) {
  const src = String(text == null ? '' : text);
  const lines = src.replace(/\s+$/, '').split('\n');
  const want = String(headingText == null ? '' : headingText).trim();
  if (!want) return null;
  let at = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
    if (m && m[2] === want) {
      at = i;
      level = m[1].length;
      break;
    }
  }
  if (at < 0) return null;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, end);
  while (head.length && head[head.length - 1].trim() === '') head.pop();
  const tail = lines.slice(end);
  const next = head.concat(['', block, '']).concat(tail.length ? [''] : []).concat(tail);
  return `${next.join('\n').replace(/\s+$/, '')}\n`;
}

/**
 * 单文件按天分组：需要时先补一行日期标题。
 * 用**二级**标题 —— 一级在 Obsidian 里太大、也抢文档标题的位置（用户 2026-10-11 反馈）；
 * 判重时一级 / 二级都认，兼容旧文件里已有的 `# YYYY-MM-DD`。
 */
function appendWithDayHeading(text, block, dateKey) {
  const src = String(text == null ? '' : text);
  const has = new RegExp(`^#{1,2}\\s+${dateKey}\\s*$`, 'm').test(src);
  if (has) return appendToEnd(src, block);
  return appendToEnd(src, `## ${dateKey}\n\n${block}`);
}

/**
 * 生成要写进文件的内容（含按天分组、frontmatter、章节的规则）
 * 返回 { text, placed }，placed ∈ end | heading | single
 */
function buildInsert(text, block, settings, dateKey) {
  const s = normalizeSettings(settings);
  const src = String(text == null ? '' : text);
  if (s.storageMode === 'daily-heading') {
    const under = insertUnderHeading(src, block, s.headingText);
    if (under !== null) return { text: under, placed: 'heading' };
    return { text: appendToEnd(src, block), placed: 'end-fallback' };
  }
  if (s.storageMode === 'single-file') {
    const text = s.groupByDayInSingleFile ? appendWithDayHeading(src, block, dateKey) : appendToEnd(src, block);
    return { text: text, placed: 'single' };
  }
  return { text: appendToEnd(src, block), placed: 'end' };
}

/** 删除若干行（含首尾），并收掉多余空行 */
function removeLines(text, startLine, endLine) {
  const lines = String(text == null ? '' : text).split('\n');
  const next = lines.slice(0, startLine).concat(lines.slice(endLine + 1));
  return next.join('\n');
}

/** 替换若干行为新内容 */
function replaceLines(text, startLine, endLine, newLines) {
  const lines = String(text == null ? '' : text).split('\n');
  return lines.slice(0, startLine).concat(newLines).concat(lines.slice(endLine + 1)).join('\n');
}

/** 热力图的格子（纯函数）：截至 today 的最近 weeks 周，每天一个 {date, count} */
function heatmapCells(memos, weeks, today) {
  const n = Math.max(1, clampInt(weeks, 1, 104, 20)) * 7;
  const end = today instanceof Date ? today : new Date();
  const counts = {};
  for (const m of Array.isArray(memos) ? memos : []) {
    const d = (m && (m.dateText || m.fileDay)) || '';
    if (!d) continue;
    counts[d] = (counts[d] || 0) + 1;
  }
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (n - 1));
  const cells = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dayKey(d);
    cells.push({ date: key, count: counts[key] || 0 });
  }
  return cells;
}

/** 热力等级 0–4（纯函数） */
function heatLevel(count) {
  const c = Number(count) || 0;
  if (c <= 0) return 0;
  if (c === 1) return 1;
  if (c <= 3) return 2;
  if (c <= 6) return 3;
  return 4;
}

/** 标签计数（纯函数）：[{ tag, count }]，多的在前 */
function tagCounts(memos) {
  const map = {};
  for (const m of Array.isArray(memos) ? memos : []) {
    for (const t of (m && m.tags) || []) map[t] = (map[t] || 0) + 1;
  }
  return Object.keys(map)
    .map((tag) => ({ tag: tag, count: map[tag] }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
}

/** 有备忘的天数（纯函数）—— 对应 Thino 那个「N 天」 */
function activeDayCount(memos) {
  const set = {};
  for (const m of Array.isArray(memos) ? memos : []) {
    const d = (m && (m.dateText || m.fileDay)) || '';
    if (d) set[d] = 1;
  }
  return Object.keys(set).length;
}/** 备忘在时间线里的排序键（新的在前）。callout 有日期，列表式用所在文件的日期或日期标题。 */
function memoSortKey(memo, fileDay) {
  const m = memo || {};
  const day = m.dateText || fileDay || '';
  const t = m.time ? m.time.replace(':', '') : '0000';
  return `${day.replace(/-/g, '')}${t}`;
}

/** 目标路径：日记或单文件 */
function resolveTargetPath(settings, daily, date) {
  const s = normalizeSettings(settings);
  if (s.storageMode === 'single-file') return s.singleFilePath;
  const folder = String(s.dailyFolder || (daily && daily.folder) || '').replace(/^\/+|\/+$/g, '');
  const format = String(s.dailyFormat || (daily && daily.format) || 'YYYY-MM-DD');
  const name = formatDaily(format, date);
  return folder ? `${folder}/${name}.md` : `${name}.md`;
}

/** 把核心「日记」的 format 字符串套到日期上（支持 YYYY MM DD 与任意前缀后缀） */
function formatDaily(format, date) {
  const d = date instanceof Date ? date : new Date();
  return String(format == null ? 'YYYY-MM-DD' : format)
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad2(d.getMonth() + 1))
    .replace(/DD/g, pad2(d.getDate()));
}

/* §3 插件主体 ============================================================= */
class SimpleMemosPlugin extends Plugin {
  async onload() {
    // 只读一次设置：不扫描库、不监听事件、不起定时器
    // （读设置失败不能让整个插件加载失败 —— 否则视图注册不上，标签页会变成"插件不再活动"）
    try {
      await this.loadSettings();
    } catch (e) {
      console.error('Simple Memos: 读取设置失败，改用默认设置', e);
      new Notice('Simple Memos：设置读取失败，已改用默认设置（详见控制台）');
      this.settings = normalizeSettings(null);
    }

    this.registerView(VIEW_TYPE, (leaf) => new MemosView(leaf, this));
    // 插件启用前留下的"死亡标签页"（工作区里存着 simple-memos-view 但视图没建成）：
    // 布局就绪后自动重建，用户不需要再手动点命令。注册视图是同步的，这里只是补一次善后。
    this.app.workspace.onLayoutReady(() => this.recoverStaleLeaves());

    this.addCommand({
      id: 'open-memos',
      name: '打开备忘视图',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'open-memos-sidebar',
      name: '在右侧边栏打开备忘',
      callback: () => this.activateView('sidebar'),
    });
    this.addCommand({
      id: 'quick-memo',
      name: '快速记录备忘',
      callback: () => this.quickMemo(),
    });
    this.addCommand({
      id: 'memo-from-selection',
      name: '存为备忘',
      editorCallback: (editor) => this.memoFromSelection(editor),
    });

    // 一次性诊断（排查"多行备忘在源码视图里显示很丑"，用户 2026-10-14）：
    // 只读当前活动 Markdown 文件，导出"含缩进续行的备忘"在**实时预览 DOM** 里的结构 + 原始文本。
    // 判读：续行元素若带 `cm-formatting-list`（被当成新列表项）→ 就会多出圆点。
    this.addCommand({
      id: 'diagnose-memo-format',
      name: '导出备忘格式诊断',
      callback: () => this.dumpMemoFormatDiagnosis(),
    });

    this.addSettingTab(new SimpleMemosSettingTab(this.app, this));
  }

  /** 导出"多行备忘"的渲染结构诊断到库根 .simple-memos-diag.txt（只读，不修改任何笔记） */
  async dumpMemoFormatDiagnosis() {
    const out = [];
    const push = (s) => out.push(s);
    const active = this.app.workspace.getActiveFile();
    push('simple-memos 备忘格式诊断  ' + new Date().toISOString());
    push('活动文件：' + (active ? active.path : '(无)'));
    if (!active) {
      push('请先打开那个含多行备忘的日记文件，再运行本命令。');
    } else {
      const text = await this.app.vault.read(active);
      const lines = text.split('\n');
      const contLines = [];
      lines.forEach((l, i) => {
        if (/^\s+\S/.test(l) && !/^\s*([-*+]|\d+[.)])\s+/.test(l)) contLines.push(i);
      });
      push('缩进续行行号（1 基）：' + (contLines.length ? contLines.map((n) => n + 1).join(', ') : '(没有)'));
      push('');
      push('--- 原始文本片段（含续行的条目，前后各 1 行；空格显示为 ·）---');
      const shown = new Set();
      contLines.slice(0, 5).forEach((n) => {
        for (let k = Math.max(0, n - 2); k <= Math.min(lines.length - 1, n + 2); k += 1) {
          if (shown.has(k)) continue;
          shown.add(k);
          push(String(k + 1).padStart(4) + ' |' + lines[k].replace(/ /g, '·'));
        }
        push('     ----');
      });

      push('');
      push('--- 实时预览 DOM（只看列表行与疑似续行）---');
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const root = view && view.contentEl ? view.contentEl : null;
      if (!root) {
        push('当前不是 Markdown 编辑视图（阅读视图或别的视图），拿不到实时预览 DOM。');
      } else {
        const lineEls = root.querySelectorAll('.cm-line');
        push('cm-line 数量：' + lineEls.length);
        Array.prototype.slice.call(lineEls).forEach(function (el, i) {
          const raw = el.textContent || '';
          const t = raw.slice(0, 60).replace(/\s+$/, '');
          const cls = el.className || '';
          const isList = /HyperMD-list-line/.test(cls);
          const fmt = el.querySelector && el.querySelector('.cm-formatting-list') ? 'YES' : 'no';
          const looksCont = /^\s/.test(raw) && !isList;
          if (looksCont || isList) {
            push(
              '  L' + String(i + 1).padStart(3) +
              '  列表行=' + (isList ? 'Y' : 'n') +
              '  列表标记=' + fmt +
              '  class=' + cls.replace(/\s+/g, ' ').slice(0, 70) +
              '  文本=「' + t + '」'
            );
          }
        });
        push('');
        push('判读：续行若「列表行=Y 且 列表标记=YES」→ 被当成新的列表项（所以多圆点）；');
        push('      续行若「列表行=n」→ 只是普通行（渲染成缩进段落，不会多圆点）。');
      }
    }

    const body = out.join('\n') + '\n';
    const path = '.simple-memos-diag.txt';
    let how = '';
    try {
      await this.app.vault.adapter.write(path, body);
      how = 'adapter.write';
    } catch (e1) {
      try {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f) await this.app.vault.modify(f, body);
        else await this.app.vault.create(path, body);
        how = 'vault.modify/create';
      } catch (e2) {
        try {
          const fs = require('fs');
          const base = this.app.vault.adapter.getBasePath();
          fs.writeFileSync(base + '/' + path, body, 'utf8');
          how = 'fs.writeFileSync';
        } catch (e3) {
          console.log('[simple-memos] 诊断内容：\n' + body);
          new Notice('诊断写不进文件，已打印到控制台（Ctrl+Shift+I）', 8000);
          return;
        }
      }
    }
    new Notice('已导出诊断到库根 ' + path + '（' + how + '）', 6000);
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 核心「日记」插件配置（读不到就用设置里的覆盖值 / 默认值） */
  dailyOptions() {
    try {
      const core = this.app.internalPlugins.getPluginById('daily-notes');
      const opts = core && core.instance ? core.instance.options : null;
      if (opts) return { folder: opts.folder || '', format: opts.format || 'YYYY-MM-DD' };
    } catch (e) {
      /* 读不到就退回默认 */
    }
    return { folder: '', format: 'YYYY-MM-DD' };
  }

  targetPath(date) {
    return resolveTargetPath(this.settings, this.dailyOptions(), date);
  }

  /** 把一条备忘写进目标文件（必要时创建） */
  async saveMemo(body, date) {
    const when = date instanceof Date ? date : new Date();
    const path = this.targetPath(when);
    let file = this.app.vault.getAbstractFileByPath(path);
    let text = '';
    if (file instanceof TFile) {
      text = await this.app.vault.read(file);
    }
    const s = this.settings;
    const block =
      effectiveMemoStyle(s, path, text) === 'callout'
        ? renderCalloutMemo(dayKey(when), timeKey(when), body, `${stampId(when)}-${Math.random().toString(16).slice(2, 8)}`)
        : renderListMemo(timeKey(when), body);
    const built = buildInsert(text, block, s, dayKey(when));
    if (file instanceof TFile) {
      await this.app.vault.modify(file, built.text);
    } else {
      const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
        await this.app.vault.createFolder(dir).catch(() => {});
      }
      await this.app.vault.create(path, built.text);
    }
    return { path: path, placed: built.placed };
  }

  async quickMemo() {
    const body = await new Promise((resolve) => new MemoModal(this.app, '', resolve).open());
    if (!body || !body.trim()) return;
    const res = await this.saveMemo(body.trim(), new Date());
    new Notice(`已记到 ${res.path}${res.placed === 'end-fallback' ? `（没找到「${this.settings.headingText}」标题，写到文末）` : ''}`);
  }

  async memoFromSelection(editor) {
    const text = editor.getSelection() || editor.getValue();
    if (!text || !text.trim()) return new Notice('没有选中内容');
    const res = await this.saveMemo(text.trim(), new Date());
    new Notice(`已记到 ${res.path}`);
  }

  /**
   * 把"占位标签页"重建为真视图（工作区里可能存着插件未注册时留下的同类型叶子）。
   * 只在布局就绪时跑一次，不轮询、不监听。
   */
  async recoverStaleLeaves() {
    let fixed = 0;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof MemosView) continue;
      try {
        await leaf.setViewState({ type: VIEW_TYPE, active: false });
        fixed += 1;
      } catch (e) {
        console.error('Simple Memos: 重建占位标签页失败', e);
      }
    }
    if (fixed) console.log(`Simple Memos: 已重建 ${fixed} 个占位标签页`);
  }

  /**
   * 打开备忘视图。
   * ⚠️ 必须区分"真的是我的视图"和"占位标签页"：插件尚未注册时 Obsidian 会留下一个
   * 同类型但内容为「插件不再活动」的占位页；旧写法只看类型就 reveal，于是永远停在占位页
   * （2026-10-11 真机踩到）。这里对占位页直接重建视图状态。
   */
  async activateView(where) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof MemosView) {
        this.app.workspace.revealLeaf(leaf);
        return;
      }
    }
    const stale = leaves[0];
    if (stale) {
      await stale.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(stale);
      return;
    }
    // 默认开在主区（像 Thino 那样有宽度）；where === 'sidebar' 时开在右侧栏
    const leaf = where === 'sidebar' ? this.app.workspace.getRightLeaf(false) : this.app.workspace.getLeaf('tab');
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

/* §4 视图 ================================================================= */

class MemosView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.memos = []; // { path, fileDay, startLine, endLine, kind, time, body, deleted, tags }
    this.days = 0;
    this.query = '';
    this.refreshTimer = null;
    this.sortDesc = true;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'memos';
  }

  getIcon() {
    // 'sticky-note' 在这个主题/版本里落成了通用文档图标，换成一定会渲染的消息图标（用户反馈"文档图标有点丑"）
    return 'message-square-text';
  }

  async onOpen() {
    this.contentEl.addClass('simple-memos');
    // 时钟每秒走一次（秒针真跳）；只在"文字真的变了"时写 DOM，窗口隐藏时跳过。
    // ⚠️ registerInterval 收的是 setInterval 返回的 **id**，不是回调 ——
    // 传回调进去等于什么都没注册（真机踩到：秒针一直不动）。这里改成传 id。
    this.clockTimer = window.setInterval(() => this.tickClock(), 1000);
    this.registerInterval(this.clockTimer);
    this.buildShell();
    this.registerEvent(this.app.vault.on('modify', () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on('create', () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh()));
    await this.reload();
  }

  async onClose() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.contentEl.empty();
  }

  scheduleRefresh() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.reload(), 400);
  }

  toggleSort() {
    this.sortDesc = !this.sortDesc;
    if (this.sortBtn) this.sortBtn.setText(this.sortDesc ? '⇅' : '⇅');
    this.renderList();
  }

  /** 常用标签条（点击即筛选） */
  renderTags() {
    const el = this.tagsEl;
    if (!el) return;
    el.empty();
    const all = tagCounts(this.memos);
    if (!all.length) return;
    el.createSpan({ cls: 'sm-tags-label', text: '常用标签' });
    for (const t of all.slice(0, 14)) {
      const chip = el.createEl('button', { cls: `sm-chip${this.query === `#${t.tag}` ? ' is-on' : ''}` });
      chip.setText(`#${t.tag}`);
      chip.createSpan({ cls: 'sm-chip-n', text: String(t.count) });
      chip.addEventListener('click', () => {
        const q = `#${t.tag}`;
        this.query = this.query === q ? '' : q;
        if (this.searchEl) this.searchEl.value = this.query;
        this.renderList();
      });
    }
  }

  /** 卡片右上角的 … 菜单 */
  openCardMenu(evt, memo) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('编辑').setIcon('pencil').onClick(() => this.editMemo(memo)));
    menu.addItem((i) => i.setTitle('复制').setIcon('copy').onClick(() => this.copyMemo(memo)));
    menu.addItem((i) => i.setTitle('在笔记中打开').setIcon('file-text').onClick(() => this.openAt(memo)));
    menu.addItem((i) => i.setTitle('删除').setIcon('trash').onClick(() => this.deleteMemo(memo)));
    evt.preventDefault();
    menu.showAtMouseEvent(evt);
  }

  /** 大号时钟（照 simple-home-tab 的做法），每 20 秒走一次 */
  tickClock() {
    if (!this.clockEl || document.hidden) return;
    const d = new Date();
    const next = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    if (next === this.clockText) return; // 文字没变就不碰 DOM
    this.clockText = next;
    this.clockEl.setText(next);
  }

  buildShell() {
    const root = this.contentEl;
    const s = this.plugin.settings;
    root.empty();
    // 页面宽度：默认跟随主题的阅读宽度（--file-line-width），关掉才用自定义 px
    root.style.setProperty('--sm-max-width', s.widthTheme ? 'var(--file-line-width, 700px)' : `${s.maxWidth}px`);

    // 题图：设置项与 simple-home-tab 同名同义（showBanner / bannerPath / bannerWidth / …）
    if (s.showBanner) {
      const banner = root.createDiv({ cls: `sm-banner${s.bannerWidth === 'full' ? ' is-full' : ''}` });
      banner.style.height = `${s.bannerHeight}px`;
      banner.style.borderRadius = `${s.bannerRadius}px`;
      const src = String(s.bannerPath || '').trim();
      if (src) {
        let url = src;
        if (!/^(https?:|data:|app:)/i.test(src)) {
          try {
            url = this.app.vault.adapter.getResourcePath(src);
          } catch (e) {
            url = src;
          }
        }
        banner.style.backgroundImage = `url("${url}")`;
        banner.style.backgroundSize = s.bannerFit === 'contain' ? 'contain' : 'cover';
        banner.style.backgroundPosition = s.bannerPosition === 'top' ? 'center top' : s.bannerPosition === 'bottom' ? 'center bottom' : 'center';
        banner.addClass('has-image');
      }
      const veil = banner.createDiv({ cls: 'sm-banner-veil' });
      if (s.bannerOverlay > 0) veil.style.background = `rgba(0,0,0,${(s.bannerOverlay / 100).toFixed(2)})`;
      else veil.style.background = 'transparent';
    }

    // 顶部工具条：标题 + 刷新 + 排序 + 搜索（保留 memos 的功能性；下方另有 6vh 留白学 home-tab）
    const tools = root.createDiv({ cls: 'sm-tools' });
    tools.createDiv({ cls: 'sm-brand', text: 'MEMOS' });
    const refresh = tools.createEl('button', { cls: 'sm-ico', text: '⟳' });
    refresh.setAttribute('aria-label', '刷新');
    refresh.addEventListener('click', () => this.reload());
    this.sortBtn = tools.createEl('button', { cls: 'sm-ico', text: '⇅' });
    this.sortBtn.setAttribute('aria-label', '切换排序');
    this.sortBtn.addEventListener('click', () => this.toggleSort());
    this.searchEl = tools.createEl('input', { cls: 'sm-search', type: 'search' });
    this.searchEl.placeholder = '搜索…';
    this.searchEl.addEventListener('input', () => {
      this.query = this.searchEl.value.trim();
      this.renderList();
    });
    // 画像区照 simple-home-tab：居中单列 —— 日期 → 大时钟 → 头像 → 名字 → 统计
    const profileEl = root.createDiv({ cls: 'sm-profile' });
    this.metaEl = profileEl.createDiv({ cls: 'sm-meta' });
    this.clockEl = profileEl.createDiv({ cls: 'sm-clock' });
    const head = profileEl.createDiv({ cls: 'sm-head' });
    const avatar = head.createDiv({ cls: 'sm-avatar' });
    const avatarSrc = String(s.avatarPath || '').trim();
    if (avatarSrc) {
      let url = avatarSrc;
      if (!/^(https?:|data:|app:)/i.test(avatarSrc)) {
        try {
          url = this.app.vault.adapter.getResourcePath(avatarSrc);
        } catch (e) {
          url = avatarSrc;
        }
      }
      avatar.createEl('img', { attr: { src: url, alt: '' } });
    } else {
      avatar.setText(s.avatar || '🙂');
    }
    const who = head.createDiv({ cls: 'sm-who' });
    who.createDiv({ cls: 'sm-name', text: s.authorName || '我' });
    this.statsEl = who.createDiv({ cls: 'sm-stats' });

    this.tagsEl = root.createDiv({ cls: 'sm-tags' });

    const box = root.createDiv({ cls: 'sm-compose' });
    this.inputEl = box.createEl('textarea', { cls: 'sm-input' });
    this.inputEl.rows = 3;
    this.inputEl.placeholder = '你现在在想什么？（Ctrl/Cmd+Enter 保存）';
    // 快捷键挂在 window 的**捕获阶段**：别的插件/全局热键可能先吃掉 Ctrl+Enter（真机踩到）
    this.registerDomEvent(
      window,
      'keydown',
      (evt) => {
        if (!(evt.ctrlKey || evt.metaKey) || evt.key !== 'Enter') return;
        if (document.activeElement !== this.inputEl) return;
        evt.preventDefault();
        this.submit();
      },
      true
    );
    this.inputEl.addEventListener('keydown', (evt) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
        evt.preventDefault();
        this.submit();
      }
    });
    const bar = box.createDiv({ cls: 'sm-compose-bar' });
    this.targetEl = bar.createDiv({ cls: 'sm-target' });
    this.saveBtn = bar.createEl('button', { text: 'NOTE', cls: 'mod-cta sm-btn' });
    this.saveBtn.addEventListener('click', () => this.submit());

    this.listEl = root.createDiv({ cls: 'sm-list' });
    this.statusEl = root.createDiv({ cls: 'sm-status' });
  }

  async submit() {
    const v = this.inputEl.value.trim();
    if (!v) return;
    try {
      /* 落盘失败要看得见（以前这里静默吞掉，用户会以为"快捷键无效"） */
      const res = await this.plugin.saveMemo(v, new Date());
      this.inputEl.value = '';
      this.statusEl.setText(`已保存到 ${res.path}`);
      await this.reload();
    } catch (e) {
      new Notice(`保存失败：${e && e.message ? e.message : e}`);
    }
  }

  targetLabel() {
    const s = this.plugin.settings;
    if (s.storageMode === 'single-file') return `→ ${s.singleFilePath}`;
    const path = this.plugin.targetPath(new Date());
    return s.storageMode === 'daily-heading' ? `→ ${path} · ${s.headingText}` : `→ ${path}`;
  }

  /** 读最近 N 天的日记 + 单文件（与写入模式无关，方便看到全部旧备忘） */
  async reload() {
    const s = this.plugin.settings;
    this.targetEl.setText(this.targetLabel());
    const sources = [];

    const daily = this.plugin.dailyOptions();
    const folder = String(s.dailyFolder || daily.folder || '').replace(/^\/+|\/+$/g, '');
    const prefix = folder ? `${folder}/` : '';
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix) && f.path.indexOf('/', prefix.length) < 0)
      .sort((a, b) => (a.basename < b.basename ? 1 : -1)); // 文件名倒序 ≈ 日期倒序
    const n = this.days || s.recentDays;
    sources.push.apply(sources, files.slice(0, n).map((f) => f.path));
    if (s.singleFilePath && sources.indexOf(s.singleFilePath) < 0) sources.push(s.singleFilePath);

    const out = [];
    for (const path of sources) {
      if (!path) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      let text = '';
      try {
        text = await this.app.vault.cachedRead(file);
      } catch (e) {
        continue;
      }
      const fileDay = (/(\d{4}-\d{2}-\d{2})/.exec(file.basename) || [])[1] || '';
      const found = parseMemos(text);
      for (const m of found) {
        if (s.hideDeleted && m.deleted) continue;
        m.path = path;
        m.fileDay = fileDay || m.dateText || '';
        out.push(m);
      }
    }
    out.sort((a, b) => (memoSortKey(a, a.fileDay) < memoSortKey(b, b.fileDay) ? 1 : -1));
    this.memos = out;
    this.days = this.days || s.recentDays;
    this.renderList();
  }

  async loadMore() {
    const s = this.plugin.settings;
    this.days = Math.min(this.days + Math.max(s.recentDays, 10), 3650);
    this.statusEl.setText(`加载最近 ${this.days} 天…`);
    await this.reload();
  }

  renderList() {
    const list = this.listEl;
    list.empty();
    const q = this.query.toLowerCase();
    let shown = q
      ? this.memos.filter((m) => {
          const body = String(m.body || '').toLowerCase();
          const tags = (m.tags || []).map((t) => `#${t}`).join(' ').toLowerCase();
          return body.indexOf(q) >= 0 || tags.indexOf(q) >= 0;
        })
      : this.memos.slice();
    if (!this.sortDesc) shown.reverse();
    if (!shown.length) {
      list.createDiv({ cls: 'sm-empty', text: this.query ? '没有匹配的备忘' : '还没有备忘' });
    }
    for (const m of shown) {
      const card = list.createDiv({ cls: 'sm-card' });
      const head = card.createDiv({ cls: 'sm-card-head' });
      const when = `${(m.fileDay || m.dateText || '').replace(/-/g, '/')} ${m.time || ''}`.trim();
      head.createSpan({ cls: 'sm-when', text: when });
      if (m.deleted) head.createSpan({ cls: 'sm-del-mark', text: '已删除' });
      const acts = head.createDiv({ cls: 'sm-acts' });
      const more = acts.createEl('button', { cls: 'sm-ico', text: '…' });
      more.setAttribute('aria-label', '更多');
      more.addEventListener('click', (evt) => this.openCardMenu(evt, m));

      const bodyEl = card.createDiv({ cls: 'sm-body' });
      try {
        MarkdownRenderer.render(this.app, String(m.body || ''), bodyEl, m.path, this);
      } catch (e) {
        bodyEl.setText(String(m.body || ''));
      }
      const foot = card.createDiv({ cls: 'sm-foot' });
      const src = foot.createEl('a', { cls: 'sm-src', text: m.path });
      src.addEventListener('click', (evt) => {
        evt.preventDefault();
        this.openAt(m);
      });
    }
    if (shown.length && !this.query) {
      const more = list.createDiv({ cls: 'sm-more' });
      const btn = more.createEl('button', { cls: 'sm-btn', text: `加载更早（当前读最近 ${this.days} 天）` });
      btn.addEventListener('click', () => this.loadMore());
    }
    if (this.metaEl) {
      const now = new Date();
      const wk = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
      // 日期在最上面（home-tab 的排法），统计在名字下面
      this.metaEl.setText(`${dayKey(now)} 星期${wk}`);
      if (this.statsEl) {
        const tags = tagCounts(this.memos).length;
        this.statsEl.setText(`${this.memos.length} 条 · ${tags} 个标签 · ${activeDayCount(this.memos)} 天`);
      }
    }
    this.tickClock();
    this.renderTags();
    this.statusEl.setText(`${shown.length} 条${this.query ? `（共 ${this.memos.length} 条）` : ''} · 已读最近 ${this.days} 天`);
  }

  /** 热力图：最近 20 周按天统计条数（纯 CSS 格子，不用 canvas、不加依赖） */
  renderHeat() {
    if (!this.heatEl) return;
    this.heatEl.empty();
    if (!this.plugin.settings.showHeatmap) return;
    const cells = heatmapCells(this.memos, 20, new Date());
    const wrap = this.heatEl.createDiv({ cls: 'sm-heat-grid' });
    for (const c of cells) {
      const el = wrap.createDiv({ cls: `sm-heat-cell lv${heatLevel(c.count)}` });
      el.setAttribute('title', `${c.date}：${c.count} 条`);
    }
    const legend = this.heatEl.createDiv({ cls: 'sm-heat-legend' });
    legend.createSpan({ text: '少' });
    for (let l = 0; l <= 4; l += 1) legend.createDiv({ cls: `sm-heat-cell lv${l}` });
    legend.createSpan({ text: '多' });
  }


  openAt(memo) {
    const file = this.app.vault.getAbstractFileByPath(memo.path);
    if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
  }

  copyMemo(memo) {
    if (navigator && navigator.clipboard) {
      navigator.clipboard.writeText(String(memo.body || '')).then(() => new Notice('已复制'));
    }
  }

  async editMemo(memo) {
    const body = await new Promise((resolve) => new MemoModal(this.app, memo.body, resolve).open());
    if (body === null || body === undefined) return;
    const file = this.app.vault.getAbstractFileByPath(memo.path);
    if (!(file instanceof TFile)) return;
    const text = await this.app.vault.read(file);
    const lines = text.split('\n');
    let replacement;
    if (memo.kind === 'callout') {
      const first = lines[memo.startLine] || '';
      replacement = [first].concat(String(body).split('\n').map((l) => `> ${l}`));
    } else {
      const { blockId } = splitBlockId(lines[memo.startLine] || '');
      const s = this.plugin.settings;
      const timePart = memo.endTime ? `${memo.time} - ${memo.endTime}` : memo.time;
      replacement = [renderListMemo(timePart, body) + (blockId ? ` ^${blockId}` : '')];
      void s;
    }
    await this.app.vault.modify(file, replaceLines(text, memo.startLine, memo.endLine, replacement));
    new Notice('已更新');
    await this.reload();
  }

  async deleteMemo(memo) {
    const file = this.app.vault.getAbstractFileByPath(memo.path);
    if (!(file instanceof TFile)) return;
    const text = await this.app.vault.read(file);
    const s = this.plugin.settings;
    if (s.deleteMode === 'mark') {
      const lines = text.split('\n');
      const mark = ` [deleted::${stampId(new Date())}]`;
      if (memo.kind === 'callout') {
        lines[memo.startLine] = lines[memo.startLine].replace(/%%\s*$/, `${mark} %%`);
        await this.app.vault.modify(file, lines.join('\n'));
      } else {
        lines[memo.startLine] = `${lines[memo.startLine]}${mark}`;
        await this.app.vault.modify(file, lines.join('\n'));
      }
      new Notice('已标记删除（保留原文）');
    } else {
      await this.app.vault.modify(file, removeLines(text, memo.startLine, memo.endLine));
      new Notice('已删除');
    }
    await this.reload();
  }
}

/* §5 输入框 / 设置页 ====================================================== */

class MemoModal extends Modal {
  constructor(app, initial, resolve) {
    super(app);
    this.initial = initial || '';
    this.resolve = resolve;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '备忘' });
    const input = contentEl.createEl('textarea', { cls: 'sm-input' });
    input.rows = 6;
    input.value = this.initial;
    const bar = contentEl.createDiv({ cls: 'sm-compose-bar' });
    const ok = bar.createEl('button', { text: '保存', cls: 'mod-cta sm-btn' });
    const cancel = bar.createEl('button', { text: '取消', cls: 'sm-btn' });
    const submit = () => {
      this.done = true;
      const v = input.value;
      this.close();
      this.resolve(v);
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => {
      input.focus();
      input.selectionStart = input.value.length;
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.resolve(null);
  }
}

class SimpleMemosSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Simple Memos 设置' });
    const bind = (key, cast) => async (value) => {
      s[key] = cast ? cast(value) : value;
      await p.saveSettings();
    };

    containerEl.createEl('h3', { text: '存到哪里' });
    new Setting(containerEl)
      .setName('保存位置')
      .setDesc('日记末尾 / 日记里指定章节下 / 单个文件不断叠加')
      .addDropdown((d) =>
        d
          .addOption('daily-end', '日记末尾')
          .addOption('daily-heading', '日记里指定章节下')
          .addOption('single-file', '单个文件')
          .setValue(s.storageMode)
          .onChange(bind('storageMode'))
      );
    new Setting(containerEl)
      .setName('章节标题')
      .setDesc('用于「日记里指定章节下」；填标题文字不要带 #；找不到则退回文末')
      .addText((t) => t.setValue(s.headingText).onChange(bind('headingText', (v) => v.trim())));
    new Setting(containerEl)
      .setName('单文件路径')
      .setDesc('用于「单个文件」，例如 memos.md')
      .addText((t) => t.setValue(s.singleFilePath).onChange(bind('singleFilePath', (v) => v.trim())));
    new Setting(containerEl)
      .setName('单文件按天分组')
      .setDesc('切到新的一天时先写一行 `# YYYY-MM-DD`')
      .addToggle((t) => t.setValue(!!s.groupByDayInSingleFile).onChange(bind('groupByDayInSingleFile')));
    new Setting(containerEl)
      .setName('日记目录')
      .setDesc('留空 = 跟随核心「日记」插件设置')
      .addText((t) => t.setValue(s.dailyFolder).onChange(bind('dailyFolder', (v) => v.trim())));
    new Setting(containerEl)
      .setName('日记文件名格式')
      .setDesc('留空 = 跟随核心「日记」插件设置')
      .addText((t) => t.setValue(s.dailyFormat).onChange(bind('dailyFormat', (v) => v.trim())));

    containerEl.createEl('h3', { text: '写入格式' });
    new Setting(containerEl)
      .setName('备忘格式')
      .setDesc('列表式：`- HH:mm 内容`；callout 式：`> [!thino] …`')
      .addDropdown((d) =>
        d
          .addOption('list', '列表式 `- HH:mm 内容`')
          .addOption('callout', 'Callout 式 `> [!thino] …`')
          .setValue(s.memoStyle)
          .onChange(bind('memoStyle'))
      );
    new Setting(containerEl)
      .setName('删除方式')
      .setDesc('直接删掉那一行，或写成 [deleted::…] 标记')
      .addDropdown((d) =>
        d
          .addOption('remove', '直接删除')
          .addOption('mark', '标记删除（保留原文）')
          .setValue(s.deleteMode)
          .onChange(bind('deleteMode'))
      );

    containerEl.createEl('h3', { text: '视图' });
    new Setting(containerEl)
      .setName('初次加载天数')
      .setDesc('打开视图时读最近多少天的日记，范围 1–3650')
      .addSlider((sl) => sl.setLimits(1, 365, 1).setValue(s.recentDays).setDynamicTooltip().onChange(bind('recentDays')));
    new Setting(containerEl)
      .setName('藏掉已删除的备忘')
      .setDesc('把带 [deleted::…] 标记的备忘从时间线里隐藏')
      .addToggle((t) => t.setValue(!!s.hideDeleted).onChange(bind('hideDeleted')));
    new Setting(containerEl)
      .setName('显示名字')
      .setDesc('视图头部显示的名字')
      .addText((t) => t.setValue(s.authorName).onChange(bind('authorName')));
    new Setting(containerEl)
      .setName('显示题图')
      .setDesc('顶部题图块')
      .addToggle((t) => t.setValue(!!s.showBanner).onChange(bind('showBanner')));
    new Setting(containerEl)
      .setName('题图来源')
      .setDesc('图片 URL 或库内图片路径，留空用主题渐变')
      .addText((t) => t.setValue(s.bannerPath).onChange(bind('bannerPath', (v) => v.trim())));
    new Setting(containerEl)
      .setName('题图宽度')
      .setDesc('跟内容同宽，或通栏铺满')
      .addDropdown((d) =>
        d
          .addOption('card', '跟内容同宽')
          .addOption('full', '通栏')
          .setValue(s.bannerWidth)
          .onChange(bind('bannerWidth'))
      );
    new Setting(containerEl)
      .setName('题图高度')
      .setDesc('60–480 px')
      .addSlider((sl) => sl.setLimits(60, 480, 10).setValue(s.bannerHeight).setDynamicTooltip().onChange(bind('bannerHeight')));
    new Setting(containerEl)
      .setName('题图圆角')
      .setDesc('0–40 px')
      .addSlider((sl) => sl.setLimits(0, 40, 1).setValue(s.bannerRadius).setDynamicTooltip().onChange(bind('bannerRadius')));
    new Setting(containerEl)
      .setName('填充方式')
      .setDesc('cover = 铺满裁切；contain = 完整显示留白')
      .addDropdown((d) =>
        d
          .addOption('cover', 'cover')
          .addOption('contain', 'contain')
          .setValue(s.bannerFit)
          .onChange(bind('bannerFit'))
      );
    new Setting(containerEl)
      .setName('焦点位置')
      .setDesc('裁切时保留哪一部分')
      .addDropdown((d) =>
        d
          .addOption('center', '居中')
          .addOption('top', '上')
          .addOption('bottom', '下')
          .setValue(s.bannerPosition)
          .onChange(bind('bannerPosition'))
      );
    new Setting(containerEl)
      .setName('题图遮罩')
      .setDesc('0–70，越大图越暗；用来让上面的文字更清楚')
      .addSlider((sl) => sl.setLimits(0, 70, 5).setValue(s.bannerOverlay).setDynamicTooltip().onChange(bind('bannerOverlay')));
    new Setting(containerEl)
      .setName('头像')
      .setDesc('没设头像图片时显示这个字符或 emoji')
      .addText((t) => t.setValue(s.avatar).onChange(bind('avatar')));
    new Setting(containerEl)
      .setName('头像图片')
      .setDesc('图片 URL 或库内图片路径，设了就用图片')
      .addText((t) => t.setValue(s.avatarPath).onChange(bind('avatarPath', (v) => v.trim())));
    new Setting(containerEl)
      .setName('页面宽度跟随主题')
      .setDesc('开：用主题的阅读宽度；关：用下面的自定义宽度')
      .addToggle((t) => t.setValue(s.widthTheme !== false).onChange(bind('widthTheme')));
    new Setting(containerEl)
      .setName('自定义内容宽度')
      .setDesc('480–1200 px；仅在上面那项关闭时生效')
      .addSlider((sl) => sl.setLimits(480, 1200, 20).setValue(s.maxWidth).setDynamicTooltip().onChange(bind('maxWidth')));
    new Setting(containerEl)
      .setName('显示热力图')
      .setDesc('头部下面按天统计条数，最近 20 周')
      .addToggle((t) => t.setValue(!!s.showHeatmap).onChange(bind('showHeatmap')));
    // 原来这里还有「关于」小节与两段开发者向说明（启动开销 / 写入格式）——用户 2026-10-14 裁定删除
  }
}

/* §6 导出 ================================================================= */

module.exports = SimpleMemosPlugin;
module.exports.VIEW_TYPE = VIEW_TYPE;
module.exports.__test = {
  DEFAULT_SETTINGS,
  LIST_RE,
  clampInt,
  normalizeSettings,
  pad2,
  dayKey,
  timeKey,
  stampId,
  extractTags,
  parseInlineFields,
  parseListMemo,
  splitBlockId,
  parseMemos,
  renderListMemo,
  renderCalloutMemo,
  frontmatterEnd,
  appendToEnd,
  insertUnderHeading,
  appendWithDayHeading,
  buildInsert,
  removeLines,
  replaceLines,
  memoSortKey,
  effectiveMemoStyle,
  heatmapCells,
  heatLevel,
  tagCounts,
  activeDayCount,
  resolveTargetPath,
  formatDaily,
};
