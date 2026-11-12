'use strict';

/* ================================================================== *
 * Basics
 * ================================================================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const LS_NOTES = 'notes.v1';
const LS_CFG = 'notes.cfg';
const LS_LAST = 'notes.lastSync';
const LS_PREFS = 'notes.prefs';
const DIR = 'notes';

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2400);
}

function formatDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

/* ================================================================== *
 * State
 * ================================================================== */
/** Note: { id, title, body, tags[], updated (ms), pinned, sha (last synced blob), dirty, deleted } */
let notes = load(LS_NOTES, []).map((n) => ({ tags: [], ...n }));
const cfg = Object.assign({ owner: 'fuzzhawk', repo: 'Notes', branch: 'main', token: '' }, load(LS_CFG, {}));
const prefs = Object.assign(
  { font: 'sans', size: 'm', spacing: 'normal', toolbar: 'on', player: false, loop: false, track: null, catSort: 'az' },
  load(LS_PREFS, {})
);

function persist() {
  if (!save(LS_NOTES, notes)) toast('Storage is full — could not save on this device');
}
const savePrefs = () => save(LS_PREFS, prefs);
const byId = (id) => notes.find((n) => n.id === id);
const liveNotes = () => notes.filter((n) => !n.deleted);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ================================================================== *
 * Layers: drawer, pages, editor, dialogs. Each one is a history entry,
 * so the Android back button / gesture closes the top one.
 * ================================================================== */
const layers = [];
let skipPop = false;
let afterPop = null;

function pushLayer(name, close) {
  layers.push({ name, close });
  history.pushState({ layer: layers.length }, '');
}
/** Swap the top layer for another without touching history (e.g. drawer -> page). */
function replaceTop(name, close) {
  const top = layers.pop();
  if (top) top.close();
  layers.push({ name, close });
  history.replaceState({ layer: layers.length }, '');
}
const popLayer = () => layers.length && history.back();
const topLayer = () => (layers.length ? layers[layers.length - 1].name : null);
const hasLayer = (name) => layers.some((l) => l.name === name);

/** Close the top `n` layers (all by default), then run `then`. */
function unwind(n, then) {
  n = Math.min(n ?? layers.length, layers.length);
  if (!n) return then && then();
  for (let i = 0; i < n; i++) layers.pop().close();
  skipPop = true;
  afterPop = then || null;
  history.go(-n);
}

window.addEventListener('popstate', () => {
  if (skipPop) {
    skipPop = false;
    const f = afterPop;
    afterPop = null;
    if (f) f();
    return;
  }
  const top = layers.pop();
  if (top) top.close();
});

// Called by the Android app for the system back button. Returns true if handled.
window.appBack = function () {
  if (layers.length) {
    history.back();
    return true;
  }
  if (tagFilter || $('#search').value) {
    tagFilter = null;
    $('#search').value = '';
    render();
    return true;
  }
  return false;
};
// Called by the Android app when it goes to the background.
window.appPause = function () {
  flushEditor();
  if (notes.some((n) => n.dirty)) sync(false);
};

/* ================================================================== *
 * Notes list + search
 * ================================================================== */
let tagFilter = null;

function parseQuery() {
  const words = [];
  const tags = [];
  for (const t of $('#search').value.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (t.startsWith('#') && t.length > 1) tags.push(t.slice(1));
    else words.push(t);
  }
  return { words, tags };
}

function matches(note, q) {
  const hay = (note.title + '\n' + note.body + '\n' + note.tags.join(' ')).toLowerCase();
  const tags = note.tags.map((t) => t.toLowerCase());
  return (
    (!tagFilter || tags.includes(tagFilter.toLowerCase())) &&
    q.words.every((w) => hay.includes(w)) &&
    q.tags.every((t) => tags.some((x) => x.startsWith(t)))
  );
}

function highlight(text, terms) {
  if (!terms.length) return esc(text);
  const pattern = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text
    .split(new RegExp(`(${pattern})`, 'gi'))
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join('');
}

function snippet(body, terms) {
  const flat = body.replace(/\n{2,}/g, '\n').trim();
  if (!terms.length) return flat.slice(0, 200);
  const lower = flat.toLowerCase();
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  return first <= 40 ? flat.slice(0, 200) : '…' + flat.slice(first - 40, first + 160);
}

function render() {
  const q = parseQuery();
  const live = liveNotes();
  const shown = live
    .filter((n) => matches(n, q))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
  const filtering = q.words.length || q.tags.length || tagFilter;

  $('#search-clear').hidden = !$('#search').value;
  $('#count').textContent = filtering
    ? `${shown.length} of ${live.length}`
    : live.length
    ? `${live.length} note${live.length === 1 ? '' : 's'}`
    : '';
  const chip = $('#tag-filter');
  chip.hidden = !tagFilter;
  chip.textContent = tagFilter ? `#${tagFilter}  ×` : '';

  $('#notes').innerHTML = shown
    .map((n) => {
      const snip = snippet(n.body, q.words);
      const tags = n.tags.length ? `<span>${n.tags.map((t) => '#' + esc(t)).join(' ')}</span>` : '';
      return `<li><button class="note" type="button" data-id="${esc(n.id)}">
        <div class="note-title">${n.pinned ? '<span class="pin">●</span>' : ''}${highlight(n.title || 'Untitled', q.words)}</div>
        ${snip ? `<div class="note-snippet">${highlight(snip, q.words)}</div>` : ''}
        <div class="note-meta"><span>${formatDate(n.updated)}</span>${tags}${
          n.dirty && cfg.token ? '<span class="unsynced">not synced</span>' : ''
        }</div>
      </button></li>`;
    })
    .join('');

  const empty = $('#empty');
  empty.hidden = shown.length > 0;
  empty.textContent = filtering ? 'No matching notes.' : 'No notes yet. Tap + to write one.';
}

$('#search').addEventListener('input', render);
$('#search-clear').addEventListener('click', () => {
  $('#search').value = '';
  $('#search').focus();
  render();
});
$('#tag-filter').addEventListener('click', () => {
  tagFilter = null;
  render();
});
$('#notes').addEventListener('click', (e) => {
  const btn = e.target.closest('.note');
  if (btn) openEditor(btn.dataset.id);
});
$('#new-btn').addEventListener('click', () => openEditor(null));

/* ================================================================== *
 * Editor
 * ================================================================== */
let currentId = null;
let saveTimer = null;
const titleEl = $('#title');
const bodyEl = $('#body');

function fillEditor(note) {
  titleEl.value = note.title;
  bodyEl.value = note.body;
  renderNoteTags(note);
  renderTakes();
  $('#edited').textContent = 'Edited ' + formatDate(note.updated);
  if (!$('#preview').hidden) renderPreview();
}

function openEditor(id) {
  let note = id && byId(id);
  const isNew = !note;
  if (isNew) {
    note = { id: newId(), title: '', body: '', tags: [], updated: Date.now(), pinned: false, sha: null, dirty: false, deleted: false };
    if (tagFilter) note.tags.push(tagFilter);
    notes.push(note);
  }
  currentId = note.id;
  setPreview(false);
  fillEditor(note);
  $('#editor').hidden = false;
  bodyEl.scrollTop = 0;
  pushLayer('editor', closeEditor);
  if (isNew) titleEl.focus();
}

