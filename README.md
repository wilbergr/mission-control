# Mission Control

A Windows desktop IDE for running **multiple Claude Code sessions at once** — tiled terminals with live per-session status, one-click responses to Claude's prompts, broadcast input, built-in file editing, and full visibility into each session's working directories.

Built with Electron + ConPTY (real Windows pseudo-terminals) + xterm.js + Monaco.

## Requirements

- Windows 10 1803+ or Windows 11 (`curl.exe` and ConPTY ship with the OS)
- [Claude Code](https://claude.com/claude-code) CLI installed and authenticated (`claude` on your PATH)
- `git` on your PATH (for the Changes panel, diffs, and worktrees)
- Optional: WSL with one or more distros (Ubuntu etc.) for Linux terminal sessions
- For development / building: Node.js 20+

## Install

**From the installer:** run `Mission Control Setup <version>.exe` (built into `dist/`). It installs per-user — no admin rights needed — and creates Start-menu and desktop shortcuts.

**From source (development):**

```
npm install
npm start
```

**Build the installer:**

```
npm run dist        # output: dist/Mission Control Setup <version>.exe
```

## Core concepts

### Sessions

Create sessions with **+** (or `Ctrl+Shift+N`). Three types:

- **Claude Code** — launches `claude` in the chosen project directory. Startup options are plain dropdowns: model (Opus/Sonnet/Haiku), permission mode (ask / plan mode / auto-accept edits), an optional starting prompt Claude begins working on immediately, extra `--add-dir` directories, and a free-form CLI args box for anything else.
- **PowerShell** — a plain terminal. Leave the directory blank to open in your home directory.
- **WSL** — a Linux terminal in any installed distro (auto-detected). Blank directory opens in the Linux home (`~`).

For Claude sessions in a git repo, the **worktree option** creates a new git worktree + branch so several sessions can work on the same repo without colliding.

### Session status (the point of this app)

Every Claude session reports its state live via Claude Code hooks — each session launches with a generated `--settings` file whose hooks POST to a local HTTP server inside the app (127.0.0.1 only):

| Status | Meaning |
|---|---|
| Working (blue) | Running tools — the sidebar shows exactly what (`Bash: npm test`, `Edit: src/app.ts`) |
| Needs you (amber, pulsing) | Permission prompt or a question is waiting |
| Your turn (green) | Finished responding |
| Exited (gray) | Process ended |

The window title summarizes it (`(2 ready) Mission Control`, `(1 needs you) Mission Control`); if the app is unfocused you get a Windows notification and taskbar flash, and clicking the notification jumps to that session. Token usage (`ctx` / `out`) appears per session after each turn, parsed from the session transcript.

### Responding to Claude's option menus

When a session needs a choice (permission prompt, multiple-choice question, plan approval), a strip appears at the bottom of that pane with **clickable answer buttons** — parsed from the structured question data when available, or from the terminal screen for permission menus — plus arrow/space/enter/escape keys for anything else. No need to click into the terminal.

The strip only appears when Claude has actually put a choice in front of you. A session can show **Needs you** without one — Claude's "waiting for your input" nudge after a finished turn, or a session that hasn't reported in yet — and those get no buttons, since a button there would just send keystrokes to Claude.

To turn the strip off entirely, untick **Settings → Clickable answer buttons when Claude asks a question**. The session still shows *Needs you*; you answer in the terminal as usual.

### Layout

- Sessions auto-tile into a grid; drag a pane header to reorder
- Zoom one pane full-workspace (`Ctrl+Shift+Z` or the corners icon); click again to re-tile
- Hide a pane from the grid without killing it (eye icon in the sidebar)
- **Pop out** any terminal or editor into its own window (arrow-out icon); **Dock** (or just close the window) brings it back into the grid. A popped-out terminal is a live mirror — you can type in either place
- Search inside a terminal with `Ctrl+Shift+F`
- Select with the mouse and `Ctrl+C` to copy, `Ctrl+V` to paste. `Ctrl+C` only
  copies when something is selected — with no selection it still interrupts,
  as a terminal should. Use `Ctrl+Shift+C` / `Ctrl+Shift+V` when you want
  copy/paste with no chance of sending an interrupt

### Broadcast bar

The input at the bottom sends a message to: the focused session, **all Claude sessions**, all sessions, or only sessions currently waiting on you. The Interrupt button sends Esc/Ctrl+C to the same targets.

### Files, changes, and editing

The right panel (`Ctrl+Shift+E`) follows the focused session:

- **Files** — live tree of the session's directories with git status badges. Click a file to open it in a **Monaco editor tile** right in the grid (syntax highlighting, `Ctrl+S` to save; binary/oversized files open read-only). Editors can pop out to their own window too.
- **Changes** — branch, ahead/behind, dirty files; click for a colorized diff. The delta icon on any pane shows the full working-tree diff for that session.
- **Activity** — a cross-session feed of everything every Claude is doing; click an entry to jump to that session.

### Session history

Previous sessions live at the bottom of the sidebar — click to **resume the exact conversation** (`--resume` under the hood), the refresh icon launches fresh in the same directory, X removes the entry. History survives restarts (last 50) and keeps **one entry per session name**, newest wins — rename a session if you want to keep more than one conversation for the same folder. A session that's currently in the list above never appears here as well. No process keeps running after you close a session — what's revived is the conversation.

If the saved conversation can't be found (transcript deleted, directory moved, worktree removed), the session starts fresh in the same directory instead of hanging, and says so in the sidebar.

**Drag any Previous entry to reorder the list.** The order is yours and is remembered
across restarts — the list is no longer sorted by how recently you used something.
Newly used sessions appear at the top so they're easy to find, without disturbing
anything you've placed. When the 50-entry limit is reached the *least recently used*
entry is dropped, wherever it happens to sit in your ordering, so parking a favourite
at the bottom won't make it the first thing to go.

**Group them by name.** The folder icon on a Previous entry sets its group — type a new
name to create one, or leave it blank to ungroup. Groups show up as collapsible headers
with a count; click a header to collapse it (remembered across restarts), and the rename
button on a header renames the group for every session in it.

Dragging is the quicker way to move things around: **an entry joins the group of
whatever you drop it next to**, and dropping onto a group header puts it at the top of
that group. Drop it next to an ungrouped session, or onto the *Ungrouped* header, to
take it out of its group again.

**Drag a group header to move the whole group**, sessions and all — collapsed groups
included. Drop it on another group's header, or on one of that group's sessions, to
place it above or below that group; drop it on *Ungrouped* to send it to the bottom
of the named groups. Ungrouped itself always stays last.

A group exists only as long as something is in it — there are no empty groups, so
emptying one makes it disappear.

### Appearance

Settings (bottom-left): app appearance (System / Dark / Light), default terminal color scheme, terminal font size, desktop notifications. 16 terminal schemes included (GitHub Dark, PowerShell blue, Ubuntu, Dracula, Nord, Solarized, One Half, Tango, …); the swatch icon on any pane overrides the scheme per-session, remembered across restarts.

### Administrator mode

Windows cannot elevate an individual terminal — a pseudo-console child always inherits the token of
the process that created it — so an elevated *session* means an elevated *app*. **Settings →
Privileges → Restart as administrator** relaunches Mission Control through UAC; every session created
afterwards is elevated. While elevated, the sidebar shows an **ADMIN** badge and the window title ends
with `[Administrator]`.

Restarting closes all running sessions; Claude conversations can be resumed afterwards from Previous.
Note that if you elevate using a *different* administrator account rather than approving the consent
prompt as yourself, the app reads that account's profile — session history, preferences, and token
usage will all appear empty.

If you only need Linux-side root, a WSL session's `sudo` needs no Windows elevation at all.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+N` | New session |
| `Alt+1`–`9` | Focus session N |
| `Ctrl+Shift+←/→` | Cycle focus |
| `Ctrl+Shift+Z` | Zoom / unzoom focused pane |
| `Ctrl+Shift+B` | Focus the broadcast input |
| `Ctrl+Shift+E` | Toggle right panel |
| `Ctrl+Shift+F` | Search in focused terminal |
| `Ctrl+C` | Copy the selection — or interrupt, when nothing is selected |
| `Ctrl+V` | Paste into the terminal |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste, never interrupts |
| `Ctrl+S` | Save (in editors) |
| `Ctrl+Shift+D` | Dock a popped-out terminal |

## Data & files

- Preferences, session history: `%APPDATA%\Mission Control\state.json`
- Generated per-session hook settings: `%APPDATA%\Mission Control\hooks\`
- Conversation transcripts belong to Claude Code itself: `%USERPROFILE%\.claude\projects\`
- Git worktrees created by the app: `<repo parent>\<repo>.worktrees\<branch>`

## Troubleshooting

- **Sidebar says "no hook signal yet"** — the status hooks aren't reaching the app. Usual causes: a custom `--settings` flag in Extra CLI args (it overrides the generated hook settings), or a proxy intercepting loopback traffic (the hook command uses `curl --noproxy "*"` to avoid this).
- **Session stuck at "Starting"** — if the directory is new to Claude, its trust prompt appears in the terminal before hooks start firing; answer it in the pane. After 45 seconds with no signal the session flips to "Needs you" and says so rather than sitting on "Starting" forever.
- **`claude` not found** — ensure the Claude Code CLI is installed and on PATH, then restart the app.
- **WSL option missing** — no distros detected (`wsl --list --quiet`); Docker/Rancher data distros are filtered out.
- **Token counts missing** — usage is parsed from the transcript in `~/.claude/projects` (or `%CLAUDE_CONFIG_DIR%\projects` when that is set).
- **"Restart as administrator" reports an error** — the UAC prompt was declined, or policy (AppLocker/WDAC, or UAC configured to deny elevation) blocked it. The current instance is left running untouched.

## Architecture (for maintainers)

```
main/                     Electron main process
  main.js                 window, IPC wiring, notifications, editor/pop-out windows
  session-manager.js      ConPTY sessions, hook-event -> status mapping, transcript usage
  hook-server.js          local HTTP server receiving Claude Code hook events
  workspace.js            dir listing, git status/diff, worktrees, fs watching
  persistence.js          state.json: last-open sessions + deduped history
preload.js                contextBridge API (renderer <-> main)
renderer/
  index.html/app.js       state, wiring, dialogs, shortcuts
  panes.js                xterm terminal tiles, response strip, menu parsing
  editors.js              Monaco editor tiles
  panels.js               sidebar, files/changes/activity panels, confirm dialog
  themes.js / icons.js    terminal color schemes / SVG icon set
  term.html/.js           popped-out terminal window
  editor.html/.js         popped-out editor window
```

Internal tool for Wilshire Advisors.
