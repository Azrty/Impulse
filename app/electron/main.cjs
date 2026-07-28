const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const net = require('net');
const http = require('http');
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
let activeGame = null;
let DiscordRPC = null;
try {
  DiscordRPC = require('discord-rpc');
} catch (error) {
  console.warn('Discord RPC package is unavailable:', error.message);
}

const DEFAULT_DISCORD_RPC_SETTINGS = {
  enabled: true,
  clientId: process.env.IMPULSE_DISCORD_CLIENT_ID || '1531038946409320539',
  showServer: true,
  showAddress: false,
  showDimension: true,
  showLoader: true,
  showElapsed: true,
  privacyMode: false
};
const DISCORD_IMPULSE_LARGE_IMAGE_KEY = String(process.env.IMPULSE_DISCORD_LARGE_IMAGE_KEY || 'impulse').trim();
const SERVER_OFFLINE_MESSAGE = 'The server is offline';
const SERVER_OFFLINE_CARD = {
  offlineKind: 'server',
  title: 'This server seems to be offline',
  description: 'Your internet connection is working, but Impulse cannot reach this Minecraft server right now. Try again later or contact the server owner.'
};
const INTERNET_OFFLINE_CARD = {
  offlineKind: 'internet',
  title: "It seems like you're offline",
  description: 'Impulse cannot reach the server or confirm your internet connection. Check your network, VPN, firewall, or Wi-Fi and try again.'
};

let discordRpcClient = null;
let discordRpcClientId = null;
let discordRpcReady = false;
let discordRpcConnecting = null;
let discordCrashTimer = null;
let updaterDownloadPromise = null;

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

function normalizeJavaRuntime(value, javaPath = store.get('javaPath')) {
  if (value === 'custom') return 'custom';
  if (value === 'auto') return 'auto';
  if (value === undefined || value === null || value === '') return javaPath ? 'custom' : 'auto';
  return 'auto';
}