function touch(note) {
  note.updated = Date.now();
  note.dirty = true;
  persist();
  $('#edited').textContent = 'Edited ' + formatDate(note.updated);
}

function flushEditor() {
  clearTimeout(saveTimer);
  const note = byId(currentId);
  if (!note || note.deleted) return;
  if (titleEl.value === note.title && bodyEl.value === note.body) return;
  note.title = titleEl.value;
  note.body = bodyEl.value;
  touch(note);
}

function closeEditor() {
  flushEditor();
  addTagsFromInput();
  const note = byId(currentId);
  if (note && !note.deleted && !note.title.trim() && !note.body.trim() && !note.tags.length) removeNote(note);
  currentId = null;
  renderTakes();
  $('#editor').hidden = true;
  bodyEl.blur();
  titleEl.blur();
  persist();
  render();
  scheduleSync(1500);
}

function removeNote(note) {
  if (note.sha) {
    note.deleted = true; // tombstone until the deletion is synced
    note.dirty = true;
  } else {
    notes = notes.filter((n) => n !== note);
  }
}

for (const el of [titleEl, bodyEl]) {
  el.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushEditor, 400);
  });
}
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    bodyEl.focus();
  }
});
$('#back-btn').addEventListener('click', popLayer);

/* ---------- Tags in the editor ---------- */
const cleanTag = (t) => t.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[,]/g, '');

function renderNoteTags(note) {
  $('#note-tags').innerHTML = note.tags
    .map((t) => `<button type="button" class="tag" data-tag="${esc(t)}">#${esc(t)} ×</button>`)
    .join(' ');
}

function addTagsFromInput() {
  const input = $('#tag-input');
  const note = byId(currentId);
  if (!note || !input.value.trim()) return;
  let changed = false;
  for (const raw of input.value.split(/[,\s]+/)) {
    const t = cleanTag(raw);
    if (t && !note.tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      note.tags.push(t);
      changed = true;
    }
  }
  input.value = '';
  if (changed) {
    touch(note);
    renderNoteTags(note);
  }
}

$('#tag-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addTagsFromInput();
  }
});
$('#tag-input').addEventListener('input', (e) => {
  if (/[,\s]$/.test(e.target.value) && e.target.value.trim()) addTagsFromInput();
});
$('#tag-input').addEventListener('blur', addTagsFromInput);
$('#note-tags').addEventListener('click', (e) => {
  const btn = e.target.closest('.tag');
  const note = byId(currentId);
  if (!btn || !note) return;
  note.tags = note.tags.filter((t) => t !== btn.dataset.tag);
  touch(note);
  renderNoteTags(note);
  toast(`Removed #${btn.dataset.tag}`);
});

/* ---------- Formatting toolbar (inserts Markdown) ---------- */
function replaceRange(start, end, text, selStart, selEnd) {
  bodyEl.focus();
  bodyEl.setSelectionRange(start, end);
  // execCommand keeps the keyboard's undo history; fall back if unsupported.
  if (!document.execCommand('insertText', false, text)) bodyEl.setRangeText(text, start, end, 'end');
  bodyEl.setSelectionRange(selStart, selEnd);
  bodyEl.dispatchEvent(new Event('input'));
}

function wrapSelection(mark) {
  const { selectionStart: s, selectionEnd: e, value: v } = bodyEl;
  const sel = v.slice(s, e);
  const n = mark.length;
  if (v.slice(s - n, s) === mark && v.slice(e, e + n) === mark) {
    replaceRange(s - n, e + n, sel, s - n, e - n); // unwrap
  } else {
    replaceRange(s, e, mark + sel + mark, s + n, e + n);
  }
}

function togglePrefix(prefix, pattern) {
  const { selectionStart: s, selectionEnd: e, value: v } = bodyEl;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = v.indexOf('\n', e);
  if (lineEnd === -1) lineEnd = v.length;
  const lines = v.slice(lineStart, lineEnd).split('\n');
  const all = lines.every((l) => pattern.test(l));
  const out = lines.map((l) => (all ? l.replace(pattern, '') : prefix + l.replace(/^(#{1,3} |[-*] \[[ xX]\] |[-*] |> )/, '')));
  const text = out.join('\n');
  const delta = text.length - (lineEnd - lineStart);
  replaceRange(lineStart, lineEnd, text, Math.max(lineStart, s + (lines.length === 1 ? delta : 0)), lineEnd + delta);
}

const FORMATS = {
  bold: () => wrapSelection('**'),
  italic: () => wrapSelection('*'),
  strike: () => wrapSelection('~~'),
  heading: () => togglePrefix('## ', /^#{1,3} /),
  list: () => togglePrefix('- ', /^[-*] (?!\[[ xX]\] )/),
  check: () => togglePrefix('- [ ] ', /^[-*] \[[ xX]\] /),
  quote: () => togglePrefix('> ', /^> /),
  rhyme: () => openRhymes(wordAtCursor(), true),
};

const fmtBar = $('#fmt-bar');
fmtBar.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) e.preventDefault(); // keep the keyboard open
});
fmtBar.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) FORMATS[btn.dataset.fmt]();
});

