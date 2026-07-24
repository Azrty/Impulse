const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const net = require('net');
const crypto = require('crypto');
const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');
const { autoUpdater } = require('electron-updater');
const { MinecraftLauncher } = require('./main/minecraft/launcher');
const { ProfileManager } = require('./main/minecraft/profiles');
const { CacheManager } = require('./main/minecraft/cache');
const { offline } = require('./main/minecraft/auth');

app.setName('Impulse');
app.setPath('userData', path.join(app.getPath('appData'), 'Impulse'));

const store = new Store({ name: 'impulse' });
let mainWindow = null;

function impulseIconPath() {
  return path.join(__dirname, '..', 'assets', 'icon.png');
}

function impulseWindowIcon() {
  return nativeImage.createFromPath(impulseIconPath());
}

function getImpulseMinecraftPath() {
  switch (os.platform()) {
    case 'win32':
      return path.join(os.homedir(), 'AppData', 'Roaming', 'Impulse', 'minecraft');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Impulse', 'minecraft');
    default:
      return path.join(os.homedir(), '.impulse', 'minecraft');
  }
}

function initializeDefaults() {
  if (!store.get('minecraftPath')) store.set('minecraftPath', getImpulseMinecraftPath());
  if (!store.get('javaPath')) store.set('javaPath', null);
  if (!store.get('minMemory')) store.set('minMemory', 1024);
  if (!store.get('maxMemory')) store.set('maxMemory', 4096);
  if (!store.get('downloadSettings')) {
    store.set('downloadSettings', {
      concurrentDownloads: 32,
      connectionsPerHost: 32,
      timeout: 120000
    });
  }
  if (!store.get('servers')) store.set('servers', []);
  if (!store.get('clientToken')) store.set('clientToken', uuidv4());
  if (!store.get('minecraftAccounts')) store.set('minecraftAccounts', []);
}

async function ensureDirectories(minecraftPath) {
  const dirs = [
    minecraftPath,
    path.join(minecraftPath, 'versions'),
    path.join(minecraftPath, 'libraries'),
    path.join(minecraftPath, 'assets'),
    path.join(minecraftPath, 'profiles'),
    path.join(minecraftPath, 'cache')
  ];
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    title: 'Impulse',
    icon: impulseIconPath(),
    backgroundColor: '#000000',
    frame: false,
    titleBarStyle: 'default',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  const url = process.env.NODE_ENV === 'development'
    ? 'http://localhost:5188'
    : `file://${path.join(__dirname, '../dist/index.html')}`;
  mainWindow.loadURL(url);
  if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createLauncher() {
  const settings = store.get('downloadSettings') || {};
  return new MinecraftLauncher({
    concurrentDownloads: Math.max(1, Number(settings.concurrentDownloads) || 32),
    connectionsPerHost: Math.max(1, Number(settings.connectionsPerHost) || 32),
    timeout: Math.max(30000, Number(settings.timeout) || 120000),
    retryLimit: 5
  });
}

function serverKey(address, port, manifestPort) {
  return crypto
    .createHash('sha1')
    .update(`${address}:${port}:${manifestPort}`)
    .digest('hex')
    .slice(0, 16);
}

function parseServerAddress(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a server IP or hostname.');
  const bracketMatch = raw.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketMatch) {
    return { host: bracketMatch[1], port: Number(bracketMatch[2] || 25565) };
  }
  const parts = raw.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: Number(parts[1]) };
  }
  return { host: raw, port: 25565 };
}

function varInt(value) {
  const out = [];
  let val = value >>> 0;
  do {
    let temp = val & 0x7f;
    val >>>= 7;
    if (val !== 0) temp |= 0x80;
    out.push(temp);
  } while (val !== 0);
  return Buffer.from(out);
}

function readVarInt(buffer, offset = 0) {
  let numRead = 0;
  let result = 0;
  let read;
  do {
    if (offset + numRead >= buffer.length) return null;
    read = buffer[offset + numRead];
    result |= (read & 0x7f) << (7 * numRead);
    numRead += 1;
    if (numRead > 5) throw new Error('VarInt is too big');
  } while ((read & 0x80) !== 0);
  return { value: result, bytes: numRead };
}

function packet(id, payloadParts = []) {
  const payload = Buffer.concat([varInt(id), ...payloadParts]);
  return Buffer.concat([varInt(payload.length), payload]);
}

function stringPart(value) {
  const data = Buffer.from(String(value), 'utf8');
  return Buffer.concat([varInt(data.length), data]);
}

