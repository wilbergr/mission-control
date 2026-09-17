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
- Token usage is not from hooks — after `Stop`, `_updateUsage` reads Claude's own transcript at `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd with every non-alphanumeric replaced by '-'>/<claudeSessionId>.jsonl` (`projectsRoot()` / `transcriptPath()`). Failures are swallowed — usage is best-effort.

### Startup failure modes are handled up front, not left to hang

A stale `--resume` id (or `--continue` with no history) makes Claude print `No conversation found …` and then sit there forever with no hooks — a session that looks like it's still "Starting". Three layers guard this, in `session-manager.js`:

1. **Pre-flight** — `create()` checks `_resumeUnavailable()` / `_noTranscripts()` against the transcript store and *drops* the flag rather than passing a doomed one, starting a fresh conversation in the same directory and setting `s.notice`. Both helpers deliberately return `false` (don't touch the flags) when `projectsRoot()` itself is missing: undecidable, so let Claude decide rather than guess wrong.
2. **Output detector** — `_checkStartupTrouble()` scans startup output for short, wrap-resistant fragments of Claude's own error messages (`STARTUP_ERROR_ANCHORS`, taken verbatim from the CLI binary). It runs *only* while `!hooksSeen` and reports once, so a conversation that merely discusses these strings can't trip it.
3. **Watchdog** — `START_GRACE_MS` (45 s) with no hook signal at all flips the session to `attention` with an explanation. Cleared by the first hook, by exit, and by `remove()`.

`s.notice` is the user-facing channel for "we changed what you asked for" — set in main, carried through `describe()`, rendered as an amber line in the sidebar item. It is not persisted.

### IPC contract

`SessionManager.describe(s)` is the wire format for a session — everything the renderer knows comes from it. Adding a session field usually means touching three places: the object literal in `create()`, `describe()`, and `Persistence.snapshotSessions`/`mergeHistory` if it should survive a restart.

Events are pushed via `main.js`'s `send()`, which broadcasts to **every** BrowserWindow (control window + pop-outs). New channels must be added to `EVENT_CHANNELS` in `preload.js` or `gwt.on()` throws.

Because the renderer's `upsertSession` re-adds any id it sees, **a removed session must never emit again**. `remove()` sets `s.removed` before killing the PTY, and `_setStatus`/`onExit`/`_updateUsage` all check it — otherwise the late exit resurrects the sidebar entry, and the second `remove()` finds nothing in the map and emits nothing, leaving an entry that can't be closed. `remove()` also emits `removed` for ids it doesn't know, so a stale renderer entry can always be cleared. `remove()` also clears the startup watchdog, which would otherwise fire against a session that no longer exists.

**Session history is one entry per name.** Claude mints a new conversation uuid on every launch, so keying history on the uuid grew a fresh "Previous" row per run. `dedupeByName` (persistence.js) collapses on lower-cased name, newest `lastUsed` winning; it runs in `load()` (heals old files), at the end of `mergeHistory`, and after `app:historyRename`. `mergeHistory`'s lookup chain also matches by name so an entry is reused *in place*, keeping `hid` stable. Consequence: several concurrent sessions on one folder share one history entry unless renamed.

**History order is the user's, not recency.** Previous is drag-reorderable, so array position in `state.history` *is* the display order. Three rules keep that from being undone:

- `mergeHistory` must **never** sort by `lastUsed`. It runs on every save (any status change, 400 ms debounce), so a sort there wipes a manual reorder within a second of making it. New entries are `unshift`ed to the top; reused entries are updated in place.
- `capHistory` trims to `MAX_HISTORY` by evicting the **least recently used**, not the tail. Evicting by position would make anything deliberately dragged to the bottom the first casualty.
- `reorderHistory(hist, orderedHids)` writes the reordered entries back into the *same array slots* they already occupied. The renderer only sees Previous entries (live sessions are filtered out of that list), so entries hidden behind a running session keep their exact index and reappear where the user left them. A request whose hid count doesn't match is treated as stale and ignored.

The drag handlers live in `panels.js` (`makeReorderable`). The row itself is the drag handle, so the click that relaunches a session is guarded by a `prevDragEndedAt` timestamp — a stray click there spawns a process.

**A Previous group is only a `group` string on an entry — there is no group object.** That keeps array order as the single source of truth: a group's position is derived from where its first member sits, so `renderPreviousSection` buckets by group and renders each bucket at the position of its first entry, with ungrouped last. Consequences, all deliberate:

- No empty groups. A group exists exactly as long as something carries its name, so emptying one removes it.
- Renaming (`renameHistoryGroup`) is a rewrite across every member — the cost of not having group objects.
- `mergeHistory` assigns a **fixed field list** onto a reused entry. `group` is deliberately not in that list, so it survives a relaunch; adding it would silently ungroup a session every time you reopened it.
- Drag has one rule: an entry adopts the group of whatever it is dropped next to (a header drop means that header's group). Creating a *new* group is the only thing a drag can't express, hence the folder button on each row. `app:historyMove` does the group change and the reorder in one call, so a drag is one save and one re-render.
- Collapsed group names are a **UI pref** (`ui.prevCollapsed`), not history — collapse is a view state and shouldn't travel with the data.

The sidebar's Previous section must never re-list a session already shown above it. `renderPreviousSection` filters on `h.runKey` being a current session id — not `claudeSessionId`, which is null until the first hook, and not "live only", since an exited session is still listed above. Both of those holes produced permanent duplicate rows.

Elevation (`app:isElevated` / `app:relaunchElevated`) is deliberately **app-wide, not a session field**: Windows can't attach an elevated child to an existing ConPTY (`ShellExecute`'s `runas` verb takes no `STARTUPINFOEX` attribute list), so every PTY inherits the main process's token. Per-session elevation would need an elevated broker relaying a PTY over IPC — which is a local privilege-escalation surface, and would also make the generated `--settings` hooks file (a list of commands, written to user-writable `%APPDATA%`) an escalation vector for a high-integrity Claude. `relaunchElevated` persists state itself and sets `relaunching`, which suppresses the `before-quit` save so the incoming instance can't read a torn `state.json`.

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
- Terminal clipboard keys live in `attachCustomKeyEventHandler`, which returns whether the event continues on to the PTY. `Ctrl+C` copies **only when there is a selection** — with none it must fall through, or the shell loses SIGINT; `Ctrl+Shift+C` is swallowed either way so it can't fire a surprise interrupt. Copy has to be implemented (via `app:clipboardWrite`) because xterm draws its own selection instead of a DOM one, so the browser's copy action has nothing to take.
- **Never implement paste.** xterm already registers its own DOM `paste` listener, which pastes once and honors bracketed-paste mode (a multi-line paste stays one input in Claude). The `KeyV` branch only returns `false` and does nothing else. That return is still load-bearing in both directions: it stops xterm mapping `Ctrl+V` to a literal `^V` for the PTY, *and* stops xterm calling `preventDefault()`, which is what suppressed the browser's own paste and made paste look broken in the first place. Adding a second path — `term.paste()` or a PTY write — delivers the clipboard **twice**; that shipped in 1.3.1. The clipboard keys are duplicated in `panes.js` and `term.js` because pop-outs don't load `panes.js` (same reason `STATUS_LABEL` is duplicated), so a fix in one needs the same fix in the other.
- All colors come from CSS variables in `style.css`, defined twice: `:root` (dark) and `:root[data-ui="light"]`. `applyUiMode()` sets `documentElement.dataset.ui`, tells Monaco (`vs`/`vs-dark`) and `nativeTheme`. Terminal color schemes are a separate axis — `themes.js`, global default with a per-session override stored on the session in main.
- `index.html` has a strict CSP (`default-src 'self'`), so remote/CDN assets won't load; vendor code is referenced by relative path into `node_modules`. Anything newly referenced that way must also survive electron-builder's `files` filter in `package.json`.
- `window.prompt` doesn't exist in Electron — use `textPrompt()` (app.js) and `GWT.ui.confirmDialog()`.
- Writes are debounced/coalesced on purpose: `saveState` 400 ms, workspace refresh 350 ms, history fetch 1200 ms (must trail main's save), pane fit 60 ms.

## Windows-only by design

`powershell.exe`, `wsl.exe --list --quiet` (UTF-16LE output, docker distros filtered), bundled `curl.exe`, ConPTY, backslash paths, and `git status` output re-joined with `path.sep`. Path comparisons against git output are lowercased (`changesMap`) because the filesystem is case-insensitive. Don't introduce POSIX assumptions; there is no cross-platform target.

**Keep the startup path free of process spawns.** Endpoint protection scores a freshly-written unsigned binary that fans out to discovery tools (`whoami`, `where`, `reg`, `cmdkey`) as credential-theft behavior, and a launch-time spawn fires that heuristic for every user on every run. So `resolveClaudePath()` walks `PATH` with `fs.statSync` + `PATHEXT` instead of calling `where.exe`, and `detectElevation()` reads an Administrators-only directory (`System32\LogFiles\WMI\RtBackup`) instead of parsing `whoami /groups` — trusting the `--elevated` argv marker that `relaunchElevated` passes when it is the one relaunching. Note `fs.access(W_OK)` cannot substitute for that probe: on Windows Node only checks the read-only attribute, not the ACL. The two remaining `execFile` calls in `main.js` are both conditional — `wsl.exe` is cached, guarded on the binary existing, and requested when the New Session dialog first opens rather than at startup; `powershell.exe` runs only on an explicit "Restart as administrator" click. `main.js` also pins both to absolute `System32` paths so `PATH` can't supply a substitute.

Git worktrees created by the app land at `<repo parent>\<repo>.worktrees\<branch>` (`workspace.worktreeAdd`).

## Reference

`README.md` is user-facing and current — features, keyboard shortcuts, data file locations, and a troubleshooting section that maps user symptoms to the mechanisms above. Keep it in sync when changing behavior it describes.