function wordAtCursor() {
  const v = bodyEl.value;
  let pos = bodyEl.selectionStart ?? v.length;
  if (bodyEl.selectionEnd > pos) return v.slice(pos, bodyEl.selectionEnd).trim().split(/\s+/).pop();
  while (pos > 0 && !/[\p{L}']/u.test(v[pos - 1]) && !/[\p{L}']/u.test(v[pos] || '')) pos--;
  let a = pos;
  let b = pos;
  while (a > 0 && /[\p{L}']/u.test(v[a - 1])) a--;
  while (b < v.length && /[\p{L}']/u.test(v[b])) b++;
  return v.slice(a, b);
}

function insertWord(word) {
  let { selectionStart: s, selectionEnd: e, value: v } = bodyEl;
  if (s === e) {
    // Never split a word: move to the end of the word under the cursor.
    while (s < v.length && /[\p{L}']/u.test(v[s])) s++;
    e = s;
  }
  const before = s > 0 && !/\s/.test(v[s - 1]) ? ' ' : '';
  const text = before + word;
  replaceRange(s, e, text, s + text.length, s + text.length);
}

/* ---------- Formatted (preview) view ---------- */
function inlineMd(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

function renderMarkdown(src) {
  const lines = src.split('\n');
  const out = [];
  let para = [];
  let list = false;
  const flush = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const endList = () => {
    if (list) out.push('</ul>');
    list = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^```/.test(line)) {
      flush();
      endList();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,3}) (.*)$/.exec(line))) {
      flush();
      endList();
      out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`);
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      endList();
      out.push('<hr>');
    } else if ((m = /^\s*[-*] (?:\[([ xX])\] )?(.*)$/.exec(line))) {
      flush();
      if (!list) out.push('<ul>');
      list = true;
      if (m[1] !== undefined) {
        const done = m[1] !== ' ';
        out.push(
          `<li class="task${done ? ' done' : ''}"><input type="checkbox" data-line="${i}"${done ? ' checked' : ''}>${inlineMd(m[2])}</li>`
        );
      } else {
        out.push(`<li>${inlineMd(m[2])}</li>`);
      }
    } else if ((m = /^> ?(.*)$/.exec(line))) {
      flush();
      endList();
      out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`);
    } else if (!line.trim()) {
      flush();
      endList();
    } else {
      endList();
      para.push(inlineMd(line));
    }
  }
  flush();
  endList();
  return out.join('');
}

function renderPreview() {
  $('#preview').innerHTML = renderMarkdown(bodyEl.value) || '<p class="hint">Nothing here yet.</p>';
}

function setPreview(on) {
  if (on) {
    flushEditor();
    renderPreview();
  }
  $('#preview').hidden = !on;
  bodyEl.hidden = on;
  titleEl.readOnly = on;
  $('#tag-row').hidden = on && !byId(currentId)?.tags.length;
  $('#tag-input').hidden = on;
  $('#editor').classList.toggle('previewing', on);
  $('#preview-btn').setAttribute('aria-pressed', String(on));
}
$('#preview-btn').addEventListener('click', () => setPreview($('#preview').hidden));

$('#preview').addEventListener('change', (e) => {
  const box = e.target.closest('input[type="checkbox"]');
  if (!box) return;
  const lines = bodyEl.value.split('\n');
  const i = Number(box.dataset.line);
  lines[i] = lines[i].replace(/\[[ xX]\]/, box.checked ? '[x]' : '[ ]');
  bodyEl.value = lines.join('\n');
  flushEditor();
  renderPreview();
});

/* ================================================================== *
 * Hamburger menu
 * ================================================================== */
function openDrawer() {
  const inEditor = hasLayer('editor') && topLayer() === 'editor';
  const note = byId(currentId);
  $('#menu-note').hidden = !inEditor;
  if (inEditor && note) $('[data-menu="pin"]').textContent = note.pinned ? 'Unpin note' : 'Pin note';
  $('#player-switch').classList.toggle('on', prefs.player);
  $('[data-menu="record"]').textContent = rec ? 'Stop recording' : inEditor ? 'Record a take' : 'Record audio';
  $('#scrim').hidden = false;
  $('#drawer').hidden = false;
  pushLayer('drawer', () => {
    $('#scrim').hidden = true;
    $('#drawer').hidden = true;
  });
}
$$('.menu-btn').forEach((b) => b.addEventListener('click', openDrawer));
$('#scrim').addEventListener('click', popLayer);

const MENU = {
  notes: () => unwind(null, () => render()),
  search: () =>
    unwind(null, () => {
      $('#list-view').scrollTop = 0;
      $('#search').focus();
    }),
  catalog: () => unwind(null, () => openPage('catalog')),
  tags: () => unwind(null, () => openPage('tags')),
  rhymes: () => {
    if (currentId !== null) {
      replaceTop('rhymes', closePage);
      showPage('rhymes', true);
      setupRhymes(wordAtCursor(), true);
    } else unwind(null, () => openRhymes('', false));
  },
  format: () => {
    if (currentId !== null) {
      replaceTop('format', closePage);
      showPage('format', true);
    } else unwind(null, () => openPage('format'));
  },
  record: () => {
    if (!prefs.player) setPlayer(true);
    popLayer();
    toggleRecording();
  },
  player: () => {
    setPlayer(!prefs.player);
    $('#player-switch').classList.toggle('on', prefs.player);
    popLayer();
  },
  sync: () => {
    replaceTop('settings', closeSettings);
    openSettings();
  },
  pin: () => {
    flushEditor();
    const note = byId(currentId);
    if (note) {
      note.pinned = !note.pinned;
      touch(note);
      toast(note.pinned ? 'Pinned' : 'Unpinned');
    }
    popLayer();
  },
  delete: () => {
    const note = byId(currentId);
    if (!note || !confirm('Delete this note?')) return;
    clearTimeout(saveTimer);
    removeNote(note);
    unwind(2, () => toast('Note deleted'));
  },
};
$('#drawer').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-menu]');
  if (btn) MENU[btn.dataset.menu]();
});

/* ================================================================== *
 * Pages: catalog, tags, rhymes, text format
 * ================================================================== */
const PAGE_TITLES = { catalog: 'Catalog', tags: 'Tags', rhymes: 'Rhyming dictionary', format: 'Text format' };

function showPage(name, over) {
  $$('.pg').forEach((p) => (p.hidden = p.id !== 'pg-' + name));
  $('#page-title').textContent = PAGE_TITLES[name];
  const page = $('#page');
  page.hidden = false;
  page.style.zIndex = over ? 4 : '';
  page.scrollTop = 0;
  if (name === 'catalog') renderCatalog();
  if (name === 'tags') renderTags();
  if (name === 'format') renderFormatOptions();
}
function openPage(name) {
  showPage(name, false);
  pushLayer(name, closePage);
}
function closePage() {
  $('#page').hidden = true;
  $('#rh-input').blur();
  $('#cat-filter').blur();
}
$('#page-back').addEventListener('click', popLayer);

/* ---------- Catalog ---------- */
function renderCatalog() {
  $$('#pg-catalog .seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === prefs.catSort)));
  const f = $('#cat-filter').value.trim().toLowerCase();
  const list = liveNotes().filter(
    (n) => !f || (n.title || 'untitled').toLowerCase().includes(f) || n.tags.some((t) => t.toLowerCase().includes(f))
  );
  const groups = new Map();
  const add = (k, n) => (groups.has(k) ? groups.get(k) : groups.set(k, []).get(k)).push(n);
  const byTitle = (a, b) => (a.title || 'Untitled').localeCompare(b.title || 'Untitled', undefined, { sensitivity: 'base' });

  if (prefs.catSort === 'az') {
    list.sort(byTitle).forEach((n) => {
      const c = (n.title.trim() || 'Untitled')[0].toUpperCase();
      add(/\p{L}/u.test(c) ? c : '#', n);
    });
  } else if (prefs.catSort === 'recent') {
    list
      .sort((a, b) => b.updated - a.updated)
      .forEach((n) => add(new Date(n.updated).toLocaleDateString([], { month: 'long', year: 'numeric' }), n));
  } else {
    const tagged = new Map();
    const untagged = [];
    for (const n of list) {
      if (!n.tags.length) untagged.push(n);
      for (const t of n.tags) (tagged.get(t) || tagged.set(t, []).get(t)).push(n);
    }
    [...tagged.keys()].sort((a, b) => a.localeCompare(b)).forEach((t) => tagged.get(t).sort(byTitle).forEach((n) => add('#' + t, n)));
    untagged.sort(byTitle).forEach((n) => add('Untagged', n));
  }

  $('#cat-list').innerHTML = groups.size
    ? [...groups.entries()]
        .map(
          ([k, ns]) =>
            `<h3>${esc(k)}</h3>` +
            ns
              .map(
                (n) =>
                  `<button type="button" data-id="${esc(n.id)}"><span class="c-title">${esc(n.title || 'Untitled')}</span><span class="c-date">${formatDate(n.updated)}</span></button>`
              )
              .join('')
        )
        .join('')
    : `<p class="hint pad">${f ? 'No matching titles.' : 'No notes yet.'}</p>`;
  const tools = $('#pg-catalog .pg-tools');
  $('#cat-list').querySelectorAll('h3').forEach((h) => (h.style.top = 52 + tools.offsetHeight + 'px'));
}
$('#cat-filter').addEventListener('input', renderCatalog);
$('#pg-catalog .seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  prefs.catSort = b.dataset.sort;
  savePrefs();
  renderCatalog();
});
$('#cat-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (b) openEditor(b.dataset.id);
});

/* ---------- Tags ---------- */
function allTags() {
  const counts = new Map();
  for (const n of liveNotes()) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderTags() {
  const tags = allTags();
  $('#tags-empty').hidden = tags.length > 0;
  $('#tag-list').innerHTML = tags
    .map(
      ([t, c]) => `<li><button type="button" class="r-main" data-tag="${esc(t)}"><span>#${esc(t)}</span><span class="r-count">${c}</span></button>
      <button type="button" class="ib" data-edit="${esc(t)}" aria-label="Rename or remove #${esc(t)}"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg></button></li>`
    )
    .join('');
}

$('#tag-list').addEventListener('click', (e) => {
  const main = e.target.closest('[data-tag]');
  const edit = e.target.closest('[data-edit]');
  if (main) {
    unwind(null, () => {
      tagFilter = main.dataset.tag;
      $('#search').value = '';
      render();
    });
  } else if (edit) {
    const old = edit.dataset.edit;
    const next = prompt(`Rename #${old} (leave empty to remove it from all notes)`, old);
    if (next === null) return;
    const t = cleanTag(next);
    for (const n of liveNotes()) {
      if (!n.tags.includes(old)) continue;
      n.tags = n.tags.filter((x) => x !== old);
      if (t && !n.tags.includes(t)) n.tags.push(t);
      n.dirty = true;
    }
    if (tagFilter === old) tagFilter = t || null;
    persist();
    renderTags();
    render();
    scheduleSync(1500);
  }
});

/* ---------- Rhyming dictionary ---------- */
// Data: web/rhymes.txt, built by tools/build-rhymes.mjs from the CMU Pronouncing Dictionary.
let rhymeDb = null;
let rhymeInsert = false;
const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

async function loadRhymes() {
  if (rhymeDb) return rhymeDb;
  const res = await fetch('rhymes.txt');
  if (!res.ok) throw new Error('missing');
  const text = await res.text();
  const groups = [];
  const words = new Map(); // word -> [group index]
  const byVowels = new Map(); // vowel pattern -> [group index]
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const key = line.slice(0, tab);
    const list = line
      .slice(tab + 1)
      .split(' ')
      .map((w) => [w.slice(0, -1), Number(w.slice(-1))]);
    const gi = groups.length;
    groups.push({ key, list });
    for (const [w] of list) (words.get(w) || words.set(w, []).get(w)).push(gi);
    const vk = key
      .split(' ')
      .filter((p) => VOWELS.has(p))
      .join(' ');
    (byVowels.get(vk) || byVowels.set(vk, []).get(vk)).push(gi);
  }
  rhymeDb = { groups, words, byVowels };
  return rhymeDb;
}

function vowelsOf(key) {
  return key
    .split(' ')
    .filter((p) => VOWELS.has(p))
    .join(' ');
}

/** Rhymes from the offline dictionary, or null if the word is unknown. */
function lookupRhymes(db, word) {
  const gis = db.words.get(word);
  if (!gis) return null;
  const perfect = new Map(); // syllables -> words
  const seen = new Set([word]);
  for (const gi of gis) {
    for (const [w, s] of db.groups[gi].list) {
      if (seen.has(w)) continue;
      seen.add(w);
      (perfect.get(s) || perfect.set(s, []).get(s)).push(w);
    }
  }
  // Near rhymes: same vowel sounds, different consonants. Interleave groups so
  // the most common word of each group comes first.
  const nearGroups = [];
  for (const gi of gis) {
    const g = db.groups[gi];
    const last = g.key.split(' ').pop();
    for (const other of db.byVowels.get(vowelsOf(g.key)) || []) {
      if (gis.includes(other)) continue;
      const og = db.groups[other];
      const score = (og.key.split(' ').pop() === last ? 2 : 0) + Math.min(og.list.length, 50) / 50;
      nearGroups.push({ list: og.list, score });
    }
  }
  nearGroups.sort((a, b) => b.score - a.score);
  const near = [];
  for (let i = 0; near.length < 150 && i < 40; i++) {
    for (const g of nearGroups) {
      const item = g.list[i];
      if (item && !seen.has(item[0])) {
        seen.add(item[0]);
        near.push(item[0]);
        if (near.length >= 150) break;
      }
    }
  }
  return { perfect, near };
}

/** For unknown words: borrow the pronunciation of a known word with the same ending. */
function guessBySpelling(db, word) {
  for (let len = Math.min(word.length - 1, 5); len >= 2; len--) {
    const end = word.slice(-len);
    let best = null;
    for (const w of db.words.keys()) {
      if (w.endsWith(end) && w !== word && (!best || w.length < best.length)) best = w;
    }
    if (best) return best;
  }
  return null;
}

async function datamuse(word) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://api.datamuse.com/words?rel_rhy=${encodeURIComponent(word)}&max=120&md=s`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const perfect = new Map();
    for (const d of data) {
      if (!/^[a-z' ]+$/.test(d.word)) continue;
      const s = Math.min(9, d.numSyllables || 1);
      (perfect.get(s) || perfect.set(s, []).get(s)).push(d.word);
    }
    return { perfect, near: [] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let rhymeSeq = 0;
async function showRhymes() {
  const raw = $('#rh-input').value.trim().toLowerCase();
  const word = raw.replace(/[^\p{L}']/gu, '').replace(/^'+|'+$/g, '');
  const hint = $('#rh-hint');
  const out = $('#rh-results');
  const seq = ++rhymeSeq;
  if (!word) {
    hint.textContent = rhymeInsert ? 'Tap a word to insert it into your note.' : 'Tap a word to copy it.';
    out.innerHTML = '';
    return;
  }
  let db;
  try {
    db = await loadRhymes();
  } catch {
    hint.textContent = 'Rhyme data could not be loaded.';
    return;
  }
  let result = lookupRhymes(db, word);
  let note = '';
  if (!result) {
    hint.textContent = 'Looking up…';
    result = await datamuse(word);
    if (seq !== rhymeSeq) return;
    if (result) note = 'Not in the offline dictionary — results from Datamuse.';
    else {
      const like = guessBySpelling(db, word);
      if (like) {
        result = lookupRhymes(db, like);
        note = `Not in the dictionary — showing rhymes for “${like}”.`;
      }
    }
  }
  if (seq !== rhymeSeq) return;
  if (!result || (!result.perfect.size && !result.near.length)) {
    hint.textContent = 'No rhymes found.';
    out.innerHTML = '';
    return;
  }
  hint.textContent = note || (rhymeInsert ? 'Tap a word to insert it.' : 'Tap a word to copy it.');
  const btns = (ws) => ws.map((w) => `<button type="button">${esc(w)}</button>`).join('');
  let html = '';
  for (const s of [...result.perfect.keys()].sort((a, b) => a - b)) {
    html += `<h3>${s} syllable${s === 1 ? '' : 's'}</h3><div class="words">${btns(result.perfect.get(s))}</div>`;
  }
  if (result.near.length) html += `<h3>Near rhymes</h3><div class="words near">${btns(result.near)}</div>`;
  out.innerHTML = html;
}

let rhymeTimer = null;
$('#rh-input').addEventListener('input', () => {
  clearTimeout(rhymeTimer);
  rhymeTimer = setTimeout(showRhymes, 180);
});
$('#rh-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#rh-input').blur();
});
$('#rh-results').addEventListener('click', async (e) => {
  const b = e.target.closest('.words button');
  if (!b) return;
  const word = b.textContent;
  if (rhymeInsert && currentId !== null) {
    popLayer();
    setTimeout(() => {
      setPreview(false);
      insertWord(word);
    }, 50);
  } else {
    try {
      await navigator.clipboard.writeText(word);
      toast(`Copied “${word}”`);
    } catch {
      toast(word);
    }
  }
});

function setupRhymes(word, insert) {
  rhymeInsert = insert;
  $('#rh-input').value = word || '';
  showRhymes();
  if (!word) setTimeout(() => $('#rh-input').focus(), 50);
}
function openRhymes(word, fromEditor) {
  showPage('rhymes', fromEditor);
  pushLayer('rhymes', closePage);
  setupRhymes(word, fromEditor);
}

/* ---------- Text format ---------- */
const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Noto Serif", "Times New Roman", serif',
  mono: 'ui-monospace, "Roboto Mono", "Droid Sans Mono", monospace',
};
const SIZES = { s: '15px', m: '17px', l: '19px', xl: '22px' };
const SPACING = { tight: '1.35', normal: '1.55', loose: '1.8' };

function applyFormat() {
  const root = document.documentElement.style;
  root.setProperty('--note-font', FONTS[prefs.font] || FONTS.sans);
  root.setProperty('--note-size', SIZES[prefs.size] || SIZES.m);
  root.setProperty('--note-lh', SPACING[prefs.spacing] || SPACING.normal);
  document.body.classList.toggle('no-toolbar', prefs.toolbar === 'off');
}
function renderFormatOptions() {
  $$('#pg-format .seg').forEach((seg) =>
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(prefs[seg.dataset.opt] === b.dataset.v)))
  );
}
$('#pg-format').addEventListener('click', (e) => {
  const b = e.target.closest('.seg button');
  if (!b) return;
  prefs[b.closest('.seg').dataset.opt] = b.dataset.v;
  savePrefs();
  applyFormat();
  renderFormatOptions();
});

/* ================================================================== *
 * Audio player + recorder
 * Audio lives on this device in IndexedDB. Recordings also sync to the
 * repository's audio/ folder; files added from the phone do not.
 * ================================================================== */
const audio = new Audio();
audio.preload = 'metadata';
/**
 * Track: { id, name, type, added, blob, duration (s) }
 * Recordings also have: recording: true, noteId, ext, sha, metaSha, dirty, deleted
 */
let tracks = [];
let trackUrl = null;
let seeking = false;

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('notes-audio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tracks', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tracks', mode);
    const req = fn(tx.objectStore('tracks'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const saveTrack = (t) => idbDo('readwrite', (s) => s.put(t));
const dropTrack = (t) => idbDo('readwrite', (s) => s.delete(t.id));
const liveTracks = () => tracks.filter((t) => !t.deleted);
const noteTakes = (noteId) => liveTracks().filter((t) => t.recording && t.noteId === noteId);

let tracksReady = Promise.resolve();
async function loadTracks() {
  try {
    tracks = (await idbDo('readonly', (s) => s.getAll())) || [];
  } catch {
    tracks = [];
  }
  tracks.sort((a, b) => a.added - b.added);
  const live = liveTracks();
  if (!live.some((t) => t.id === prefs.track)) prefs.track = live.length ? live[0].id : null;
  selectTrack(prefs.track, false);
  renderTakes();
}

const fmtTime = (t) => {
  if (!Number.isFinite(t)) return '0:00';
  t = Math.floor(t);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const currentTrack = () => tracks.find((t) => t.id === prefs.track && !t.deleted);
// Recorded WebM files carry no duration, so fall back to the one we measured.
function trackDuration() {
  const d = audio.duration;
  if (Number.isFinite(d) && d > 0) return d;
  const t = currentTrack();
  return t && t.duration ? t.duration : NaN;
}

function selectTrack(id, play) {
  const t = tracks.find((x) => x.id === id && !x.deleted);
  audio.pause();
  if (trackUrl) URL.revokeObjectURL(trackUrl);
  trackUrl = null;
  prefs.track = t ? t.id : null;
  savePrefs();
  if (t) {
    trackUrl = URL.createObjectURL(t.blob);
    audio.src = trackUrl;
    if (play) audio.play().catch(() => {});
  } else {
    audio.removeAttribute('src');
    audio.load();
  }
  $('#pl-track').textContent = t ? t.name : 'No audio — tap to add';
  if ('mediaSession' in navigator && t) navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: 'Notes' });
  updateTime();
  renderTracks();
  renderTakes();
}

function updateTime() {
  if (rec) return; // the time slot shows the recording timer
  const d = trackDuration();
  $('#pl-time').textContent = Number.isFinite(d) ? `${fmtTime(audio.currentTime)}/${fmtTime(d)}` : fmtTime(audio.currentTime);
  if (!seeking) $('#pl-seek').value = Number.isFinite(d) && d > 0 ? Math.round((audio.currentTime / d) * 1000) : 0;
}

const X_ICON = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function renderTracks() {
  $('#track-list').innerHTML = liveTracks()
    .map(
      (t) => `<li class="${t.id === prefs.track ? 'current' : ''}"><button type="button" class="t-name" data-id="${esc(t.id)}">${
        t.recording ? '<span class="rec-dot" aria-label="Recording"></span>' : ''
      }${esc(t.name)}</button>
      <button type="button" class="ib sm" data-del="${esc(t.id)}" aria-label="Remove ${esc(t.name)}">${X_ICON}</button></li>`
    )
    .join('');
}

/** The open note's recordings, listed under its tags. */
function renderTakes() {
  const box = $('#takes');
  const takes = currentId === null ? [] : noteTakes(currentId);
  box.hidden = !takes.length;
  box.innerHTML = takes
    .map(
      (t) => `<button type="button" class="take${t.id === prefs.track ? ' current' : ''}" data-id="${esc(t.id)}">
        <span class="rec-dot"></span><span class="take-name">${esc(t.name)}</span><span class="take-len">${fmtTime(t.duration)}</span></button>`
    )
    .join('');
}
$('#takes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  if (!prefs.player) setPlayer(true);
  if (prefs.track === b.dataset.id && !audio.paused) audio.pause();
  else if (prefs.track === b.dataset.id) audio.play().catch(() => {});
  else selectTrack(b.dataset.id, true);
});

function setPlayer(on) {
  prefs.player = on;
  savePrefs();
  $('#player').hidden = !on;
  if (!on) {
    if (rec) stopRecording();
    audio.pause();
    if (hasLayer('tracks')) popLayer();
  }
}

function openTracks() {
  if (hasLayer('tracks')) return popLayer();
  $('#tracks').style.top = $('#player').getBoundingClientRect().bottom + 'px';
  $('#tracks').hidden = false;
  pushLayer('tracks', () => ($('#tracks').hidden = true));
}

$('#pl-play').addEventListener('click', () => {
  if (!prefs.track) return $('#track-file').click();
  if (audio.paused) audio.play().catch(() => toast('Could not play this file'));
  else audio.pause();
});
$('#pl-track').addEventListener('click', () => (liveTracks().length ? openTracks() : $('#track-file').click()));
$('#pl-loop').addEventListener('click', () => {
  prefs.loop = !prefs.loop;
  audio.loop = prefs.loop;
  savePrefs();
  $('#pl-loop').setAttribute('aria-pressed', String(prefs.loop));
  toast(prefs.loop ? 'Loop on' : 'Loop off');
});
$('#pl-seek').addEventListener('input', () => {
  seeking = true;
  const d = trackDuration();
  if (Number.isFinite(d) && !rec) $('#pl-time').textContent = `${fmtTime(($('#pl-seek').value / 1000) * d)}/${fmtTime(d)}`;
});
$('#pl-seek').addEventListener('change', () => {
  const d = trackDuration();
  if (Number.isFinite(d)) audio.currentTime = ($('#pl-seek').value / 1000) * d;
  seeking = false;
});
audio.addEventListener('timeupdate', updateTime);
audio.addEventListener('loadedmetadata', updateTime);
audio.addEventListener('play', () => {
  $('#player').classList.add('playing');
  renderTakes();
});
audio.addEventListener('pause', () => $('#player').classList.remove('playing'));
audio.addEventListener('ended', () => {
  audio.currentTime = 0;
  updateTime();
});
audio.addEventListener('error', () => {
  if (audio.getAttribute('src')) toast('This audio format is not supported');
});
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
}

async function removeTrack(t) {
  if (t.recording && t.sha) {
    // Keep a tombstone until the deletion reaches GitHub.
    t.deleted = true;
    t.dirty = true;
    t.blob = new Blob([]);
    await saveTrack(t).catch(() => {});
    scheduleSync(1500);
  } else {
    await dropTrack(t).catch(() => {});
    tracks = tracks.filter((x) => x !== t);
  }
}

$('#track-list').addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-id]');
  const del = e.target.closest('[data-del]');
  if (pick) {
    selectTrack(pick.dataset.id, true);
    popLayer();
  } else if (del) {
    const t = tracks.find((x) => x.id === del.dataset.del);
    if (!t) return;
    const msg = t.recording
      ? `Delete the recording “${t.name}”? It is also removed from GitHub.`
      : `Remove “${t.name}” from the player?`;
    if (!confirm(msg)) return;
    const wasCurrent = prefs.track === t.id;
    await removeTrack(t);
    const live = liveTracks();
    if (wasCurrent) selectTrack(live.length ? live[0].id : null, false);
    else {
      renderTracks();
      renderTakes();
    }
    if (!live.length) popLayer();
  }
});
$('#track-add').addEventListener('click', () => $('#track-file').click());
$('#track-file').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  let last = null;
  for (const f of files) {
    try {
      const blob = new Blob([await f.arrayBuffer()], { type: f.type || 'audio/mpeg' });
      const t = { id: newId(), name: f.name.replace(/\.[^.]+$/, ''), type: blob.type, added: Date.now(), blob };
      await saveTrack(t);
      tracks.push(t);
      last = t;
    } catch {
      toast(`Could not add ${f.name} (storage full?)`);
    }
  }
  if (last) {
    selectTrack(last.id, false);
    toast(files.length > 1 ? `Added ${files.length} files` : `Added “${last.name}”`);
  }
});