function ushort(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function flattenDescription(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenDescription).join('');
  if (typeof value === 'object') {
    return [
      value.text,
      value.translate,
      ...(Array.isArray(value.extra) ? value.extra : [])
    ].map(flattenDescription).join('');
  }
  return String(value);
}

function cleanDescriptionText(value) {
  return flattenDescription(value)
    .replace(/\s*\[impulse:\d{1,5}]\s*/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const clean = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(clean)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(clean)) return false;
  return fallback;
}

function menuSkinValue(value) {
  return String(value || '').trim().toLowerCase() === 'classic' ? 'classic' : 'default';
}

function extractImpulseManifestPort(status) {
  const direct = validPort(status?.impulse?.manifestPort)
    || validPort(status?.impulse?.manifest_port)
    || validPort(status?.impulseManifestPort);
  if (direct) return direct;

  const searchable = [
    flattenDescription(status?.description),
    JSON.stringify(status?.impulse || {}),
    JSON.stringify(status?.modinfo || {})
  ].join(' ');
  const patterns = [
    /\[impulse:(\d{1,5})]/i,
    /impulse[-_\s]*(?:manifest[-_\s]*)?port\s*[:=]\s*(\d{1,5})/i,
    /manifest[-_\s]*port\s*[:=]\s*(\d{1,5})/i
  ];

  for (const pattern of patterns) {
    const match = searchable.match(pattern);
    const port = match ? validPort(match[1]) : null;
    if (port) return port;
  }
  return null;
}

function pingMinecraftServer(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const chunks = [];
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.on('timeout', () => finish({ online: false, error: 'Server ping timed out' }));
    socket.on('error', (error) => finish({ online: false, error: error.message }));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      try {
        const packetLength = readVarInt(data, 0);
        if (!packetLength || data.length < packetLength.bytes + packetLength.value) return;
        let offset = packetLength.bytes;
        const packetId = readVarInt(data, offset);
        if (!packetId) return;
        offset += packetId.bytes;
        const jsonLength = readVarInt(data, offset);
        if (!jsonLength) return;
        offset += jsonLength.bytes;
        const json = data.slice(offset, offset + jsonLength.value).toString('utf8');
        const status = JSON.parse(json);
        const impulseManifestPort = extractImpulseManifestPort(status);
        finish({
          online: true,
          version: status.version?.name || null,
          protocol: status.version?.protocol || null,
          impulseManifestPort,
          players: {
            online: status.players?.online || 0,
            max: status.players?.max || 0
          },
          description: cleanDescriptionText(status.description) || null
        });
      } catch (error) {
        finish({ online: false, error: error.message });
      }
    });
    socket.connect(port, host, () => {
      const handshake = packet(0, [varInt(47), stringPart(host), ushort(port), varInt(1)]);
      const request = packet(0);
      socket.write(Buffer.concat([handshake, request]));
    });
  });
}

function absoluteManifestUrl(host, manifestPort, value, fallbackPath = '') {
  if (!value) return null;
  const raw = String(value);
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (isWildcardHost(url.hostname)) {
        url.hostname = host;
        if (!url.port) url.port = String(manifestPort);
      }
      return url.toString();
    } catch {
      return raw;
    }
  }
  const prefix = `http://${host}:${manifestPort}`;
  if (raw.startsWith('/')) return `${prefix}${raw}`;
  return `${prefix}${fallbackPath}/${raw}`;
}

function isWildcardHost(value) {
  const host = String(value || '').trim().toLowerCase();
  return host === '0.0.0.0' || host === '::' || host === '[::]' || host === '';
}

