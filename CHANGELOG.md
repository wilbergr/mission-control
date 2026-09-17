# Changelog

All notable changes to Mission Control.

Mission Control is distributed unsigned, so Windows shows an "Unknown publisher"
elevation prompt when you run the installer, and again if you use **Restart as
administrator**. Confirm the file came from the expected internal location before
accepting.

## 1.4.0 — 2026-09-17

### Added

- **Reorder the Previous list.** Drag any previous session where you want it. The
  order is yours and is remembered across restarts — the list is no longer sorted
  by how recently you used something. Newly used sessions appear at the top so
  they stay easy to find, without disturbing anything you have placed.

  When the 50-entry limit is reached, the *least recently used* entry is dropped
  wherever it sits in your ordering, so parking a favourite at the bottom won't
  make it the first thing to go.

- **Group previous sessions.** The folder icon on a Previous entry sets its group —
  type a new name to create one, or leave it blank to ungroup. Groups appear as
  collapsible headers with a count; click a header to collapse it (remembered
  across restarts), and the rename button on a header renames the group for every
  session in it.

  Dragging is the quicker route: an entry joins the group of whatever you drop it
  next to, and dropping onto a group header puts it at the top of that group. Drop
  it beside an ungrouped session, or onto the *Ungrouped* header, to take it out
  again.

  Groups exist only while something is in them, so emptying one makes it
  disappear, and group order follows your ordering of the sessions inside.

## 1.3.2 — 2026-09-17

### Fixed

- **Pasting into a terminal inserted the text twice.** `Ctrl+V` was delivering
  the clipboard through two paths at once. It now pastes exactly once. Affects
  1.3.1 only; if you are on 1.3.1, install this build.

## 1.3.1 — 2026-09-01

### Added

- **Copy and paste in terminals.** Select with the mouse and press `Ctrl+C` to
  copy; `Ctrl+V` pastes. Previously there was no way to get text into or out of
  a PowerShell or WSL terminal.

  `Ctrl+C` copies only when something is selected — with nothing selected it
  still interrupts whatever is running, as a terminal should, so you do not lose
  the ability to stop a runaway command. If you would rather never risk sending
  an interrupt, `Ctrl+Shift+C` and `Ctrl+Shift+V` always mean copy and paste.

  Pasting several lines into a Claude session stays a single message rather than
  submitting on every line break. Note that pasting several lines into a plain
  PowerShell or WSL shell runs each line, exactly as it would in any other
  terminal — check what you are pasting first.

  Works in tiled panes and in popped-out terminal windows.

## 1.3.0 — 2026-08-24

Also includes the changes prepared for 1.2.0, which was not distributed.

### Added

- **Administrator mode.** Some work needs an elevated terminal. Windows cannot
  elevate an individual terminal — a session always runs with the privileges of
  the app that started it — so **Settings → Privileges → Restart as
  administrator** relaunches Mission Control itself through a Windows elevation
  prompt. Every session created afterwards is elevated.

  While elevated, the sidebar shows a red **ADMIN** badge and the window title
  ends with `[Administrator]`, so an elevated window is never mistaken for an
  ordinary one.

  Restarting closes all running sessions. Claude conversations can be resumed
  afterwards from **Previous**; plain shell sessions cannot.

  If you only need root inside Linux, a WSL session's `sudo` works without
  elevating Mission Control at all.

### Fixed

- **Closing a session could leave an entry that refused to go away.** Clicking
  the **X** on a running session removed its tile, but the sidebar entry came
  back as "Exited" and further clicks did nothing, leaving a row stuck there for
  the rest of the session. The entry is now removed properly, and any row
  already stuck in a running window clears on the next click.

- **Previous filled up with duplicate rows.** Each launch of a conversation
  added another entry, and sessions already listed as running could appear a
  second time under Previous. History now keeps one entry per session name, and
  Previous no longer repeats a session shown above it.

  As a consequence, several concurrent sessions in the same folder share a
  single history entry unless you rename them.

- **Sessions could sit on "Starting" forever.** Resuming a conversation that no
  longer existed, or continuing in a directory with no history, left Claude
  waiting silently with no indication of what went wrong. Mission Control now
  checks first and starts a fresh conversation in the same directory instead,
  explaining what it did on an amber line in the sidebar. As a backstop, a
  session that reports nothing at all within 45 seconds switches to **Needs
  you** with an explanation rather than appearing to start indefinitely.

- **Token usage was missing when Claude's configuration lived outside the
  default location.** Usage is now read correctly when `CLAUDE_CONFIG_DIR` is
  set.

### Changed

- **Sharper app icon.** The icon now carries every standard Windows size, so it
  renders cleanly in the taskbar, Alt-Tab, window corners and at large sizes in
  Explorer.

- **Faster, quieter startup.** Locating the Claude CLI and determining whether
  the app is running as administrator no longer launch external helper programs;
  both are now resolved inside the app. Launch is slightly faster and involves
  fewer interactions with endpoint security software.

- **WSL distributions are detected on first use.** The list is built the first
  time you open the New Session dialog, rather than on every launch, and is then
  reused. Machines without WSL are skipped entirely.

## 1.1.0

Previous release.
