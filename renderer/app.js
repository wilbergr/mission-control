'use strict';
// App state, event wiring, dialogs, keyboard shortcuts.

window.GWT = window.GWT || {};

(() => {
  const $ = (sel) => document.querySelector(sel);

  GWT.util = {
    fmtDuration(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      return `${Math.floor(m / 60)}h ${m % 60}m`;
    },
    fmtTime(ts) {
      return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
    },
    fmtTokens(n) {
      if (n == null) return '?';
      if (n < 1000) return String(n);
      if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
      return (n / 1_000_000).toFixed(1) + 'M';
    },
    fmtAgo(ts) {
      if (!ts) return '';
      const s = Math.floor((Date.now() - ts) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    },
  };

  GWT.state = {
    sessions: new Map(), // id -> info (as described by main)
    order: [],
    focused: null,
    zoomed: false,
    hidden: new Set(), // hidden from grid (still tracked in sidebar)
    feed: [],
    gitInfo: null,
    changesMap: new Map(),
    expanded: new Map(), // sessionId -> Set of expanded dir paths
    globalTheme: 'GitHub Dark',
    fontSize: 13,
    notifications: true,
    uiMode: 'system', // 'system' | 'dark' | 'light'
    layout: 'tiles', // 'tiles' | 'tabs'
    elevated: false, // app-wide: every session inherits it (see main.js)
    history: [], // persisted session history (drives sidebar "Previous")
  };

  // ---------------- session actions ----------------

  let wsRefreshTimer = null;
  function scheduleWorkspaceRefresh(force) {
    clearTimeout(wsRefreshTimer);
    wsRefreshTimer = setTimeout(() => GWT.ui.refreshWorkspace(force), 350);
  }

  function focusSession(id, opts = {}) {
    const st = GWT.state;
    if (!st.sessions.has(id)) return;
    const changed = st.focused !== id;
    st.focused = id;
    GWT.panes.setFocused(id);
    if (st.hidden.has(id)) toggleGridVisibility(id); // focusing unhides
    if (st.zoomed) GWT.panes.fitAll();
    if (!opts.silent) GWT.panes.focusTerminal(id);
    GWT.ui.renderSidebar();
    if (changed) {
      const s = st.sessions.get(id);
      window.gwt.ws.watch([s.cwd, ...(s.addDirs || [])]);
      scheduleWorkspaceRefresh(false);
    }
  }

  async function closeSession(id) {
    const s = GWT.state.sessions.get(id);
    if (!s) return;
    if (s.status !== 'exited') {
      const choice = await GWT.ui.confirmDialog({
        title: `Close "${s.name}"?`,
        message: `The ${s.kind === 'claude' ? 'Claude session' : 'shell'} will be terminated.${
          s.kind === 'claude' ? ' You can resume the conversation later from Previous.' : ''
        }`,
        buttons: [
          { label: 'Close session', value: 'yes', danger: true },
          { label: 'Cancel', value: null },
        ],
      });
      if (!choice) return;
    }
    window.gwt.sessions.remove(id);
  }

  function toggleGridVisibility(id) {
    const st = GWT.state;
    const pane = document.querySelector(`.pane[data-id="${id}"]`);
    if (st.hidden.has(id)) {
      st.hidden.delete(id);
      pane?.classList.remove('gone');
      GWT.panes.relayout();
      // content may have reflowed at a pop-out window's size while hidden —
      // rebuild the view cleanly from the main-process buffer
      GWT.panes.refreshFromBuffer(id);
    } else {
      st.hidden.add(id);
      pane?.classList.add('gone');
      GWT.panes.relayout();
    }
    GWT.ui.renderSidebar();
  }

  function toggleZoom(force) {
    const st = GWT.state;
    st.zoomed = typeof force === 'boolean' ? force : !st.zoomed;
    $('#grid').classList.toggle('zoomed', st.zoomed);
    GWT.panes.relayout(); // grid template must collapse to 1x1 when zoomed
  }

  async function renameSession(id) {
    const s = GWT.state.sessions.get(id);
    if (!s) return;
    const name = await textPrompt('Rename session', s.name);
    if (name && name.trim()) window.gwt.sessions.rename(id, name.trim());
  }

  function cycleFocus(dir) {
    const st = GWT.state;
    if (!st.order.length) return;
    const idx = Math.max(0, st.order.indexOf(st.focused));
    const next = (idx + dir + st.order.length) % st.order.length;
    focusSession(st.order[next]);
  }

  // Minimal prompt dialog (window.prompt is unsupported in Electron).
  function textPrompt(title, value) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.innerHTML = `<h2></h2><input type="text" style="width:100%" spellcheck="false">
        <div class="dlg-buttons"><button class="c">Cancel</button><button class="ok primary">OK</button></div>`;
      dlg.querySelector('h2').textContent = title;
      const input = dlg.querySelector('input');
      input.value = value || '';
      const done = (v) => {
        dlg.close();
        dlg.remove();
        resolve(v);
      };
      dlg.querySelector('.c').addEventListener('click', () => done(null));
      dlg.querySelector('.ok').addEventListener('click', () => done(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(input.value);
        if (e.key === 'Escape') done(null);
      });
      document.body.appendChild(dlg);
      dlg.showModal();
      input.select();
    });
  }

  function saveUiPrefs() {
    window.gwt.app.saveUiPrefs({
      rightCollapsed: $('#right').classList.contains('collapsed'),
      leftCollapsed: $('#sidebar').classList.contains('collapsed'),
      bcTarget: $('#bc-target').value,
      termTheme: GWT.state.globalTheme,
      fontSize: GWT.state.fontSize,
      notifications: GWT.state.notifications,
      uiMode: GWT.state.uiMode,
      layout: GWT.state.layout,
    });
  }

  function applyLayout() {
    const tabbed = GWT.state.layout === 'tabs';
    document.getElementById('grid').classList.toggle('tabbed', tabbed);
    document.getElementById('tabbar').style.display = tabbed ? 'flex' : 'none';
    const btn = $('#btn-layout');
    btn.innerHTML = '';
    btn.insertAdjacentHTML('afterbegin', GWT.icons.MAP[tabbed ? 'tiles' : 'tabs']);
    btn.append(tabbed ? ' Tiles' : ' Tabs');
    if (tabbed && !document.querySelector('#grid .pane.focused') && GWT.state.order.length) {
      focusSession(GWT.state.order[0]);
    }
    GWT.ui.renderTabbar();
    GWT.panes.relayout();
  }

  function toggleLayout() {
    GWT.state.layout = GWT.state.layout === 'tabs' ? 'tiles' : 'tabs';
    applyLayout();
    saveUiPrefs();
  }

  const sysLight = window.matchMedia('(prefers-color-scheme: light)');
  function resolvedUiLight() {
    return GWT.state.uiMode === 'light' || (GWT.state.uiMode === 'system' && sysLight.matches);
  }
  function applyUiMode() {
    const light = resolvedUiLight();
    document.documentElement.dataset.ui = light ? 'light' : 'dark';
    GWT.editors.applyUiTheme(light);
    window.gwt.app.setNativeTheme(GWT.state.uiMode);
  }
  sysLight.addEventListener('change', () => {
    if (GWT.state.uiMode === 'system') applyUiMode();
  });
  GWT.app = GWT.app || {};
  GWT.appUiLight = resolvedUiLight; // used by editor tiles created later

  // Elevation applies to the whole app, so it is surfaced in chrome (badge +
  // window title) rather than per session.
  function applyElevationUi() {
    const on = GWT.state.elevated;
    const chip = $('#admin-chip');
    chip.classList.toggle('on', on);
    chip.title = on ? 'Mission Control is running with administrator privileges' : '';
    $('#nf-elev-hint').textContent = on
      ? 'Mission Control is running as administrator — every new session will be elevated.'
      : "Sessions run with Mission Control's privileges. For an elevated session, use Settings → Restart as administrator.";
    GWT.ui.updateAttentionCount(); // repaints the title-bar suffix
  }

  function togglePanel(sel, force) {
    const el = $(sel);
    el.classList.toggle('collapsed', typeof force === 'boolean' ? force : undefined);
    GWT.panes.fitAll();
    saveUiPrefs();
  }

  // ---------------- session history (sidebar "Previous" + Recent dialog) ----

  let histTimer = null;
  function scheduleHistoryRefresh() {
    // main persists history on a 400ms debounce — fetch a beat after that
    clearTimeout(histTimer);
    histTimer = setTimeout(async () => {
      GWT.state.history = await window.gwt.app.history();
      GWT.ui.renderSidebar();
    }, 1200);
  }

  /** Relaunch a history entry; returns an error string or null. */
  async function launchHistory(h, { resume = true } = {}) {
    if (resume && h.claudeSessionId) {
      const live = [...GWT.state.sessions.values()].find(
        (s) => s.claudeSessionId === h.claudeSessionId && s.status !== 'exited'
      );
      if (live) {
        focusSession(live.id);
        return null;
      }
    }
    try {
      await window.gwt.sessions.create({
        name: h.name,
        kind: h.kind,
        cwd: h.cwd,
        addDirs: h.addDirs,
        extraArgs: h.extraArgs,
        distro: h.distro || undefined,
        theme: h.theme || undefined,
        resume: resume && h.claudeSessionId ? h.claudeSessionId : undefined,
      });
      return null;
    } catch (err) {
      return String(err.message || err);
    }
  }

  async function removeHistory(hid) {
    GWT.state.history = await window.gwt.app.historyRemove(hid);
    GWT.ui.renderSidebar();
  }

  async function renameHistory(hid, currentName) {
    const name = await textPrompt('Rename previous session', currentName);
    if (!name || !name.trim()) return;
    GWT.state.history = await window.gwt.app.historyRename(hid, name.trim());
    GWT.ui.renderSidebar();
  }

  GWT.app = {
    focusSession, closeSession, toggleGridVisibility, toggleZoom, renameSession,
    saveUiPrefs, launchHistory, removeHistory, renameHistory,
  };

  // ---------------- new session dialog ----------------

  const dlgNew = $('#dlg-new');

  function openNewDialog() {
    $('#nf-error').textContent = '';
    $('#nf-gitline').textContent = '';
    loadWslDistros();
    dlgNew.showModal();
    $('#nf-dir').focus();
  }

  async function checkDirGit() {
    const dir = $('#nf-dir').value.trim();
    const line = $('#nf-gitline');
    const wt = $('#nf-worktree');
    const br = $('#nf-branch');
    if (!dir) {
      line.textContent = '';
      wt.disabled = br.disabled = true;
      return;
    }
    const info = await window.gwt.ws.gitInfo(dir);
    if (info.isRepo) {
      line.textContent = `git repository · branch ${info.branch} · ${info.changes.length} uncommitted change(s)`;
      wt.disabled = false;
      br.disabled = !wt.checked;
    } else {
      line.textContent = 'not a git repository';
      wt.checked = false;
      wt.disabled = br.disabled = true;
    }
  }

  $('#nf-browse').addEventListener('click', async () => {
    const dir = await window.gwt.app.pickDir();
    if (dir) {
      $('#nf-dir').value = dir;
      checkDirGit();
    }
  });
  $('#nf-dir').addEventListener('change', checkDirGit);
  $('#nf-worktree').addEventListener('change', () => {
    $('#nf-branch').disabled = !$('#nf-worktree').checked;
    if ($('#nf-worktree').checked) $('#nf-branch').focus();
  });
  document.querySelectorAll('#new-form input[name="kind"]').forEach((r) =>
    r.addEventListener('change', () => {
      if (!r.checked) return;
      $('#nf-claude-opts').style.display = r.value === 'claude' ? '' : 'none';
      $('#nf-dir').placeholder =
        r.value === 'claude' ? 'C:\\src\\myproject' : '(leave blank to open in your home directory)';
    })
  );

  // Offer WSL only when distros are actually installed. Deferred until the
  // dialog is first opened rather than run at startup: enumerating distros
  // means spawning wsl.exe, and there's no reason to do that for someone who
  // never creates a session. Main caches the result, so this costs one spawn.
  let wslLoaded = false;
  async function loadWslDistros() {
    if (wslLoaded) return;
    wslLoaded = true;
    try {
      const distros = await window.gwt.app.wslDistros();
      if (distros.length) {
        $('#nf-wsl-label').style.display = '';
        $('#nf-distro').innerHTML = distros
          .map((d) => `<option value="${d.replace(/"/g, '&quot;')}">${d}</option>`)
          .join('');
      }
    } catch { /* wsl.exe missing — keep option hidden */ }
  }
  $('#nf-cancel').addEventListener('click', () => dlgNew.close());

  $('#new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#nf-error');
    errEl.textContent = '';
    const kind = document.querySelector('#new-form input[name="kind"]:checked').value;
    let cwd = $('#nf-dir').value.trim();
    let name = $('#nf-name').value.trim();
    if (!cwd && kind === 'claude') {
      errEl.textContent = 'Directory is required for Claude sessions.';
      return;
    }
    try {
      if (kind === 'claude' && $('#nf-worktree').checked) {
        const r = await window.gwt.ws.worktreeAdd(cwd, $('#nf-branch').value);
        if (r.error) {
          errEl.textContent = r.error;
          return;
        }
        cwd = r.path;
        if (!name) name = r.branch;
      }
      const addDirs = $('#nf-adddirs').value.split('\n').map((l) => l.trim()).filter(Boolean);
      // Friendly dropdowns become CLI flags; folding them into extraArgs means
      // they persist through history/restore like any other launch options.
      const flagParts = [];
      if ($('#nf-model').value) flagParts.push(`--model ${$('#nf-model').value}`);
      if ($('#nf-permmode').value) flagParts.push(`--permission-mode ${$('#nf-permmode').value}`);
      flagParts.push($('#nf-args').value.trim());
      await window.gwt.sessions.create({
        name: name || undefined,
        kind,
        cwd,
        addDirs,
        extraArgs: flagParts.filter(Boolean).join(' '),
        continue: $('#nf-continue').checked,
        distro: kind === 'wsl' ? $('#nf-distro').value : undefined,
        initialPrompt: $('#nf-prompt').value.trim() || undefined,
      });
      dlgNew.close();
      $('#nf-name').value = '';
      $('#nf-continue').checked = false;
      $('#nf-worktree').checked = false;
      $('#nf-branch').value = '';
      $('#nf-prompt').value = '';
      $('#nf-model').value = '';
      $('#nf-permmode').value = '';
    } catch (err) {
      errEl.textContent = String(err.message || err).replace(/^.*Error(?: invoking remote method '[^']+')?:\s*/, '');
    }
  });

  $('#btn-new').addEventListener('click', openNewDialog);
  $('#btn-new-2').addEventListener('click', openNewDialog);
  $('#btn-layout').addEventListener('click', toggleLayout);
  $('#btn-collapse-left').addEventListener('click', () => togglePanel('#sidebar', true));
  $('#left-rail').addEventListener('click', () => togglePanel('#sidebar', false));
  $('#btn-collapse-right').addEventListener('click', () => togglePanel('#right', true));
  $('#right-rail').addEventListener('click', () => togglePanel('#right', false));

  // ---------------- keyboard shortcuts ----------------

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.shiftKey) {
        const map = {
          KeyN: () => openNewDialog(),
          KeyZ: () => toggleZoom(),
          KeyB: () => $('#bc-input').focus(),
          KeyE: () => togglePanel('#right'),
          KeyF: () => GWT.state.focused && GWT.panes.openSearch(GWT.state.focused),
          KeyT: () => toggleLayout(),
          ArrowLeft: () => cycleFocus(-1),
          ArrowRight: () => cycleFocus(1),
        };
        if (map[e.code]) {
          e.preventDefault();
          e.stopPropagation();
          map[e.code]();
          return;
        }
      }
      if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
        const idx = Number(e.code.slice(5)) - 1;
        if (GWT.state.order[idx]) {
          e.preventDefault();
          e.stopPropagation();
          focusSession(GWT.state.order[idx]);
        }
      }
    },
    true
  );

  // ---------------- main-process event wiring ----------------

  function upsertSession(info) {
    const st = GWT.state;
    const isNew = !st.sessions.has(info.id);
    st.sessions.set(info.id, info);
    if (isNew) st.order.push(info.id);
    return isNew;
  }

  window.gwt.on('session:created', async (info) => {
    upsertSession(info);
    await GWT.panes.createPane(info);
    GWT.ui.renderSidebar();
    focusSession(info.id);
    scheduleHistoryRefresh();
  });

  window.gwt.on('session:data', ({ id, data }) => GWT.panes.writeData(id, data));

  window.gwt.on('session:status', (info) => {
    const prev = GWT.state.sessions.get(info.id);
    if (info.claudeSessionId && (!prev || !prev.claudeSessionId)) scheduleHistoryRefresh();
    upsertSession(info);
    GWT.panes.updatePane(info);
    GWT.ui.renderSidebar();
    // Claude finishing a turn usually means files changed — refresh the panel.
    if (info.id === GWT.state.focused && (info.status === 'ready' || info.status === 'attention')) {
      scheduleWorkspaceRefresh(true);
    }
  });

  window.gwt.on('session:exit', () => {
    GWT.ui.renderSidebar();
    scheduleHistoryRefresh();
  });

  window.gwt.on('session:removed', ({ id }) => {
    const st = GWT.state;
    st.sessions.delete(id);
    st.order = st.order.filter((x) => x !== id);
    st.hidden.delete(id);
    st.expanded.delete(id);
    GWT.panes.removePane(id);
    scheduleHistoryRefresh();
    if (st.focused === id) {
      st.focused = null;
      if (st.order.length) focusSession(st.order[st.order.length - 1]);
      else {
        GWT.ui.renderSidebar();
        GWT.ui.refreshWorkspace(false);
      }
    } else {
      GWT.ui.renderSidebar();
    }
  });

  window.gwt.on('session:activity', (e) => GWT.ui.addFeedEntry(e));
  window.gwt.on('session:focus-request', ({ id }) => focusSession(id));
  window.gwt.on('session:popin', ({ id }) => {
    // popped-out window closed -> re-dock the tile
    if (GWT.state.hidden.has(id) && GWT.state.sessions.has(id)) toggleGridVisibility(id);
  });
  window.gwt.on('editor:dock', ({ file }) => GWT.editors.open(file));
  window.gwt.on('ws:changed', () => scheduleWorkspaceRefresh(true));
  window.gwt.on('window:focus', () => GWT.ui.updateAttentionCount());

  // ---------------- init ----------------

  (async function init() {
    const prefs = await window.gwt.app.uiPrefs();
    if (prefs.rightCollapsed) $('#right').classList.add('collapsed');
    if (prefs.leftCollapsed) $('#sidebar').classList.add('collapsed');
    if (prefs.bcTarget) $('#bc-target').value = prefs.bcTarget;
    if (prefs.termTheme && GWT.themes.valid(prefs.termTheme)) GWT.state.globalTheme = prefs.termTheme;
    if (prefs.fontSize >= 9 && prefs.fontSize <= 22) GWT.state.fontSize = prefs.fontSize;
    GWT.state.notifications = prefs.notifications !== false;
    if (['system', 'dark', 'light'].includes(prefs.uiMode)) GWT.state.uiMode = prefs.uiMode;
    applyUiMode();
    if (['tiles', 'tabs'].includes(prefs.layout)) GWT.state.layout = prefs.layout;
    applyLayout();
    GWT.state.elevated = await window.gwt.app.isElevated();
    applyElevationUi();

    // settings dialog
    const themeSel = $('#set-theme');
    themeSel.innerHTML = GWT.themes.names().map((n) => `<option>${n}</option>`).join('');
    $('#btn-settings').addEventListener('click', () => {
      themeSel.value = GWT.state.globalTheme;
      $('#set-font').value = GWT.state.fontSize;
      $('#set-notif').checked = GWT.state.notifications;
      $('#set-uimode').value = GWT.state.uiMode;
      $('#set-elev-state').textContent = GWT.state.elevated
        ? 'Running as administrator'
        : 'Running as standard user';
      $('#set-elevate').style.display = GWT.state.elevated ? 'none' : '';
      $('#set-elev-error').textContent = '';
      $('#dlg-settings').showModal();
    });
    $('#set-elevate').addEventListener('click', async () => {
      const choice = await GWT.ui.confirmDialog({
        title: 'Restart as administrator?',
        message:
          'Windows cannot elevate a session on its own, so Mission Control has to relaunch itself. ' +
          'You will get a UAC prompt, and every running session will be closed — Claude conversations ' +
          'can be resumed afterwards from Previous.',
        buttons: [
          { label: 'Restart elevated', value: 'yes', primary: true },
          { label: 'Cancel', value: null },
        ],
      });
      if (!choice) return;
      const r = await window.gwt.app.relaunchElevated();
      // Success quits this instance, so only failures ever render here.
      if (!r.ok) $('#set-elev-error').textContent = r.error || 'Could not restart as administrator.';
    });
    $('#set-uimode').addEventListener('change', () => {
      GWT.state.uiMode = $('#set-uimode').value;
      applyUiMode();
      saveUiPrefs();
    });
    $('#settings-close').addEventListener('click', () => $('#dlg-settings').close());
    themeSel.addEventListener('change', () => {
      GWT.state.globalTheme = themeSel.value;
      GWT.panes.applyGlobalTheme();
      saveUiPrefs();
    });
    $('#set-font').addEventListener('change', () => {
      const v = Math.max(9, Math.min(22, Number($('#set-font').value) || 13));
      GWT.state.fontSize = v;
      $('#set-font').value = v;
      GWT.panes.applyFontSize(v);
      saveUiPrefs();
    });
    $('#set-notif').addEventListener('change', () => {
      GWT.state.notifications = $('#set-notif').checked;
      saveUiPrefs();
    });

    // Re-attach to sessions that already exist (e.g. renderer reload).
    const existing = await window.gwt.sessions.list();
    for (const info of existing) {
      upsertSession(info);
      await GWT.panes.createPane(info);
    }
    if (existing.length) focusSession(existing[existing.length - 1].id);

    // no startup modals — previous sessions live in the sidebar
    GWT.state.history = await window.gwt.app.history();
    GWT.ui.renderSidebar();

    setInterval(() => GWT.ui.tickDurations(), 5000);

    // Warm up Monaco in the background so the first editor tile opens instantly.
    const warm = () => GWT.editors.preload().catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 5000 });
    else setTimeout(warm, 2500);
  })();
})();
