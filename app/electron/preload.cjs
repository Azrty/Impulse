const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLegalConsent: () => ipcRenderer.invoke('get-legal-consent'),
  acceptLegalConsent: (payload) => ipcRenderer.invoke('accept-legal-consent', payload),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getLauncherAvailability: () => ipcRenderer.invoke('get-launcher-availability'),
  uninstallLauncher: () => ipcRenderer.invoke('uninstall-launcher'),
  offlineLogin: (username) => ipcRenderer.invoke('offline-login', username),
  microsoftLogin: () => ipcRenderer.invoke('microsoft-login'),
  getCurrentUser: () => ipcRenderer.invoke('get-current-user'),
  logout: () => ipcRenderer.invoke('logout'),
  getMinecraftAccounts: () => ipcRenderer.invoke('get-minecraft-accounts'),
  setActiveMinecraftAccount: (accountId) => ipcRenderer.invoke('set-active-minecraft-account', accountId),
  removeMinecraftAccount: (accountId) => ipcRenderer.invoke('remove-minecraft-account', accountId),

  listServers: () => ipcRenderer.invoke('impulse-list-servers'),
  addServer: (payload) => ipcRenderer.invoke('impulse-add-server', payload),
  previewInvitation: (raw) => ipcRenderer.invoke('impulse-preview-invitation', raw),
  consumeDeepLinks: () => ipcRenderer.invoke('impulse-consume-deep-links'),
  refreshServer: (serverId) => ipcRenderer.invoke('impulse-refresh-server', serverId),
  updateOptionalMods: (serverId, selections, markPrompted = false) => ipcRenderer.invoke('impulse-update-optional-mods', serverId, selections, markPrompted),
  searchCustomMods: (serverId, query) => ipcRenderer.invoke('impulse-search-custom-mods', serverId, query),
  getCustomModProject: (serverId, projectId, channel = 'release') => ipcRenderer.invoke('impulse-custom-mod-project', serverId, projectId, channel),
  installCustomMod: (serverId, projectId, versionId, channel = 'release') => ipcRenderer.invoke('impulse-install-custom-mod', serverId, projectId, versionId, channel),
  removeCustomMod: (serverId, projectId) => ipcRenderer.invoke('impulse-remove-custom-mod', serverId, projectId),
  dismissOutdatedVersionWarning: (serverId) => ipcRenderer.invoke('impulse-dismiss-outdated-version-warning', serverId),
  acceptUnverifiedMods: (serverId, signature) => ipcRenderer.invoke('impulse-accept-unverified-mods', serverId, signature),
  respondCrashSharing: (reportId, share, remember = true) => ipcRenderer.invoke('impulse-respond-crash-sharing', reportId, share, remember),
  updateCrashSharing: (serverId, preference) => ipcRenderer.invoke('impulse-update-crash-sharing', serverId, preference),
  retryCrashReports: (serverId = null) => ipcRenderer.invoke('impulse-retry-crash-reports', serverId),
  markAnnouncementsRead: (serverId, ids) => ipcRenderer.invoke('impulse-mark-announcements-read', serverId, ids),
  removeServer: (serverId) => ipcRenderer.invoke('impulse-remove-server', serverId),
  launchServer: (serverId) => ipcRenderer.invoke('impulse-launch-server', serverId),
  cancelLaunch: (serverId) => ipcRenderer.invoke('impulse-cancel-launch', serverId),
  verifyServerFiles: (serverId) => ipcRenderer.invoke('impulse-verify-server-files', serverId),

  getLauncherSettings: () => ipcRenderer.invoke('get-launcher-settings'),
  getMicrophonePermission: () => ipcRenderer.invoke('get-microphone-permission'),
  requestMicrophonePermission: () => ipcRenderer.invoke('request-microphone-permission'),
  updateLauncherSettings: (settings) => ipcRenderer.invoke('update-launcher-settings', settings),
  clearGameFiles: () => ipcRenderer.invoke('clear-game-files'),
  getGameStorage: () => ipcRenderer.invoke('get-game-storage'),
  verifyGameCache: () => ipcRenderer.invoke('verify-game-cache'),
  cleanGameCache: () => ipcRenderer.invoke('clean-game-cache'),

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
  onCrashShareStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('impulse-crash-share-status', listener);
    return () => ipcRenderer.removeListener('impulse-crash-share-status', listener);
  },
  onDeepLink: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('impulse-deep-link', listener);
    return () => ipcRenderer.removeListener('impulse-deep-link', listener);
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
  onLauncherAvailabilityChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('launcher-availability-changed', listener);
    return () => ipcRenderer.removeListener('launcher-availability-changed', listener);
  },

  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  isElectron: true,
  platform: process.platform
});