function initializeDefaults() {
  if (!store.get('minecraftPath')) store.set('minecraftPath', getImpulseMinecraftPath());
  if (!store.get('javaPath')) store.set('javaPath', null);
  const javaRuntime = normalizeJavaRuntime(store.get('javaRuntime'));
  if (store.get('javaRuntime') !== javaRuntime) store.set('javaRuntime', javaRuntime);
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
  const discordRpc = normalizeDiscordRpcSettings(store.get('discordRpc'));
  if (!discordRpc.userConfigured) discordRpc.enabled = true;
  store.set('discordRpc', discordRpc);
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

async function clearImpulseGameFiles(minecraftPath) {
  const root = path.resolve(minecraftPath || getImpulseMinecraftPath());
  if (root === path.parse(root).root || root === path.resolve(os.homedir())) {
    throw new Error('Refusing to clear an unsafe Minecraft path.');
  }
  const targets = [
    'versions',
    'libraries',
    'assets',
    'profiles',
    'cache',
    'logs',
    'crash-reports',
    'jdks',
    'launcher_profiles.json'
  ];
  const cleared = [];

  for (const target of targets) {
    const targetPath = path.resolve(root, target);
    if (targetPath !== root && targetPath.startsWith(root + path.sep)) {
      await fs.rm(targetPath, { recursive: true, force: true });
      cleared.push(target);
    }
  }

  await ensureDirectories(root);
  return cleared;
}

async function readTextTail(filePath, maxBytes = 60000) {
  if (!filePath) return '';
  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8').trim();
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function normalizeDiscordRpcSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const hasEnabled = Object.prototype.hasOwnProperty.call(source, 'enabled');
  return {
    enabled: hasEnabled ? source.enabled === true : DEFAULT_DISCORD_RPC_SETTINGS.enabled,
    clientId: String(source.clientId || DEFAULT_DISCORD_RPC_SETTINGS.clientId || '').trim(),
    showServer: source.showServer !== false,
    showAddress: source.showAddress === true,
    showDimension: source.showDimension !== false,
    showLoader: source.showLoader !== false,
    showElapsed: source.showElapsed !== false,
    privacyMode: source.privacyMode === true,
    userConfigured: source.userConfigured === true
  };
}

function discordRpcSettings() {
  return normalizeDiscordRpcSettings(store.get('discordRpc'));
}

async function ensureDiscordRpcClient(settings = discordRpcSettings()) {
  const normalized = normalizeDiscordRpcSettings(settings);
  if (!normalized.enabled || !normalized.clientId || !DiscordRPC) return null;
  if (discordRpcReady && discordRpcClient && discordRpcClientId === normalized.clientId) return discordRpcClient;
  if (discordRpcConnecting && discordRpcClientId === normalized.clientId) return discordRpcConnecting;

  await destroyDiscordRpcClient();
  discordRpcClientId = normalized.clientId;
  discordRpcClient = new DiscordRPC.Client({ transport: 'ipc' });
  discordRpcReady = false;
  discordRpcConnecting = discordRpcClient.login({ clientId: normalized.clientId })
    .then(() => {
      discordRpcReady = true;
      return discordRpcClient;
    })
    .catch((error) => {
      console.warn('Discord RPC unavailable:', error.message || error);
      discordRpcReady = false;
      discordRpcClient = null;
      discordRpcClientId = null;
      return null;
    })
    .finally(() => {
      discordRpcConnecting = null;
    });
  return discordRpcConnecting;
}

async function destroyDiscordRpcClient() {
  if (!discordRpcClient) return;
  const client = discordRpcClient;
  discordRpcClient = null;
  discordRpcClientId = null;
  discordRpcReady = false;
  try {
    await client.clearActivity();
  } catch {}
  try {
    client.destroy();
  } catch {}
}

function discordImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function buildDiscordAssets(context = {}, settings = discordRpcSettings()) {
  if (settings.privacyMode === true) return {};
  const serverName = context.serverName || 'Impulse Server';
  const largeImageKey = discordImageUrl(context.serverBannerUrl) || DISCORD_IMPULSE_LARGE_IMAGE_KEY || null;
  const smallImageKey = discordImageUrl(context.serverIconUrl);
  const assets = {};
  if (largeImageKey) {
    assets.largeImageKey = largeImageKey;
    assets.largeImageText = context.serverBannerUrl ? serverName : 'Impulse';
  }
  if (smallImageKey) {
    assets.smallImageKey = smallImageKey;
    assets.smallImageText = serverName;
  }
  return assets;
}

function serverRpcImages(serverOrManifest) {
  const manifest = serverOrManifest?.manifest || serverOrManifest || {};
  return {
    serverIconUrl: discordImageUrl(manifest.icon_url),
    serverBannerUrl: discordImageUrl(manifest.banner_url)
  };
}

function buildLauncherActivity(label, context = {}, settings = discordRpcSettings()) {
  const serverName = context.serverName || 'Impulse';
  const phase = String(label || 'browsing').toLowerCase();
  const assets = buildDiscordAssets(context, settings);
  if (phase === 'syncing') {
    return {
      details: 'In the launcher',
      state: `Syncing ${serverName}`,
      startTimestamp: context.startedAt ? new Date(context.startedAt) : new Date(),
      ...assets,
      instance: false
    };
  }
  if (phase === 'connecting') {
    return {
      details: `Connecting to ${serverName}`,
      state: 'Starting Minecraft',
      startTimestamp: context.startedAt ? new Date(context.startedAt) : new Date(),
      ...assets,
      instance: false
    };
  }
  if (phase === 'crashed') {
    return {
      details: 'Minecraft crashed',
      state: serverName,
      startTimestamp: context.startedAt ? new Date(context.startedAt) : new Date(),
      ...assets,
      instance: false
    };
  }
  return {
    details: 'In the launcher',
    state: 'Browsing servers',
    startTimestamp: context.startedAt ? new Date(context.startedAt) : new Date(),
    instance: false
  };
}

function buildGameActivity(payload = {}, context = {}, settings = discordRpcSettings()) {
  const privacy = settings.privacyMode === true;
  const serverName = payload.serverName || context.serverName || 'Impulse Server';
  const serverAddress = payload.serverAddress || context.serverAddress || '';
  const minecraft = payload.minecraft || context.minecraft || '';
  const loader = payload.loader || context.loader || '';
  const loaderLine = [minecraft, loader].filter(Boolean).join(' ');
  const stateValue = String(payload.state || 'playing').toLowerCase();
  const dimension = payload.dimension || '';
  const startedAt = Number(payload.startedAt || context.startedAt || Date.now());
  const onServer = payload.onServer !== false;
  const details = privacy
    ? 'Playing Impulse'
    : stateValue === 'menu'
      ? 'In the Impulse menu'
      : stateValue === 'connecting'
        ? `Connecting to ${settings.showServer ? serverName : 'server'}`
        : onServer
          ? `Playing ${settings.showServer ? serverName : 'Impulse'}`
          : 'Playing Singleplayer';
  const stateParts = [];
  if (!privacy && settings.showDimension && dimension) stateParts.push(dimension);
  if (!privacy && settings.showAddress && serverAddress) stateParts.push(serverAddress);
  if (settings.showLoader && loaderLine) stateParts.push(loaderLine);

  return {
    details,
    state: stateParts.join(' • ') || (privacy ? 'In game' : 'In game'),
    startTimestamp: settings.showElapsed ? new Date(startedAt) : undefined,
    ...buildDiscordAssets(context, settings),
    instance: false
  };
}

async function setDiscordActivity(activity, settings = discordRpcSettings()) {
  if (discordCrashTimer) {
    clearTimeout(discordCrashTimer);
    discordCrashTimer = null;
  }
  const client = await ensureDiscordRpcClient(settings);
  if (!client || !discordRpcReady) return;
  try {
    await client.setActivity(activity);
  } catch (error) {
    console.warn('Failed to update Discord RPC:', error.message || error);
  }
}

function updateLauncherDiscordActivity(label, context = {}) {
  const settings = discordRpcSettings();
  if (!settings.enabled) return;
  setDiscordActivity(buildLauncherActivity(label, context, settings), settings).catch(() => {});
}

function updateGameDiscordActivity(payload, context, settings) {
  if (!settings.enabled) return;
  setDiscordActivity(buildGameActivity(payload, context, settings), settings).catch(() => {});
}

function clearDiscordActivitySoon() {
  if (discordCrashTimer) clearTimeout(discordCrashTimer);
  discordCrashTimer = setTimeout(() => {
    destroyDiscordRpcClient().catch(() => {});
    discordCrashTimer = null;
  }, 30000);
}

async function createRpcBridge(context, settings) {
  const normalized = normalizeDiscordRpcSettings(settings);
  if (!normalized.enabled) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/rpc') {
      response.writeHead(404);
      response.end();
      return;
    }
    const auth = request.headers.authorization || '';
    const headerToken = request.headers['x-impulse-rpc-token'] || '';
    if (auth !== `Bearer ${token}` && headerToken !== token) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8192) request.destroy();
    });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const summary = `${payload.state || 'unknown'}:${payload.screen || ''}:${payload.dimension || ''}:${payload.onServer}`;
        if (context.lastRpcSummary !== summary) {
          context.lastRpcSummary = summary;
          console.log(`[Impulse RPC] ${summary}`);
        }
        updateGameDiscordActivity(payload, context, normalized);
        response.writeHead(204);
        response.end();
      } catch (error) {
        response.writeHead(400);
        response.end('Invalid JSON');
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
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
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    const wantsDevTools = input.type === 'keyDown' && (
      key === 'f12'
      || (key === 'i' && input.shift && (input.control || input.meta) && (process.platform !== 'darwin' || input.alt))
    );
    if (!wantsDevTools) return;
    event.preventDefault();
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
    } else {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });
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

