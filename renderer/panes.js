'use strict';
// Terminal pane grid: one xterm.js terminal per session, auto-tiled.

window.GWT = window.GWT || {};

(() => {
  // xterm UMD builds expose either the class itself or a namespace object.
  const XTerminal = typeof Terminal === 'function' ? Terminal : Terminal.Terminal;
  const XFit = typeof FitAddon === 'function' ? FitAddon : FitAddon.FitAddon;
  const XWebLinks = typeof WebLinksAddon === 'function' ? WebLinksAddon : WebLinksAddon.WebLinksAddon;
  const XSearch = typeof SearchAddon === 'function' ? SearchAddon : SearchAddon.SearchAddon;

  function effectiveThemeName(info) {
    if (info.theme && GWT.themes.valid(info.theme)) return info.theme;
    return GWT.state && GWT.themes.valid(GWT.state.globalTheme) ? GWT.state.globalTheme : GWT.themes.DEFAULT;
  }

  function applyTheme(p, name) {
    if (p.appliedTheme === name) return;
    p.appliedTheme = name;
    const t = GWT.themes.get(name);
    p.term.options.theme = t;
    p.el.style.background = t.background;
    p.el.querySelector('.pane-term').style.background = t.background;
  }

  const panes = new Map(); // id -> {el, term, fit, els:{...}, ro}
  const gridEl = () => document.getElementById('grid');

  const STATUS_LABEL = {
    starting: 'Starting', working: 'Working', attention: 'Needs you',
    ready: 'Your turn', running: 'Running', exited: 'Exited',
  };

  function shortPath(p, max = 42) {
    if (!p) return '';
    return p.length <= max ? p : '…' + p.slice(p.length - max + 1);
  }

  // Ctrl+C is ambiguous in a terminal — it means both "copy" and SIGINT. Follow
  // the Windows Terminal convention: copy when text is selected, otherwise fall
  // through so the interrupt still reaches the shell. Ctrl+Shift+C/V are
  // unambiguous aliases, and Ctrl+Shift+C is swallowed even with nothing
  // selected so it can never fire an unexpected interrupt.
  //
  // Paste goes through term.paste() rather than a raw PTY write so the running
  // program's bracketed-paste mode is honored — that keeps a multi-line paste
  // as one input in Claude instead of submitting on every newline.
  //
  // Returns whether the event should continue on to the PTY.
  function handleClipboardKey(ev, term) {
    if (!ev.ctrlKey || ev.altKey) return true;
    if (ev.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) {
        window.gwt.app.clipboardWrite(sel);
        term.clearSelection();
        return false;
      }
      return !ev.shiftKey; // bare Ctrl+C with no selection must still interrupt
    }
    if (ev.code === 'KeyV') {
      window.gwt.app.clipboardRead().then((text) => {
        if (text) term.paste(text);
      });
      return false;
    }
    return true;
  }

  async function createPane(info) {
    if (panes.has(info.id)) return;
    const el = document.createElement('div');
    el.className = 'pane';
    el.dataset.id = info.id;
    el.innerHTML = `
      <div class="pane-head" draggable="true">
        <span class="dot"></span>
        <span class="name"></span>
        <span class="meta"></span>
        <button class="b-theme" title="Color scheme for this session" data-icon="swatch"></button>
        <button class="b-diff" title="Working-tree diff for this session" data-icon="diff"></button>
        <button class="b-pop" title="Pop out to its own window" data-icon="popout"></button>
        <button class="b-interrupt" title="Interrupt (Esc/Ctrl+C)" data-icon="stop"></button>
        <button class="b-zoom" title="Zoom (Ctrl+Shift+Z)" data-icon="zoom"></button>
        <button class="b-close" title="Close session" data-icon="close"></button>
      </div>
      <div class="pane-term">
        <div class="pane-search">
          <input type="text" placeholder="Find… (Enter next, Shift+Enter prev)" spellcheck="false">
          <button class="s-close" title="Close (Esc)" data-icon="close"></button>
        </div>
      </div>
      <div class="pane-foot">
        <div class="pf-question"></div>
        <div class="pf-options"></div>
        <div class="pf-row">
          <span class="pf-hint">keys:</span>
          <button data-k="up" title="Arrow up" data-icon="keyUp"></button>
          <button data-k="down" title="Arrow down" data-icon="keyDown"></button>
          <button data-k="space" title="Space (toggle multi-select)" data-icon="keySpace"></button>
          <button data-k="enter" title="Enter" data-icon="keyEnter"></button>
          <button data-k="esc" title="Escape" data-icon="keyEsc"></button>
        </div>
      </div>`;
    const els = {
      dot: el.querySelector('.dot'),
      name: el.querySelector('.name'),
      meta: el.querySelector('.meta'),
      question: el.querySelector('.pf-question'),
      options: el.querySelector('.pf-options'),
      search: el.querySelector('.pane-search'),
      searchInput: el.querySelector('.pane-search input'),
    };

    const term = new XTerminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: (GWT.state && GWT.state.fontSize) || 13,
      lineHeight: 1.15,
      scrollback: 8000,
      theme: GWT.themes.get(effectiveThemeName(info)),
      allowProposedApi: true,
    });
    const fit = new XFit();
    term.loadAddon(fit);
    term.loadAddon(new XWebLinks((_ev, uri) => window.gwt.ws.openExternal(uri)));
    const search = new XSearch();
    term.loadAddon(search);

    // Let app-level shortcuts through; everything else goes to the PTY.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const global =
        (ev.ctrlKey && ev.shiftKey &&
          ['KeyN', 'KeyZ', 'KeyB', 'KeyE', 'KeyF', 'KeyT', 'ArrowLeft', 'ArrowRight'].includes(ev.code)) ||
        (ev.altKey && /^Digit[1-9]$/.test(ev.code));
      if (global) return false;
      return handleClipboardKey(ev, term);
    });

    term.onData((d) => window.gwt.sessions.write(info.id, d));
    term.onResize(({ cols, rows }) => window.gwt.sessions.resize(info.id, cols, rows));
    term.open(el.querySelector('.pane-term'));

    el.addEventListener('mousedown', (e) => {
      // don't yank keyboard focus into the terminal when clicking footer/search UI
      const silent = !!e.target.closest('.pane-foot, .pane-search, button');
      GWT.app.focusSession(info.id, { silent });
    });
    term.textarea?.addEventListener('focus', () => GWT.app.focusSession(info.id, { silent: true }));
    el.querySelector('.b-close').addEventListener('click', (e) => {
      e.stopPropagation();
      GWT.app.closeSession(info.id);
    });
    el.querySelector('.b-zoom').addEventListener('click', (e) => {
      e.stopPropagation();
      GWT.app.focusSession(info.id);
      GWT.app.toggleZoom();
    });
    el.querySelector('.b-interrupt').addEventListener('click', (e) => {
      e.stopPropagation();
      window.gwt.sessions.interrupt(info.id);
    });
    el.querySelector('.b-diff').addEventListener('click', (e) => {
      e.stopPropagation();
      GWT.ui.showRepoDiff(info.id);
    });
    el.querySelector('.b-theme').addEventListener('click', (e) => {
      e.stopPropagation();
      showThemeMenu(e.currentTarget, info.id);
    });
    el.querySelector('.b-pop').addEventListener('click', (e) => {
      e.stopPropagation();
      window.gwt.sessions.popout(info.id);
      // undock: hide the tile; it re-docks when the window closes
      if (!GWT.state.hidden.has(info.id)) GWT.app.toggleGridVisibility(info.id);
    });
    const head = el.querySelector('.pane-head');
    head.addEventListener('dblclick', () => GWT.app.renameSession(info.id));
    makeDraggableTile(el, head);

    // ---- utility keys (shown only while the session needs input) ----
    const KEYSEQ = { up: '\x1b[A', down: '\x1b[B', space: ' ', enter: '\r', esc: '\x1b' };
    el.querySelectorAll('.pf-row button').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        window.gwt.sessions.write(info.id, KEYSEQ[b.dataset.k]);
      })
    );

    // ---- search overlay ----
    els.searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.shiftKey) search.findPrevious(els.searchInput.value);
      else if (e.key === 'Enter') search.findNext(els.searchInput.value);
      else if (e.key === 'Escape') closeSearch(info.id);
    });
    els.searchInput.addEventListener('input', () => search.findNext(els.searchInput.value, { incremental: true }));
    el.querySelector('.s-close').addEventListener('click', () => closeSearch(info.id));

    let fitTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        if (el.offsetParent !== null && el.clientHeight > 40) {
          try { fit.fit(); } catch { /* transient zero-size during layout */ }
        }
      }, 60);
    });
    ro.observe(el.querySelector('.pane-term'));

    GWT.icons.apply(el);
    panes.set(info.id, { el, term, fit, search, els, ro, menuTimer: null });
    gridEl().appendChild(el);
    updatePane(info);
    relayout();

    // Replay whatever the session printed before this pane existed.
    const buf = await window.gwt.sessions.buffer(info.id);
    if (buf) term.write(buf);
  }

  function removePane(id) {
    const p = panes.get(id);
    if (!p) return;
    p.ro.disconnect();
    p.term.dispose();
    p.el.remove();
    panes.delete(id);
    relayout();
  }

  function writeData(id, data) {
    const p = panes.get(id);
    if (!p) return;
    p.term.write(data);
    // menus can finish painting after the attention status arrives — re-parse
    const info = GWT.state && GWT.state.sessions.get(id);
    if (info && info.status === 'attention') {
      clearTimeout(p.menuTimer);
      p.menuTimer = setTimeout(() => renderResponseStrip(id), 300);
    }
  }

  // Small floating menu for picking a per-session scheme.
  function showThemeMenu(anchor, sessionId) {
    document.querySelector('.theme-menu')?.remove();
    const info = GWT.state.sessions.get(sessionId);
    const menu = document.createElement('div');
    menu.className = 'theme-menu';
    const items = [{ name: null, label: `Use global (${GWT.state.globalTheme})` }].concat(
      GWT.themes.names().map((n) => ({ name: n, label: n }))
    );
    for (const it of items) {
      const b = document.createElement('button');
      const t = it.name ? GWT.themes.get(it.name) : null;
      b.innerHTML = t
        ? `<span class="swatch" style="background:${t.background};border-color:${t.foreground}"></span>`
        : '<span class="swatch none"></span>';
      b.append(it.label + ((info && info.theme) === it.name ? '  ✓' : ''));
      b.addEventListener('click', () => {
        window.gwt.sessions.setTheme(sessionId, it.name);
        menu.remove();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 240)) + 'px';
    menu.style.top = r.bottom + 4 + 'px';
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        window.removeEventListener('mousedown', close, true);
      }
    };
    window.addEventListener('mousedown', close, true);
  }

  // Re-skin panes that follow the global default (no per-session override).
  function applyGlobalTheme() {
    for (const [id, p] of panes) {
      const info = GWT.state.sessions.get(id);
      if (info) applyTheme(p, effectiveThemeName(info));
    }
  }

  function applyFontSize(size) {
    for (const p of panes.values()) {
      p.term.options.fontSize = size;
    }
    fitAll();
  }

  function updatePane(info) {
    const p = panes.get(info.id);
    if (!p) return;
    applyTheme(p, effectiveThemeName(info));
    p.els.dot.className = `dot ${info.status}`;
    p.els.name.textContent = info.name;
    const dur = GWT.util.fmtDuration(Date.now() - info.statusSince);
    const usage = info.usage
      ? ` · ctx ${GWT.util.fmtTokens(info.usage.ctx)} · out ${GWT.util.fmtTokens(info.usage.out)}`
      : '';
    p.els.meta.textContent =
      `${STATUS_LABEL[info.status] || info.status} · ${dur}${usage} — ${info.activity || ''}  ·  ${shortPath(info.cwd)}`;
    p.el.classList.toggle('attention', info.status === 'attention');
    updateResponseStrip(info);
  }

  // ---- respond-to-options strip -------------------------------------------
  // Sources, in order of preference:
  //  1. structured question from the AskUserQuestion hook (info.pendingQuestion)
  //  2. numbered menu parsed from the visible terminal screen (permission
  //     prompts, plan approval, trust dialogs, ...)

  function parseMenuFromScreen(term) {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = buf.viewportY; y < buf.viewportY + term.rows && y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    const clean = lines.map((l) => l.replace(/[│┃║╭╮╰╯├┤┬┴─═┄┆┊>]/g, ' ').trimEnd());
    const found = []; // {i, n, label}
    for (let i = 0; i < clean.length; i++) {
      const m = /^\s*(?:❯\s*)?(\d{1,2})[.)]\s+(.+)$/.exec(clean[i]);
      if (m) found.push({ i, n: +m[1], label: m[2].trim() });
    }
    if (!found.length) return null;
    // take the last cluster that starts at option 1 and counts upward
    let start = -1;
    for (let k = found.length - 1; k >= 0; k--) {
      if (found[k].n === 1) { start = k; break; }
    }
    if (start < 0) return null;
    const options = [found[start]];
    for (let k = start + 1; k < found.length; k++) {
      if (found[k].n === options.length + 1 && found[k].i - options[options.length - 1].i <= 3) {
        options.push(found[k]);
      } else break;
    }
    if (options.length < 2) return null;
    // question: closest non-empty lines directly above the menu
    const qLines = [];
    for (let y = options[0].i - 1; y >= 0 && qLines.length < 3; y--) {
      const t = clean[y].trim();
      if (!t) { if (qLines.length) break; else continue; }
      qLines.unshift(t);
    }
    return {
      question: qLines.join(' ').slice(0, 220),
      multiSelect: false,
      options: options.map((o) => ({ n: o.n, label: o.label.slice(0, 120) })),
    };
  }

  function updateResponseStrip(info) {
    const p = panes.get(info.id);
    if (!p) return;
    const foot = p.el.querySelector('.pane-foot');
    if (info.status !== 'attention') {
      foot.style.display = 'none';
      p.els.question.style.display = 'none';
      p.els.options.style.display = 'none';
      p.els.options.innerHTML = '';
      return;
    }
    foot.style.display = 'block';
    // parse a beat after the menu paints; re-run once more in case it's slow
    clearTimeout(p.menuTimer);
    p.menuTimer = setTimeout(() => renderResponseStrip(info.id), 250);
    setTimeout(() => {
      if (GWT.state.sessions.get(info.id)?.status === 'attention') renderResponseStrip(info.id);
    }, 1200);
  }

  function renderResponseStrip(id) {
    const p = panes.get(id);
    const info = GWT.state.sessions.get(id);
    if (!p || !info || info.status !== 'attention') return;

    let menu = parseMenuFromScreen(p.term);
    if (!menu && info.pendingQuestion && info.pendingQuestion.length) {
      const q = info.pendingQuestion[0];
      menu = {
        question: q.question,
        multiSelect: q.multiSelect,
        options: q.options.map((label, i) => ({ n: i + 1, label })),
      };
    }
    if (!menu) {
      p.els.question.style.display = 'none';
      p.els.options.style.display = 'none';
      p.els.options.innerHTML = '';
      return;
    }
    p.els.question.textContent =
      (menu.question || 'Choose an option') + (menu.multiSelect ? '  (multi-select: ␣ toggles, ⏎ submits)' : '');
    p.els.question.style.display = 'block';
    p.els.options.innerHTML = '';
    for (const opt of menu.options) {
      const b = document.createElement('button');
      b.className = 'pf-opt';
      b.textContent = `${opt.n} · ${opt.label}`;
      b.title = opt.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        window.gwt.sessions.write(id, String(opt.n));
      });
      p.els.options.appendChild(b);
    }
    p.els.options.style.display = 'flex';
  }

  // ---- search overlay -------------------------------------------------------

  function openSearch(id) {
    const p = panes.get(id);
    if (!p) return;
    p.els.search.style.display = 'flex';
    p.els.searchInput.focus();
    p.els.searchInput.select();
  }

  function closeSearch(id) {
    const p = panes.get(id);
    if (!p) return;
    p.els.search.style.display = 'none';
    try { p.search.clearDecorations(); } catch { /* addon version without decorations */ }
    p.term.focus();
  }

  // ---- drag to reorder (any tile: terminal or editor) ------------------------

  let dragEl = null;

  function makeDraggableTile(tileEl, handle) {
    handle.setAttribute('draggable', 'true');
    handle.addEventListener('dragstart', (e) => {
      dragEl = tileEl;
      e.dataTransfer.setData('text/gwt-tile', '1');
      e.dataTransfer.effectAllowed = 'move';
      tileEl.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
      tileEl.classList.remove('dragging');
      dragEl = null;
    });
    tileEl.addEventListener('dragover', (e) => {
      if (dragEl && dragEl !== tileEl) {
        e.preventDefault();
        tileEl.classList.add('drop-target');
      }
    });
    tileEl.addEventListener('dragleave', () => tileEl.classList.remove('drop-target'));
    tileEl.addEventListener('drop', (e) => {
      tileEl.classList.remove('drop-target');
      if (!dragEl || dragEl === tileEl) return;
      e.preventDefault();
      const grid = gridEl();
      const kids = [...grid.children];
      if (kids.indexOf(dragEl) < kids.indexOf(tileEl)) grid.insertBefore(dragEl, tileEl.nextSibling);
      else grid.insertBefore(dragEl, tileEl);
      syncOrderFromDom();
      relayout();
    });
  }

  // Sidebar order / Alt+N follow the visual grid order after a drag.
  function syncOrderFromDom() {
    if (!GWT.state) return;
    GWT.state.order = [...gridEl().querySelectorAll('.pane[data-id]')].map((p) => p.dataset.id);
    GWT.ui.renderSidebar();
  }

  function reorderDom(order) {
    const grid = gridEl();
    for (const id of order) {
      const p = panes.get(id);
      if (p) grid.appendChild(p.el);
    }
    relayout();
  }

  // Grid focus works for any pane (terminal or editor tile).
  function setFocusedEl(el) {
    for (const pane of gridEl().querySelectorAll('.pane')) {
      pane.classList.toggle('focused', pane === el);
    }
    GWT.ui?.renderTabbar?.();
    if (GWT.state && GWT.state.layout === 'tabs') fitAll();
  }

  function setFocused(id) {
    setFocusedEl(panes.get(id)?.el || null);
  }

  function relayout() {
    const grid = gridEl();
    // count every visible tile: terminal panes AND editor panes
    const visible = [...grid.querySelectorAll('.pane')].filter((el) => !el.classList.contains('gone'));
    grid.classList.toggle('empty', visible.length === 0);
    // zoomed or tabbed: a single visible pane owns the whole grid
    const single = GWT.state && (GWT.state.zoomed || GWT.state.layout === 'tabs');
    const n = single ? 1 : Math.max(1, visible.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    fitAll();
  }

  function fitAll() {
    requestAnimationFrame(() => {
      for (const p of panes.values()) {
        if (p.el.offsetParent !== null && p.el.clientHeight > 40) {
          try { p.fit.fit(); } catch { /* ignore */ }
        }
      }
    });
  }

  function focusTerminal(id) {
    panes.get(id)?.term.focus();
  }

  // Rebuild a pane's terminal from the main-process ring buffer. Used when a
  // tile comes back from being hidden/popped-out: while hidden it received
  // output sized for the pop-out window, so its buffer no longer matches the
  // tile. Replay restores scrollback; the history may still contain redraws
  // cursor-addressed for the other window's dimensions, so finish with a
  // deliberate PTY size jiggle (the "zoom out and in" effect) to make the
  // running TUI repaint itself cleanly at the tile's real size.
  async function refreshFromBuffer(id) {
    const p = panes.get(id);
    if (!p) return;
    await new Promise((r) => requestAnimationFrame(r)); // let layout settle
    try { p.fit.fit(); } catch { /* zero-size during layout */ }
    const buf = await window.gwt.sessions.buffer(id);
    p.term.reset();
    const jiggle = () => {
      const info = GWT.state.sessions.get(id);
      if (!info || info.status === 'exited') return;
      const { cols, rows } = p.term;
      window.gwt.sessions.resize(id, cols, rows > 2 ? rows - 1 : rows + 1);
      setTimeout(() => window.gwt.sessions.resize(id, cols, rows), 150);
    };
    if (buf) p.term.write(buf, jiggle);
    else jiggle();
  }

  function has(id) {
    return panes.has(id);
  }

  GWT.panes = {
    createPane, removePane, writeData, updatePane, setFocused, setFocusedEl, relayout, fitAll,
    focusTerminal, has, openSearch, closeSearch, reorderDom, applyGlobalTheme, applyFontSize,
    makeDraggableTile, refreshFromBuffer,
  };
})();