function normalizeManifest(manifest, host, port, manifestPort) {
  const server = manifest.server || {};
  const minecraft = manifest.minecraft || {};
  const menu = manifest.menu || {};
  if (!minecraft.version) throw new Error('Manifest is missing minecraft.version');
  if (!minecraft.loader_version) throw new Error('Manifest is missing minecraft.loader_version');
  const loader = String(minecraft.loader || 'forge').trim().toLowerCase();
  if (!['forge', 'neoforge'].includes(loader)) {
    throw new Error(`Unsupported Minecraft loader "${minecraft.loader}". Supported loaders: forge, neoforge.`);
  }
  const mods = Array.isArray(manifest.mods) ? manifest.mods : [];
  return {
    manifest_version: Number(manifest.manifest_version || 1),
    name: String(manifest.name || host),
    description: String(manifest.description || ''),
    icon_url: absoluteManifestUrl(host, manifestPort, manifest.icon_url, ''),
    banner_url: absoluteManifestUrl(host, manifestPort, manifest.banner_url, ''),
    video_background_url: absoluteManifestUrl(host, manifestPort, manifest.video_background_url, ''),
    server: {
      address: isWildcardHost(server.address) ? host : (server.address || host),
      port: Number(server.port || port || 25565),
      auto_connect: server.auto_connect !== false
    },
    minecraft: {
      version: String(minecraft.version),
      loader,
      loader_version: String(minecraft.loader_version)
    },
    menu: {
      enabled: boolValue(menu.enabled, true),
      skin: menuSkinValue(menu.skin ?? manifest.skin),
      title: String(menu.title || 'IMPULSE'),
      subtitle: String(menu.subtitle || 'A focused way into your server'),
      hide_server_name_from_play_button: boolValue(
        menu.hide_server_name_from_play_button ?? menu.hideServerNameFromPlayButton,
        false
      )
    },
    mods: mods
      .map((mod) => ({
        name: String(mod.name || mod.file_name || 'mod'),
        file_name: String(mod.file_name || mod.name || 'mod.jar'),
        download_url: absoluteManifestUrl(host, manifestPort, mod.download_url, '/impulse/mods'),
        sha1: mod.sha1 ? String(mod.sha1).toLowerCase() : null,
        size: Number(mod.size || 0),
        required: mod.required !== false,
        source: mod.source || 'url'
      }))
  };
}

async function fetchManifest(host, port, manifestPort) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const url = `http://${host}:${manifestPort}/impulse/server.json`;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'ImpulseLauncher/0.1' }
    });
    if (!response.ok) throw new Error(`Manifest returned HTTP ${response.status}`);
    return normalizeManifest(await response.json(), host, port, manifestPort);
  } finally {
    clearTimeout(timeout);
  }
}

function getServers() {
  return store.get('servers') || [];
}

function setServers(servers) {
  store.set('servers', servers);
}

const MS_DEFAULT_CLIENT_ID = '00000000402b5328';
const MS_REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const MS_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const MS_SCOPE = 'XboxLive.signin offline_access';

function getMicrosoftClientId() {
  return String(store.get('microsoftClientId') || process.env.IMPULSE_MICROSOFT_CLIENT_ID || MS_DEFAULT_CLIENT_ID);
}

function getMicrosoftAuthUrl() {
  const params = new URLSearchParams({
    client_id: getMicrosoftClientId(),
    response_type: 'code',
    redirect_uri: MS_REDIRECT_URI,
    scope: MS_SCOPE,
    prompt: 'select_account'
  });
  return `https://login.live.com/oauth20_authorize.srf?${params.toString()}`;
}

async function openMicrosoftAuthWindow() {
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 520,
      height: 700,
      title: 'Sign in with Microsoft',
      icon: impulseIconPath(),
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      try {
        callback();
      } finally {
        if (!authWindow.isDestroyed()) authWindow.destroy();
      }
    };
    const handleUrl = (url) => {
      if (!String(url).startsWith(MS_REDIRECT_URI)) return;
      finish(() => {
        const params = new URL(url).searchParams;
        const code = params.get('code');
        const error = params.get('error_description') || params.get('error');
        if (code) resolve(code);
        else reject(new Error(error || 'Microsoft sign-in was cancelled.'));
      });
    };

    authWindow.webContents.on('will-navigate', (_event, url) => handleUrl(url));
    authWindow.webContents.on('will-redirect', (_event, url) => handleUrl(url));
    authWindow.webContents.on('did-navigate', (_event, url) => handleUrl(url));
    authWindow.on('closed', () => {
      if (!settled) {
        settled = true;
        reject(new Error('Microsoft sign-in window was closed.'));
      }
    });
    authWindow.loadURL(getMicrosoftAuthUrl());
  });
}

async function exchangeMicrosoftCode(authCode) {
  const response = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: getMicrosoftClientId(),
      code: authCode,
      redirect_uri: MS_REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Microsoft token exchange failed: ${await response.text()}`);
  }
  return response.json();
}

async function refreshMicrosoftToken(refreshToken) {
  const response = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: getMicrosoftClientId(),
      refresh_token: refreshToken,
      redirect_uri: MS_REDIRECT_URI,
      grant_type: 'refresh_token',
      scope: MS_SCOPE,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Microsoft refresh failed: ${await response.text()}`);
  }
  return response.json();
}

