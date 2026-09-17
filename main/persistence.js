'use strict';
// Saves session definitions + UI prefs so a restart can offer to restore the
// workspace (fresh PTYs; Claude sessions can relaunch with --continue).

const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 50;

// Trim to MAX_HISTORY while preserving display order. Eviction is by
// least-recently-used, deliberately NOT by list position: the order is the
// user's own arrangement, so dropping the tail would make anything they
// dragged to the bottom the first thing deleted.
function capHistory(hist) {
  if (hist.length <= MAX_HISTORY) return hist;
  const keep = new Set(
    [...hist].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, MAX_HISTORY)
  );
  return hist.filter((h) => keep.has(h));
}

// Apply a user-supplied order to the entries the sidebar actually displayed.
// Entries hidden from Previous (because that session is currently listed as
// running) keep their exact slots, so they reappear where they were left.
function reorderHistory(hist, orderedHids) {
  const wanted = new Set((orderedHids || []).filter(Boolean));
  const slots = [];
  const byHid = new Map();
  hist.forEach((h, i) => {
    if (wanted.has(h.hid)) {
      slots.push(i);
      byHid.set(h.hid, h);
    }
  });
  if (slots.length < 2) return hist;
  const seq = (orderedHids || []).map((id) => byHid.get(id)).filter(Boolean);
  if (seq.length !== slots.length) return hist; // stale request — leave it alone
  const out = [...hist];
  slots.forEach((slot, k) => { out[slot] = seq[k]; });
  return out;
}

// Groups are just an optional `group` string on an entry — there is no group
// object. A group therefore exists exactly as long as something is in it, and
// its position is derived from where its first member sits in the array, so the
// user's manual ordering stays the single source of truth.
function setHistoryGroup(hist, hid, group) {
  const g = String(group == null ? '' : group).trim();
  const e = (hist || []).find((h) => h.hid === hid);
  if (e) {
    if (g) e.group = g;
    else delete e.group; // back to ungrouped
  }
  return hist;
}

// Renaming is a rewrite across every member — the cost of not having group
// objects. An empty `to` ungroups them all.
function renameHistoryGroup(hist, from, to) {
  const f = String(from || '').trim();
  if (!f) return hist;
  const t = String(to || '').trim();
  for (const h of hist || []) {
    if (String(h.group || '').trim() !== f) continue;
    if (t) h.group = t;
    else delete h.group;
  }
  return hist;
}

// One pinned entry per name: a Claude conversation gets a fresh uuid every time,
// so without this the Previous list fills up with copies of the same folder
// name. Newest wins; rename a session to keep more than one.
function dedupeByName(hist) {
  const byName = new Map(); // lower-cased name -> entry
  for (const h of hist || []) {
    const key = String(h.name || '').trim().toLowerCase();
    const kept = byName.get(key);
    if (!kept || (h.lastUsed || 0) >= (kept.lastUsed || 0)) byName.set(key, h);
  }
  return [...byName.values()];
}

class Persistence {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'state.json');
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(s.history)) s.history = [];
      s.history = dedupeByName(s.history); // heals lists saved before the rule existed
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
  //
  // Order is the user's own arrangement and is preserved here. It must NOT be
  // re-sorted by lastUsed: this runs on every save (any status change, 400 ms
  // debounce), so re-sorting would wipe a manual reorder within a second of
  // making it. Newly seen work is unshifted to the top instead; existing
  // entries are updated in place.
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
          hist.find((h) => h.kind === s.kind && h.cwd === s.cwd && h.name === s.name && (h.distro || null) === (s.distro || null))) ||
        // one entry per name: reuse it in place (keeps hid stable) rather than
        // adding a second entry for dedupeByName to collapse later
        hist.find((h) => String(h.name || '').trim().toLowerCase() === String(s.name || '').trim().toLowerCase());
      if (!e) {
        e = { hid: `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}` };
        hist.unshift(e); // newly seen work surfaces at the top of Previous
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
    return capHistory(dedupeByName(hist));
  }
}

module.exports = {
  Persistence,
  dedupeByName,
  reorderHistory,
  capHistory,
  setHistoryGroup,
  renameHistoryGroup,
  MAX_HISTORY,
};
