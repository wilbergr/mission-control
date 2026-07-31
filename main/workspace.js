'use strict';
// Filesystem + git visibility for the directories each session works in.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const MAX_ENTRIES = 1500;
const MAX_FILE_BYTES = 300_000;

function git(dir, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { windowsHide: true, maxBuffer: 8_000_000 },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

async function listDir(dir) {
  try {
    const names = await fs.promises.readdir(dir, { withFileTypes: true });
    const entries = names
      .slice(0, MAX_ENTRIES)
      .map((d) => ({
        name: d.name,
        path: path.join(dir, d.name),
        isDir: d.isDirectory(),
        isSymlink: d.isSymbolicLink(),
      }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { entries, truncated: names.length > MAX_ENTRIES };
  } catch (err) {
    return { entries: [], error: String(err.message || err) };
  }
}

// Parse `git status --porcelain=v1 -b`; returns absolute paths so the file
// tree can badge entries no matter where the session cwd sits in the repo.
async function gitInfo(dir) {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.err) return { isRepo: false };
  const root = top.stdout.trim().replace(/\//g, path.sep);

  const st = await git(dir, ['status', '--porcelain=v1', '-b']);
  if (st.err) return { isRepo: true, root, branch: '?', changes: [] };

  let branch = '?';
  let ahead = 0;
  let behind = 0;
  const changes = [];
  for (const line of st.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const b = line.slice(3);
      branch = b.split('...')[0].trim();
      const am = /ahead (\d+)/.exec(b);
      const bm = /behind (\d+)/.exec(b);
      if (am) ahead = +am[1];
      if (bm) behind = +bm[1];
      continue;
    }
    const code = line.slice(0, 2);
    let rel = line.slice(3);
    if (rel.includes(' -> ')) rel = rel.split(' -> ')[1]; // renames
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    changes.push({
      code: code.trim() || '??',
      rel,
      path: path.join(root, rel.replace(/\//g, path.sep)),
    });
  }
  return { isRepo: true, root, branch, ahead, behind, changes };
}

async function gitDiff(dir, file) {
  // staged + unstaged combined view against HEAD
  let r = await git(dir, ['diff', 'HEAD', '--', file]);
  if (!r.err && r.stdout.trim()) return { diff: r.stdout };
  // untracked file: show its content as an "all new" preview
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_FILE_BYTES) return { diff: `(new file, ${stat.size} bytes — too large to preview)` };
    const content = await fs.promises.readFile(file, 'utf8');
    return { diff: content.split('\n').map((l) => '+' + l).join('\n'), untracked: true };
  } catch (err) {
    return { diff: '', error: String(err.message || err) };
  }
}

async function readFileCapped(file, cap = MAX_FILE_BYTES) {
  try {
    const stat = await fs.promises.stat(file);
    let content, truncated;
    if (stat.size > cap) {
      const fh = await fs.promises.open(file, 'r');
      const buf = Buffer.alloc(cap);
      await fh.read(buf, 0, cap, 0);
      await fh.close();
      content = buf.toString('utf8');
      truncated = true;
    } else {
      content = await fs.promises.readFile(file, 'utf8');
      truncated = false;
    }
    // NUL byte in the first 8KB -> treat as binary (not editable)
    const probe = content.slice(0, 8192);
    const binary = probe.includes('\u0000');
    return { content: binary ? '' : content, truncated, size: stat.size, binary };
  } catch (err) {
    return { content: '', error: String(err.message || err) };
  }
}

async function writeFile(file, content) {
  try {
    await fs.promises.writeFile(file, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

// Full working-tree diff for the "what has this session changed" view.
async function gitDiffAll(dir) {
  const info = await gitInfo(dir);
  if (!info.isRepo) return { error: 'Not a git repository' };
  const stat = await git(dir, ['diff', 'HEAD', '--stat']);
  const patch = await git(dir, ['diff', 'HEAD']);
  const untracked = info.changes.filter((c) => c.code === '??').map((c) => c.rel);
  return {
    branch: info.branch,
    stat: stat.err ? '' : stat.stdout,
    patch: patch.err ? '(no commits yet — diff unavailable)' : patch.stdout,
    untracked,
  };
}

// Create a git worktree so several Claude sessions can work on one repo
// without stepping on each other. Worktrees land next to the repo:
//   C:\src\myrepo  ->  C:\src\myrepo.worktrees\<branch>
async function worktreeAdd(repoDir, branch) {
  const info = await gitInfo(repoDir);
  if (!info.isRepo) return { error: `${repoDir} is not a git repository` };
  const safe = String(branch || '').trim().replace(/[^\w./-]+/g, '-');
  if (!safe) return { error: 'Branch name required' };
  const base = path.join(path.dirname(info.root), `${path.basename(info.root)}.worktrees`);
  const wtPath = path.join(base, safe.replace(/[\\/]+/g, '_'));
  if (fs.existsSync(wtPath)) return { error: `Worktree path already exists: ${wtPath}` };
  await fs.promises.mkdir(base, { recursive: true });
  const r = await git(info.root, ['worktree', 'add', wtPath, '-b', safe]);
  if (r.err) return { error: r.stderr.trim() || String(r.err.message) };
  return { path: wtPath, branch: safe };
}

// Watches the focused session's root dirs and emits debounced 'changed'
// events so the file tree / changes panel stay current.
class WorkspaceWatcher extends EventEmitter {
  constructor() {
    super();
    this.watchers = new Map(); // root -> fs.FSWatcher
    this.timer = null;
  }

  setRoots(roots) {
    const want = new Set((roots || []).filter((r) => r && fs.existsSync(r)));
    for (const [root, w] of this.watchers) {
      if (!want.has(root)) {
        w.close();
        this.watchers.delete(root);
      }
    }
    for (const root of want) {
      if (this.watchers.has(root)) continue;
      try {
        const w = fs.watch(root, { recursive: true }, (_ev, fname) => {
          if (fname && /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(fname)) return;
          this._bump();
        });
        w.on('error', () => this.watchers.delete(root));
        this.watchers.set(root, w);
      } catch { /* dir may vanish; tree refresh button still works */ }
    }
  }

  _bump() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emit('changed'), 600);
  }

  close() {
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}

module.exports = { listDir, gitInfo, gitDiff, gitDiffAll, readFileCapped, writeFile, worktreeAdd, WorkspaceWatcher };
