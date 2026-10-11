# Simple Memos

[English](#english) · [简体中文](#简体中文)

---

## English

A lightweight memo pad for Obsidian — the everyday part of Thino / Memos, without the account, the server or the weight.

**Drop-in compatible with the memos you already have**: it reads both shapes Thino writes, and it writes in the same list form, so Thino (or anything else) keeps reading your notes.

| shape | where it lives | example |
|---|---|---|
| list | daily notes (the common case) | `- 21:25 text #Thino/摘录 ^ecxegr` |
| callout | `.thino.md` single files | `> [!thino] 2025/01/06 12:01:24 %% [id::…] [thinoType::JOURNAL] %%` |

Also understood: time ranges (`- 14:30 - 15:00 …`), `[deleted::…]` marks, `[webId::…]`, `^blockid`, and any `#tag`.

### What it does

- A **view** with a compose box on top and a timeline of memo cards below. Cards render Markdown (links, tags, bold — all live), and each card can be **edited / copied / deleted**.
- **Search** box, "load more" for older days, and a status line telling you exactly which files were read.
- **Three write targets**, switchable in settings: **end of the daily note**, **under a heading in the daily note**, or **one file that keeps growing**.
- Two write styles: the list form above, or the `.thino` callout form. Optional `# YYYY-MM-DD` group headings in single-file mode.
- **Deleting**: removes the line (default) or writes Thino's `[deleted::…]` mark so the original text survives.

### Commands

| Command | What it does |
|---|---|
| 打开备忘视图 | Opens the memo view in the right sidebar |
| 快速记录备忘（弹输入框） | Type a memo in a modal, without opening the view |
| 把选中内容存为备忘 | Turns the current selection into a memo |

### Settings

| Setting | Default | Notes |
|---|---|---|
| Save location | end of the daily note | or a heading, or a single file |
| Heading | `Journal` | used by the "under a heading" mode; falls back to the end of the note if missing |
| Single-file path | `memos.md` | can point at an existing `.thino.md` |
| Group single file by day | off | writes `# YYYY-MM-DD` when the day changes |
| Daily folder / format override | empty | empty = follow the core **Daily notes** plugin |
| Memo style | list | or the callout form |
| Deletion | remove the line | or mark with `[deleted::…]` |
| Days loaded at first | 30 | plus a "load more" button |
| Hide deleted memos | on | |

### Uninstalling changes nothing

Memos are ordinary Markdown list items (or callouts) inside your own notes — no custom markers, no private database, no HTML comments. Remove the plugin and every memo is still there, readable by anything.

### Startup and runtime cost

`onload` reads the settings once, registers **one view**, three commands and the settings tab. It does not walk the vault, read a file, or register a listener. The vault's `modify`/`create`/`delete` events are registered **by the view**, so they exist only while the view is open, and the view only reads the last N daily notes plus the single file — never the whole vault. The test suite asserts the startup half of that by reading `main.js` as text.

### Zero dependencies

Plain JavaScript, no build step, no library. `main.js` is both the source and the artifact.

### Install (manual)

1. Copy `main.js`, `manifest.json`, `styles.css` and `versions.json` into `<your vault>/.obsidian/plugins/simple-memos/`.
2. Reload Obsidian, then enable **Simple Memos**.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1 -Vault "E:\Dnotes" -Enable
```

### Development

```bash
node tools/test.mjs        # unit tests, no Obsidian needed
node tools/smoke-parse.mjs "E:\Dnotes\B Listing\B3 日记清单"   # parse real memos
```

The smoke tool exists because synthetic tests only prove the format was read correctly — real files prove it works. (That step is how the sibling plugin `simple-reading` discovered that every real EPUB in this vault uses the older NCX table of contents.)

### License

MIT — see [LICENSE](LICENSE).

---

## 简体中文

给 Obsidian 用的**轻量备忘**：Thino / Memos 的日常功能，**不要账号、不要服务器、不臃肿**。

**和你已有的备忘直接兼容** —— Thino 写过的两种形态它都读，写入又用同一种列表形态，所以 Thino（或别的工具）照样能继续读你的笔记。

| 形态 | 存在哪 | 例子 |
|---|---|---|
| 列表式 | 日记里（你现在的用法） | `- 21:25 内容 #Thino/摘录 ^ecxegr` |
| Callout 式 | `.thino.md` 单文件 | `> [!thino] 2025/01/06 12:01:24 %% [id::…] [thinoType::JOURNAL] %%` |

另外也认：**时间区间**（`- 14:30 - 15:00 …`）、`[deleted::…]` 删除标记、`[webId::…]`、`^blockid`、任意 `#标签`。

### 它能做什么

- 一个**视图**：上面输入框，下面是备忘卡片时间线。卡片把 Markdown 真渲染（链接、标签、加粗都能点），每张卡可**编辑 / 复制 / 删除**。
- **搜索**框、「加载更多」往更早翻、底部状态行告诉你这次到底读了哪些文件、读了多少天。
- **三种写入位置**（设置里切）：**日记末尾** / **日记里指定章节下** / **单个文件不断叠加**。
- 两种写入格式：上面的列表式，或 `.thino` 的 callout 式；单文件模式还能按天自动补 `# YYYY-MM-DD`。
- **删除**：默认直接删掉那一行；也可切成 Thino 那种 `[deleted::…]` 标记（保留原文）。

### 命令

| 命令 | 作用 |
|---|---|
| 打开备忘视图 | 在右侧边栏打开备忘视图 |
| 快速记录备忘（弹输入框） | 不打开视图也能记一条 |
| 把选中内容存为备忘 | 把当前选中的文字变成一条备忘 |

### 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| 保存位置 | 日记末尾 | 也可「日记里指定章节下」或「单个文件」 |
| 章节标题 | `Journal` | 「章节下」模式用；找不到该标题会退回文末并提示 |
| 单文件路径 | `memos.md` | 也可指向已有的 `.thino.md` |
| 单文件按天分组 | 关 | 切到新一天时先写 `# YYYY-MM-DD` |
| 日记目录 / 文件名格式（覆盖） | 空 | 空 = 跟随核心「日记」插件 |
| 备忘格式 | 列表式 | 也可选 callout 式 |
| 删除方式 | 直接删除 | 也可选 `[deleted::…]` 标记 |
| 初次加载天数 | 30 | 另有「加载更多」按钮 |
| 藏掉已删除的备忘 | 开 | |

### 卸载不影响笔记

备忘就是你笔记里**普通的 Markdown 列表项**（或 callout）—— 没有自定义标记、没有私有数据库、没有 HTML 注释。卸载插件后每一条都还在，任何工具都能读。

### 启动与运行开销

`onload` 只读一次设置、注册 **1 个视图**、3 个命令和设置页；**不遍历库、不读文件、不注册监听**。库的 `modify`/`create`/`delete` 事件由**视图**注册 —— 只在视图打开期间存在；视图只读最近 N 天的日记 + 单文件，**从不全库扫描**。测试里有一条**把 `main.js` 当文本读**的断言守着这段结论。

### 零依赖

纯 JavaScript、无构建、无第三方库。`main.js` 既是源码也是产物。

### 安装（手动）

1. 把 `main.js`、`manifest.json`、`styles.css`、`versions.json` 放进 `<你的库>/.obsidian/plugins/simple-memos/`；
2. 重新加载 Obsidian，启用 **Simple Memos**。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1 -Vault "E:\Dnotes" -Enable
```

### 开发

```bash
node tools/test.mjs        # 单测，不需要 Obsidian
node tools/smoke-parse.mjs "E:\Dnotes\B Listing\B3 日记清单"   # 拿真备忘跑解析
```

真数据冒烟这一步是刻意留的：**合成单测只能证明"格式读对了"，真文件才证明"能干活"**（姊妹插件 `simple-reading` 就是靠这一步发现库里每本真 EPUB 都用老式 NCX 目录的）。

### 许可证

MIT，见 [LICENSE](LICENSE)。