async function createMinecraftAccountFromMicrosoftToken(msToken, existingAccount = null) {
  const { MicrosoftAuthenticator, MojangClient } = require('@xmcl/user');
  const msAuth = new MicrosoftAuthenticator({ fetch });
  const mojang = new MojangClient({ fetch });

  const { minecraftXstsResponse } = await msAuth.acquireXBoxToken(msToken.access_token);
  const uhs = minecraftXstsResponse.DisplayClaims.xui[0].uhs;
  const xstsToken = minecraftXstsResponse.Token;
  const mcAuth = await msAuth.loginMinecraftWithXBox(uhs, xstsToken);
  const profile = await mojang.getProfile(mcAuth.access_token);
  const now = Date.now();
  const expiresAt = new Date(now + Number(mcAuth.expires_in || 86400) * 1000).toISOString();

  return {
    id: existingAccount?.id || uuidv4(),
    username: profile.name,
    uuid: profile.id,
    type: 'microsoft',
    accessToken: mcAuth.access_token,
    microsoftRefreshToken: msToken.refresh_token || existingAccount?.microsoftRefreshToken || null,
    minecraftExpiresAt: expiresAt,
    created_at: existingAccount?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function sanitizeAccount(account) {
  if (!account) return null;
  const { accessToken, microsoftRefreshToken, ...safe } = account;
  return safe;
}

function setActiveAuthFromAccount(account) {
  store.set('authData', {
    type: account.type,
    username: account.username,
    uuid: account.uuid,
    accessToken: account.accessToken || '',
    minecraftExpiresAt: account.minecraftExpiresAt || null,
    accountId: account.id,
    offline: account.type === 'offline',
  });
}

async function refreshActiveMicrosoftAccountIfNeeded() {
  const authData = store.get('authData');
  if (!authData || authData.type !== 'microsoft') return authData;

  const expiresAt = authData.minecraftExpiresAt ? new Date(authData.minecraftExpiresAt).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() > 5 * 60 * 1000) return authData;

  const accounts = store.get('minecraftAccounts') || [];
  const existingIndex = accounts.findIndex((account) => account.id === authData.accountId || account.uuid === authData.uuid);
  const existing = existingIndex >= 0 ? accounts[existingIndex] : null;
  if (!existing?.microsoftRefreshToken) {
    throw new Error('Your Microsoft session expired. Sign in with Microsoft again.');
  }

  const refreshedMsToken = await refreshMicrosoftToken(existing.microsoftRefreshToken);
  const refreshedAccount = await createMinecraftAccountFromMicrosoftToken(refreshedMsToken, existing);
  accounts[existingIndex] = refreshedAccount;
  store.set('minecraftAccounts', accounts);
  setActiveAuthFromAccount(refreshedAccount);
  return store.get('authData');
}

async function discoverServer(input, manifestPort = null) {
  const parsed = parseServerAddress(input);
  const port = Number(parsed.port || 25565);
  const status = await pingMinecraftServer(parsed.host, port);
  const resolvedManifestPort = validPort(manifestPort)
    || validPort(status.impulseManifestPort)
    || 25850;
  const manifest = await fetchManifest(parsed.host, port, resolvedManifestPort);
  const id = serverKey(parsed.host, port, resolvedManifestPort);
  return {
    id,
    host: parsed.host,
    port,
    manifestPort: resolvedManifestPort,
    status,
    manifest,
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    profileId: `impulse-${id}`
  };
}

function forgeLaunchVersion(mcVersion, forgeVersion) {
  const normalized = forgeVersion.includes('-') ? forgeVersion : `${mcVersion}-${forgeVersion}`;
  return normalized.replace(/^(\d[\d.]+)-(\d.*)$/, '$1-forge-$2');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveForgeLaunchVersion(minecraftPath, mcVersion, forgeVersion, installedId = null) {
  const candidates = [
    installedId,
    forgeLaunchVersion(mcVersion, forgeVersion),
    `${mcVersion}-Forge${forgeVersion}-${mcVersion}`,
    `${mcVersion}-forge-${forgeVersion}-${mcVersion}`,
    `${mcVersion}-Forge${forgeVersion}`,
    `${mcVersion}-forge-${forgeVersion}`,
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    const jsonPath = path.join(minecraftPath, 'versions', candidate, `${candidate}.json`);
    if (await fileExists(jsonPath)) return candidate;
  }

  const versionsDir = path.join(minecraftPath, 'versions');
  const entries = await fs.readdir(versionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!/forge/i.test(id) || !id.includes(mcVersion) || !id.includes(forgeVersion)) continue;
    const jsonPath = path.join(versionsDir, id, `${id}.json`);
    try {
      const data = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
      if (data.inheritsFrom === mcVersion || data.id === id) return id;
    } catch {
      // Keep looking.
    }
  }

  throw new Error(
    `Forge ${forgeVersion} for Minecraft ${mcVersion} installed, but no launchable version JSON was found. ` +
    `Checked: ${candidates.join(', ')}`
  );
}

async function resolveNeoForgeLaunchVersion(minecraftPath, mcVersion, neoForgeVersion, installedId = null) {
  const candidates = [
    installedId,
    `neoforge-${neoForgeVersion}`,
    `${mcVersion}-neoforge-${neoForgeVersion}`,
    `${mcVersion}-NeoForge-${neoForgeVersion}`,
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    const jsonPath = path.join(minecraftPath, 'versions', candidate, `${candidate}.json`);
    if (await fileExists(jsonPath)) return candidate;
  }

  const versionsDir = path.join(minecraftPath, 'versions');
  const entries = await fs.readdir(versionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!/neoforge/i.test(id) || !id.includes(neoForgeVersion)) continue;
    const jsonPath = path.join(versionsDir, id, `${id}.json`);
    try {
      const data = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
      const body = JSON.stringify(data).toLowerCase();
      if (id.includes(mcVersion) || data.inheritsFrom === mcVersion || body.includes(`minecraft:${mcVersion}`)) return id;
    } catch {
      // Keep looking.
    }
  }

  throw new Error(
    `NeoForge ${neoForgeVersion} for Minecraft ${mcVersion} installed, but no launchable version JSON was found. ` +
    `Checked: ${candidates.join(', ')}`
  );
}