function getNetworkTimeout(defaultTimeout = 120000) {
  const settings = store.get('downloadSettings') || {};
  return Math.max(30000, Number(settings.timeout) || defaultTimeout);
}

function getModDownloadConcurrency() {
  const settings = store.get('downloadSettings') || {};
  return Math.max(1, Math.min(8, Number(settings.concurrentDownloads) || 4));
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
  if (raw.startsWith('/')) return `${prefix}${encodeRelativeUrlPath(raw)}`;
  return `${prefix}${fallbackPath}/${encodeRelativeUrlPath(raw)}`;
}

function encodeRelativeUrlPath(value) {
  return String(value || '')
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join('/');
}

function safeManifestFileName(value, fallback = 'mod.jar') {
  const normalized = String(value || fallback).replace(/\\/g, '/');
  const fileName = path.basename(normalized).trim();
  return fileName || fallback;
}

function normalizeManifestMod(mod, host, manifestPort, fallbackPath, requiredFallback) {
  const fileName = safeManifestFileName(mod.file_name || mod.name || 'mod.jar');
  return {
    name: String(mod.name || fileName || 'mod'),
    description: String(mod.description || ''),
    file_name: fileName,
    download_url: absoluteManifestUrl(host, manifestPort, mod.download_url, fallbackPath),
    sha1: mod.sha1 ? String(mod.sha1).toLowerCase() : null,
    size: Number(mod.size || 0),
    required: mod.required !== undefined ? mod.required !== false : requiredFallback,
    source: mod.source || 'url'
  };
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
  const optionalMods = Array.isArray(manifest.optional_mods) ? manifest.optional_mods : [];
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
      ),
      singleplayer_enabled: boolValue(
        menu.singleplayer_enabled ?? menu.singleplayerEnabled,
        false
      ),
      multiplayer_enabled: boolValue(
        menu.multiplayer_enabled ?? menu.multiplayerEnabled,
        false
      )
    },
    mods: mods.map((mod) => normalizeManifestMod(mod, host, manifestPort, '/impulse/mods', true)),
    optional_mods: optionalMods.map((mod) => normalizeManifestMod(mod, host, manifestPort, '/impulse/optional-mods', false))
  };
}

