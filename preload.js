'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = [
  'session:data',
  'session:status',
  'session:exit',
  'session:created',
  'session:removed',
  'session:activity',
  'session:focus-request',
  'session:popin',
  'editor:dock',
  'ws:changed',
  'window:focus',
];

contextBridge.exposeInMainWorld('gwt', {
  sessions: {
    create: (opts) => ipcRenderer.invoke('sessions:create', opts),
    kill: (id) => ipcRenderer.invoke('sessions:kill', id),
    remove: (id) => ipcRenderer.invoke('sessions:remove', id),
    list: () => ipcRenderer.invoke('sessions:list'),
    buffer: (id) => ipcRenderer.invoke('sessions:buffer', id),
    rename: (id, name) => ipcRenderer.invoke('sessions:rename', { id, name }),
    setTheme: (id, theme) => ipcRenderer.invoke('sessions:setTheme', { id, theme }),
    sendText: (ids, text, submit) => ipcRenderer.invoke('sessions:sendText', { ids, text, submit }),
    interrupt: (id) => ipcRenderer.invoke('sessions:interrupt', id),
    popout: (id) => ipcRenderer.invoke('sessions:popout', id),
    write: (id, data) => ipcRenderer.send('sessions:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('sessions:resize', { id, cols, rows }),
  },
  ws: {
    listDir: (dir) => ipcRenderer.invoke('ws:listDir', dir),
    gitInfo: (dir) => ipcRenderer.invoke('ws:gitInfo', dir),
    gitDiff: (dir, file) => ipcRenderer.invoke('ws:gitDiff', { dir, file }),
    gitDiffAll: (dir) => ipcRenderer.invoke('ws:gitDiffAll', dir),
    readFile: (file) => ipcRenderer.invoke('ws:readFile', file),
    readFileForEdit: (file) => ipcRenderer.invoke('ws:readFileForEdit', file),
    writeFile: (file, content) => ipcRenderer.invoke('ws:writeFile', { file, content }),
    watch: (roots) => ipcRenderer.invoke('ws:watch', roots),
    worktreeAdd: (repoDir, branch) => ipcRenderer.invoke('ws:worktreeAdd', { repoDir, branch }),
    openExternal: (target) => ipcRenderer.invoke('ws:openExternal', target),
  },
  app: {
    pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
    restorable: () => ipcRenderer.invoke('app:restorable'),
    wslDistros: () => ipcRenderer.invoke('app:wslDistros'),
    history: () => ipcRenderer.invoke('app:history'),
    historyRemove: (hid) => ipcRenderer.invoke('app:historyRemove', hid),
    historyRename: (hid, name) => ipcRenderer.invoke('app:historyRename', { hid, name }),
    openEditor: (file) => ipcRenderer.invoke('editor:open', file),
    dockEditor: (file) => ipcRenderer.invoke('editor:dock', file),
    uiPrefs: () => ipcRenderer.invoke('app:uiPrefs'),
    saveUiPrefs: (ui) => ipcRenderer.invoke('app:saveUiPrefs', ui),
    setNativeTheme: (mode) => ipcRenderer.invoke('app:setNativeTheme', mode),
  },
  on: (channel, cb) => {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`Unknown channel: ${channel}`);
    const wrapped = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