async function createOrSyncProfile(minecraftPath, serverEntry) {
  const profileManager = new ProfileManager(minecraftPath);
  const manifest = serverEntry.manifest;
  const localManifest = {
    manifest_version: manifest.manifest_version,
    name: manifest.name,
    server_description: manifest.description,
    banner_url: manifest.banner_url,
    video_background_url: manifest.video_background_url,
    server: manifest.server,
    minecraft: manifest.minecraft,
    menu: manifest.menu,
    mods: manifest.mods,
    allow_user_mods: false,
    resourcePacks: [],
    shaderPacks: []
  };

  try {
    await profileManager.getProfile(serverEntry.profileId);
    await profileManager.applyServerManifest(serverEntry.profileId, localManifest);
  } catch {
    await profileManager.createProfile({
      id: serverEntry.profileId,
      name: manifest.name,
      source: 'server',
      server_description: manifest.description,
      banner_url: manifest.banner_url,
      video_background_url: manifest.video_background_url,
      server: manifest.server,
      minecraft: manifest.minecraft,
      menu: manifest.menu,
      mods: manifest.mods,
      allow_user_mods: false,
      manifest_version: manifest.manifest_version
    });
  }

  return profileManager.getProfile(serverEntry.profileId);
}

async function downloadProfileMods(event, minecraftPath, profile, profileId) {
  const cacheManager = new CacheManager(minecraftPath);
  const profileManager = new ProfileManager(minecraftPath);
  const mods = profile.mods || [];

  for (let i = 0; i < mods.length; i += 1) {
    const mod = mods[i];
    const label = mod.file_name || mod.name || 'mod.jar';
    const ext = path.extname(label) || '.jar';
    if (!mod.sha1) throw new Error(`The mod "${label}" is missing sha1.`);
    if (!mod.download_url) throw new Error(`The mod "${label}" is missing download_url.`);

    const cached = await cacheManager.hasFile('mods', mod.sha1, ext);
    if (cached) {
      const cachePath = cacheManager.getCachePath('mods', mod.sha1, ext);
      const valid = await cacheManager.verifyFileSha1(cachePath, mod.sha1).catch(() => false);
      if (valid) continue;
      await fs.rm(cachePath, { force: true });
    }

    event.sender.send('impulse-launch-progress', {
      status: 'downloading-mods',
      message: `Downloading mods (${i + 1}/${mods.length}): ${label}`,
      progress: 65 + Math.floor(((i + 1) / Math.max(mods.length, 1)) * 20),
      total: 100
    });
    await cacheManager.downloadAndStore('mods', mod.download_url, mod.sha1, ext);
  }

  const profileDir = profileManager.getProfileDir(profileId);
  const items = mods.map((mod) => ({
    category: 'mods',
    sha1: mod.sha1,
    ext: path.extname(mod.file_name || '') || '.jar',
    file_name: mod.file_name
  }));
  const syncResult = await cacheManager.syncProfileFiles(profileDir, items, {
    purgeCategories: true,
    categoriesToPurge: ['mods', 'resourcepacks', 'shaderpacks'],
    copyCategories: ['mods']
  });
  if (syncResult.failed > 0) {
    throw new Error(`Profile sync failed: ${syncResult.failed} cached file(s) missing. ${syncResult.errors.join('; ')}`);
  }

  for (const mod of mods) {
    const fileName = mod.file_name || mod.name || 'mod.jar';
    const profileModPath = path.join(profileDir, 'mods', fileName);
    const actual = await cacheManager.computeFileSha1(profileModPath).catch((error) => {
      throw new Error(`Downloaded mod is missing from profile: ${fileName} (${error.message})`);
    });
    if (actual.toLowerCase() !== String(mod.sha1).toLowerCase()) {
      throw new Error(`Profile mod SHA1 mismatch for ${fileName}: expected ${mod.sha1}, got ${actual}`);
    }
  }

  event.sender.send('impulse-launch-progress', {
    status: 'mods-ready',
    message: mods.length ? `Synced ${mods.length} mod(s).` : 'No server mods to sync.',
    progress: 86,
    total: 100
  });
}