/* ---------- Recorder ---------- */
// ~1 MB per minute. The current track keeps playing; only the mic is recorded.
const REC_BITRATE = 128000;
const REC_TYPES = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/ogg;codecs=opus', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/webm', 'webm'],
];
let rec = null; // { mr, stream, chunks, started, noteId, type, ext, timer, wake }

async function startRecording() {
  if (rec) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    return toast('Recording is not supported here');
  }
  let stream;
  try {
    // No voice processing: it would squash singing and duck the beat.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    return toast('Microphone access was denied');
  }
  const [type, ext] = REC_TYPES.find(([t]) => MediaRecorder.isTypeSupported(t)) || ['', 'webm'];
  let mr;
  try {
    mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: REC_BITRATE } : { audioBitsPerSecond: REC_BITRATE });
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    return toast('Could not start recording');
  }
  rec = { mr, stream, chunks: [], started: Date.now(), noteId: currentId, type: (mr.mimeType || type || 'audio/webm').split(';')[0], ext };
  mr.addEventListener('dataavailable', (e) => e.data && e.data.size && rec && rec.chunks.push(e.data));
  mr.addEventListener('stop', finishRecording);
  mr.start(1000);
  try {
    rec.wake = await navigator.wakeLock.request('screen'); // the mic stops if the screen turns off
  } catch {}
  $('#player').classList.add('recording');
  $('#pl-rec').setAttribute('aria-label', 'Stop recording');
  $('#pl-time').textContent = '0:00';
  rec.timer = setInterval(() => ($('#pl-time').textContent = fmtTime((Date.now() - rec.started) / 1000)), 250);
  toast(rec.noteId ? 'Recording a take for this note' : 'Recording');
}