async function fetchManifest(host, port, manifestPort, timeoutMs = getNetworkTimeout()) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `http://${host}:${manifestPort}/impulse/server.json`;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'ImpulseLauncher/0.1' }
    });
    if (!response.ok) throw new Error(`Manifest returned HTTP ${response.status}`);
    return normalizeManifest(await response.json(), host, port, manifestPort);
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
      throw new Error(`Manifest request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSavedServer(server) {
  const host = String(server?.host || server?.manifest?.server?.address || '').trim();
  const port = Number(server?.port || server?.manifest?.server?.port || 25565);
  const manifestPort = Number(server?.manifestPort || 25850);
  const id = String(server?.id || (host ? serverKey(host, port, manifestPort) : uuidv4()));
  return {
    ...server,
    id,
    host,
    port,
    manifestPort,
    profileId: server?.profileId || `impulse-${id}`,
    status: server?.status || { online: false, error: SERVER_OFFLINE_MESSAGE },
    manifest: server?.manifest || { mods: [], optional_mods: [] }
  };
}

function getServers() {
  return (store.get('servers') || []).map((server) => reconcileOptionalMods(normalizeSavedServer(server), false));
}

function setServers(servers) {
  store.set('servers', (servers || []).map(normalizeSavedServer));
}

function serverOfflineError(server = null) {
  const error = new Error(SERVER_OFFLINE_MESSAGE);
  error.code = 'SERVER_OFFLINE';
  if (server) error.server = server;
  if (server?.offlineDetails) error.offlineDetails = server.offlineDetails;
  return error;
}

function isServerOfflineError(error) {
  return error?.code === 'SERVER_OFFLINE' || error?.message === SERVER_OFFLINE_MESSAGE;
}

function offlineServerEntry(server, status = {}) {
  return {
    ...server,
    status: {
      ...status,
      online: false,
      error: SERVER_OFFLINE_MESSAGE
    },
    updatedAt: new Date().toISOString()
  };
}

async function checkInternetConnection(timeoutMs = 3000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://checkip.amazonaws.com', {
      signal: controller.signal,
      headers: { Accept: 'text/plain', 'User-Agent': 'ImpulseLauncher/0.1' }
    });
    if (!response.ok) return false;
    return Boolean((await response.text()).trim());
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function offlineDetails() {
  return (await checkInternetConnection()) ? SERVER_OFFLINE_CARD : INTERNET_OFFLINE_CARD;
}

async function emitServerOffline(event, progress = 0) {
  const details = await offlineDetails();
  event?.sender?.send('impulse-launch-progress', {
    status: 'server-offline',
    message: SERVER_OFFLINE_MESSAGE,
    progress,
    total: 100,
    details
  });
  return details;
}

function saveServerEntry(serverId, updatedServer) {
  const servers = getServers();
  const next = servers.map((entry) => (entry.id === serverId ? reconcileOptionalMods(updatedServer, false) : entry));
  setServers(next);
  return next.find((entry) => entry.id === serverId) || updatedServer;
}

function markServerOffline(serverId, server, status = {}) {
  return saveServerEntry(serverId, offlineServerEntry(server, status));
}

async function assertServerOnline(server, event = null, progress = 4) {
  event?.sender?.send('impulse-launch-progress', {
    status: 'checking-server',
    message: 'Checking server status...',
    progress,
    total: 100
  });
  const status = await pingMinecraftServer(server.host, server.port);
  if (!status.online) {
    const updated = markServerOffline(server.id, server, status);
    updated.offlineDetails = await emitServerOffline(event, 0);
    throw serverOfflineError(updated);
  }
  return status;
}

function optionalModKey(mod) {
  return String(mod?.sha1 || mod?.file_name || mod?.name || '').toLowerCase();
}

function optionalModSignature(manifest) {
  const optionalMods = Array.isArray(manifest?.optional_mods) ? manifest.optional_mods : [];
  const payload = optionalMods
    .map((mod) => `${optionalModKey(mod)}:${safeManifestFileName(mod.file_name || mod.name || 'mod.jar')}:${mod.size || 0}`)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function reconcileOptionalMods(server, markPrompted = false) {
  const optionalMods = Array.isArray(server?.manifest?.optional_mods) ? server.manifest.optional_mods : [];
  const signature = optionalModSignature(server.manifest);
  const existing = server.optionalModSelections || {};
  const nextSelections = {};
  for (const mod of optionalMods) {
    const key = optionalModKey(mod);
    if (!key) continue;
    nextSelections[key] = existing[key] === true;
  }
  return {
    ...server,
    optionalModSelections: nextSelections,
    optionalModSignature: signature,
    optionalModPromptedSignature: markPrompted ? signature : (server.optionalModPromptedSignature || null)
  };
}

function optionalModsNeedPrompt(server) {
  const optionalMods = Array.isArray(server?.manifest?.optional_mods) ? server.manifest.optional_mods : [];
  return optionalMods.length > 0 && server.optionalModPromptedSignature !== optionalModSignature(server.manifest);
}

function selectedOptionalMods(server) {
  const selections = server.optionalModSelections || {};
  return (server.manifest?.optional_mods || [])
    .filter((mod) => selections[optionalModKey(mod)] === true)
    .map((mod) => ({ ...mod, required: false }));
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
  const xboxIdentity = minecraftXstsResponse.DisplayClaims.xui[0];
  const uhs = xboxIdentity.uhs;
  const xuid = xboxIdentity.xid || '';
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
    xuid: xuid || mcAuth.username || '',
    clientId: existingAccount?.clientId || uuidv4(),
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
    xuid: account.xuid || '',
    clientId: account.clientId || account.id || '',
    userType: account.type === 'microsoft' ? 'msa' : 'legacy',
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

async function discoverServer(input, manifestPort = null, event = null) {
  const parsed = parseServerAddress(input);
  const port = Number(parsed.port || 25565);
  const knownManifestPort = validPort(manifestPort);
  const status = await pingMinecraftServer(parsed.host, port);
  if (!status.online) {
    const offline = {
      host: parsed.host,
      port,
      status: offlineServerEntry({ host: parsed.host, port }, status).status
    };
    if (event) offline.offlineDetails = await emitServerOffline(event, 0);
    throw serverOfflineError(offline);
  }
  const resolvedManifestPort = knownManifestPort
    || validPort(status.impulseManifestPort)
    || 25850;
  let manifest;
  try {
    manifest = await fetchManifest(parsed.host, port, resolvedManifestPort);
  } catch (error) {
    const recheck = await pingMinecraftServer(parsed.host, port);
    if (!recheck.online) {
      const offline = {
        host: parsed.host,
        port,
        status: offlineServerEntry({ host: parsed.host, port }, recheck).status
      };
      if (event) offline.offlineDetails = await emitServerOffline(event, 0);
      throw serverOfflineError(offline);
    }
    throw error;
  }
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

async function refreshSavedServer(existing, options = {}) {
  const status = await pingMinecraftServer(existing.host, existing.port);
  if (!status.online) {
    const offline = offlineServerEntry(existing, status);
    if (options.event) offline.offlineDetails = await emitServerOffline(options.event, 0);
    if (options.strict) throw serverOfflineError(offline);
    return offline;
  }

  let manifest;
  try {
    manifest = await fetchManifest(existing.host, existing.port, existing.manifestPort, options.timeout || 10000);
  } catch (error) {
    const recheck = await pingMinecraftServer(existing.host, existing.port);
    if (!recheck.online) {
      const offline = offlineServerEntry(existing, recheck);
      if (options.event) offline.offlineDetails = await emitServerOffline(options.event, 0);
      if (options.strict) throw serverOfflineError(offline);
      return offline;
    }
    throw error;
  }

  return {
    ...existing,
    status,
    manifest,
    updatedAt: new Date().toISOString()
  };
}

function hasUsableManifest(server) {
  return !!server?.manifest?.minecraft?.version
    && !!server?.manifest?.minecraft?.loader_version
    && Array.isArray(server?.manifest?.mods);
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
  const enabledOptionalMods = selectedOptionalMods(serverEntry);
  const profileMods = [
    ...(manifest.mods || []).map((mod) => ({ ...mod, required: true })),
    ...enabledOptionalMods
  ];
  const localManifest = {
    manifest_version: manifest.manifest_version,
    name: manifest.name,
    server_description: manifest.description,
    banner_url: manifest.banner_url,
    video_background_url: manifest.video_background_url,
    server: manifest.server,
    minecraft: manifest.minecraft,
    menu: manifest.menu,
    mods: profileMods,
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
      mods: profileMods,
      allow_user_mods: false,
      manifest_version: manifest.manifest_version
    });
  }

  return profileManager.getProfile(serverEntry.profileId);
}

async function downloadProfileMods(event, minecraftPath, profile, serverEntry) {
  const cacheManager = new CacheManager(minecraftPath);
  const profileManager = new ProfileManager(minecraftPath);
  const mods = profile.mods || [];
  const profileId = serverEntry.profileId;
  const timeout = getNetworkTimeout();
  const concurrency = Math.min(getModDownloadConcurrency(), Math.max(mods.length, 1));
  const downloads = [];

  for (let i = 0; i < mods.length; i += 1) {
    const mod = mods[i];
    const label = safeManifestFileName(mod.file_name || mod.name || 'mod.jar');
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

    downloads.push({ mod, label, ext });
  }

  let completed = mods.length - downloads.length;
  const sendDownloadProgress = (label) => {
    event.sender.send('impulse-launch-progress', {
      status: 'downloading-mods',
      message: downloads.length
        ? `Downloading mods (${Math.min(completed + 1, mods.length)}/${mods.length}): ${label}`
        : `Using cached mods (${completed}/${mods.length}).`,
      progress: 65 + Math.floor((completed / Math.max(mods.length, 1)) * 20),
      total: 100
    });
  };

  if (downloads.length) sendDownloadProgress(downloads[0].label);

  let cursor = 0;
  async function worker() {
    while (cursor < downloads.length) {
      const current = downloads[cursor++];
      sendDownloadProgress(current.label);
      let failed = false;
      try {
        await cacheManager.downloadAndStore('mods', current.mod.download_url, current.mod.sha1, current.ext, {
          timeout,
          attempts: 3,
          retryDelays: [500, 1500, 3000],
          onRetry: ({ attempt, maxAttempts }) => {
            event.sender.send('impulse-launch-progress', {
              status: 'retrying-download',
              message: `Retrying ${current.label} (attempt ${attempt}/${maxAttempts})...`,
              progress: 65 + Math.floor((completed / Math.max(mods.length, 1)) * 20),
              total: 100
            });
          }
        });
      } catch (error) {
        failed = true;
        const status = await pingMinecraftServer(serverEntry.host, serverEntry.port);
        if (!status.online) {
          const updated = markServerOffline(serverEntry.id, serverEntry, status);
          updated.offlineDetails = await emitServerOffline(event, 0);
          throw serverOfflineError(updated);
        }
        throw new Error(`Failed to download mod "${current.label}" from ${current.mod.download_url}: ${error.message}`);
      } finally {
        completed += 1;
        if (!failed) sendDownloadProgress(current.label);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const profileDir = profileManager.getProfileDir(profileId);
  const items = mods.map((mod) => ({
    category: 'mods',
    sha1: mod.sha1,
    ext: path.extname(safeManifestFileName(mod.file_name || mod.name || 'mod.jar')) || '.jar',
    file_name: safeManifestFileName(mod.file_name || mod.name || 'mod.jar')
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
    const fileName = safeManifestFileName(mod.file_name || mod.name || 'mod.jar');
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

async function verifyLaunchReadiness(event, minecraftPath, profile, serverEntry, launchVersion, loader, loaderVersion) {
  const cacheManager = new CacheManager(minecraftPath);
  const profileManager = new ProfileManager(minecraftPath);
  const profileDir = profileManager.getProfileDir(serverEntry.profileId);
  const profileModsDir = path.join(profileDir, 'mods');
  const loaderLabel = loader === 'neoforge' ? 'NeoForge' : 'Forge';

  event.sender.send('impulse-launch-progress', {
    status: 'verifying-launch',
    message: 'Verifying launch files...',
    progress: 88,
    total: 100
  });

  if (!launchVersion) {
    throw new Error(`Launch check failed: ${loaderLabel} ${loaderVersion} is not installed correctly`);
  }

  const versionJsonPath = path.join(minecraftPath, 'versions', launchVersion, `${launchVersion}.json`);
  let versionData;
  try {
    versionData = JSON.parse(await fs.readFile(versionJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Launch check failed: ${loaderLabel} ${loaderVersion} is not installed correctly (${error.message})`);
  }

  const versionBody = JSON.stringify(versionData).toLowerCase();
  const loaderNeedle = String(loader || 'forge').toLowerCase();
  const versionNeedle = String(loaderVersion || '').toLowerCase();
  if (!String(launchVersion).toLowerCase().includes(loaderNeedle) && !versionBody.includes(loaderNeedle)) {
    throw new Error(`Launch check failed: ${loaderLabel} ${loaderVersion} is not installed correctly`);
  }
  if (versionNeedle && !String(launchVersion).toLowerCase().includes(versionNeedle) && !versionBody.includes(versionNeedle)) {
    throw new Error(`Launch check failed: ${loaderLabel} ${loaderVersion} is not installed correctly`);
  }

  const expectedMods = (profile.mods || []).map((mod) => ({
    fileName: safeManifestFileName(mod.file_name || mod.name || 'mod.jar'),
    sha1: String(mod.sha1 || '').toLowerCase()
  }));
  const expectedNames = new Set(expectedMods.map((mod) => mod.fileName));

  let actualEntries = [];
  try {
    actualEntries = await fs.readdir(profileModsDir, { withFileTypes: true });
  } catch {
    if (expectedMods.length) throw new Error(`Launch check failed: missing mods directory for ${serverEntry.profileId}`);
  }

  const actualModFiles = actualEntries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name);

  for (const mod of expectedMods) {
    const modPath = path.join(profileModsDir, mod.fileName);
    try {
      await fs.access(modPath);
    } catch {
      throw new Error(`Launch check failed: missing mod ${mod.fileName}`);
    }
    if (!mod.sha1) throw new Error(`Launch check failed: missing SHA1 for ${mod.fileName}`);
    const actualSha1 = await cacheManager.computeFileSha1(modPath).catch((error) => {
      throw new Error(`Launch check failed: unable to read ${mod.fileName} (${error.message})`);
    });
    if (actualSha1.toLowerCase() !== mod.sha1) {
      throw new Error(`Launch check failed: SHA1 mismatch for ${mod.fileName}`);
    }
  }

  for (const fileName of actualModFiles) {
    if (!expectedNames.has(fileName)) {
      throw new Error(`Launch check failed: unexpected stale mod ${fileName}`);
    }
  }

  event.sender.send('impulse-launch-progress', {
    status: 'verifying-launch',
    message: 'Launch files verified.',
    progress: 92,
    total: 100
  });
}