async function launchServer(event, serverId) {
  const minecraftPath = store.get('minecraftPath');
  await ensureDirectories(minecraftPath);
  const servers = getServers();
  const server = servers.find((entry) => entry.id === serverId);
  if (!server) throw new Error('Server not found.');

  const authData = await refreshActiveMicrosoftAccountIfNeeded();
  if (!authData) throw new Error('Log in with an offline username before launching.');

  event.sender.send('impulse-launch-progress', {
    status: 'syncing',
    message: 'Refreshing server manifest...',
    progress: 5,
    total: 100
  });
  const refreshed = await discoverServer(`${server.host}:${server.port}`, server.manifestPort);
  const merged = { ...server, ...refreshed, addedAt: server.addedAt };
  setServers(servers.map((entry) => (entry.id === serverId ? merged : entry)));

  const profile = await createOrSyncProfile(minecraftPath, merged);
  const launcher = createLauncher();
  const { version, loader = 'forge', loader_version: loaderVersion } = profile.minecraft;

  event.sender.send('impulse-launch-progress', {
    status: 'installing',
    message: `Installing Minecraft ${version}...`,
    progress: 10,
    total: 100
  });
  await launcher.installMinecraft({
    version,
    minecraftPath,
    progressCallback: (data) => event.sender.send('impulse-launch-progress', data)
  });

  const loaderLabel = loader === 'neoforge' ? 'NeoForge' : 'Forge';
  event.sender.send('impulse-launch-progress', {
    status: loader,
    message: `Installing ${loaderLabel} ${loaderVersion}...`,
    progress: 45,
    total: 100
  });
  let launchVersion;
  if (loader === 'neoforge') {
    const installedNeoForgeVersion = await launcher.manager.installNeoForge(version, loaderVersion, minecraftPath, (data) => {
      event.sender.send('impulse-launch-progress', data);
    });
    launchVersion = await resolveNeoForgeLaunchVersion(minecraftPath, version, loaderVersion, installedNeoForgeVersion);
  } else {
    const installedForgeVersion = await launcher.manager.installForge(version, loaderVersion, minecraftPath, (data) => {
      event.sender.send('impulse-launch-progress', data);
    });
    launchVersion = await resolveForgeLaunchVersion(minecraftPath, version, loaderVersion, installedForgeVersion);
  }
  console.log(`Using ${loaderLabel} launch version: ${launchVersion}`);

  await downloadProfileMods(event, minecraftPath, profile, merged.profileId);

  event.sender.send('impulse-launch-progress', {
    status: 'launching',
    message: 'Launching Minecraft...',
    progress: 100,
    total: 100
  });

  const profileManager = new ProfileManager(minecraftPath);
  const profileDir = profileManager.getProfileDir(merged.profileId);
  const autoConnect = profile.server?.auto_connect;
  const extraJvmArgs = ['-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8'];
  if (profile.server?.address) {
    const impulseServerName = merged.manifest?.name || profile.name || profile.server?.address || 'Impulse Server';
    extraJvmArgs.push('-Dimpulse.client=true');
    extraJvmArgs.push(`-Dimpulse.server.name=${impulseServerName}`);
    extraJvmArgs.push(`-Dimpulse.menu.enabled=${boolValue(profile.menu?.enabled, true)}`);
    extraJvmArgs.push(`-Dimpulse.menu.skin=${menuSkinValue(profile.menu?.skin)}`);
    extraJvmArgs.push(`-Dimpulse.menu.title=${profile.menu?.title || 'IMPULSE'}`);
    extraJvmArgs.push(`-Dimpulse.menu.subtitle=${profile.menu?.subtitle || 'A focused way into your server'}`);
    extraJvmArgs.push(`-Dimpulse.menu.hide_server_name_from_play_button=${boolValue(profile.menu?.hide_server_name_from_play_button ?? profile.menu?.hideServerNameFromPlayButton, false)}`);
    if (autoConnect) {
      extraJvmArgs.push('-Dimpulse.auto_connect=true');
      extraJvmArgs.push(`-Dimpulse.server.address=${profile.server.address}`);
      extraJvmArgs.push(`-Dimpulse.server.port=${Number(profile.server.port || 25565)}`);
    }
  }
  const proc = await launcher.launchMinecraft({
    version: launchVersion,
    minecraftPath,
    javaPath: store.get('javaPath') || null,
    username: authData.username,
    uuid: authData.uuid,
    accessToken: authData.accessToken || '',
    maxMemory: profile.jvm?.max_memory || store.get('maxMemory') || 4096,
    minMemory: profile.jvm?.min_memory || store.get('minMemory') || 1024,
    extraJvmArgs,
    detached: true,
    gameDir: profileDir,
    serverAddress: autoConnect ? profile.server.address : null,
    serverPort: autoConnect ? profile.server.port : null
  });

  await profileManager.updateProfile(merged.profileId, {
    last_played_at: new Date().toISOString()
  });

  proc.on('close', (code) => {
    event.sender.send('impulse-game-closed', {
      code,
      serverId,
      logPath: proc.logPath,
      diagnosticsDir: proc.diagnosticsDir
    });
  });
  proc.on('error', (error) => {
    event.sender.send('impulse-launch-error', {
      error: error.message,
      serverId,
      logPath: proc.logPath,
      diagnosticsDir: proc.diagnosticsDir
    });
  });

  console.log(`Minecraft log: ${proc.logPath}`);
  console.log(`Impulse launch diagnostics: ${proc.diagnosticsDir}`);
  event.sender.send('impulse-launched', {
    serverId,
    message: 'Minecraft launched.',
    logPath: proc.logPath,
    diagnosticsDir: proc.diagnosticsDir
  });
  return { success: true };
}

