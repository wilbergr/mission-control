'use strict';
// Terminal color schemes (xterm.js theme objects). The global default lives in
// ui prefs; a per-session override rides on the session and is persisted with
// the last-open snapshot and the Recent history.

window.GWT = window.GWT || {};

(() => {
  const THEMES = {
    'GitHub Dark': {
      background: '#0d1117', foreground: '#c9d1d9', cursor: '#4da3ff', cursorAccent: '#0d1117',
      selectionBackground: '#264f78',
      black: '#161b22', red: '#ff7b72', green: '#3fd97a', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
      brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
    'Campbell (Windows)': {
      background: '#0c0c0c', foreground: '#cccccc', cursor: '#cccccc', cursorAccent: '#0c0c0c',
      selectionBackground: '#3b78ff55',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
      blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
      brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
    'PowerShell (blue)': {
      // Campbell Powershell — the classic blue PowerShell console
      background: '#012456', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#012456',
      selectionBackground: '#1f4b99',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
      blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
      brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
    'Vintage (cmd)': {
      background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', cursorAccent: '#000000',
      selectionBackground: '#3a3a3a',
      black: '#000000', red: '#800000', green: '#008000', yellow: '#808000',
      blue: '#000080', magenta: '#800080', cyan: '#008080', white: '#c0c0c0',
      brightBlack: '#808080', brightRed: '#ff0000', brightGreen: '#00ff00', brightYellow: '#ffff00',
      brightBlue: '#0000ff', brightMagenta: '#ff00ff', brightCyan: '#00ffff', brightWhite: '#ffffff',
    },
    'One Half Dark': {
      background: '#282c34', foreground: '#dcdfe4', cursor: '#dcdfe4', cursorAccent: '#282c34',
      selectionBackground: '#474e5d',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
      brightBlack: '#5a6374', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#dcdfe4',
    },
    'One Half Light': {
      background: '#fafafa', foreground: '#383a42', cursor: '#4f525e', cursorAccent: '#fafafa',
      selectionBackground: '#d0d0d0',
      black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
      blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#fafafa',
      brightBlack: '#4f525e', brightRed: '#df6c75', brightGreen: '#98c379', brightYellow: '#e4c07a',
      brightBlue: '#61afef', brightMagenta: '#c577dd', brightCyan: '#56b5c1', brightWhite: '#ffffff',
    },
    'Tango Dark': {
      background: '#000000', foreground: '#d3d7cf', cursor: '#d3d7cf', cursorAccent: '#000000',
      selectionBackground: '#3a3f44',
      black: '#000000', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
      brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    },
    'Tango Light': {
      background: '#ffffff', foreground: '#555753', cursor: '#555753', cursorAccent: '#ffffff',
      selectionBackground: '#c1deff',
      black: '#000000', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
      brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    },
    'Ubuntu': {
      // classic Ubuntu aubergine terminal
      background: '#300a24', foreground: '#eeeeec', cursor: '#eeeeec', cursorAccent: '#300a24',
      selectionBackground: '#573a52',
      black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
      brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    },
    'Dracula': {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    'Nord': {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    'One Dark': {
      background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#d19a66',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
    'Monokai': {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#272822',
      selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#e6db74',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#e6db74',
      brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
    'Gruvbox Dark': {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
    'Solarized Dark': {
      background: '#002b36', foreground: '#839496', cursor: '#839496', cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
    'Solarized Light': {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  };

  const DEFAULT = 'GitHub Dark';

  GWT.themes = {
    THEMES,
    DEFAULT,
    names: () => Object.keys(THEMES),
    get: (name) => THEMES[name] || THEMES[DEFAULT],
    valid: (name) => !!THEMES[name],
  };
})();