async function launchServer(event, serverId) {
  if (activeGame) {
    throw new Error('Minecraft is already running.');
  }
  const minecraftPath = store.get('minecraftPath');
  await ensureDirectories(minecraftPath);
  const servers = getServers();
  const server = servers.find((entry) => entry.id === serverId);
  if (!server) throw new Error('Server not found.');

  const authData = await refreshActiveMicrosoftAccountIfNeeded();
  if (!authData) throw new Error('Log in with an offline username before launching.');
  const rpcSettings = discordRpcSettings();
  const serverDisplayName = server.manifest?.name || server.host || 'Impulse Server';
  updateLauncherDiscordActivity('syncing', {
    serverName: serverDisplayName,
    ...serverRpcImages(server)
  });

  let merged = server;
  const recentlyRefreshed = hasUsableManifest(server)
    && server.status?.online === true
    && Date.now() - new Date(server.updatedAt || 0).getTime() < 15000;

  event.sender.send('impulse-launch-progress', {
    status: 'checking-server',
    message: recentlyRefreshed ? 'Checking server status...' : 'Refreshing server manifest...',
    progress: 5,
    total: 100
  });

  try {
    if (recentlyRefreshed) {
      const status = await assertServerOnline(server, event, 5);
      merged = saveServerEntry(serverId, {
        ...server,
        status,
        updatedAt: new Date().toISOString()
      });
    } else {
      merged = reconcileOptionalMods(await refreshSavedServer(server, { strict: true, timeout: getNetworkTimeout(), event }), false);
      merged = saveServerEntry(serverId, merged);
    }
  } catch (error) {
    if (isServerOfflineError(error) && error.server) saveServerEntry(serverId, error.server);
    throw error;
  }

  const profile = await createOrSyncProfile(minecraftPath, merged);
  const launcher = createLauncher();
  const { version, loader = 'forge', loader_version: loaderVersion } = profile.minecraft;
  const profileServerName = merged.manifest?.name || profile.name || profile.server?.address || serverDisplayName;
  const profileServerImages = serverRpcImages(merged);

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
  let launchVersion;
  if (loader === 'neoforge') {
    launchVersion = await resolveNeoForgeLaunchVersion(minecraftPath, version, loaderVersion).catch(() => null);
    if (launchVersion) {
      event.sender.send('impulse-launch-progress', {
        status: loader,
        message: `${loaderLabel} ${loaderVersion} already installed.`,
        progress: 45,
        total: 100
      });
    } else {
      event.sender.send('impulse-launch-progress', {
        status: loader,
        message: `Installing ${loaderLabel} ${loaderVersion}...`,
        progress: 45,
        total: 100
      });
      const installedNeoForgeVersion = await launcher.manager.installNeoForge(version, loaderVersion, minecraftPath, (data) => {
        event.sender.send('impulse-launch-progress', data);
      });
      launchVersion = await resolveNeoForgeLaunchVersion(minecraftPath, version, loaderVersion, installedNeoForgeVersion);
    }
  } else {
    launchVersion = await resolveForgeLaunchVersion(minecraftPath, version, loaderVersion).catch(() => null);
    if (launchVersion) {
      event.sender.send('impulse-launch-progress', {
        status: loader,
        message: `${loaderLabel} ${loaderVersion} already installed.`,
        progress: 45,
        total: 100
      });
    } else {
      event.sender.send('impulse-launch-progress', {
        status: loader,
        message: `Installing ${loaderLabel} ${loaderVersion}...`,
        progress: 45,
        total: 100
      });
      const installedForgeVersion = await launcher.manager.installForge(version, loaderVersion, minecraftPath, (data) => {
        event.sender.send('impulse-launch-progress', data);
      });
      launchVersion = await resolveForgeLaunchVersion(minecraftPath, version, loaderVersion, installedForgeVersion);
    }
  }
  console.log(`Using ${loaderLabel} launch version: ${launchVersion}`);

  updateLauncherDiscordActivity('syncing', {
    serverName: profileServerName,
    ...profileServerImages
  });
  await downloadProfileMods(event, minecraftPath, profile, merged);
  await verifyLaunchReadiness(event, minecraftPath, profile, merged, launchVersion, loader, loaderVersion);
  await assertServerOnline(merged, event, 94);

  const profileManager = new ProfileManager(minecraftPath);
  const profileDir = profileManager.getProfileDir(merged.profileId);

  event.sender.send('impulse-launch-progress', {
    status: 'launching',
    message: 'Launching Minecraft...',
    progress: 100,
    total: 100
  });

  const autoConnect = profile.server?.auto_connect;
  const extraJvmArgs = ['-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8'];
  let rpcBridge = null;
  let rpcFallbackTimer = null;
  const rpcStartedAt = Date.now();
  if (profile.server?.address) {
    extraJvmArgs.push('-Dimpulse.client=true');
    extraJvmArgs.push(`-Dimpulse.server.name=${profileServerName}`);
    extraJvmArgs.push(`-Dimpulse.minecraft.version=${version}`);
    extraJvmArgs.push(`-Dimpulse.minecraft.loader=${loaderLabel}`);
    extraJvmArgs.push(`-Dimpulse.menu.enabled=${boolValue(profile.menu?.enabled, true)}`);
    extraJvmArgs.push(`-Dimpulse.menu.skin=${menuSkinValue(profile.menu?.skin)}`);
    extraJvmArgs.push(`-Dimpulse.menu.title=${profile.menu?.title || 'IMPULSE'}`);
    extraJvmArgs.push(`-Dimpulse.menu.subtitle=${profile.menu?.subtitle || 'A focused way into your server'}`);
    extraJvmArgs.push(`-Dimpulse.menu.hide_server_name_from_play_button=${boolValue(profile.menu?.hide_server_name_from_play_button ?? profile.menu?.hideServerNameFromPlayButton, false)}`);
    extraJvmArgs.push(`-Dimpulse.menu.singleplayer_enabled=${boolValue(profile.menu?.singleplayer_enabled ?? profile.menu?.singleplayerEnabled, false)}`);
    extraJvmArgs.push(`-Dimpulse.menu.multiplayer_enabled=${boolValue(profile.menu?.multiplayer_enabled ?? profile.menu?.multiplayerEnabled, false)}`);
    const rpcContext = {
      serverName: profileServerName,
      serverAddress: `${profile.server.address}:${Number(profile.server.port || 25565)}`,
      ...profileServerImages,
      minecraft: version,
      loader: loaderLabel,
      startedAt: rpcStartedAt
    };
    rpcBridge = await createRpcBridge(rpcContext, rpcSettings).catch((error) => {
      console.warn('Impulse RPC bridge could not start:', error.message || error);
      return null;
    });
    if (rpcBridge && rpcSettings.enabled) {
      rpcFallbackTimer = setTimeout(() => {
        if (!rpcContext.lastRpcSummary) {
          console.warn('[Impulse RPC] No in-game RPC updates received; falling back to launcher presence.');
          updateGameDiscordActivity({
            state: 'playing',
            screen: 'In Game',
            serverName: profileServerName,
            serverAddress: `${profile.server.address}:${Number(profile.server.port || 25565)}`,
            minecraft: version,
            loader: loaderLabel,
            startedAt: rpcStartedAt,
            onServer: true
          }, rpcContext, rpcSettings);
        }
      }, 45000);
    }
    extraJvmArgs.push(`-Dimpulse.rpc.enabled=${rpcSettings.enabled === true && rpcBridge ? 'true' : 'false'}`);
    extraJvmArgs.push(`-Dimpulse.rpc.show_server=${rpcSettings.showServer === true}`);
    extraJvmArgs.push(`-Dimpulse.rpc.show_address=${rpcSettings.showAddress === true}`);
    extraJvmArgs.push(`-Dimpulse.rpc.show_dimension=${rpcSettings.showDimension === true}`);
    extraJvmArgs.push(`-Dimpulse.rpc.show_loader=${rpcSettings.showLoader === true}`);
    extraJvmArgs.push(`-Dimpulse.rpc.show_elapsed=${rpcSettings.showElapsed === true}`);
    extraJvmArgs.push(`-Dimpulse.rpc.privacy_mode=${rpcSettings.privacyMode === true}`);
    if (rpcBridge) {
      extraJvmArgs.push(`-Dimpulse.rpc.bridge_port=${rpcBridge.port}`);
      extraJvmArgs.push(`-Dimpulse.rpc.bridge_token=${rpcBridge.token}`);
      extraJvmArgs.push(`-Dimpulse.rpc.started_at=${rpcStartedAt}`);
    }
    if (autoConnect) {
      extraJvmArgs.push('-Dimpulse.auto_connect=true');
      extraJvmArgs.push(`-Dimpulse.server.address=${profile.server.address}`);
      extraJvmArgs.push(`-Dimpulse.server.port=${Number(profile.server.port || 25565)}`);
    }
  }
  updateLauncherDiscordActivity('connecting', {
    serverName: profileServerName,
    ...profileServerImages
  });
  let proc;
  try {
    proc = await launcher.launchMinecraft({
    version: launchVersion,
    minecraftPath,
    javaRuntime: normalizeJavaRuntime(store.get('javaRuntime')),
    javaPath: store.get('javaPath') || null,
    loader,
    progressCallback: (data) => event.sender.send('impulse-launch-progress', data),
    username: authData.username,
    uuid: authData.uuid,
    accessToken: authData.accessToken || '',
    userType: authData.userType || (authData.type === 'microsoft' ? 'msa' : 'legacy'),
    xuid: authData.xuid || '',
    clientId: authData.clientId || authData.accountId || '',
    maxMemory: profile.jvm?.max_memory || store.get('maxMemory') || 4096,
    minMemory: profile.jvm?.min_memory || store.get('minMemory') || 1024,
    extraJvmArgs,
    detached: true,
    gameDir: profileDir,
    serverAddress: autoConnect ? profile.server.address : null,
    serverPort: autoConnect ? profile.server.port : null
    });
  } catch (error) {
    if (rpcFallbackTimer) clearTimeout(rpcFallbackTimer);
    if (rpcBridge) await rpcBridge.close().catch(() => {});
    throw error;
  }
  activeGame = {
    serverId,
    pid: proc.pid,
    logPath: proc.logPath,
    diagnosticsDir: proc.diagnosticsDir,
    startedAt: new Date().toISOString(),
    rpcBridge,
    rpcFallbackTimer
  };

  proc.on('close', async (code, signal) => {
    if (activeGame?.serverId === serverId && activeGame?.pid === proc.pid) {
      activeGame = null;
    }
    if (rpcFallbackTimer) clearTimeout(rpcFallbackTimer);
    if (rpcBridge) await rpcBridge.close().catch(() => {});
    const crashed = code !== 0 && code !== null;
    if (crashed) {
      updateLauncherDiscordActivity('crashed', { serverName: profileServerName });
      clearDiscordActivitySoon();
    } else {
      destroyDiscordRpcClient().catch(() => {});
    }
    const crashLog = crashed ? await readTextTail(proc.logPath) : '';
    event.sender.send('impulse-game-closed', {
      code,
      signal,
      serverId,
      logPath: proc.logPath,
      diagnosticsDir: proc.diagnosticsDir,
      crashed,
      crashLog
    });
  });
  proc.on('error', (error) => {
    if (activeGame?.serverId === serverId && activeGame?.pid === proc.pid) {
      activeGame = null;
    }
    if (rpcFallbackTimer) clearTimeout(rpcFallbackTimer);
    if (rpcBridge) rpcBridge.close().catch(() => {});
    updateLauncherDiscordActivity('crashed', { serverName: profileServerName });
    clearDiscordActivitySoon();
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
    pid: proc.pid,
    logPath: proc.logPath,
    diagnosticsDir: proc.diagnosticsDir
  });

  profileManager.updateProfile(merged.profileId, {
    last_played_at: new Date().toISOString()
  }).catch((error) => {
    console.warn(`Failed to update last played profile timestamp for ${merged.profileId}:`, error);
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
  updateLauncherDiscordActivity('browsing');
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (!mainWindow) createWindow();
});
app.on('before-quit', () => {
  destroyDiscordRpcClient().catch(() => {});
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
  const entry = reconcileOptionalMods(await discoverServer(payload.address, payload.manifestPort || null), false);
  const servers = getServers();
  const next = [entry, ...servers.filter((server) => server.id !== entry.id)];
  setServers(next);
  return { success: true, server: entry, servers: next };
});

ipcMain.handle('impulse-refresh-server', async (_event, serverId) => {
  try {
    const servers = getServers();
    const existing = servers.find((server) => server.id === serverId);
    if (!existing) return { success: false, error: 'Server not found.' };
    const refreshed = reconcileOptionalMods(await refreshSavedServer(existing), false);
    if (refreshed.status?.online === false) {
      refreshed.offlineDetails = await offlineDetails();
    }
    const next = servers.map((server) => (server.id === serverId ? refreshed : server));
    setServers(next);
    return { success: true, server: refreshed, servers: next, details: refreshed.offlineDetails };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to refresh server manifest.' };
  }
});

ipcMain.handle('impulse-update-optional-mods', async (_event, serverId, selections, markPrompted = false) => {
  try {
    const servers = getServers();
    const existing = servers.find((server) => server.id === serverId);
    if (!existing) return { success: false, error: 'Server not found.' };
    const allowed = new Set((existing.manifest?.optional_mods || []).map(optionalModKey).filter(Boolean));
    const cleaned = {};
    for (const key of Object.keys(selections || {})) {
      const cleanKey = String(key).toLowerCase();
      if (allowed.has(cleanKey)) cleaned[cleanKey] = selections[key] === true;
    }
    const updated = reconcileOptionalMods({
      ...existing,
      optionalModSelections: cleaned
    }, markPrompted === true);
    const next = servers.map((server) => (server.id === serverId ? updated : server));
    setServers(next);
    return { success: true, server: updated, servers: next };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to update optional mods.' };
  }
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
    const details = isServerOfflineError(error) ? (error.offlineDetails || await offlineDetails()) : undefined;
    event.sender.send('impulse-launch-error', { error: error.message, serverId, details });
    return { success: false, error: error.message, details };
  }
});

