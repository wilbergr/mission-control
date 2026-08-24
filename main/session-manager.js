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

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
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
    const kind = ['shell', 'wsl'].includes(opts.kind) ? opts.kind : 'claude';
    let cwd = opts.cwd;
    if (!cwd) {
      // shells may omit the directory and open at home; Claude needs a project
      if (kind === 'claude') throw new Error('Directory is required for Claude sessions');
      cwd = os.homedir();
    }
    if (!fs.existsSync(cwd)) throw new Error(`Directory does not exist: ${cwd}`);
    const addDirs = (opts.addDirs || []).filter(Boolean);

    let file, args;
    let notice = null; // surfaced in the UI when we had to change what was asked for
    if (kind === 'claude') {
      const settingsPath = this._writeHookSettings(id);
      args = ['--settings', settingsPath];
      for (const d of addDirs) args.push('--add-dir', d);
      // A stale --resume id (or --continue with no history) makes Claude print
      // "No conversation found …" and sit there with no hooks — a dead session.
      // Check first and fall back to a fresh conversation in the same directory.
      let resume = opts.resume || null;
      let cont = !!opts.continue;
      if (resume && this._resumeUnavailable(cwd, resume)) {
        notice = 'Saved conversation not found for this directory — started a fresh session instead.';
        resume = null;
      }
      if (cont && this._noTranscripts(cwd)) {
        notice = 'No previous conversation in this directory — started a fresh session instead.';
        cont = false;
      }
      if (cont) args.push('--continue');
      if (resume) args.push('--resume', resume);
      args.push(...splitArgs(opts.extraArgs));
      // one-shot starting prompt (positional arg); deliberately not persisted,
      // so restore/resume won't replay it
      if (opts.initialPrompt) args.push(opts.initialPrompt);
      file = this.claudePath || 'claude';
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
      homeDefault: !opts.cwd && kind !== 'claude', // launched with blank dir
      addDirs,
      extraArgs: opts.extraArgs || '',
      distro: opts.distro || null,
      theme: opts.theme || null, // per-session color scheme override
      pid: proc.pid,
      proc,
      buffer: '',
      status: kind === 'claude' ? 'starting' : 'running',
      statusSince: Date.now(),
      activity:
        kind === 'claude' ? 'Starting Claude…' : kind === 'wsl' ? `WSL ${opts.distro || 'default'}` : 'Shell session',
      hooksSeen: false,
      claudeSessionId: null, // Claude's own session UUID (from hook payloads)
      pendingQuestion: null, // AskUserQuestion payload while Claude waits on a choice
      usage: null, // {out, ctx, model} parsed from the transcript after each turn
      notice, // launch caveat worth showing the user (e.g. resume fell back to fresh)
      startedAt: Date.now(), // bounds how long startup output is scanned
      startupReported: false, // startup-trouble message already raised
      startTimer: null,
      exitCode: null,
    };
    this.sessions.set(id, s);
    if (notice) s.activity = notice;
    if (kind === 'claude') {
      // Nothing from Claude at all after a generous grace period means the
      // session is stuck (unanswered prompt in the terminal, a launch error we
      // don't recognize, hooks blocked). Say so instead of showing "Starting".
      s.startTimer = setTimeout(() => {
        s.startTimer = null;
        if (s.hooksSeen || s.status !== 'starting') return;
        s.notice = s.notice || 'No signal from Claude yet — check this session\'s terminal for a prompt or error.';
        this._setStatus(s, 'attention', 'No signal from Claude yet — check the terminal');
        this._pushActivity(s, 'attention', 'No hook signal after 45s — session may be waiting in the terminal');
      }, START_GRACE_MS);
    }

    proc.onData((data) => {
      s.buffer += data;
      if (s.buffer.length > MAX_BUFFER_CHARS) {
        s.buffer = s.buffer.slice(s.buffer.length - MAX_BUFFER_CHARS);
      }
      if (s.kind === 'claude' && !s.hooksSeen && s.status !== 'exited') {
        // Bell heuristic: only trusted when hooks aren't reporting (e.g. hooks
        // misconfigured) — Claude rings BEL when it needs attention.
        if (data.includes('\x07')) this._setStatus(s, 'attention', 'Terminal bell — may need input');
        this._checkStartupTrouble(s);
      }
      this.emit('data', { id, data });
    });

    proc.onExit(({ exitCode }) => {
      s.exitCode = exitCode;
      this._clearStartTimer(s);
      this._setStatus(s, 'exited', `Exited (code ${exitCode})`);
      if (s.removed) return; // remove() already told the renderer this one is gone
      this._pushActivity(s, 'exit', `Process exited with code ${exitCode}`);
      this.emit('exit', { id, exitCode });
    });

    this.emit('created', this.describe(s));
    this._pushActivity(s, 'spawn', kind === 'claude' ? 'Claude session launched' : 'Terminal launched');
    if (notice) this._pushActivity(s, 'notice', notice);
    return this.describe(s);
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
      // The startup watchdog would otherwise still fire and push an activity
      // entry for a session that is already gone.
      this._clearStartTimer(s);
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
        if (s.kind === 'claude') {
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
    s.proc.write(s.kind === 'claude' ? '\x1b' : '\x03');
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
      usage: s.usage,
      notice: s.notice,
      distro: s.distro,
      theme: s.theme,
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
    this._setStatus(s, 'attention', 'Could not open the saved conversation');
    this._pushActivity(s, 'attention', 'Resume failed — Claude could not open the saved conversation');
  }

  // ---- Claude hook handling ------------------------------------------------

  handleHookEvent(id, payload) {
    const s = this.sessions.get(id);
    if (!s || s.status === 'exited') return;
    s.hooksSeen = true;
    this._clearStartTimer(s); // Claude is talking to us; the watchdog is moot
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
        this._pushActivity(s, 'prompt', p ? `Prompt: ${p}` : 'Prompt submitted');
        break;
      }
      case 'PreToolUse': {
        if (payload.tool_name === 'AskUserQuestion') {
          // Claude is about to show an interactive choice menu — surface the
          // structured question so the UI can render clickable options.
          s.pendingQuestion = normalizeQuestions(payload.tool_input);
          const q = s.pendingQuestion ? trunc(s.pendingQuestion[0].question, 110) : 'Question';
          this._setStatus(s, 'attention', `Question: ${q}`);
          this._pushActivity(s, 'attention', `Question: ${q}`);
          break;
        }
        s.pendingQuestion = null;
        const desc = describeTool(payload.tool_name, payload.tool_input);
        this._setStatus(s, 'working', desc);
        this._pushActivity(s, 'tool', desc);
        break;
      }
      case 'PostToolUse':
        if (payload.tool_name === 'AskUserQuestion') s.pendingQuestion = null;
        // status stays 'working'; no feed entry to avoid doubling every tool
        if (s.status !== 'working') this._setStatus(s, 'working', s.activity);
        break;
      case 'Notification': {
        const msg = trunc(payload.message, 140) || 'Claude needs your attention';
        this._setStatus(s, 'attention', msg);
        this._pushActivity(s, 'attention', msg);
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
      case 'SubagentStop':
      default:
        break;
    }
  }

  // Sum token usage from the session's transcript (JSONL under
  // <config dir>/projects/<encoded-cwd>/<claude-session-uuid>.jsonl).
  async _updateUsage(s) {
    if (!s.claudeSessionId) return;
    const file = transcriptPath(s.cwd, s.claudeSessionId);
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
    if (activity) s.activity = activity;
    if (changed) s.statusSince = Date.now();
    // A removed session must never surface again: the renderer's upsert would
    // re-add it to the sidebar, and it could no longer be closed.
    if (!s.removed) this.emit('status', this.describe(s));
  }

  _pushActivity(s, type, detail) {
    this.emit('activity', {
      ts: Date.now(),
      sessionId: s.id,
      sessionName: s.name,
      type,
      detail,
    });
  }

  // ---- hook settings generation ---------------------------------------------

  _writeHookSettings(id) {
    // curl.exe ships with Windows 10 1803+. --noproxy avoids corporate proxy
    // env vars hijacking loopback traffic; "|| exit 0" keeps a dead IDE from
    // surfacing hook errors inside the Claude session.
    const cmd =
      `curl -s --noproxy "*" --max-time 3 -X POST ` +
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

module.exports = { SessionManager, splitArgs };
