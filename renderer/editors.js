'use strict';
// Editor tiles: Monaco editors living in the terminal grid as first-class
// panes (focus, zoom, close), with save + pop-out-to-window.

window.GWT = window.GWT || {};

(() => {
  const tiles = new Map(); // filePath -> {el, editor, model, dirty, readOnly, els}
  let monacoReady = null;

  function loadMonaco() {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise((resolve, reject) => {
      // no language-service workers needed for quick edits; stub them out
      self.MonacoEnvironment = { getWorkerUrl: () => 'data:text/javascript;charset=utf-8,' };
      const s = document.createElement('script');
      s.src = '../node_modules/monaco-editor/min/vs/loader.js';
      s.onload = () => {
        window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
        window.require(['vs/editor/editor.main'], () => resolve(window.monaco));
      };
      s.onerror = () => reject(new Error('failed to load Monaco'));
      document.head.appendChild(s);
    });
    return monacoReady;
  }

  function baseName(p) {
    return p.split(/[\\/]/).pop();
  }

  async function open(filePath) {
    const existing = tiles.get(filePath);
    if (existing) {
      GWT.panes.setFocusedEl(existing.el);
      existing.editor?.focus();
      return;
    }

    const el = document.createElement('div');
    el.className = 'pane editor-pane';
    el.innerHTML = `
      <div class="pane-head">
        <span class="name"></span>
        <span class="meta"></span>
        <span class="ed-dirty" title="Unsaved changes"></span>
        <button class="b-save" title="Save (Ctrl+S)" data-icon="save"></button>
        <button class="b-pop" title="Open in separate window" data-icon="popout"></button>
        <button class="b-zoom" title="Zoom (Ctrl+Shift+Z)" data-icon="zoom"></button>
        <button class="b-close" title="Close editor" data-icon="close"></button>
      </div>
      <div class="ed-note"></div>
      <div class="ed-body"></div>`;
    const els = {
      name: el.querySelector('.name'),
      meta: el.querySelector('.meta'),
      dirty: el.querySelector('.ed-dirty'),
      note: el.querySelector('.ed-note'),
      save: el.querySelector('.b-save'),
      body: el.querySelector('.ed-body'),
    };
    els.name.textContent = baseName(filePath);
    els.meta.textContent = filePath;
    els.meta.title = filePath;

    GWT.icons.apply(el);
    const t = { el, editor: null, model: null, dirty: false, readOnly: false, els };
    tiles.set(filePath, t);
    document.getElementById('grid').appendChild(el);
    GWT.panes.relayout();
    GWT.panes.setFocusedEl(el);
    GWT.ui.renderTabbar();

    el.addEventListener('mousedown', () => GWT.panes.setFocusedEl(el));
    GWT.panes.makeDraggableTile(el, el.querySelector('.pane-head'));
    el.querySelector('.b-close').addEventListener('click', (e) => {
      e.stopPropagation();
      close(filePath);
    });
    el.querySelector('.b-zoom').addEventListener('click', (e) => {
      e.stopPropagation();
      GWT.panes.setFocusedEl(el);
      GWT.app.toggleZoom();
    });
    el.querySelector('.b-pop').addEventListener('click', (e) => {
      e.stopPropagation();
      if (t.dirty) {
        note(t, 'Save before popping out — the window loads the file from disk.');
        return;
      }
      window.gwt.app.openEditor(filePath);
      close(filePath);
    });
    els.save.addEventListener('click', (e) => {
      e.stopPropagation();
      save(t, filePath);
    });

    // load content + editor (in parallel; monaco is usually preloaded)
    try {
      note(t, 'Loading editor…');
      const [monaco, r] = await Promise.all([
        loadMonaco(),
        window.gwt.ws.readFileForEdit(filePath),
      ]);
      note(t, '');
      if (r.error) {
        note(t, 'Cannot open: ' + r.error);
        return;
      }
      if (r.binary) {
        note(t, 'Binary file — editing disabled.');
        t.readOnly = true;
      } else if (r.truncated) {
        note(t, `Large file (${r.size} bytes): showing first 2 MB read-only.`);
        t.readOnly = true;
      }
      t.model = monaco.editor.createModel(r.content, undefined, monaco.Uri.file(filePath));
      t.editor = monaco.editor.create(els.body, {
        model: t.model,
        theme: GWT.appUiLight && GWT.appUiLight() ? 'vs' : 'vs-dark',
        automaticLayout: true,
        fontFamily: '"Cascadia Mono", Consolas, monospace',
        fontSize: 13,
        minimap: { enabled: false },
        readOnly: t.readOnly,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
      });
      t.model.onDidChangeContent(() => setDirty(t, true));
      t.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save(t, filePath));
      if (t.readOnly) els.save.style.display = 'none';
      t.editor.focus();
    } catch (err) {
      note(t, String(err.message || err));
    }
  }

  function note(t, msg) {
    t.els.note.textContent = msg;
    t.els.note.style.display = msg ? 'block' : 'none';
  }

  function setDirty(t, v) {
    const changed = t.dirty !== v;
    t.dirty = v;
    t.els.dirty.textContent = v ? '●' : '';
    if (changed) GWT.ui.renderTabbar();
  }

  async function save(t, filePath) {
    if (!t.editor || t.readOnly) return;
    const r = await window.gwt.ws.writeFile(filePath, t.editor.getValue());
    if (r.error) {
      note(t, 'Save failed: ' + r.error);
      return;
    }
    setDirty(t, false);
    note(t, '');
    t.els.meta.textContent = `${filePath} — saved ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`;
  }

  async function close(filePath) {
    const t = tiles.get(filePath);
    if (!t) return;
    if (t.dirty) {
      const choice = await GWT.ui.confirmDialog({
        title: baseName(filePath),
        message: 'This file has unsaved changes.',
        buttons: [
          { label: 'Save & close', value: 'save', primary: true },
          { label: 'Discard changes', value: 'discard', danger: true },
          { label: 'Keep editing', value: null },
        ],
      });
      if (!choice) return;
      if (choice === 'save') {
        await save(t, filePath);
        if (t.dirty) return; // save failed; error note is showing
      }
    }
    t.editor?.dispose();
    t.model?.dispose();
    t.el.remove();
    tiles.delete(filePath);
    GWT.panes.relayout();
    GWT.ui.renderTabbar();
  }

  function list() {
    return [...tiles.entries()].map(([path, t]) => ({
      path,
      name: baseName(path),
      el: t.el,
      dirty: t.dirty,
      focus: () => t.editor?.focus(),
    }));
  }

  // Follow the app's light/dark mode (monaco themes are global).
  function applyUiTheme(light) {
    if (window.monaco) monaco.editor.setTheme(light ? 'vs' : 'vs-dark');
    else if (monacoReady) monacoReady.then(() => monaco.editor.setTheme(light ? 'vs' : 'vs-dark'));
  }

  GWT.editors = { open, close, list, preload: loadMonaco, applyUiTheme };
})();
