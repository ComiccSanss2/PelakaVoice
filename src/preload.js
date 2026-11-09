const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  ipcRenderer.on(channel, (_event, data) => cb(data));
};

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // Hosting (local server + worldwide tunnel)
  hostStart: (online) => ipcRenderer.invoke('host-start', !!online),
  hostStop: () => ipcRenderer.invoke('host-stop'),
  onHostState: listen('host-state'),

  // Preferences mirrored to the main process
  setTheme: (name) => ipcRenderer.send('set-theme', name),
  setServer: (url) => ipcRenderer.send('set-server', url),
  flash: () => ipcRenderer.send('flash'),
  focusWindow: () => ipcRenderer.send('focus-window'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.invoke('set-autostart', !!on),
  onHotkey: listen('hotkey'),
  hostStatus: () => ipcRenderer.invoke('host-status'),
  hostConfig: (conf) => ipcRenderer.invoke('host-config', conf),
  setPresence: (inCall) => ipcRenderer.send('presence', { inCall: !!inCall }),
  selectCapture: (id, audio) => ipcRenderer.invoke('capture-select', { id, audio: !!audio }),
  shakeWindow: () => ipcRenderer.send('shake-window'),

  // In-app updates
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  getUpdateState: () => ipcRenderer.invoke('update-state'),
  whatsNew: () => ipcRenderer.invoke('whats-new'),
  onUpdateState: listen('update-state'),
  onSplashState: listen('splash-state')
});
