'use strict';
// PTY session lifecycle + Claude Code status tracking.
//
// Each session is a real ConPTY. Claude sessions are launched with a generated
// --settings file registering hooks that report lifecycle events back to the
// local HookServer; those events drive the status shown in the UI:
//   starting  -> spawned, no signal yet
//   working   -> Claude is doing things (prompt submitted / tools running)
//   attention -> Claude needs the user (permission prompt, waiting on input)
//   ready     -> Claude finished responding; it's the user's turn
//   running   -> plain shell session, process alive
//   exited    -> process ended

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const MAX_BUFFER_CHARS = 400_000; // scrollback replay buffer per session
const START_GRACE_MS = 45_000; // no hook signal by now -> tell the user instead of sitting on "Starting"

// Short, wrap-resistant fragments of what Claude Code prints when it cannot open
// a conversation (stale --resume id, --continue with nothing to continue). Only
// matched during startup, before any hook has reported.
const STARTUP_ERROR_ANCHORS = [
  'no conversation found',
  'not found in project directory',
  'not found in any project directory',
  'may have been archived or expired',
  'session not found',
];

// Notification types (the hook payload's `notification_type`, sent by Claude
// Code 2.1.x) that mean a choice is on screen right now. Everything else is an
// FYI — most importantly `idle_prompt` ("Claude is waiting for your input"),
// which fires after a *finished* turn has sat for a minute and must not grow
// answer buttons. `agent_needs_input` is left out on purpose: when unsure, show
// nothing, since a wrong button sends keystrokes to Claude.
const PROMPT_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'worker_permission_prompt']);

function notificationAwaitsInput(payload) {
  const type = payload && payload.notification_type;
  if (type) return PROMPT_NOTIFICATIONS.has(type);
  // CLIs from before notification_type existed: only a permission message
  // reliably means a menu is up.
  return /permission/i.test(String((payload && payload.message) || ''));
}

// Auto-approve answers approvals only. These two raise a permission request too,
// but they are really questions for the person — a multiple-choice answer, and
// the plan someone chose plan mode in order to review — so they always reach them.
const NEVER_AUTO_APPROVE = new Set(['AskUserQuestion', 'ExitPlanMode']);

// The hook reply that answers a permission prompt on the user's behalf
// (Claude Code 2.1.x PermissionRequest output). It approves this one call only.
const ALLOW_DECISION = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
};

// Auto-approve can be limited to a time window. Upper bound so a bad value can't
// quietly mean "for the next three weeks".
const MAX_AUTO_APPROVE_MINUTES = 24 * 60;

/** ms for a valid window, 0 for "until turned off", -1 if the value is invalid. */
function autoApproveWindowMs(minutes) {
  if (minutes == null || minutes === 0) return 0;
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0 || m > MAX_AUTO_APPROVE_MINUTES) return -1;
  return Math.round(m * 60_000);
}

function fmtWindow(ms) {
  const m = ms / 60_000;
  if (m >= 1) return `${+m.toFixed(1)} minute${m === 1 ? '' : 's'}`;
  return `${Math.max(1, Math.round(ms / 1000))} seconds`;
}

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest', // only fires when Claude is about to show an approval prompt
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
];