initializeDefaults();

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(impulseWindowIcon());
  }
  createWindow();
  setupAutoUpdater();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (!mainWindow) createWindow();
});

ipcMain.handle('offline-login', async (_event, username) => {
  const clean = String(username || '').trim();
  if (!clean) return { success: false, error: 'Username is required.' };
  const user = offline(clean);
  const accounts = store.get('minecraftAccounts') || [];
  const existingIndex = accounts.findIndex((account) => account.type === 'offline' && account.username.toLowerCase() === clean.toLowerCase());
  const account = {
    id: existingIndex >= 0 ? accounts[existingIndex].id : uuidv4(),
    type: 'offline',
    username: user.name,
    uuid: user.id,
    accessToken: user.id,
    offline: true,
    created_at: existingIndex >= 0 ? accounts[existingIndex].created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (existingIndex >= 0) accounts[existingIndex] = account;
  else accounts.push(account);
  store.set('minecraftAccounts', accounts);
  setActiveAuthFromAccount(account);
  return { success: true, user: store.get('authData') };
});

ipcMain.handle('get-current-user', async () => {
  const user = store.get('authData');
  return user ? { success: true, user } : { success: false, error: 'Not logged in' };
});

ipcMain.handle('logout', async () => {
  store.delete('authData');
  return { success: true };
});

ipcMain.handle('get-minecraft-accounts', async () => {
  const accounts = store.get('minecraftAccounts') || [];
  return accounts.map(sanitizeAccount);
});

ipcMain.handle('set-active-minecraft-account', async (_event, accountId) => {
  const accounts = store.get('minecraftAccounts') || [];
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) return { success: false, error: 'Account not found.' };
  setActiveAuthFromAccount(account);
  return { success: true, user: store.get('authData') };
});

