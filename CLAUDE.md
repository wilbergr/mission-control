# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm install          # required before first run — the renderer loads xterm/monaco straight out of node_modules
npm start            # electron .
npm run dist         # electron-builder --win nsis -> dist/Mission Control Setup <version>.exe
```

There is no build step, no bundler, no test suite, and no linter configured. Verification is manual: `npm start`, create a session, and drive the UI. Reloading the renderer window (Ctrl+R) is safe — `app.js`'s `init()` re-attaches to sessions already alive in the main process via `sessions:list` + buffer replay, so you don't need to restart Electron to test renderer changes. Main-process changes do require a restart.

`node_modules/` and `dist/` are gitignored.

## Big picture

Electron app. **The main process owns all state**; the renderer is a projection of it.

- `main/session-manager.js` — the core. One real ConPTY per session (`@homebridge/node-pty-prebuilt-multiarch`, `useConpty: true`), plus the status model. It keeps a per-session ring buffer (`MAX_BUFFER_CHARS`) of everything the PTY printed.
- `main/hook-server.js` — loopback-only HTTP server (`127.0.0.1`, ephemeral port) that receives Claude Code hook events.
- `main/workspace.js` — all `git`/`fs` access (status, diff, worktrees, recursive `fs.watch` with a 600 ms debounce).
- `main/persistence.js` — `state.json` under `app.getPath('userData')`: last-open sessions, deduped history (cap 50), UI prefs.
- `preload.js` — the only renderer↔main surface: `window.gwt.{sessions,ws,app,on}`.
- `renderer/` — no framework, no modules. Plain classic scripts sharing a `window.GWT` namespace, loaded in dependency order by `index.html`: `themes → icons → panes → editors → panels → app`.

### How session status works (the app's whole reason to exist)

Claude sessions are spawned as `claude --settings <generated>.json …`. `SessionManager._writeHookSettings` writes a settings file registering every event in `HOOK_EVENTS` to a `curl -s --noproxy "*" … POST http://127.0.0.1:<port>/hook/<sessionId>` command. Claude pipes the hook payload on stdin; `HookServer` responds `200 {}` immediately (so hooks never stall Claude) and hands the payload to `SessionManager.handleHookEvent`, which maps it onto a status: `starting → working / attention / ready → exited` (plain shells are just `running`).

Consequences to keep in mind when changing anything here:

- Adding a hook event means adding it to `HOOK_EVENTS` **and** to the `switch` in `handleHookEvent`.
- A user-supplied `--settings` in Extra CLI args replaces the generated one and silently kills all status reporting. The sidebar's "no hook signal yet" (`hooksSeen === false`) is the tell. A terminal-BEL heuristic in `proc.onData` is the only fallback, and it is deliberately trusted *only* while `hooksSeen` is false.
- `PreToolUse` for `AskUserQuestion` is special-cased: the structured `tool_input` is normalized into `pendingQuestion` so the renderer can draw real answer buttons.
- Token usage is not from hooks — after `Stop`, `_updateUsage` reads Claude's own transcript at `~/.claude/projects/<cwd with every non-alphanumeric replaced by '-'>/<claudeSessionId>.jsonl`. A nonstandard `CLAUDE_CONFIG_DIR` makes usage silently unavailable (by design; failures are swallowed).

### IPC contract

`SessionManager.describe(s)` is the wire format for a session — everything the renderer knows comes from it. Adding a session field usually means touching three places: the object literal in `create()`, `describe()`, and `Persistence.snapshotSessions`/`mergeHistory` if it should survive a restart.

Events are pushed via `main.js`'s `send()`, which broadcasts to **every** BrowserWindow (control window + pop-outs). New channels must be added to `EVENT_CHANNELS` in `preload.js` or `gwt.on()` throws.

