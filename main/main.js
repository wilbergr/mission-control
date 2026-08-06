'use strict';

const { app, BrowserWindow, ipcMain, dialog, Notification, shell, nativeTheme } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const { HookServer } = require('./hook-server');
const { SessionManager } = require('./session-manager');
const ws = require('./workspace');
const { Persistence, dedupeByName } = require('./persistence');

let win = null;
let manager = null;
let hookServer = null;
let persistence = null;
let watcher = null;
let restorable = []; // sessions from the previous run, offered on startup

app.setAppUserModelId('com.wilshire.missioncontrol');

// Broadcast to every window: the control window plus any popped-out
// terminals/editors that subscribe to session events.
function send(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

const popouts = new Map(); // sessionId -> BrowserWindow

// Windows only picks this up per-window; build/icon.ico must also be listed in
// electron-builder's `files` or it won't exist in the packaged app.
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');

function resolveClaudePath() {
  return new Promise((resolve) => {
    execFile('where.exe', ['claude'], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      resolve(stdout.trim().split(/\r?\n/)[0]);
    });
  });
}

// `wsl --list --quiet` prints UTF-16LE, one distro per line.
function listWslDistros() {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['--list', '--quiet'],
      { windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const names = stdout
          .toString('utf16le')
          .split(/\r?\n/)
          .map((l) => l.replace(/\0/g, '').trim())
          .filter((l) => l && !l.startsWith('docker-desktop'));
        resolve(names);
      }
    );
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0b0e14',
    title: 'Mission Control',
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('focus', () => send('window:focus', true));
}

function notifyIfUnfocused(info) {
  if (!win || win.isFocused()) return;
  if (persistence && (persistence.load().ui || {}).notifications === false) return;
  if (info.status === 'attention') win.flashFrame(true);
  const title =
    info.status === 'attention'
      ? `${info.name} needs your attention`
      : `${info.name} is ready for you`;
  const n = new Notification({ title, body: info.activity || '', silent: info.status !== 'attention' });
  n.on('click', () => {
    const pw = popouts.get(info.id);
    if (pw && !pw.isDestroyed()) {
      if (pw.isMinimized()) pw.restore();
      pw.show();
      pw.focus();
      return;
    }
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('session:focus-request', { id: info.id });
  });
  n.show();
}

async function init() {
  // One-time migration: the app was renamed GW Terminal -> Mission Control,
  // which changes the userData folder; carry the old state over.
  try {
    const fs = require('fs');
    const newState = path.join(app.getPath('userData'), 'state.json');
    const oldState = path.join(app.getPath('userData'), '..', 'GW Terminal', 'state.json');
    if (!fs.existsSync(newState) && fs.existsSync(oldState)) {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.copyFileSync(oldState, newState);
    }
  } catch (err) {
    console.error('state migration failed:', err);
  }

  persistence = new Persistence(app.getPath('userData'));
  const prev = persistence.load();
  restorable = prev.sessions || [];

  const claudePath = await resolveClaudePath();
  manager = new SessionManager({
    hooksDir: path.join(app.getPath('userData'), 'hooks'),
    claudePath,
  });
  hookServer = new HookServer((id, payload) => manager.handleHookEvent(id, payload));
  manager.hookPort = await hookServer.start();

  watcher = new ws.WorkspaceWatcher();
  watcher.on('changed', () => send('ws:changed', {}));

  manager.on('data', (p) => send('session:data', p));
  manager.on('exit', (p) => send('session:exit', p));
  manager.on('created', (p) => send('session:created', p));
  manager.on('removed', (p) => {
    const pw = popouts.get(p.id);
    if (pw && !pw.isDestroyed()) pw.close();
    send('session:removed', p);
  });
  manager.on('activity', (p) => send('session:activity', p));
  manager.on('status', (info) => {
    send('session:status', info);
    if (info.status === 'attention' || info.status === 'ready') notifyIfUnfocused(info);
    saveState();
  });

  registerIpc();
  createWindow();
}

let saveTimer = null;
function saveState(uiPrefs) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const prev = persistence.load();
    persistence.save({
      sessions: persistence.snapshotSessions(manager),
      history: persistence.mergeHistory(prev.history, manager.list()),
      ui: uiPrefs || prev.ui || {},
    });
  }, 400);
}

