'use strict';
// Saves session definitions + UI prefs so a restart can offer to restore the
// workspace (fresh PTYs; Claude sessions can relaunch with --continue).

const fs = require('fs');
const path = require('path');

class Persistence {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'state.json');
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(s.history)) s.history = [];
      return s;
    } catch {
      return { sessions: [], history: [], ui: {} };
    }
  }

  save(state) {
    try {
      fs.writeFileSync(this.file, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('failed to save state:', err);
    }
  }

  snapshotSessions(manager) {
    return manager
      .list()
      .filter((s) => s.status !== 'exited')
      .map((s) => ({
        name: s.name,
        kind: s.kind,
        cwd: s.homeDefault ? '' : s.cwd, // blank stays blank -> home default on relaunch
        addDirs: s.addDirs,
        extraArgs: s.extraArgs,
        distro: s.distro,
        theme: s.theme,
        claudeSessionId: s.claudeSessionId,
      }));
  }

  // Durable session history: every session ever launched (deduped, capped),
  // so old work can be relaunched from the Recent dialog at any time —
  // independent of what happened to the last-open list.
  mergeHistory(prevHistory, liveSessions) {
    const hist = [...(prevHistory || [])];
    for (const s of liveSessions) {
      let e =
        // same Claude conversation
        (s.claudeSessionId && hist.find((h) => h.claudeSessionId === s.claudeSessionId)) ||
        // same runtime session earlier in this run (before its uuid was known)
        hist.find((h) => h.runKey === s.id) ||
        // plain shells: collapse by identity so history isn't spammed
        (s.kind !== 'claude' &&
          hist.find((h) => h.kind === s.kind && h.cwd === s.cwd && h.name === s.name && (h.distro || null) === (s.distro || null)));
      if (!e) {
        e = { hid: `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}` };
        hist.push(e);
      }
      Object.assign(e, {
        runKey: s.id,
        name: s.name,
        kind: s.kind,
        cwd: s.homeDefault ? '' : s.cwd,
        addDirs: s.addDirs || [],
        extraArgs: s.extraArgs || '',
        distro: s.distro || null,
        theme: s.theme || null,
        claudeSessionId: s.claudeSessionId || e.claudeSessionId || null,
        lastUsed: Date.now(),
      });
    }
    hist.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    return hist.slice(0, 50);
  }
}

module.exports = { Persistence };