ipcMain.handle('get-launcher-settings', async () => ({
  minecraftPath: store.get('minecraftPath'),
  javaRuntime: normalizeJavaRuntime(store.get('javaRuntime')),
  javaPath: store.get('javaPath'),
  minMemory: store.get('minMemory'),
  maxMemory: store.get('maxMemory'),
  downloadSettings: store.get('downloadSettings'),
  discordRpc: discordRpcSettings()
}));

ipcMain.handle('update-launcher-settings', async (_event, settings) => {
  for (const [key, value] of Object.entries(settings || {})) {
    if (value === undefined) continue;
    if (key === 'discordRpc') {
      const normalized = normalizeDiscordRpcSettings(value);
      normalized.userConfigured = true;
      store.set(key, normalized);
      if (!normalized.enabled) destroyDiscordRpcClient().catch(() => {});
      else updateLauncherDiscordActivity(activeGame ? 'connecting' : 'browsing');
    } else if (key === 'javaRuntime') {
      store.set(key, normalizeJavaRuntime(value));
    } else {
      store.set(key, value);
    }
  }
  return { success: true };
});

ipcMain.handle('clear-game-files', async () => {
  try {
    const minecraftPath = store.get('minecraftPath') || getImpulseMinecraftPath();
    const cleared = await clearImpulseGameFiles(minecraftPath);
    return { success: true, cleared };
  } catch (error) {
    return { success: false, error: error.message };
  }
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
  autoUpdater.autoInstallOnAppQuit = false;

  let isStartupCheck = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ status: 'checking', startup: isStartupCheck });
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ status: 'available', version: info.version, startup: isStartupCheck });
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
ipcMain.handle('update-download', async () => {
  if (updaterDownloadPromise) return updaterDownloadPromise;
  updaterDownloadPromise = autoUpdater.downloadUpdate()
    .catch((error) => {
      sendUpdateStatus({ status: 'error', message: error.message || String(error) });
      return null;
    })
    .finally(() => {
      updaterDownloadPromise = null;
    });
  return updaterDownloadPromise;
});
ipcMain.handle('update-install', () => autoUpdater.quitAndInstall(false, true));
ipcMain.handle('get-app-version', () => app.getVersion());