Because the renderer's `upsertSession` re-adds any id it sees, **a removed session must never emit again**. `remove()` sets `s.removed` before killing the PTY, and `_setStatus`/`onExit`/`_updateUsage` all check it — otherwise the late exit resurrects the sidebar entry, and the second `remove()` finds nothing in the map and emits nothing, leaving an entry that can't be closed. `remove()` also emits `removed` for ids it doesn't know, so a stale renderer entry can always be cleared.

Launch options set through the friendly dropdowns (model, permission mode) are deliberately folded into the `extraArgs` string in `app.js`'s submit handler rather than kept as separate fields — that way they persist through history/restore like any other CLI arg. `initialPrompt` is the exception: it's passed positionally and never persisted, so restore/resume doesn't replay it.

### The grid: tiles are polymorphic

`#grid` holds `.pane` elements of two kinds — terminal panes (`panes.js`) and Monaco editor panes (`editors.js`). `GWT.panes.relayout()` counts *all* `.pane:not(.gone)` and computes a near-square `grid-template`; `setFocusedEl` and `makeDraggableTile` work on either kind. If you add a third tile type, reuse those helpers rather than adding parallel bookkeeping.

Two orthogonal notions of "not in the grid":

- **Hidden** (`.gone` + `state.hidden`) — tile removed from layout, session untouched.
- **Popped out** — `sessions:popout` opens `term.html` as a *second live view* onto the same PTY (both views write to it and receive `session:data`). Popping out also hides the tile; closing the window fires `session:popin`, which unhides it.

Because a hidden tile keeps receiving output sized for the pop-out window, re-docking calls `refreshFromBuffer(id)`: replay the main-process buffer, then deliberately jiggle the PTY size (rows−1, then back) to force the running TUI to repaint at the tile's real dimensions. This is why the pop-in "flickers" — it's intentional.

### Response strip (clickable answers)

`panes.js` renders answer buttons only while status is `attention`, preferring a menu scraped from the *visible xterm screen* (`parseMenuFromScreen` strips box-drawing chars and finds the last cluster of `1.`/`2.`… lines) and falling back to `info.pendingQuestion`. Menus often finish painting after the status event arrives, so parsing is retried on a timer (250 ms / 1200 ms) and again from `writeData`. Clicking a button just writes the digit to the PTY.

### Renderer conventions

- Markup carries `data-icon="name"`; `GWT.icons.apply(root)` injects the SVG from `icons.js` after any dynamic `innerHTML`. No emoji in the UI.
- All colors come from CSS variables in `style.css`, defined twice: `:root` (dark) and `:root[data-ui="light"]`. `applyUiMode()` sets `documentElement.dataset.ui`, tells Monaco (`vs`/`vs-dark`) and `nativeTheme`. Terminal color schemes are a separate axis — `themes.js`, global default with a per-session override stored on the session in main.
- `index.html` has a strict CSP (`default-src 'self'`), so remote/CDN assets won't load; vendor code is referenced by relative path into `node_modules`. Anything newly referenced that way must also survive electron-builder's `files` filter in `package.json`.
- `window.prompt` doesn't exist in Electron — use `textPrompt()` (app.js) and `GWT.ui.confirmDialog()`.
- Writes are debounced/coalesced on purpose: `saveState` 400 ms, workspace refresh 350 ms, history fetch 1200 ms (must trail main's save), pane fit 60 ms.

## Windows-only by design

`powershell.exe`, `wsl.exe --list --quiet` (UTF-16LE output, docker distros filtered), `where.exe claude`, bundled `curl.exe`, ConPTY, backslash paths, and `git status` output re-joined with `path.sep`. Path comparisons against git output are lowercased (`changesMap`) because the filesystem is case-insensitive. Don't introduce POSIX assumptions; there is no cross-platform target.

Git worktrees created by the app land at `<repo parent>\<repo>.worktrees\<branch>` (`workspace.worktreeAdd`).

## Reference

`README.md` is user-facing and current — features, keyboard shortcuts, data file locations, and a troubleshooting section that maps user symptoms to the mechanisms above. Keep it in sync when changing behavior it describes.
