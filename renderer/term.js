'use strict';
// Popped-out terminal window: a full-size xterm mirror of one session's PTY.

(() => {
  const id = new URLSearchParams(location.search).get('id');
  const XTerminal = typeof Terminal === 'function' ? Terminal : Terminal.Terminal;
  const XFit = typeof FitAddon === 'function' ? FitAddon : FitAddon.FitAddon;

  const STATUS_LABEL = {
    starting: 'starting', working: 'working', attention: 'NEEDS YOU',
    ready: 'your turn', running: 'running', exited: 'exited',
  };

  (async () => {
    const sessions = await window.gwt.sessions.list();
    const info = sessions.find((s) => s.id === id);
    const prefs = await window.gwt.app.uiPrefs();
    const themeName =
      info && info.theme && GWT.themes.valid(info.theme)
        ? info.theme
        : GWT.themes.valid(prefs.termTheme) ? prefs.termTheme : GWT.themes.DEFAULT;
    const theme = GWT.themes.get(themeName);
    document.body.style.background = theme.background;

    const setTitle = (s) => {
      document.title = s
        ? `${s.name} — ${STATUS_LABEL[s.status] || s.status}${s.status === 'attention' ? ' (!)' : ''}`
        : 'Terminal';
    };
    setTitle(info);

    const term = new XTerminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: prefs.fontSize >= 9 && prefs.fontSize <= 22 ? prefs.fontSize : 13,
      lineHeight: 1.15,
      scrollback: 8000,
      theme,
      allowProposedApi: true,
    });
    const fit = new XFit();
    term.loadAddon(fit);
    term.open(document.getElementById('term'));

    // Same clipboard convention as the tiled panes (see panes.js): Ctrl+C
    // copies a selection and otherwise falls through to the interrupt, Ctrl+V
    // pastes, Ctrl+Shift+C/V are unambiguous aliases. Ctrl+Shift+D is handled
    // by the window-level capture listener below, so it is swallowed here.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey) return true;
      if (ev.shiftKey && ev.code === 'KeyD') return false;
      if (ev.code === 'KeyC') {
        const sel = term.getSelection();
        if (sel) {
          window.gwt.app.clipboardWrite(sel);
          term.clearSelection();
          return false;
        }
        return !ev.shiftKey;
      }
      if (ev.code === 'KeyV') {
        window.gwt.app.clipboardRead().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });

    term.onData((d) => window.gwt.sessions.write(id, d));
    term.onResize(({ cols, rows }) => window.gwt.sessions.resize(id, cols, rows));

    const buf = await window.gwt.sessions.buffer(id);
    if (buf) term.write(buf);
    fit.fit();
    term.focus();

    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => fit.fit(), 80);
    });

    // Re-dock = just close this window; main.js notifies the control window,
    // which un-hides the tile. The session itself never stops.
    document.getElementById('dock').addEventListener('click', () => window.close());
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
          e.preventDefault();
          e.stopPropagation();
          window.close();
        }
      },
      true
    );

    window.gwt.on('session:data', (p) => {
      if (p.id === id) term.write(p.data);
    });
    window.gwt.on('session:status', (s) => {
      if (s.id !== id) return;
      setTitle(s);
      if (s.theme && GWT.themes.valid(s.theme)) {
        const t = GWT.themes.get(s.theme);
        term.options.theme = t;
        document.body.style.background = t.background;
      }
    });
    window.gwt.on('session:exit', (p) => {
      if (p.id === id) document.getElementById('gone').style.display = 'block';
    });
    window.gwt.on('session:removed', (p) => {
      if (p.id === id) window.close();
    });
  })();
})();