function stopRecording() {
  if (rec && rec.mr.state !== 'inactive') rec.mr.stop();
}

async function finishRecording() {
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  if (r.wake) r.wake.release().catch(() => {});
  $('#player').classList.remove('recording');
  $('#pl-rec').setAttribute('aria-label', 'Record');
  updateTime();

  const duration = (Date.now() - r.started) / 1000;
  const blob = new Blob(r.chunks, { type: r.type });
  if (duration < 1 || !blob.size) return toast('Recording too short — not saved');
  const note = r.noteId && byId(r.noteId);
  const stamp = new Date(r.started);
  const name = note
    ? `${note.title.trim() || 'Untitled'} — take ${noteTakes(note.id).length + 1}`
    : `Recording ${stamp.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${stamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  const t = {
    id: newId(), name, type: r.type, ext: r.ext, added: r.started, duration, blob,
    recording: true, noteId: note ? note.id : null, sha: null, metaSha: null, dirty: true, deleted: false,
  };
  try {
    await saveTrack(t);
  } catch {
    return toast('Could not save the recording (storage full?)');
  }
  tracks.push(t);
  if (!prefs.track) selectTrack(t.id, false);
  renderTracks();
  renderTakes();
  toast(`Saved “${name}”`);
  scheduleSync(1500);
}

function toggleRecording() {
  if (rec) stopRecording();
  else startRecording();
}
$('#pl-rec').addEventListener('click', toggleRecording);

/* ================================================================== *
 * Note <-> Markdown file
 * ================================================================== */
function serialize(note) {
  return (
    '---\n' +
    `title: ${JSON.stringify(note.title)}\n` +
    `tags: ${JSON.stringify(note.tags || [])}\n` +
    `updated: ${new Date(note.updated).toISOString()}\n` +
    `pinned: ${!!note.pinned}\n` +
    '---\n\n' +
    note.body +
    (note.body.endsWith('\n') ? '' : '\n')
  );
}

function parse(text, id) {
  text = text.replace(/\r\n/g, '\n');
  const out = { title: id, body: text.replace(/\n$/, ''), tags: [], updated: Date.now(), pinned: false };
  const m = /^---\n([\s\S]*?)\n---\n\n?/.exec(text);
  if (!m) return out; // a plain Markdown file added by hand
  out.body = text.slice(m[0].length).replace(/\n$/, '');
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key === 'title') {
      try {
        out.title = String(JSON.parse(val));
      } catch {
        out.title = val;
      }
    } else if (key === 'tags') {
      try {
        const arr = JSON.parse(val);
        if (Array.isArray(arr)) out.tags = arr.map(String).map(cleanTag).filter(Boolean);
      } catch {
        out.tags = val.replace(/^\[|\]$/g, '').split(',').map(cleanTag).filter(Boolean);
      }
    } else if (key === 'updated') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) out.updated = t;
    } else if (key === 'pinned') {
      out.pinned = val === 'true';
    }
  }
  return out;
}

/* ================================================================== *
 * GitHub sync
 * ================================================================== */
class SyncError extends Error {}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gh(method, path, { body, raw } = {}) {
  const base = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  let res;
  try {
    res = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('Offline — will sync when connected');
  }
  if (res.status === 401) throw new SyncError('Token is invalid or expired');
  if (res.status === 403) throw new SyncError('Token lacks permission (needs Contents: Read and write)');
  return res;
}

const filePath = (id) => `/contents/${DIR}/${encodeURIComponent(id)}.md`;
const refQuery = () => `?ref=${encodeURIComponent(cfg.branch)}`;

async function listRemote() {
  const res = await gh('GET', `/contents/${DIR}${refQuery()}`);
  if (res.status === 404) {
    // Either the notes folder does not exist yet, or the repo/branch is wrong.
    const repo = await gh('GET', '');
    if (!repo.ok) throw new SyncError('Repository not found — check the name and token access');
    const branch = await gh('GET', `/branches/${encodeURIComponent(cfg.branch)}`);
    if (!branch.ok) throw new SyncError(`Branch "${cfg.branch}" not found`);
    return new Map();
  }
  if (!res.ok) throw new SyncError(`GitHub error ${res.status}`);
  const map = new Map();
  for (const it of await res.json()) {
    if (it.type === 'file' && it.name.endsWith('.md')) map.set(it.name.slice(0, -3), it.sha);
  }
  return map;
}

async function fetchRemote(id) {
  const res = await gh('GET', filePath(id) + refQuery(), { raw: true });
  if (!res.ok) throw new SyncError(`Could not download a note (${res.status})`);
  return res.text();
}

async function pushNote(note) {
  const snapshot = serialize(note);
  const body = {
    message: `${note.sha ? 'Update' : 'Add'} note: ${note.title.trim().slice(0, 60) || 'Untitled'}`,
    content: b64(snapshot),
    branch: cfg.branch,
  };
  if (note.sha) body.sha = note.sha;
  const res = await gh('PUT', filePath(note.id), { body });
  if (res.status === 409 || res.status === 422) throw new SyncError('A note changed on GitHub meanwhile — sync again');
  if (!res.ok) throw new SyncError(`Could not upload a note (${res.status})`);
  note.sha = (await res.json()).content.sha;
  // Keep it dirty if it was edited while the upload was in flight.
  if (!note.deleted && serialize(note) === snapshot) note.dirty = false;
  persist();
}

async function deleteRemote(note) {
  const res = await gh('DELETE', filePath(note.id), {
    body: { message: `Delete note: ${note.title.trim().slice(0, 60) || 'Untitled'}`, sha: note.sha, branch: cfg.branch },
  });
  if (!res.ok && res.status !== 404) throw new SyncError(`Could not delete a note (${res.status})`);
}

async function runSync() {
  flushEditor();
  const remote = await listRemote();

  // 1. Bring in remote additions and changes.
  for (const [id, sha] of remote) {
    const local = byId(id);
    if (local && local.sha === sha) continue;
    const text = await fetchRemote(id);
    const data = parse(text, id);
    flushEditor(); // capture anything typed while downloading
    if (!local) {
      notes.push({ id, ...data, sha, dirty: false, deleted: false });
    } else if (local.dirty && !local.deleted && serialize(local) !== text) {
      // Edited on both sides: keep this device's version as a separate copy.
      notes.push({
        id: newId(), title: (local.title || 'Untitled') + ' (conflict copy)', body: local.body, tags: local.tags.slice(),
        updated: local.updated, pinned: local.pinned, sha: null, dirty: true, deleted: false,
      });
      Object.assign(local, data, { sha, dirty: false, deleted: false });
    } else {
      // Remote is newer (a remote edit also beats a local delete).
      Object.assign(local, data, { sha, dirty: false, deleted: false });
    }
    if (id === currentId) fillEditor(byId(id));
    persist();
  }

  // 2. Send local changes.
  for (const note of notes.slice()) {
    const onRemote = remote.has(note.id);
    if (note.deleted) {
      if (onRemote && note.sha) await deleteRemote(note);
      notes = notes.filter((n) => n !== note);
    } else if (note.sha && !onRemote) {
      // Deleted on another device.
      if (note.dirty) {
        note.sha = null;
        await pushNote(note);
      } else if (note.id !== currentId) {
        notes = notes.filter((n) => n !== note);
      }
    } else if (note.dirty && (note.title.trim() || note.body.trim() || note.tags.length)) {
      await pushNote(note);
    }
    persist();
  }

  await syncAudio();
}

/* ---------- Recordings <-> audio/ folder ---------- */
const AUDIO_DIR = 'audio';
const MAX_SYNC_BYTES = 40 * 1024 * 1024; // GitHub's file API tops out a little above this

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function listRemoteAudio() {
  const res = await gh('GET', `/contents/${AUDIO_DIR}${refQuery()}`);
  if (res.status === 404) return new Map();
  if (!res.ok) throw new SyncError(`GitHub error ${res.status}`);
  const map = new Map(); // id -> { file, sha, metaSha }
  for (const it of await res.json()) {
    const m = it.type === 'file' && /^([a-z0-9]+)\.([a-z0-9]+)$/.exec(it.name);
    if (!m) continue;
    const e = map.get(m[1]) || {};
    if (m[2] === 'json') e.metaSha = it.sha;
    else Object.assign(e, { file: it.name, sha: it.sha });
    map.set(m[1], e);
  }
  return map;
}

const audioPath = (name) => `/contents/${AUDIO_DIR}/${encodeURIComponent(name)}`;

async function putAudioFile(name, content, message, sha) {
  const body = { message, content, branch: cfg.branch };
  if (sha) body.sha = sha;
  const res = await gh('PUT', audioPath(name), { body });
  if (!res.ok) throw new SyncError(`Could not upload a recording (${res.status})`);
  return (await res.json()).content.sha;
}

async function deleteAudioFile(name, sha, message) {
  const res = await gh('DELETE', audioPath(name), { body: { message, sha, branch: cfg.branch } });
  if (!res.ok && res.status !== 404) throw new SyncError(`Could not delete a recording (${res.status})`);
}

const recordingMeta = (t) =>
  JSON.stringify(
    { name: t.name, note: t.noteId || null, added: new Date(t.added).toISOString(), duration: Math.round(t.duration * 10) / 10, type: t.type },
    null,
    2
  ) + '\n';

async function syncAudio() {
  await tracksReady;
  const remote = await listRemoteAudio();
  let changed = false;

  // 1. Download recordings made on other devices.
  for (const [id, r] of remote) {
    if (!r.file || !r.metaSha || tracks.some((t) => t.id === id)) continue;
    const metaRes = await gh('GET', audioPath(id + '.json') + refQuery(), { raw: true });
    const fileRes = metaRes.ok && (await gh('GET', audioPath(r.file) + refQuery(), { raw: true }));
    if (!metaRes.ok || !fileRes.ok) throw new SyncError('Could not download a recording');
    let meta = {};
    try {
      meta = JSON.parse(await metaRes.text());
    } catch {}
    const type = String(meta.type || 'audio/webm');
    const blob = new Blob([await fileRes.arrayBuffer()], { type });
    const t = {
      id, name: String(meta.name || 'Recording'), type, ext: r.file.split('.').pop(),
      added: Date.parse(meta.added) || Date.now(), duration: Number(meta.duration) || 0, blob,
      recording: true, noteId: meta.note || null, sha: r.sha, metaSha: r.metaSha, dirty: false, deleted: false,
    };
    await saveTrack(t);
    tracks.push(t);
    changed = true;
  }

  // 2. Upload new recordings, send deletions, drop ones deleted elsewhere.
  for (const t of tracks.filter((x) => x.recording)) {
    const r = remote.get(t.id);
    const file = `${t.id}.${t.ext || 'webm'}`;
    if (t.deleted) {
      if (r && r.sha) await deleteAudioFile(r.file, r.sha, `Delete recording: ${t.name}`);
      if (r && r.metaSha) await deleteAudioFile(t.id + '.json', r.metaSha, `Delete recording: ${t.name}`);
      await dropTrack(t);
      tracks = tracks.filter((x) => x !== t);
      changed = true;
    } else if (t.sha && !r && !t.dirty) {
      await dropTrack(t); // deleted on another device
      tracks = tracks.filter((x) => x !== t);
      changed = true;
    } else if (t.dirty) {
      if (t.blob.size > MAX_SYNC_BYTES) {
        if (!t.tooBig) toast(`“${t.name}” is too long to sync (over 40 MB)`);
        t.tooBig = true;
        continue;
      }
      if (!t.sha) t.sha = await putAudioFile(file, await blobToBase64(t.blob), `Add recording: ${t.name}`);
      if (!t.metaSha) t.metaSha = await putAudioFile(t.id + '.json', b64(recordingMeta(t)), `Add recording info: ${t.name}`);
      t.dirty = false;
      await saveTrack(t);
    }
  }

  if (changed) {
    const live = liveTracks();
    if (!live.some((t) => t.id === prefs.track)) selectTrack(live.length ? live[0].id : null, false);
    renderTracks();
    renderTakes();
  }
}

let syncing = false;
let syncAgain = false;
let syncTimer = null;
let lastError = '';

async function sync(manual) {
  if (!cfg.token) {
    if (manual) {
      pushLayer('settings', closeSettings);
      openSettings();
    }
    return false;
  }
  if (syncing) {
    syncAgain = true;
    return false;
  }
  syncing = true;
  $('#sync-btn').classList.add('spinning');
  updateStatus();
  try {
    await runSync();
    lastError = '';
    save(LS_LAST, String(Date.now()));
    if (manual) toast('Synced');
  } catch (err) {
    lastError = err instanceof SyncError ? err.message : 'Sync failed';
    if (!(err instanceof SyncError)) console.error(err);
    if (manual) toast(lastError);
  }
  syncing = false;
  $('#sync-btn').classList.remove('spinning');
  if (currentId !== null) {
    const open = byId(currentId);
    if (!open || open.deleted) unwind(layers.length - layers.findIndex((l) => l.name === 'editor'));
  }
  render();
  if (!$('#page').hidden && !$('#pg-catalog').hidden) renderCatalog();
  if (!$('#page').hidden && !$('#pg-tags').hidden) renderTags();
  updateStatus();
  if (syncAgain) {
    syncAgain = false;
    scheduleSync(500);
  }
  return !lastError;
}

function scheduleSync(delay) {
  if (!cfg.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(false), delay);
}

function updateStatus() {
  const el = $('#status');
  el.classList.remove('error');
  if (!cfg.token) {
    el.textContent = 'Sync off — tap to connect GitHub';
  } else if (syncing) {
    el.textContent = 'Syncing…';
  } else if (lastError) {
    el.textContent = lastError;
    el.classList.add('error');
  } else {
    const pending = notes.filter((n) => n.dirty).length + tracks.filter((t) => t.recording && t.dirty && !t.tooBig).length;
    const last = Number(localStorage.getItem(LS_LAST));
    el.textContent = pending
      ? `${pending} change${pending === 1 ? '' : 's'} to sync`
      : last
      ? `Synced ${formatDate(last)}`
      : 'Ready to sync';
  }
}

$('#sync-btn').addEventListener('click', () => sync(true));
$('#status').addEventListener('click', () => sync(true));
window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') window.appPause();
  else if (Date.now() - Number(localStorage.getItem(LS_LAST)) > 60000) scheduleSync(300);
});
window.addEventListener('pagehide', flushEditor);

/* ================================================================== *
 * Sync settings dialog
 * ================================================================== */
const dialog = $('#settings');

function setMsg(text, cls) {
  const el = $('#settings-msg');
  el.textContent = text;
  el.className = 'hint msg ' + (cls || '');
}

function closeSettings() {
  if (dialog.open) dialog.close();
}

function openSettings() {
  $('#cfg-owner').value = cfg.owner;
  $('#cfg-repo').value = cfg.repo;
  $('#cfg-branch').value = cfg.branch;
  $('#cfg-token').value = cfg.token;
  setMsg('');
  dialog.showModal();
}
// The dialog's own Escape / back closes it; keep the layer stack in step.
dialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  popLayer();
});
$('#settings-cancel').addEventListener('click', popLayer);
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = {
    owner: $('#cfg-owner').value.trim(),
    repo: $('#cfg-repo').value.trim(),
    branch: $('#cfg-branch').value.trim(),
    token: $('#cfg-token').value.trim(),
  };
  if (next.owner !== cfg.owner || next.repo !== cfg.repo || next.branch !== cfg.branch) {
    // Different destination: everything on this device needs uploading there.
    notes = notes.filter((n) => !n.deleted);
    for (const n of notes) {
      n.sha = null;
      n.dirty = true;
    }
    persist();
  }
  Object.assign(cfg, next);
  save(LS_CFG, cfg);
  lastError = '';
  if (!cfg.token) {
    updateStatus();
    render();
    popLayer();
    return;
  }
  setMsg('Syncing…');
  while (syncing) await new Promise((r) => setTimeout(r, 150));
  if (await sync(false)) popLayer();
  else setMsg(lastError, 'error');
});

/* ================================================================== *
 * Start
 * ================================================================== */
const inApp = location.hostname === 'appassets.androidplatform.net';
if ('serviceWorker' in navigator && location.protocol === 'https:' && !inApp) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// A reload leaves stale history entries for layers that no longer exist.
if (history.state && history.state.layer) history.replaceState(null, '');

applyFormat();
audio.loop = prefs.loop;
$('#pl-loop').setAttribute('aria-pressed', String(prefs.loop));
$('#player').hidden = !prefs.player;
tracksReady = loadTracks();
render();
updateStatus();
scheduleSync(300);
