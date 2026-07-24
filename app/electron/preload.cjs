const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  offlineLogin: (username) => ipcRenderer.invoke('offline-login', username),
  microsoftLogin: () => ipcRenderer.invoke('microsoft-login'),
  getCurrentUser: () => ipcRenderer.invoke('get-current-user'),
  logout: () => ipcRenderer.invoke('logout'),
  getMinecraftAccounts: () => ipcRenderer.invoke('get-minecraft-accounts'),
  setActiveMinecraftAccount: (accountId) => ipcRenderer.invoke('set-active-minecraft-account', accountId),
  removeMinecraftAccount: (accountId) => ipcRenderer.invoke('remove-minecraft-account', accountId),

  listServers: () => ipcRenderer.invoke('impulse-list-servers'),
  addServer: (payload) => ipcRenderer.invoke('impulse-add-server', payload),
  refreshServer: (serverId) => ipcRenderer.invoke('impulse-refresh-server', serverId),
  removeServer: (serverId) => ipcRenderer.invoke('impulse-remove-server', serverId),
  launchServer: (serverId) => ipcRenderer.invoke('impulse-launch-server', serverId),

  getLauncherSettings: () => ipcRenderer.invoke('get-launcher-settings'),
  updateLauncherSettings: (settings) => ipcRenderer.invoke('update-launcher-settings', settings),

  onLaunchProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('impulse-launch-progress', listener);
    return () => ipcRenderer.removeListener('impulse-launch-progress', listener);
  },
  onLaunched: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('impulse-launched', listener);
    return () => ipcRenderer.removeListener('impulse-launched', listener);
  },
  onLaunchError: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('impulse-launch-error', listener);
    return () => ipcRenderer.removeListener('impulse-launch-error', listener);
  },
  onGameClosed: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('impulse-game-closed', listener);
    return () => ipcRenderer.removeListener('impulse-game-closed', listener);
  },

  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },

  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  isElectron: true,
  platform: process.platform
});