ipcMain.handle('remove-minecraft-account', async (_event, accountId) => {
  const accounts = store.get('minecraftAccounts') || [];
  const next = accounts.filter((entry) => entry.id !== accountId);
  if (next.length === accounts.length) return { success: false, error: 'Account not found.' };
  store.set('minecraftAccounts', next);
  const current = store.get('authData');
  if (current?.accountId === accountId) store.delete('authData');
  return { success: true, accounts: next.map(sanitizeAccount) };
});

ipcMain.handle('microsoft-login', async () => {
  try {
    const authCode = await openMicrosoftAuthWindow();
    const msToken = await exchangeMicrosoftCode(authCode);
    const accounts = store.get('minecraftAccounts') || [];
    const accountDraft = await createMinecraftAccountFromMicrosoftToken(msToken);
    const existingIndex = accounts.findIndex((entry) => entry.uuid === accountDraft.uuid);
    const account = existingIndex >= 0
      ? {
          ...accountDraft,
          id: accounts[existingIndex].id,
          created_at: accounts[existingIndex].created_at,
        }
      : accountDraft;
    if (existingIndex >= 0) accounts[existingIndex] = account;
    else accounts.push(account);
    store.set('minecraftAccounts', accounts);
    setActiveAuthFromAccount(account);
    return { success: true, user: store.get('authData'), account: sanitizeAccount(account) };
  } catch (error) {
    console.error('Microsoft login failed:', error);
    return { success: false, error: error.message || 'Microsoft login failed.' };
  }
});

ipcMain.handle('impulse-list-servers', async () => getServers());

ipcMain.handle('impulse-add-server', async (_event, payload) => {
  const entry = await discoverServer(payload.address, payload.manifestPort || null);
  const servers = getServers();
  const next = [entry, ...servers.filter((server) => server.id !== entry.id)];
  setServers(next);
  return { success: true, server: entry, servers: next };
});

ipcMain.handle('impulse-refresh-server', async (_event, serverId) => {
  const servers = getServers();
  const existing = servers.find((server) => server.id === serverId);
  if (!existing) return { success: false, error: 'Server not found.' };
  const refreshed = await discoverServer(`${existing.host}:${existing.port}`);
  const merged = { ...existing, ...refreshed, addedAt: existing.addedAt };
  const next = servers.map((server) => (server.id === serverId ? merged : server));
  setServers(next);
  return { success: true, server: merged, servers: next };
});

ipcMain.handle('impulse-remove-server', async (_event, serverId) => {
  const next = getServers().filter((server) => server.id !== serverId);
  setServers(next);
  return { success: true, servers: next };
});

ipcMain.handle('impulse-launch-server', async (event, serverId) => {
  try {
    return await launchServer(event, serverId);
  } catch (error) {
    event.sender.send('impulse-launch-error', { error: error.message, serverId });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-launcher-settings', async () => ({
  minecraftPath: store.get('minecraftPath'),
  javaPath: store.get('javaPath'),
  minMemory: store.get('minMemory'),
  maxMemory: store.get('maxMemory'),
  downloadSettings: store.get('downloadSettings')
}));

ipcMain.handle('update-launcher-settings', async (_event, settings) => {
  for (const [key, value] of Object.entries(settings || {})) {
    if (value !== undefined) store.set(key, value);
  }
  return { success: true };
});

ipcMain.on('minimize-window', () => mainWindow?.minimize());
ipcMain.on('maximize-window', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('close-window', () => mainWindow?.close());

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', payload);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  let isStartupCheck = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ status: 'checking', startup: isStartupCheck });
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ status: 'available', version: info.version, startup: isStartupCheck });
    if (isStartupCheck) autoUpdater.downloadUpdate().catch(() => {});
  });

  autoUpdater.on('update-not-available', () => {
    isStartupCheck = false;
    sendUpdateStatus({ status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      status: 'downloading',
      startup: isStartupCheck,
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const wasStartup = isStartupCheck;
    isStartupCheck = false;
    sendUpdateStatus({ status: 'ready', version: info.version, startup: wasStartup });
    if (wasStartup) setTimeout(() => autoUpdater.quitAndInstall(), 1500);
  });

  autoUpdater.on('error', (error) => {
    isStartupCheck = false;
    sendUpdateStatus({ status: 'error', message: error.message });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);

  setInterval(() => {
    isStartupCheck = false;
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30 * 60 * 1000);
}

ipcMain.handle('update-check', () => autoUpdater.checkForUpdates().catch(() => {}));
ipcMain.handle('update-download', () => autoUpdater.downloadUpdate().catch(() => {}));
ipcMain.handle('update-install', () => autoUpdater.quitAndInstall());
ipcMain.handle('get-app-version', () => app.getVersion());
