'use strict';
// Sidebar (session list), right panel (files / changes / activity), broadcast bar.

window.GWT = window.GWT || {};

(() => {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const STATUS_LABEL = {
    starting: 'Starting', working: 'Working', attention: 'Needs you',
    ready: 'Your turn', running: 'Running', exited: 'Exited',
  };

  // ---------------- sidebar ----------------

  function renderSidebar() {
    const list = $('#session-list');
    list.innerHTML = '';
    const st = GWT.state;
    st.order.forEach((id, i) => {
      const s = st.sessions.get(id);
      if (!s) return;
      const item = el('div', 'sess' + (id === st.focused ? ' focused' : '') + (st.hidden.has(id) ? ' hidden-in-grid' : ''));
      item.dataset.id = id;
      item.style.setProperty('--tab-color', `hsl(${sessionHue(id)} 60% var(--who-l))`);
      item.innerHTML = `
        <div class="row1">
          <span class="dot ${s.status}"></span>
          <span class="name">${esc(s.name)}</span>
          <span class="idx">${i < 9 ? 'Alt+' + (i + 1) : ''}</span>
        </div>
        <div class="statusline">
          <span class="st ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          <span class="dur" data-since="${s.statusSince}">${GWT.util.fmtDuration(Date.now() - s.statusSince)}</span>
          <span>${
            s.kind === 'claude'
              ? s.usage
                ? `· ctx ${GWT.util.fmtTokens(s.usage.ctx)} · out ${GWT.util.fmtTokens(s.usage.out)}`
                : s.hooksSeen ? '' : '· no hook signal yet'
              : s.kind === 'wsl' ? `· wsl ${esc(s.distro || '')}` : '· shell'
          }</span>
        </div>
        <div class="activity">${esc(s.activity || '')}</div>
        ${s.notice ? `<div class="notice" title="${esc(s.notice)}">${esc(s.notice)}</div>` : ''}
        <div class="cwd" title="${esc(s.cwd)}">${esc(s.cwd)}</div>
        <div class="btns">
          <button class="b-rename" title="Rename session" data-icon="edit"></button>
          <button class="b-eye" title="${st.hidden.has(id) ? 'Show in grid' : 'Hide from grid'}" data-icon="${st.hidden.has(id) ? 'eyeOff' : 'eye'}"></button>
          <button class="b-x" title="Close session" data-icon="close"></button>
        </div>`;
      GWT.icons.apply(item);
      item.addEventListener('click', () => GWT.app.focusSession(id));
      item.addEventListener('dblclick', () => GWT.app.renameSession(id));
      item.querySelector('.b-rename').addEventListener('click', (e) => {
        e.stopPropagation();
        GWT.app.renameSession(id);
      });
      item.querySelector('.b-eye').addEventListener('click', (e) => {
        e.stopPropagation();
        GWT.app.toggleGridVisibility(id);
      });
      item.querySelector('.b-x').addEventListener('click', (e) => {
        e.stopPropagation();
        GWT.app.closeSession(id);
      });
      list.appendChild(item);
    });
    renderPreviousSection(list);
    updateAttentionCount();
    renderTabbar();
  }

  // Previous sessions (persisted history) live below the running ones —
  // click to relaunch/resume, no startup dialog needed.
  function renderPreviousSection(list) {
    // A session already listed above must never appear here as well. Match on
    // runKey (the session id its history entry was last written for) rather than
    // claudeSessionId: a Claude session has no uuid until its first hook, and an
    // exited one is still listed above — both used to show up twice.
    const listed = GWT.state.sessions;
    const listedNames = new Set(
      [...listed.values()].map((s) => String(s.name || '').trim().toLowerCase())
    );
    const prev = (GWT.state.history || []).filter((h) => {
      if (h.runKey && listed.has(h.runKey)) return false;
      if (h.claudeSessionId && [...listed.values()].some((s) => s.claudeSessionId === h.claudeSessionId)) return false;
      // backstop for an entry not yet written for this run (history is one
      // entry per name, so a name in the list above owns that entry)
      if (listedNames.has(String(h.name || '').trim().toLowerCase())) return false;
      return true;
    });
    if (!prev.length) return;

    const head = el('div', 'sb-section');
    head.textContent = 'Previous';
    list.appendChild(head);

    for (const h of prev) {
      const item = el('div', 'sess prev');
      const resumable = h.kind === 'claude' && h.claudeSessionId;
      item.innerHTML = `
        <div class="row1">
          <span class="dot exited"></span>
          <span class="name">${esc(h.name)}</span>
          <span class="idx">${GWT.util.fmtAgo(h.lastUsed)}</span>
        </div>
        <div class="statusline">
          <span>${h.kind}${h.distro ? ':' + esc(h.distro) : ''}</span>
          <span>${resumable ? '· resumable' : ''}</span>
        </div>
        <div class="cwd" title="${esc(h.cwd)}">${esc(h.cwd)}</div>
        <div class="btns">
          <button class="b-hrename" title="Rename" data-icon="edit"></button>
          ${resumable ? '<button class="b-fresh" title="Launch fresh (same directory, new conversation)" data-icon="refresh"></button>' : ''}
          <button class="b-del" title="Remove from history" data-icon="close"></button>
        </div>`;
      GWT.icons.apply(item);
      item.title = resumable ? 'Click to resume this conversation' : 'Click to relaunch';
      const launch = async (resume) => {
        item.style.opacity = '.4';
        const err = await GWT.app.launchHistory(h, { resume });
        if (err) {
          item.style.opacity = '';
          item.querySelector('.cwd').textContent = err;
        }
      };
      item.addEventListener('click', () => launch(true));
      item.querySelector('.b-hrename').addEventListener('click', (e) => {
        e.stopPropagation();
        GWT.app.renameHistory(h.hid, h.name);
      });
      item.querySelector('.b-fresh')?.addEventListener('click', (e) => {
        e.stopPropagation();
        launch(false);
      });
      item.querySelector('.b-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        GWT.app.removeHistory(h.hid);
      });
      list.appendChild(item);
    }
  }

  function tickDurations() {
    document.querySelectorAll('#session-list .dur').forEach((d) => {
      d.textContent = GWT.util.fmtDuration(Date.now() - Number(d.dataset.since));
    });
    for (const s of GWT.state.sessions.values()) GWT.panes.updatePane(s);
  }

  function updateAttentionCount() {
    const n = [...GWT.state.sessions.values()].filter((s) => s.status === 'attention').length;
    const ready = [...GWT.state.sessions.values()].filter((s) => s.status === 'ready').length;
    $('#attention-count').textContent = n ? `${n} need${n === 1 ? 's' : ''} you` : '';
    const admin = GWT.state.elevated ? ' [Administrator]' : '';
    document.title =
      (n
        ? `(${n} need${n === 1 ? 's' : ''} you) Mission Control`
        : ready
          ? `(${ready} ready) Mission Control`
          : 'Mission Control') + admin;
  }

  // ---------------- workspace: files ----------------

  const dirCache = new Map(); // absolute dir path -> entries

  async function listDirCached(dir, force) {
    if (force || !dirCache.has(dir)) {
      const r = await window.gwt.ws.listDir(dir);
      dirCache.set(dir, r.entries || []);
    }
    return dirCache.get(dir);
  }

  function expandedSet() {
    const f = GWT.state.focused;
    if (!GWT.state.expanded.has(f)) GWT.state.expanded.set(f, new Set());
    return GWT.state.expanded.get(f);
  }

  function badgeFor(entry) {
    const changes = GWT.state.changesMap;
    if (!changes || changes.size === 0) return null;
    const key = entry.path.toLowerCase();
    if (!entry.isDir) {
      const code = changes.get(key);
      if (!code) return null;
      if (code.includes('D')) return 'D';
      if (code.includes('?') || code.includes('A')) return 'A';
      return 'M';
    }
    const prefix = key + '\\';
    for (const k of changes.keys()) if (k.startsWith(prefix)) return 'U';
    return null;
  }

  async function renderFiles() {
    const c = $('#panel-files');
    const s = GWT.state.sessions.get(GWT.state.focused);
    c.innerHTML = '';
    if (!s) {
      c.innerHTML = '<div class="empty-note">Focus a session to see its directories.</div>';
      return;
    }
    const roots = [s.cwd, ...(s.addDirs || [])];
    for (const root of roots) {
      const rootEl = el('div', 'ws-root');
      const label = el('div', 'root-label');
      const git = GWT.state.gitInfo;
      const branch = git && git.isRepo && root === s.cwd ? `  ⎇ ${git.branch}` : '';
      label.textContent = root + branch;
      label.title = root;
      rootEl.appendChild(label);
      const holder = el('div');
      rootEl.appendChild(holder);
      c.appendChild(rootEl);
      await renderDir(holder, root, 0);
    }
  }

  async function renderDir(container, dir, depth) {
    const entries = await listDirCached(dir);
    const exp = expandedSet();
    for (const e of entries) {
      if (e.name === '.git') continue;
      const node = el('div', 'tree-node' + (e.isDir ? ' dir' : ''));
      node.style.paddingLeft = depth * 12 + 2 + 'px';
      const arrow = el('span', 'arrow');
      arrow.textContent = e.isDir ? (exp.has(e.path) ? '▾' : '▸') : '';
      const nm = el('span', 'nm');
      nm.textContent = e.name;
      nm.title = e.path;
      node.append(arrow, nm);
      const b = badgeFor(e);
      if (b) {
        const bEl = el('span', 'badge ' + b);
        bEl.textContent = b === 'U' ? '•' : b;
        node.appendChild(bEl);
      }
      node.addEventListener('click', () => {
        if (e.isDir) {
          exp.has(e.path) ? exp.delete(e.path) : exp.add(e.path);
          renderFiles();
        } else {
          openFileOrDiff(e.path);
        }
      });
      container.appendChild(node);
      if (e.isDir && exp.has(e.path)) {
        const childHolder = el('div');
        container.appendChild(childHolder);
        await renderDir(childHolder, e.path, depth + 1);
      }
    }
  }

  // Files tree: click opens the file in an editor tile in the grid
  // (pop-out to a window from the tile header). Diffs live in Changes.
  function openFileOrDiff(filePath) {
    GWT.editors.open(filePath);
  }

  // ---------------- workspace: changes ----------------

  function renderChanges() {
    const c = $('#panel-changes');
    const s = GWT.state.sessions.get(GWT.state.focused);
    const git = GWT.state.gitInfo;
    c.innerHTML = '';
    if (!s) {
      c.innerHTML = '<div class="empty-note">Focus a session to see its git changes.</div>';
      return;
    }
    if (!git || !git.isRepo) {
      c.innerHTML = '<div class="empty-note">Not a git repository.</div>';
      return;
    }
    const head = el('div', 'chg-head');
    const sync = [git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : ''].filter(Boolean).join(' ');
    head.innerHTML = `<span class="branch">⎇ ${esc(git.branch)}</span><span>${sync}</span>
      <span>${git.changes.length} change${git.changes.length === 1 ? '' : 's'}</span>`;
    c.appendChild(head);
    if (!git.changes.length) {
      c.appendChild(Object.assign(el('div', 'empty-note'), { textContent: 'Working tree clean.' }));
      return;
    }
    for (const ch of git.changes) {
      const item = el('div', 'chg-item');
      const codeEl = el('span', 'code');
      codeEl.textContent = ch.code;
      codeEl.style.color =
        ch.code.includes('D') ? 'var(--danger)' : ch.code.includes('?') || ch.code.includes('A') ? 'var(--ready)' : 'var(--attention)';
      const nmEl = el('span', 'nm');
      nmEl.textContent = ch.rel;
      nmEl.title = ch.path;
      item.append(codeEl, nmEl);
      item.addEventListener('click', () => showDiff(s.cwd, ch.path));
      c.appendChild(item);
    }
  }

  async function refreshWorkspace(force) {
    const s = GWT.state.sessions.get(GWT.state.focused);
    if (force) dirCache.clear();
    if (s) {
      const info = await window.gwt.ws.gitInfo(s.cwd);
      GWT.state.gitInfo = info;
      GWT.state.changesMap = new Map(
        (info.changes || []).map((ch) => [ch.path.toLowerCase(), ch.code])
      );
    } else {
      GWT.state.gitInfo = null;
      GWT.state.changesMap = new Map();
    }
    await renderFiles();
    renderChanges();
  }

  // ---------------- viewer (diff / file) ----------------

  function colorizeDiff(text) {
    return text
      .split('\n')
      .map((line) => {
        const e = esc(line);
        if (line.startsWith('@@')) return `<span class="dl-hunk">${e}</span>`;
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="dl-add">${e}</span>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<span class="dl-del">${e}</span>`;
        return e;
      })
      .join('\n');
  }

  async function showDiff(dir, file) {
    const r = await window.gwt.ws.gitDiff(dir, file);
    $('#view-title').textContent = file + (r.untracked ? '  (untracked — full content)' : '  (diff vs HEAD)');
    $('#view-body').innerHTML = r.error ? esc(r.error) : colorizeDiff(r.diff || '(no differences)');
    $('#dlg-view').showModal();
  }

  async function showRepoDiff(sessionId) {
    const s = GWT.state.sessions.get(sessionId);
    if (!s) return;
    const r = await window.gwt.ws.gitDiffAll(s.cwd);
    if (r.error) {
      $('#view-title').textContent = s.cwd;
      $('#view-body').textContent = r.error;
      $('#dlg-view').showModal();
      return;
    }
    const untracked = r.untracked.length
      ? `\nUntracked files:\n${r.untracked.map((u) => '  + ' + u).join('\n')}\n`
      : '';
    const text = `# ${s.name} — working tree vs HEAD (⎇ ${r.branch})\n\n${r.stat || '(no tracked changes)'}${untracked}\n${r.patch || ''}`;
    $('#view-title').textContent = `${s.cwd}  (all changes)`;
    $('#view-body').innerHTML = colorizeDiff(text);
    $('#dlg-view').showModal();
  }

  async function showFile(file) {
    const r = await window.gwt.ws.readFile(file);
    $('#view-title').textContent = file + (r.truncated ? `  (first 300 KB of ${r.size} bytes)` : '');
    $('#view-body').textContent = r.error || r.content || '(empty file)';
    $('#dlg-view').showModal();
  }

  // ---------------- activity feed ----------------

  function sessionHue(id) {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }

  function feedNode(e) {
    const item = el('div', 'feed-item' + (e.type === 'attention' ? ' attention' : ''));
    item.innerHTML = `<span class="t">${GWT.util.fmtTime(e.ts)}</span>
      <span class="who" style="color:hsl(${sessionHue(e.sessionId)} 60% var(--who-l))">${esc(e.sessionName)}</span>
      <span class="what">${esc(e.detail)}</span>`;
    item.addEventListener('click', () => GWT.app.focusSession(e.sessionId));
    return item;
  }

  function addFeedEntry(e) {
    GWT.state.feed.push(e);
    if (GWT.state.feed.length > 400) GWT.state.feed.splice(0, GWT.state.feed.length - 400);
    const panel = $('#panel-activity');
    panel.prepend(feedNode(e));
    while (panel.children.length > 400) panel.lastChild.remove();
  }

  function renderActivity() {
    const panel = $('#panel-activity');
    panel.innerHTML = '';
    for (let i = GWT.state.feed.length - 1; i >= 0; i--) panel.appendChild(feedNode(GWT.state.feed[i]));
  }

  // ---------------- tabs + right panel + refresh ----------------

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      $('#panel-' + t.dataset.tab).classList.add('active');
    })
  );
  $('#btn-refresh-ws').addEventListener('click', () => refreshWorkspace(true));
  $('#view-close').addEventListener('click', () => $('#dlg-view').close());

  // ---------------- broadcast bar ----------------

  function broadcastTargets() {
    const mode = $('#bc-target').value;
    const all = [...GWT.state.sessions.values()].filter((s) => s.status !== 'exited');
    switch (mode) {
      case 'focused':
        return GWT.state.focused ? [GWT.state.focused] : [];
      case 'claude':
        return all.filter((s) => s.kind === 'claude').map((s) => s.id);
      case 'attention':
        return all.filter((s) => s.kind === 'claude' && (s.status === 'attention' || s.status === 'ready')).map((s) => s.id);
      case 'all':
      default:
        return all.map((s) => s.id);
    }
  }

  async function sendBroadcast() {
    const input = $('#bc-input');
    const text = input.value;
    if (!text.trim()) return;
    const ids = broadcastTargets();
    if (!ids.length) return;
    await window.gwt.sessions.sendText(ids, text, true);
    input.value = '';
  }

  $('#bc-send').addEventListener('click', sendBroadcast);
  $('#bc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendBroadcast();
    }
  });
  $('#bc-interrupt').addEventListener('click', () => {
    for (const id of broadcastTargets()) window.gwt.sessions.interrupt(id);
  });
  $('#bc-target').addEventListener('change', () => GWT.app.saveUiPrefs());

  // ---------------- tab bar (tabbed layout) ----------------

  function renderTabbar() {
    const bar = document.getElementById('tabbar');
    if (!bar || GWT.state.layout !== 'tabs') return;
    bar.innerHTML = '';
    // terminal sessions in sidebar order
    for (const id of GWT.state.order) {
      const s = GWT.state.sessions.get(id);
      if (!s) continue;
      const pane = document.querySelector(`.pane[data-id="${CSS.escape(id)}"]`);
      const tab = el('div', 'tab-item' + (pane?.classList.contains('focused') ? ' active' : '') + (s.status === 'attention' ? ' attn' : ''));
      tab.style.setProperty('--tab-color', `hsl(${sessionHue(id)} 60% var(--who-l))`);
      tab.innerHTML = `<span class="dot ${s.status}"></span><span class="t-name"></span>
        <button class="t-close" title="Close session" data-icon="close"></button>`;
      tab.querySelector('.t-name').textContent = s.name;
      tab.title = `${s.name} — ${s.activity || s.status}  (double-click to rename)`;
      tab.addEventListener('click', () => GWT.app.focusSession(id));
      tab.addEventListener('dblclick', () => GWT.app.renameSession(id));
      tab.querySelector('.t-close').addEventListener('click', (e) => {
        e.stopPropagation();
        GWT.app.closeSession(id);
      });
      GWT.icons.apply(tab);
      bar.appendChild(tab);
    }
    // editor tiles
    for (const ed of (GWT.editors?.list?.() || [])) {
      const tab = el('div', 'tab-item editor' + (ed.el.classList.contains('focused') ? ' active' : ''));
      tab.style.setProperty('--tab-color', `hsl(${sessionHue(ed.path)} 25% var(--who-l))`);
      tab.innerHTML = `<span class="t-name"></span><span class="t-dirty">${ed.dirty ? '●' : ''}</span>
        <button class="t-close" title="Close editor" data-icon="close"></button>`;
      tab.querySelector('.t-name').textContent = ed.name;
      tab.title = ed.path;
      tab.addEventListener('click', () => {
        GWT.panes.setFocusedEl(ed.el);
        ed.focus();
      });
      tab.querySelector('.t-close').addEventListener('click', (e) => {
        e.stopPropagation();
        GWT.editors.close(ed.path);
      });
      GWT.icons.apply(tab);
      bar.appendChild(tab);
    }
  }

  // App-styled replacement for window.confirm. Returns the chosen button's
  // value; Escape/backdrop resolves null.
  function confirmDialog({ title, message, buttons }) {
    return new Promise((resolve) => {
      const dlg = el('dialog', 'confirm-dlg');
      dlg.innerHTML = `<h2></h2><p class="msg"></p><div class="dlg-buttons"></div>`;
      dlg.querySelector('h2').textContent = title;
      dlg.querySelector('.msg').textContent = message || '';
      const row = dlg.querySelector('.dlg-buttons');
      const done = (v) => {
        dlg.close();
        dlg.remove();
        resolve(v);
      };
      for (const b of buttons) {
        const btn = el('button', b.primary ? 'primary' : b.danger ? 'danger' : '');
        btn.textContent = b.label;
        btn.addEventListener('click', () => done(b.value));
        row.appendChild(btn);
      }
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        done(null);
      });
      document.body.appendChild(dlg);
      dlg.showModal();
    });
  }

  GWT.ui = {
    renderSidebar,
    renderTabbar,
    confirmDialog,
    tickDurations,
    updateAttentionCount,
    refreshWorkspace,
    renderActivity,
    addFeedEntry,
    showDiff,
    showFile,
    showRepoDiff,
  };
})();