function trunc(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function describeTool(name, input) {
  input = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `${name}: ${trunc(input.command, 90)}`;
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${name}: ${trunc(input.file_path, 90)}`;
    case 'Read':
      return `Read: ${trunc(input.file_path, 90)}`;
    case 'Glob':
      return `Glob: ${trunc(input.pattern, 60)}`;
    case 'Grep':
      return `Grep: ${trunc(input.pattern, 60)}`;
    case 'WebFetch':
      return `WebFetch: ${trunc(input.url, 90)}`;
    case 'WebSearch':
      return `WebSearch: ${trunc(input.query, 60)}`;
    case 'Task':
      return `Subagent: ${trunc(input.description, 60)}`;
    default:
      return name ? `Tool: ${name}` : 'Working';
  }
}

// Activity entries carry a one-line `detail` (truncated for the feed row) and,
// where it adds something, the untruncated `full` text for the entry's detail
// dialog. Capped so a huge Write payload can't bloat the in-memory feed; the
// feed itself is never persisted.
const MAX_ACTIVITY_FULL = 8000;

function capFull(s) {
  if (typeof s !== 'string' || !s) return undefined;
  return s.length > MAX_ACTIVITY_FULL ? s.slice(0, MAX_ACTIVITY_FULL) + '\n… (truncated)' : s;
}

// The whole tool call, for the detail dialog. Shell commands read better raw
// than JSON-escaped; everything else shows its full input.
function describeToolFull(name, input) {
  input = input || {};
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
    return capFull(`${name}\n\n${input.command}${input.description ? `\n\n— ${input.description}` : ''}`);
  }
  let body;
  try { body = JSON.stringify(input, null, 2); } catch { body = String(input); }
  return capFull(`${name || 'Tool'}\n\n${body}`);
}

// Split a user-provided extra-args string, honoring double quotes.
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// Claude Code encodes a project cwd into its transcript folder name by
// replacing every non-alphanumeric character with '-'.
function transcriptDirFor(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

// Where Claude Code keeps conversation transcripts, honoring CLAUDE_CONFIG_DIR.
function projectsRoot() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

function transcriptPath(cwd, claudeSessionId) {
  return path.join(projectsRoot(), transcriptDirFor(cwd), `${claudeSessionId}.jsonl`);
}

// ---- Claude inside WSL ('wslclaude') ------------------------------------------

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const WSL_EXE = path.join(SYS32, 'wsl.exe');
const WIN_CURL = path.join(SYS32, 'curl.exe');

/** Both kinds run Claude and report through hooks; only the launch differs. */
function isClaudeKind(kind) {
  return kind === 'claude' || kind === 'wslclaude';
}

// Windows path -> the same place seen from inside WSL. \\wsl.localhost\<distro>\…
// (and \\wsl$\…) are the distro's own files; drive paths assume WSL's default
// automount root, /mnt/. Returns null for anything else (e.g. a network share).
function toWslPath(p) {
  const s = String(p || '');
  const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/i.exec(s);
  if (unc) return { distro: unc[1], path: unc[2].replace(/\\/g, '/') || '/' };
  const drive = /^([A-Za-z]):(.*)$/.exec(s);
  if (drive) return { distro: null, path: `/mnt/${drive[1].toLowerCase()}${drive[2].replace(/\\/g, '/') || '/'}` };
  return null;
}

// Path inside WSL -> a path Windows can open (used for Claude's transcript).
function fromWslPath(p, distro) {
  const s = String(p || '');
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(s);
  if (m) return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${distro}${s.replace(/\//g, '\\')}`;
}

// Claude runs through the distro's login + interactive bash, so ~/.profile and
// ~/.bashrc both apply: nvm-style installs put claude on PATH only from
// .bashrc, past its "not interactive, return" guard. `exec` replaces bash, so
// the PTY's process is Claude itself. Claude's arguments travel as "$@", never
// through the script text, so nothing in them is ever parsed by the shell.
const WSL_CLAUDE_LAUNCH = 'exec claude "$@"';
function wslClaudeArgs(distro, cdPath, claudeArgs) {
  return ['-d', distro, '--cd', cdPath, '--exec', 'bash', '-lic', WSL_CLAUDE_LAUNCH, 'claude', ...claudeArgs];
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
}

// Normalize AskUserQuestion tool_input into a UI-friendly shape.
function normalizeQuestions(input) {
  const qs = (input && input.questions) || [];
  if (!qs.length) return null;
  return qs.map((q) => ({
    question: q.question || '',
    header: q.header || '',
    multiSelect: !!q.multiSelect,
    options: (q.options || []).map((o) => (typeof o === 'string' ? o : o.label || '')).filter(Boolean),
  }));
}

class SessionManager extends EventEmitter {
  /**
   * @param {{hooksDir: string, claudePath: string|null}} opts
   */
  constructor(opts) {
    super();
    this.hooksDir = opts.hooksDir;
    this.claudePath = opts.claudePath;
    this.hookPort = 0; // set after HookServer starts
    this.sessions = new Map();
    this.counter = 0;
    fs.mkdirSync(this.hooksDir, { recursive: true });
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * @param {{name?:string, kind:'claude'|'shell'|'wsl', cwd:string, addDirs?:string[],
   *          extraArgs?:string, continue?:boolean, resume?:string, distro?:string}} opts
   */
  create(opts) {
    const id = `s${++this.counter}-${Date.now().toString(36)}`;
    const kind = ['shell', 'wsl', 'wslclaude'].includes(opts.kind) ? opts.kind : 'claude';
    let cwd = opts.cwd;
    if (!cwd) {
      // shells may omit the directory and open at home; Claude needs a project
      if (isClaudeKind(kind)) throw new Error('Directory is required for Claude sessions');
      cwd = os.homedir();
    }
    if (!fs.existsSync(cwd)) throw new Error(`Directory does not exist: ${cwd}`);
    const addDirs = (opts.addDirs || []).filter(Boolean);
    let distro = opts.distro || null;

    let file, args;
    let notice = null; // surfaced in the UI when we had to change what was asked for
    if (kind === 'claude') {
      ({ args, notice } = this._claudeArgs(opts, cwd, this._writeHookSettings(id), addDirs, true));
      file = this.claudePath || 'claude';
    } else if (kind === 'wslclaude') {
      const inWsl = toWslPath(cwd);
      if (!inWsl) throw new Error(`WSL can't open ${cwd}. Use a drive path or a \\\\wsl.localhost\\ path.`);
      // a \\wsl.localhost\<distro>\ path names its own distro
      distro = inWsl.distro || distro;
      if (!distro) throw new Error('Choose a WSL distribution for this session.');
      const settings = toWslPath(this._writeHookSettings(id, { wsl: true })).path;
      const dirs = addDirs.map((d) => (toWslPath(d) || { path: d }).path);
      // No pre-flight: Claude keeps this distro's transcripts inside Linux, so
      // whether a --resume/--continue can succeed is undecidable from here —
      // the documented fallback is to let Claude make the call.
      ({ args } = this._claudeArgs(opts, cwd, settings, dirs, false));
      // Drive paths go to --cd as-is (wsl translates them); a distro path goes
      // as the Linux path it is.
      args = wslClaudeArgs(distro, inWsl.distro ? inWsl.path : cwd, args);
      file = WSL_EXE;
    } else if (kind === 'wsl') {
      file = 'wsl.exe';
      // blank directory -> Linux home (~), not the mapped Windows home
      args = ['--cd', opts.cwd ? cwd : '~'];
      if (opts.distro) args.unshift('-d', opts.distro);
    } else {
      file = 'powershell.exe';
      args = ['-NoLogo'];
    }

    const env = { ...process.env, GWT_SESSION_ID: id };
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
      useConpty: true,
    });

    const defaultName = opts.cwd
      ? path.basename(cwd) || cwd
      : kind === 'wsl' ? (opts.distro || 'WSL') : 'PowerShell';
    const s = {
      id,
      name: opts.name || defaultName,
      kind,
      cwd,
      homeDefault: !opts.cwd && !isClaudeKind(kind), // launched with blank dir
      addDirs,
      extraArgs: opts.extraArgs || '',
      distro,
      theme: opts.theme || null, // per-session color scheme override
      // Answer Claude's permission prompts with "allow". Deliberately never
      // persisted (not in snapshotSessions/mergeHistory): relaunching an old
      // session must not silently come back approving everything.
      autoApprove: isClaudeKind(kind) && opts.autoApprove === true && autoApproveWindowMs(opts.autoApproveMinutes) >= 0,
      autoApproveUntil: null, // ms timestamp when a timed window ends; null = until turned off
      autoApproveTimer: null,
      pid: proc.pid,
      proc,
      buffer: '',
      status: isClaudeKind(kind) ? 'starting' : 'running',
      statusSince: Date.now(),
      activity:
        kind === 'claude' ? 'Starting Claude…'
          : kind === 'wslclaude' ? `Starting Claude in ${distro}…`
          : kind === 'wsl' ? `WSL ${opts.distro || 'default'}` : 'Shell session',
      // wslclaude: Claude's own transcript path from the hook payloads, a Linux
      // path; token usage is read from it through \\wsl.localhost.
      transcriptPath: null,
      hooksSeen: false,
      claudeSessionId: null, // Claude's own session UUID (from hook payloads)
      pendingQuestion: null, // AskUserQuestion payload while Claude waits on a choice
      // True only while a choice is actually on screen. 'attention' alone is not
      // enough — it also covers the idle nudge, the startup watchdog and a failed
      // resume — and the renderer shows answer buttons only when this is set.
      awaitingInput: false,
      usage: null, // {out, ctx, model} parsed from the transcript after each turn
      notice, // launch caveat worth showing the user (e.g. resume fell back to fresh)
      startedAt: Date.now(), // bounds how long startup output is scanned
      startupReported: false, // startup-trouble message already raised
      startTimer: null,
      exitCode: null,
    };
    this.sessions.set(id, s);
    if (notice) s.activity = notice;
    if (s.autoApprove) this._startAutoApproveWindow(s, autoApproveWindowMs(opts.autoApproveMinutes));
    if (isClaudeKind(kind)) {
      // Nothing from Claude at all after a generous grace period means the
      // session is stuck (unanswered prompt in the terminal, a launch error we
      // don't recognize, hooks blocked). Say so instead of showing "Starting".
      s.startTimer = setTimeout(() => {
        s.startTimer = null;
        if (s.hooksSeen || s.status !== 'starting') return;
        s.notice = s.notice || (kind === 'wslclaude'
          // in WSL the hooks reach us through Windows' curl.exe (WSL interop)
          ? `No signal from Claude yet — check the terminal for a prompt or error. If Claude is running normally, WSL interop may be switched off in ${distro} (/etc/wsl.conf); status and auto-approve need it.`
          : 'No signal from Claude yet — check this session\'s terminal for a prompt or error.');
        s.awaitingInput = false; // an explanation, not a question
        this._setStatus(s, 'attention', 'No signal from Claude yet — check the terminal');
        this._pushActivity(s, 'attention', 'No hook signal after 45s — session may be waiting in the terminal');
      }, START_GRACE_MS);
    }

    proc.onData((data) => {
      s.buffer += data;
      if (s.buffer.length > MAX_BUFFER_CHARS) {
        s.buffer = s.buffer.slice(s.buffer.length - MAX_BUFFER_CHARS);
      }
      if (isClaudeKind(s.kind) && !s.hooksSeen && s.status !== 'exited') {
        // Bell heuristic: only trusted when hooks aren't reporting (e.g. hooks
        // misconfigured) — Claude rings BEL when it needs attention.
        // Before any hook, a bell almost always means an interactive menu —
        // typically the folder-trust prompt — so offer the navigation keys.
        if (data.includes('\x07')) {
          s.awaitingInput = true;
          this._setStatus(s, 'attention', 'Terminal bell — may need input');
        }
        this._checkStartupTrouble(s);
      }
      this.emit('data', { id, data });
    });

    proc.onExit(({ exitCode }) => {
      s.exitCode = exitCode;
      this._clearStartTimer(s);
      this._clearAutoApproveTimer(s);
      // bash's "command not found" is 127: Claude isn't installed in the distro,
      // or not on its PATH. Say that rather than just "Exited (code 127)".
      if (s.kind === 'wslclaude' && exitCode === 127 && !s.hooksSeen) {
        s.notice = `Claude Code isn't installed in ${s.distro}, or isn't on its PATH. Install it inside WSL, then launch again.`;
      }
      this._setStatus(s, 'exited', `Exited (code ${exitCode})`);
      if (s.removed) return; // remove() already told the renderer this one is gone
      this._pushActivity(s, 'exit', `Process exited with code ${exitCode}`);
      this.emit('exit', { id, exitCode });
    });

    this.emit('created', this.describe(s));
    this._pushActivity(s, 'spawn',
      kind === 'claude' ? 'Claude session launched'
        : kind === 'wslclaude' ? `Claude session launched in ${distro}` : 'Terminal launched');
    if (notice) this._pushActivity(s, 'notice', notice);
    if (s.autoApprove) this._pushActivity(s, 'autoapprove', this._autoApproveOnText(s));
    return this.describe(s);
  }

  // Claude's command-line arguments, shared by both Claude kinds. `preflight`
  // checks --resume/--continue against the transcript store first: a stale id,
  // or --continue with no history, makes Claude print "No conversation found …"
  // and sit there with no hooks — a dead session — so we fall back to a fresh
  // conversation in the same directory instead.
  _claudeArgs(opts, cwd, settingsPath, addDirs, preflight) {
    const args = ['--settings', settingsPath];
    let notice = null;
    for (const d of addDirs) args.push('--add-dir', d);
    let resume = opts.resume || null;
    let cont = !!opts.continue;
    if (preflight && resume && this._resumeUnavailable(cwd, resume)) {
      notice = 'Saved conversation not found for this directory — started a fresh session instead.';
      resume = null;
    }
    if (preflight && cont && this._noTranscripts(cwd)) {
      notice = 'No previous conversation in this directory — started a fresh session instead.';
      cont = false;
    }
    if (cont) args.push('--continue');
    if (resume) args.push('--resume', resume);
    args.push(...splitArgs(opts.extraArgs));
    // one-shot starting prompt (positional arg); deliberately not persisted,
    // so restore/resume won't replay it
    if (opts.initialPrompt) args.push(opts.initialPrompt);
    return { args, notice };
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.status !== 'exited') {
      try { s.proc.kill(); } catch { /* already dead */ }
    }
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (s) {
      // Killing the PTY makes onExit fire *after* this returns; the flag stops
      // that late exit from emitting a status the renderer would treat as a
      // live session and re-add to the sidebar.
      s.removed = true;
      // The startup watchdog and an auto-approve window would otherwise still
      // fire against a session that is already gone.
      this._clearStartTimer(s);
      this._clearAutoApproveTimer(s);
      this.kill(id);
      this.sessions.delete(id);
      const settings = path.join(this.hooksDir, `${id}.json`);
      fs.promises.unlink(settings).catch(() => {});
    }
    // Emitted even for an id we no longer know about, so a renderer holding a
    // stale entry can always clear it.
    this.emit('removed', { id });
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s && s.status !== 'exited') s.proc.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || s.status === 'exited') return;
    try { s.proc.resize(Math.max(2, cols), Math.max(1, rows)); } catch { /* race with exit */ }
  }

  rename(id, name) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.name = String(name || '').trim() || s.name;
    this.emit('status', this.describe(s));
  }

  // `minutes` limits how long it stays on (omit or 0 for "until turned off").
  // Turning it on again restarts the window; an invalid window changes nothing.
  setAutoApprove(id, on, minutes) {
    const s = this.sessions.get(id);
    if (!s || !isClaudeKind(s.kind)) return;
    const windowMs = autoApproveWindowMs(minutes);
    if (on === true && windowMs < 0) return;
    this._clearAutoApproveTimer(s);
    s.autoApprove = on === true;
    s.autoApproveUntil = null;
    if (s.autoApprove) this._startAutoApproveWindow(s, windowMs);
    this._pushActivity(s, 'autoapprove', s.autoApprove ? this._autoApproveOnText(s) : 'Auto-approve turned off');
    this.emit('status', this.describe(s));
  }

  _startAutoApproveWindow(s, windowMs) {
    if (!(windowMs > 0)) return;
    s.autoApproveUntil = Date.now() + windowMs;
    s.autoApproveTimer = setTimeout(() => this._expireAutoApprove(s), windowMs);
  }

  _autoApproveOnText(s) {
    return s.autoApproveUntil
      ? `Auto-approve turned on for ${fmtWindow(s.autoApproveUntil - Date.now())}`
      : 'Auto-approve turned on (until turned off)';
  }

  // The window ran out. Called by the timer, and also from PermissionRequest
  // when the deadline has passed — timers don't run while Windows sleeps, so the
  // timer alone could leave auto-approve on past its end after a sleep.
  _expireAutoApprove(s) {
    this._clearAutoApproveTimer(s);
    if (!s.autoApprove) return;
    s.autoApprove = false;
    s.autoApproveUntil = null;
    if (s.removed) return;
    this._pushActivity(s, 'autoapprove', 'Auto-approve ended — its time limit ran out');
    this.emit('status', this.describe(s));
  }

  _clearAutoApproveTimer(s) {
    if (s.autoApproveTimer) {
      clearTimeout(s.autoApproveTimer);
      s.autoApproveTimer = null;
    }
  }

  setTheme(id, theme) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.theme = theme || null;
    this.emit('status', this.describe(s));
  }

  /** Send text to several sessions at once (broadcast). */
  sendText(ids, text, submit = true) {
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (!s || s.status === 'exited') continue;
      let payload = text;
      if (/\r|\n/.test(text)) {
        if (isClaudeKind(s.kind)) {
          // bracketed paste keeps multi-line input as one message
          payload = `\x1b[200~${text}\x1b[201~`;
        } else {
          payload = text.replace(/\r?\n/g, ' ');
        }
      }
      s.proc.write(payload + (submit ? '\r' : ''));
    }
  }

  /** Esc interrupts Claude; Ctrl+C interrupts a shell. */
  interrupt(id) {
    const s = this.sessions.get(id);
    if (!s || s.status === 'exited') return;
    s.proc.write(isClaudeKind(s.kind) ? '\x1b' : '\x03');
  }

  list() {
    return [...this.sessions.values()].map((s) => this.describe(s));
  }

  bufferOf(id) {
    const s = this.sessions.get(id);
    return s ? s.buffer : '';
  }

  describe(s) {
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      cwd: s.cwd,
      homeDefault: s.homeDefault,
      addDirs: s.addDirs,
      extraArgs: s.extraArgs,
      pid: s.pid,
      status: s.status,
      statusSince: s.statusSince,
      activity: s.activity,
      hooksSeen: s.hooksSeen,
      claudeSessionId: s.claudeSessionId,
      pendingQuestion: s.pendingQuestion,
      awaitingInput: s.awaitingInput,
      usage: s.usage,
      notice: s.notice,
      distro: s.distro,
      theme: s.theme,
      autoApprove: s.autoApprove,
      autoApproveUntil: s.autoApproveUntil,
      exitCode: s.exitCode,
    };
  }

  killAll() {
    for (const s of this.sessions.values()) {
      this._clearStartTimer(s);
      try { s.proc.kill(); } catch { /* ignore */ }
    }
  }

  // ---- startup trouble detection -------------------------------------------

  _clearStartTimer(s) {
    if (s.startTimer) {
      clearTimeout(s.startTimer);
      s.startTimer = null;
    }
  }

  /** True when we can positively tell Claude has no such conversation here. */
  _resumeUnavailable(cwd, claudeSessionId) {
    try {
      // If the transcript root is missing entirely we can't tell (relocated
      // config, first ever run) — let Claude make the call.
      if (!fs.existsSync(projectsRoot())) return false;
      return !fs.existsSync(transcriptPath(cwd, claudeSessionId));
    } catch {
      return false;
    }
  }

  /** True when this directory has no conversations for --continue to pick up. */
  _noTranscripts(cwd) {
    try {
      if (!fs.existsSync(projectsRoot())) return false;
      const dir = path.join(projectsRoot(), transcriptDirFor(cwd));
      if (!fs.existsSync(dir)) return true;
      return !fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
  }

  // Last line of defence for a launch that failed in a way we didn't predict:
  // scan startup output (before any hook has reported) for Claude's own
  // "can't open that conversation" messages and flag the session. Bounded to the
  // startup window: `hooksSeen` stays false forever when hooks are misconfigured,
  // and scanning every chunk of a whole session would be both wasteful and prone
  // to matching conversation text that merely quotes these messages.
  _checkStartupTrouble(s) {
    if (s.startupReported || Date.now() - s.startedAt > START_GRACE_MS) return;
    const tail = stripAnsi(s.buffer.slice(-6000)).replace(/\s+/g, ' ').toLowerCase();
    if (!STARTUP_ERROR_ANCHORS.some((a) => tail.includes(a))) return;
    s.startupReported = true;
    this._clearStartTimer(s);
    s.notice = 'Claude could not open that conversation. Launch a fresh session in this directory, or answer the prompt in the terminal.';
    s.awaitingInput = false;
    this._setStatus(s, 'attention', 'Could not open the saved conversation');
    this._pushActivity(s, 'attention', 'Resume failed — Claude could not open the saved conversation');
  }

  // ---- Claude hook handling ------------------------------------------------

  handleHookEvent(id, payload) {
    const s = this.sessions.get(id);
    if (!s || s.status === 'exited') return;
    s.hooksSeen = true;
    this._clearStartTimer(s); // Claude is talking to us; the watchdog is moot
    // Claude reports its own transcript location. For Windows sessions it's
    // derived from the cwd (transcriptPath); inside WSL it's a Linux path under
    // the distro user's home, which we couldn't know in advance.
    if (s.kind === 'wslclaude' && typeof payload.transcript_path === 'string') s.transcriptPath = payload.transcript_path;
    if (payload.session_id) s.claudeSessionId = payload.session_id;

    const ev = payload.hook_event_name;
    switch (ev) {
      case 'SessionStart':
        this._setStatus(s, 'ready', 'Ready — waiting for a prompt');
        this._pushActivity(s, 'start', `Claude ready (${payload.source || 'startup'})`);
        break;
      case 'UserPromptSubmit': {
        s.pendingQuestion = null;
        const p = trunc(payload.prompt, 100);
        this._setStatus(s, 'working', p ? `You: ${p}` : 'Prompt submitted');
        this._pushActivity(s, 'prompt', p ? `Prompt: ${p}` : 'Prompt submitted',
          typeof payload.prompt === 'string' ? capFull(payload.prompt) : undefined);
        break;
      }
      case 'PreToolUse': {
        if (payload.tool_name === 'AskUserQuestion') {
          // Claude is about to show an interactive choice menu — surface the
          // structured question so the UI can render clickable options.
          s.pendingQuestion = normalizeQuestions(payload.tool_input);
          s.awaitingInput = true;
          const q = s.pendingQuestion ? trunc(s.pendingQuestion[0].question, 110) : 'Question';
          this._setStatus(s, 'attention', `Question: ${q}`);
          const full = (s.pendingQuestion || [])
            .map((qq) => `${qq.question}\n${qq.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}`)
            .join('\n\n');
          this._pushActivity(s, 'attention', `Question: ${q}`, capFull(full));
          break;
        }
        s.pendingQuestion = null;
        const desc = describeTool(payload.tool_name, payload.tool_input);
        this._setStatus(s, 'working', desc);
        this._pushActivity(s, 'tool', desc, describeToolFull(payload.tool_name, payload.tool_input));
        break;
      }
      case 'PostToolUse':
        if (payload.tool_name === 'AskUserQuestion') s.pendingQuestion = null;
        // status stays 'working'; no feed entry to avoid doubling every tool
        if (s.status !== 'working') this._setStatus(s, 'working', s.activity);
        break;
      case 'Notification': {
        const msg = trunc(payload.message, 140) || 'Claude needs your attention';
        // OR, not assign: an FYI (e.g. the idle nudge) arriving while a question
        // is still on screen must not hide that question's buttons. Leaving
        // 'attention' clears the flag in _setStatus, so it can't go stale.
        s.awaitingInput = s.awaitingInput || notificationAwaitsInput(payload);
        this._setStatus(s, 'attention', msg);
        this._pushActivity(s, 'attention', msg, capFull(payload.message));
        break;
      }
      case 'Stop':
        s.pendingQuestion = null;
        this._setStatus(s, 'ready', 'Finished — your turn');
        this._pushActivity(s, 'stop', 'Finished responding');
        this._updateUsage(s); // async; emits a status refresh when done
        break;
      case 'PreCompact':
        this._setStatus(s, 'working', 'Compacting context…');
        this._pushActivity(s, 'compact', 'Compacting context');
        break;
      case 'SessionEnd':
        this._pushActivity(s, 'end', `Claude session ended (${payload.reason || 'exit'})`);
        break;
      case 'PermissionRequest': {
        // Returning nothing leaves Claude to show its normal prompt (which then
        // sends a permission_prompt Notification and raises the answer strip).
        if (s.autoApprove && s.autoApproveUntil && Date.now() >= s.autoApproveUntil) {
          this._expireAutoApprove(s); // the deadline wins even if the timer slept
          return undefined;
        }
        if (!s.autoApprove || NEVER_AUTO_APPROVE.has(payload.tool_name)) return undefined;
        // Logged so there is always a record of what was approved without a person.
        this._pushActivity(s, 'autoapprove', `Auto-approved ${describeTool(payload.tool_name, payload.tool_input)}`);
        return ALLOW_DECISION;
      }
      case 'SubagentStop':
      default:
        break;
    }
  }

  // Sum token usage from the session's transcript (JSONL under
  // <config dir>/projects/<encoded-cwd>/<claude-session-uuid>.jsonl).
  async _updateUsage(s) {
    if (!s.claudeSessionId) return;
    const file = s.kind === 'wslclaude'
      ? s.transcriptPath && fromWslPath(s.transcriptPath, s.distro)
      : transcriptPath(s.cwd, s.claudeSessionId);
    if (!file) return;
    try {
      const stat = await fs.promises.stat(file);
      if (stat.size > 50_000_000) return; // sanity cap
      const text = await fs.promises.readFile(file, 'utf8');
      let out = 0, ctx = 0, model = null;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const u = e.message && e.message.usage;
        if (e.type === 'assistant' && u) {
          out += u.output_tokens || 0;
          ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (e.message.model) model = e.message.model;
        }
      }
      s.usage = { out, ctx, model, updated: Date.now() };
      if (s.removed) return; // closed while we were reading the transcript
      this.emit('status', this.describe(s));
    } catch {
      // transcript not found (e.g. custom CLAUDE_CONFIG_DIR) — usage stays unknown
    }
  }

  _setStatus(s, status, activity) {
    const changed = s.status !== status;
    s.status = status;
    // Any move out of 'attention' means the prompt, if there was one, is gone.
    if (status !== 'attention') s.awaitingInput = false;
    if (activity) s.activity = activity;
    if (changed) s.statusSince = Date.now();
    // A removed session must never surface again: the renderer's upsert would
    // re-add it to the sidebar, and it could no longer be closed.
    if (!s.removed) this.emit('status', this.describe(s));
  }

  _pushActivity(s, type, detail, full) {
    this.emit('activity', {
      ts: Date.now(),
      sessionId: s.id,
      sessionName: s.name,
      type,
      detail,
      full: full || undefined,
    });
  }

  // ---- hook settings generation ---------------------------------------------

  _writeHookSettings(id, { wsl = false } = {}) {
    // curl.exe ships with Windows 10 1803+. --noproxy avoids corporate proxy
    // env vars hijacking loopback traffic; "|| exit 0" keeps a dead IDE from
    // surfacing hook errors inside the Claude session.
    //
    // Inside WSL the command still calls *Windows'* curl.exe, via WSL interop.
    // Under WSL2's default NAT networking, 127.0.0.1 inside Linux is Linux's own
    // loopback and can't reach this server; curl.exe runs on the Windows side,
    // so the HookServer can stay bound to Windows loopback only. Linux's own
    // curl would need mirrored networking, or the server exposed on WSL's
    // virtual adapter — not acceptable now that a reply can approve commands.
    const curl = wsl ? toWslPath(WIN_CURL).path : 'curl';
    const cmd =
      `${curl} -s --noproxy "*" --max-time 3 -X POST ` +
      `"http://127.0.0.1:${this.hookPort}/hook/${id}" ` +
      `--data-binary @- -H "Content-Type: application/json" || exit 0`;
    const hook = { type: 'command', command: cmd, timeout: 5 };
    const hooks = {};
    for (const ev of HOOK_EVENTS) {
      hooks[ev] = [{ hooks: [hook] }];
    }
    const settingsPath = path.join(this.hooksDir, `${id}.json`);
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
    return settingsPath;
  }
}

module.exports = {
  SessionManager,
  splitArgs,
  notificationAwaitsInput,
  isClaudeKind,
  toWslPath,
  fromWslPath,
  wslClaudeArgs,
  WSL_CLAUDE_LAUNCH,
};