function registerIpc() {
  ipcMain.handle('sessions:create', (_e, opts) => {
    const info = manager.create(opts);
    saveState();
    return info;
  });
  ipcMain.handle('sessions:kill', (_e, id) => manager.kill(id));
  ipcMain.handle('sessions:remove', (_e, id) => {
    manager.remove(id);
    saveState();
  });
  ipcMain.handle('sessions:list', () => manager.list());
  ipcMain.handle('sessions:buffer', (_e, id) => manager.bufferOf(id));
  ipcMain.handle('sessions:rename', (_e, { id, name }) => {
    manager.rename(id, name);
    saveState();
  });
  ipcMain.handle('sessions:setTheme', (_e, { id, theme }) => {
    manager.setTheme(id, theme);
    saveState();
  });
  ipcMain.handle('sessions:sendText', (_e, { ids, text, submit }) =>
    manager.sendText(ids, text, submit !== false)
  );
  ipcMain.handle('sessions:interrupt', (_e, id) => manager.interrupt(id));
  ipcMain.handle('sessions:popout', (_e, id) => {
    const existing = popouts.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const pw = new BrowserWindow({
      width: 960,
      height: 620,
      backgroundColor: '#0d1117',
      icon: APP_ICON,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    pw.loadFile(path.join(__dirname, '..', 'renderer', 'term.html'), { query: { id } });
    popouts.set(id, pw);
    pw.on('closed', () => {
      popouts.delete(id);
      send('session:popin', { id }); // control window re-docks the tile
    });
  });
  ipcMain.on('sessions:write', (_e, { id, data }) => manager.write(id, data));
  ipcMain.on('sessions:resize', (_e, { id, cols, rows }) => manager.resize(id, cols, rows));

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('ws:listDir', (_e, dir) => ws.listDir(dir));
  ipcMain.handle('ws:gitInfo', (_e, dir) => ws.gitInfo(dir));
  ipcMain.handle('ws:gitDiff', (_e, { dir, file }) => ws.gitDiff(dir, file));
  ipcMain.handle('ws:gitDiffAll', (_e, dir) => ws.gitDiffAll(dir));
  ipcMain.handle('ws:readFile', (_e, file) => ws.readFileCapped(file));
  ipcMain.handle('ws:readFileForEdit', (_e, file) => ws.readFileCapped(file, 2_000_000));
  ipcMain.handle('ws:writeFile', (_e, { file, content }) => ws.writeFile(file, content));
  ipcMain.handle('editor:open', (_e, file) => {
    const ew = new BrowserWindow({
      width: 1050,
      height: 780,
      backgroundColor: '#0b0e14',
      icon: APP_ICON,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    ew.loadFile(path.join(__dirname, '..', 'renderer', 'editor.html'), {
      query: { f: file },
    });
  });
  ipcMain.handle('ws:watch', (_e, roots) => watcher.setRoots(roots));
  ipcMain.handle('ws:worktreeAdd', (_e, { repoDir, branch }) => ws.worktreeAdd(repoDir, branch));
  ipcMain.handle('ws:openExternal', (_e, target) => shell.openPath(target));

  // An editor window asked to move back into the control window's grid.
  ipcMain.handle('editor:dock', (_e, file) => {
    send('editor:dock', { file });
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.handle('app:restorable', () => restorable);
  ipcMain.handle('app:wslDistros', () => listWslDistros());
  ipcMain.handle('app:setNativeTheme', (_e, mode) => {
    if (['system', 'dark', 'light'].includes(mode)) nativeTheme.themeSource = mode;
  });
  ipcMain.handle('app:history', () => persistence.load().history);
  ipcMain.handle('app:historyRemove', (_e, hid) => {
    const state = persistence.load();
    state.history = (state.history || []).filter((h) => h.hid !== hid);
    persistence.save(state);
    return state.history;
  });
  ipcMain.handle('app:historyRename', (_e, { hid, name }) => {
    const state = persistence.load();
    const entry = (state.history || []).find((h) => h.hid === hid);
    if (entry && String(name || '').trim()) entry.name = String(name).trim();
    // renaming onto an existing name must not leave two entries behind
    state.history = dedupeByName(state.history);
    persistence.save(state);
    return state.history;
  });
  ipcMain.handle('app:uiPrefs', () => persistence.load().ui || {});
  ipcMain.handle('app:saveUiPrefs', (_e, ui) => saveState(ui));
}

app.whenReady().then(init);

app.on('before-quit', () => {
  // persist final state synchronously-ish before teardown
  clearTimeout(saveTimer);
  const prev = persistence ? persistence.load() : { ui: {} };
  if (persistence && manager) {
    persistence.save({
      sessions: persistence.snapshotSessions(manager),
      history: persistence.mergeHistory(prev.history, manager.list()),
      ui: prev.ui || {},
    });
  }
  if (manager) manager.killAll();
  if (hookServer) hookServer.stop();
  if (watcher) watcher.close();
});

app.on('window-all-closed', () => app.quit());
