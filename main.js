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
const { Plugin, PluginSettingTab, Setting, Notice, TFile, ItemView, MarkdownRenderer, Modal } = obsidian;

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
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fm = /^\s*(```|~~~)/.exec(line);
    if (fm) {
      if (fence === null) fence = fm[1];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const list = parseListMemo(line);
    if (list) {
      out.push({
        startLine: i,
        endLine: i,
        kind: 'list',
        dateText: '',
        time: list.time,
        endTime: list.endTime,
        body: list.body,
        deleted: list.deleted,
        id: list.id,
        tags: list.tags,
      });
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
function renderListMemo(time, body) {
  return `- ${time} ${String(body == null ? '' : body).replace(/\s+$/, '')}`;
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

/** 单文件按天分组：需要时先补一行 `# YYYY-MM-DD` */
function appendWithDayHeading(text, block, dateKey) {
  const src = String(text == null ? '' : text);
  const has = new RegExp(`^#\\s+${dateKey.replace(/[-]/g, '[-]')}\\s*$`, 'm').test(src);
  if (has) return appendToEnd(src, block);
  return appendToEnd(src, `# ${dateKey}\n\n${block}`);
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

/** 备忘在时间线里的排序键（新的在前）。callout 有日期，列表式用所在文件的日期。 */
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
      id: 'quick-memo',
      name: '快速记录备忘（弹输入框）',
      callback: () => this.quickMemo(),
    });
    this.addCommand({
      id: 'memo-from-selection',
      name: '把选中内容存为备忘',
      editorCallback: (editor) => this.memoFromSelection(editor),
    });

    this.addSettingTab(new SimpleMemosSettingTab(this.app, this));
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
      s.memoStyle === 'callout'
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
  async activateView() {
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
    const leaf = this.app.workspace.getRightLeaf(false);
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
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'memos';
  }

  getIcon() {
    return 'sticky-note';
  }

  async onOpen() {
    this.contentEl.addClass('simple-memos');
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

  buildShell() {
    const root = this.contentEl;
    root.empty();

    const box = root.createDiv({ cls: 'sm-compose' });
    this.inputEl = box.createEl('textarea', { cls: 'sm-input' });
    this.inputEl.rows = 3;
    this.inputEl.placeholder = '记录点什么…（Ctrl/Cmd+Enter 保存）';
    this.inputEl.addEventListener('keydown', (evt) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
        evt.preventDefault();
        this.submit();
      }
    });
    const bar = box.createDiv({ cls: 'sm-compose-bar' });
    this.targetEl = bar.createDiv({ cls: 'sm-target' });
    this.saveBtn = bar.createEl('button', { text: '保存', cls: 'mod-cta sm-btn' });
    this.saveBtn.addEventListener('click', () => this.submit());

    const tools = root.createDiv({ cls: 'sm-tools' });
    this.searchEl = tools.createEl('input', { cls: 'sm-search', type: 'search' });
    this.searchEl.placeholder = '搜索…';
    this.searchEl.addEventListener('input', () => {
      this.query = this.searchEl.value.trim();
      this.renderList();
    });
    const more = tools.createEl('button', { text: '加载更多', cls: 'sm-btn' });
    more.addEventListener('click', () => this.loadMore());
    const refresh = tools.createEl('button', { text: '刷新', cls: 'sm-btn' });
    refresh.addEventListener('click', () => this.reload());

    this.listEl = root.createDiv({ cls: 'sm-list' });
    this.statusEl = root.createDiv({ cls: 'sm-status' });
  }

  async submit() {
    const v = this.inputEl.value.trim();
    if (!v) return;
    try {
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
    const shown = q
      ? this.memos.filter((m) => String(m.body || '').toLowerCase().indexOf(q) >= 0 || (m.tags || []).join(' ').toLowerCase().indexOf(q) >= 0)
      : this.memos;
    if (!shown.length) {
      list.createDiv({ cls: 'sm-empty', text: this.query ? '没有匹配的备忘' : '还没有备忘' });
    }
    for (const m of shown) {
      const card = list.createDiv({ cls: 'sm-card' });
      const head = card.createDiv({ cls: 'sm-card-head' });
      head.createSpan({ cls: 'sm-when', text: `${m.fileDay || m.dateText || ''} ${m.time || ''}`.trim() });
      if (m.deleted) head.createSpan({ cls: 'sm-del-mark', text: '已删除' });
      const acts = head.createDiv({ cls: 'sm-acts' });
      this.addAction(acts, '编辑', 'pencil', () => this.editMemo(m));
      this.addAction(acts, '复制', 'copy', () => this.copyMemo(m));
      this.addAction(acts, '删除', 'trash', () => this.deleteMemo(m));

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
    this.statusEl.setText(`${shown.length} 条${this.query ? `（共 ${this.memos.length} 条）` : ''} · 已读最近 ${this.days} 天`);
  }

  addAction(parent, title, icon, handler) {
    const b = parent.createEl('button', { cls: 'sm-icon sm-btn' });
    b.setAttribute('aria-label', title);
    b.setText(title);
    b.addEventListener('click', (evt) => {
      evt.preventDefault();
      handler();
    });
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
      .setDesc('保存位置选「日记里指定章节下」时用；填标题文字，不带 #；找不到该标题会退回文末并提示')
      .addText((t) => t.setValue(s.headingText).onChange(bind('headingText', (v) => v.trim())));
    new Setting(containerEl)
      .setName('单文件路径')
      .setDesc('保存位置选「单个文件」时用，例如 memos.md；也可以指向已有的 thino 文件')
      .addText((t) => t.setValue(s.singleFilePath).onChange(bind('singleFilePath', (v) => v.trim())));
    new Setting(containerEl)
      .setName('单文件按天分组')
      .setDesc('开启后，切到新的一天时先写一行 `# YYYY-MM-DD`（与 thino 单文件同构）')
      .addToggle((t) => t.setValue(!!s.groupByDayInSingleFile).onChange(bind('groupByDayInSingleFile')));
    new Setting(containerEl)
      .setName('日记目录（覆盖）')
      .setDesc('留空 = 跟随核心「日记」插件设置')
      .addText((t) => t.setValue(s.dailyFolder).onChange(bind('dailyFolder', (v) => v.trim())));
    new Setting(containerEl)
      .setName('日记文件名格式（覆盖）')
      .setDesc('留空 = 跟随核心「日记」插件设置')
      .addText((t) => t.setValue(s.dailyFormat).onChange(bind('dailyFormat', (v) => v.trim())));

    containerEl.createEl('h3', { text: '写入格式' });
    new Setting(containerEl)
      .setName('备忘格式')
      .setDesc('列表式 = `- HH:mm 内容`（与 Thino 在日记里的写法一致）；callout 式 = `> [!thino] …`（与 thino 单文件一致）')
      .addDropdown((d) =>
        d
          .addOption('list', '列表式 `- HH:mm 内容`')
          .addOption('callout', 'Callout 式 `> [!thino] …`')
          .setValue(s.memoStyle)
          .onChange(bind('memoStyle'))
      );
    new Setting(containerEl)
      .setName('删除方式')
      .setDesc('直接删掉那一行，或写成 Thino 那种 [deleted::…] 标记（保留原文）')
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
      .setDesc('打开视图时读最近多少天的日记（1–3650）；下面的「加载更多」可以再加')
      .addSlider((sl) => sl.setLimits(1, 365, 1).setValue(s.recentDays).setDynamicTooltip().onChange(bind('recentDays')));
    new Setting(containerEl)
      .setName('藏掉已删除的备忘')
      .setDesc('把带 [deleted::…] 标记的备忘从时间线里隐藏')
      .addToggle((t) => t.setValue(!!s.hideDeleted).onChange(bind('hideDeleted')));

    containerEl.createEl('h3', { text: '关于' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '启动开销：onload 只读一次设置、注册 1 个视图、3 个命令与设置页 —— 不遍历库、不读文件、不监听事件（文件监听挂在视图上，视图关掉即注销）。',
    });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '写入的东西就是普通 Markdown 列表项（或 callout），没有自定义标记；随时可以卸载，笔记不受影响。' +
        '兼容旧数据：能读 Thino 在日记里的 `- HH:mm 内容`，也能读 `.thino.md` 里的 `> [!thino] …` 块。',
    });
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
  resolveTargetPath,
  formatDaily,
};
