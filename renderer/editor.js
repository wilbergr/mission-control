'use strict';
// Standalone file editor window (Monaco). Opened via editor.html?f=<path>.

(() => {
  const filePath = new URLSearchParams(location.search).get('f');
  const $ = (s) => document.querySelector(s);

  const fname = $('#fname');
  const dirtyEl = $('#dirty');
  const statusEl = $('#status');
  const noteEl = $('#note');
  const confirmEl = $('#confirm');

  fname.textContent = filePath || '(no file)';
  fname.title = filePath || '';
  document.title = filePath ? filePath.split(/[\\/]/).pop() : 'Editor';

  let editor = null;
  let dirty = false;
  let readOnly = false;
  let closing = false;

  function setDirty(v) {
    dirty = v;
    dirtyEl.textContent = v ? '●' : '';
    document.title = (v ? '● ' : '') + (filePath ? filePath.split(/[\\/]/).pop() : 'Editor');
  }

  function note(msg) {
    noteEl.textContent = msg;
    noteEl.style.display = msg ? 'block' : 'none';
  }

  async function save() {
    if (!editor || readOnly || !filePath) return;
    const r = await window.gwt.ws.writeFile(filePath, editor.getValue());
    if (r.error) {
      statusEl.textContent = 'Save failed: ' + r.error;
      statusEl.style.color = 'var(--danger)';
      return false;
    }
    setDirty(false);
    statusEl.textContent = 'Saved ' + new Date().toLocaleTimeString('en-GB', { hour12: false });
    statusEl.style.color = 'var(--ok)';
    return true;
  }

  $('#btn-save').addEventListener('click', save);
  $('#btn-dock').addEventListener('click', async () => {
    if (dirty && !(await save())) return; // dock loads from disk — save first
    await window.gwt.app.dockEditor(filePath);
    closing = true;
    window.close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyS') {
      e.preventDefault();
      save();
    }
  });

  // close protection
  window.addEventListener('beforeunload', (e) => {
    if (dirty && !closing) {
      e.preventDefault();
      e.returnValue = false;
      confirmEl.style.display = 'flex';
    }
  });
  $('#c-save').addEventListener('click', async () => {
    if (await save()) {
      closing = true;
      window.close();
    }
  });
  $('#c-discard').addEventListener('click', () => {
    closing = true;
    window.close();
  });
  $('#c-back').addEventListener('click', () => {
    confirmEl.style.display = 'none';
  });

  // Monaco boot: AMD loader; workers are stubbed out (fine for highlighting +
  // editing; we don't need language services in a quick-edit window).
  self.MonacoEnvironment = {
    getWorkerUrl: () => 'data:text/javascript;charset=utf-8,',
  };
  require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });

  require(['vs/editor/editor.main'], async () => {
    if (!filePath) {
      note('No file specified.');
      return;
    }
    const prefs = await window.gwt.app.uiPrefs();
    const light =
      prefs.uiMode === 'light' ||
      (prefs.uiMode !== 'dark' && window.matchMedia('(prefers-color-scheme: light)').matches);
    if (light) document.documentElement.dataset.ui = 'light';
    const r = await window.gwt.ws.readFileForEdit(filePath);
    if (r.error) {
      note('Cannot open: ' + r.error);
      return;
    }
    if (r.binary) {
      note('This looks like a binary file — editing is disabled.');
      readOnly = true;
    }
    if (r.truncated) {
      note(`File is large (${r.size} bytes); showing the first 2 MB read-only to avoid corrupting it on save.`);
      readOnly = true;
    }

    const model = monaco.editor.createModel(r.content, undefined, monaco.Uri.file(filePath));
    editor = monaco.editor.create($('#editor'), {
      model,
      theme: light ? 'vs' : 'vs-dark',
      automaticLayout: true,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      minimap: { enabled: true },
      readOnly,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
    });
    model.onDidChangeContent(() => {
      if (!dirty) setDirty(true);
      statusEl.textContent = '';
    });
    if (readOnly) $('#btn-save').style.display = 'none';
    editor.focus();
  });
})();
