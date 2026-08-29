const { app, BrowserWindow, Menu, ipcMain, nativeImage, shell, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const net = require('net');
const dns = require('dns').promises;
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
let activeLaunch = null;
const pendingDeepLinks = [];
const pendingCrashConsents = new Map();
const activeCrashUploads = new Set();
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
const UPDATE_FEED_URL = 'https://impulse.epivalent.com';
const IMPULSE_MOD_INDEX_URL = 'https://impulse.epivalent.com/mods/index.json';
const IMPULSE_RECOGNIZED_MODS_URL = 'https://api.impulsemc.com/v1/mod-verification/recognized-mods';
const IMPULSE_CURSEFORGE_VERIFICATION_URL = 'https://api.impulsemc.com/v1/mod-verification/curseforge';
const IMPULSE_BLOCKED_SERVERS_URL = 'https://api.impulsemc.com/v1/security/blocked-servers';
const MODRINTH_VERSION_FILES_URL = 'https://api.modrinth.com/v2/version_files';
const LEGAL_DOCUMENT_VERSION = '2026-08-20.2';
const PRIVACY_POLICY_URL = 'https://impulsemc.com/privacy/';
const TERMS_OF_SERVICE_URL = 'https://impulsemc.com/terms/';
const CRASH_REPORT_UPLOAD_LIMIT = 2 * 1024 * 1024;
const CRASH_REPORT_RETRY_DELAYS = [500, 1500, 3000];

let discordRpcClient = null;
let discordRpcClientId = null;
let discordRpcReady = false;
let discordRpcConnecting = null;
let discordCrashTimer = null;
let updaterDownloadPromise = null;
let consentDependentServicesStarted = false;
let officialImpulseReleasesCache = { expiresAt: 0, releases: [] };
const modVerificationCache = new Map();
let recognizedModsCache = { expiresAt: 0, mods: null };
let blockedServersCache = { expiresAt: 0, servers: null };

const SERVER_ACCESS_RESTRICTED_HEADING = 'Access to this server has been restricted by Impulse';
const SERVER_RESTRICTION_REASONS = {
  malware: ['Malicious software detected', 'This server has distributed files identified as malicious or harmful.'],
  credential_theft: ['Credential theft risk', 'This server has attempted to collect passwords, session tokens, account credentials, or other sensitive information.'],
  phishing_impersonation: ['Phishing or impersonation', 'This server has impersonated another service, project, or community in a way that could mislead players.'],
  compromised_server: ['Server infrastructure compromised', 'This server appears to be compromised and may distribute unauthorized files or content.'],
  unsafe_mod_distribution: ['Unsafe mod distribution', 'This server has distributed deceptive, tampered, or unauthorized mod files.'],
  fraud: ['Fraudulent activity', 'This server has been associated with scams, fraudulent transactions, or intentionally misleading offers.'],
  illegal_distribution: ['Unauthorized content distribution', 'This server has repeatedly distributed software or content without the required authorization.'],
  abusive_content: ['Severe abusive activity', 'This server has been restricted because of severe abuse that presents a risk to Impulse users.'],
  repeated_security_incidents: ['Repeated security incidents', 'This server has continued unsafe behavior after previous security incidents.'],
  policy_violation: ['Impulse security policy violation', 'This server has violated Impulse security requirements in a way that may put players at risk.']
};
const UNKNOWN_SERVER_RESTRICTION = ['Security restriction', 'Impulse has restricted access to this server because it may present a risk to players.'];

function normalizeUpdateChannel(value) {
  return value === 'beta' ? 'beta' : 'stable';
}

function updateChannel() {
  return normalizeUpdateChannel(store.get('updateChannel'));
}

function configureAutoUpdaterChannel(value = updateChannel()) {
  const channel = normalizeUpdateChannel(value);
  autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest';
  autoUpdater.allowDowngrade = channel === 'stable';
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_FEED_URL,
    channel: autoUpdater.channel
  });
  return channel;
}

function impulseIconPath() {
  return path.join(__dirname, '..', 'assets', 'icon.png');
}

function impulseWindowIcon() {
  return nativeImage.createFromPath(impulseIconPath());
}

function microphonePermissionStatus() {
  if (process.platform !== 'darwin') {
    return { supported: false, status: 'unsupported', granted: true };
  }
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    return { supported: true, status, granted: status === 'granted' };
  } catch (error) {
    return { supported: true, status: 'unknown', granted: false, error: error.message || String(error) };
  }
}

async function requestMicrophonePermission() {
  if (process.platform !== 'darwin') {
    return { supported: false, status: 'unsupported', granted: true };
  }
  const current = microphonePermissionStatus();
  if (current.granted || current.status === 'denied' || current.status === 'restricted') return current;
  try {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    const next = microphonePermissionStatus();
    return { ...next, granted: granted === true || next.granted };
  } catch (error) {
    return { supported: true, status: 'unknown', granted: false, error: error.message || String(error) };
  }
}

function modsNeedMicrophone(mods) {
  const haystack = (mods || [])
    .map((mod) => `${mod?.id || ''} ${mod?.name || ''} ${mod?.file_name || ''}`.toLowerCase())
    .join('\n');
  return haystack.includes('simple voice chat')
    || haystack.includes('simplevoicechat')
    || haystack.includes('voicechat')
    || haystack.includes('voice-chat');
}

async function ensureMicrophonePermissionForLaunch(event, profile) {
  if (process.platform !== 'darwin' || !modsNeedMicrophone(profile?.mods || [])) return microphonePermissionStatus();
  event.sender.send('impulse-launch-progress', {
    status: 'microphone-permission',
    message: 'Checking microphone permission...',
    progress: 96,
    total: 100
  });
  const result = await requestMicrophonePermission();
  if (!result.granted) {
    console.warn(`Microphone permission is ${result.status}. Voice chat mods may not be able to use the microphone.`);
    event.sender.send('impulse-launch-progress', {
      status: 'microphone-permission',
      message: 'Microphone permission was not granted. Voice chat may not work.',
      progress: 97,
      total: 100
    });
  }
  return result;
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

function isBareJavaCommand(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'java' || normalized === 'java.exe';
}

function normalizeJavaRuntime(value, javaPath = store.get('javaPath')) {
  if (value === 'custom') return isBareJavaCommand(javaPath) ? 'auto' : 'custom';
  if (value === 'auto') return 'auto';
  if (value === undefined || value === null || value === '') {
    return javaPath && !isBareJavaCommand(javaPath) ? 'custom' : 'auto';
  }
  return 'auto';
}

function initializeDefaults() {
  if (!store.get('minecraftPath')) store.set('minecraftPath', getImpulseMinecraftPath());
  if (isBareJavaCommand(store.get('javaPath'))) store.set('javaPath', null);
  if (!store.get('javaPath')) store.set('javaPath', null);
  const javaRuntime = normalizeJavaRuntime(store.get('javaRuntime'));
  if (store.get('javaRuntime') !== javaRuntime) store.set('javaRuntime', javaRuntime);
  if (!store.get('minMemory')) store.set('minMemory', 1024);
  if (!store.get('maxMemory')) store.set('maxMemory', 4096);
  store.set('updateChannel', normalizeUpdateChannel(store.get('updateChannel')));
  const previousDownloads = store.get('downloadSettings') || {};
  store.set('downloadSettings', {
    concurrentDownloads: Math.max(1, Math.min(8, Number(previousDownloads.concurrentDownloads) || 4)),
    connectionsPerHost: Math.max(1, Number(previousDownloads.connectionsPerHost) || 16),
    timeout: Math.max(30000, Number(previousDownloads.timeout) || 120000)
  });
  if (!store.get('servers')) store.set('servers', []);
  if (!store.get('clientToken')) store.set('clientToken', uuidv4());
  if (!store.get('minecraftAccounts')) store.set('minecraftAccounts', []);
  const discordRpc = normalizeDiscordRpcSettings(store.get('discordRpc'));
  if (!discordRpc.userConfigured) discordRpc.enabled = true;
  store.set('discordRpc', discordRpc);
}

function legalConsentStatus() {
  const acceptance = store.get('legalAcceptance') || {};
  return {
    accepted: acceptance.version === LEGAL_DOCUMENT_VERSION,
    requiredVersion: LEGAL_DOCUMENT_VERSION,
    acceptedAt: acceptance.acceptedAt || null,
    privacyUrl: PRIVACY_POLICY_URL,
    termsUrl: TERMS_OF_SERVICE_URL
  };
}

function requireLegalConsent() {
  if (!legalConsentStatus().accepted) {
    const error = new Error('Accept the Privacy Policy and Terms of Service before using Impulse.');
    error.code = 'LEGAL_CONSENT_REQUIRED';
    throw error;
  }
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

async function directorySize(root) {
  let total = 0;
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(filePath);
    else if (entry.isFile()) total += (await fs.stat(filePath).catch(() => ({ size: 0 }))).size;
  }
  return total;
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

function normalizeCrashSharingPreference(value) {
  return ['always', 'never'].includes(value) ? value : 'ask';
}

function crashReportsPendingDir() {
  return path.join(app.getPath('userData'), 'pending-crash-reports');
}

function pendingCrashReportPath(reportId) {
  const safeId = String(reportId || '').replace(/[^A-Za-z0-9-]/g, '');
  return path.join(crashReportsPendingDir(), `${safeId}.json`);
}

function sanitizeCrashText(value, secrets = []) {
  let text = String(value || '');
  const home = os.homedir();
  if (home) {
    text = text.split(home).join('<HOME>');
    text = text.split(home.replace(/\\/g, '\\\\')).join('<HOME>');
  }
  for (const secret of secrets.filter(Boolean)) {
    const clean = String(secret);
    if (clean.length >= 6) text = text.split(clean).join('<REDACTED>');
  }
  return text
    .replace(/(--accessToken(?:=|\s+))(?:"[^"]*"|\S+)/gi, '$1<REDACTED>')
    .replace(/("?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)"?\s*[:=]\s*)"?[A-Za-z0-9._~+\/-]{8,}"?/gi, '$1<REDACTED>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1<REDACTED>')
    .replace(/(XBL3\.0\s+x=)[^\s"']+/gi, '$1<REDACTED>');
}

function truncateUtf8(value, maximumBytes) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= maximumBytes) return buffer.toString('utf8');
  return `${buffer.subarray(0, Math.max(0, maximumBytes - 32)).toString('utf8')}\n[truncated by Impulse]`;
}

async function newestMinecraftCrashReport(profileDir, launchedAt) {
  const directory = path.join(profileDir, 'crash-reports');
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt')) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat && stat.mtimeMs >= Number(launchedAt || 0) - 5000) candidates.push({ filePath, fileName: entry.name, modified: stat.mtimeMs });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  if (!candidates[0]) return null;
  return {
    fileName: candidates[0].fileName,
    content: await readTextTail(candidates[0].filePath, 1536 * 1024)
  };
}

function fitCrashReportPayload(payload, maximumBytes) {
  const limit = Math.max(65536, Math.min(Number(maximumBytes) || CRASH_REPORT_UPLOAD_LIMIT, CRASH_REPORT_UPLOAD_LIMIT));
  payload.crash.minecraft_report = truncateUtf8(payload.crash.minecraft_report, Math.floor(limit * 0.68));
  payload.crash.launcher_log = truncateUtf8(payload.crash.launcher_log, Math.floor(limit * 0.24));
  let serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') <= limit) return payload;
  payload.crash.launcher_log = truncateUtf8(payload.crash.launcher_log, 32768);
  serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') <= limit) return payload;
  const overhead = Buffer.byteLength(serialized, 'utf8') - Buffer.byteLength(payload.crash.minecraft_report, 'utf8');
  payload.crash.minecraft_report = truncateUtf8(payload.crash.minecraft_report, Math.max(8192, limit - overhead - 512));
  return payload;
}

async function buildCrashReportPayload({ server, profile, profileDir, logPath, launchedAt, code, signal, authData, crashLog }) {
  const minecraftReport = await newestMinecraftCrashReport(profileDir, launchedAt);
  const secrets = [authData?.accessToken, authData?.microsoftRefreshToken];
  const payload = {
    report_id: uuidv4(),
    created_at: new Date().toISOString(),
    server: {
      id: server.id,
      name: server.manifest?.name || server.host,
      address: server.host,
      port: server.port
    },
    player: {
      username: authData?.username || 'Unknown',
      uuid: authData?.uuid || ''
    },
    environment: {
      launcher_version: app.getVersion(),
      minecraft_version: profile.minecraft?.version || server.manifest?.minecraft?.version || '',
      loader: profile.minecraft?.loader || server.manifest?.minecraft?.loader || '',
      loader_version: profile.minecraft?.loader_version || server.manifest?.minecraft?.loader_version || '',
      platform: process.platform,
      architecture: process.arch
    },
    crash: {
      exit_code: code,
      signal: signal || null,
      minecraft_report_file: minecraftReport?.fileName || null,
      minecraft_report: sanitizeCrashText(minecraftReport?.content || '', secrets),
      launcher_log: sanitizeCrashText(crashLog || await readTextTail(logPath, 256 * 1024), secrets)
    }
  };
  return fitCrashReportPayload(payload, server.manifest?.crash_reports?.max_upload_bytes);
}

async function savePendingCrashRecord(record) {
  await fs.mkdir(crashReportsPendingDir(), { recursive: true });
  const target = pendingCrashReportPath(record.payload.report_id);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(record), 'utf8');
  await fs.rename(temporary, target);
  return target;
}

async function deletePendingCrashRecord(reportId) {
  await fs.rm(pendingCrashReportPath(reportId), { force: true }).catch(() => {});
}

function crashShareStatus(reportId, serverId, status, message = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('impulse-crash-share-status', { reportId, serverId, status, message });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function uploadCrashRecord(record) {
  const url = `http://${record.host}:${record.manifestPort}/impulse/crash-reports`;
  let lastError = null;
  for (let attempt = 0; attempt < CRASH_REPORT_RETRY_DELAYS.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          'User-Agent': `ImpulseLauncher/${app.getVersion()}`
        },
        body: JSON.stringify(record.payload)
      });
      if (response.ok) return await response.json().catch(() => ({ success: true }));
      const detail = await response.text().catch(() => '');
      const error = new Error(`Crash report upload returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      error.transient = [408, 429, 500, 502, 503, 504, 521, 522, 524].includes(response.status);
      throw error;
    } catch (error) {
      lastError = error;
      const transient = error?.transient !== false && (error?.name === 'AbortError' || error?.transient === true || /fetch|network|socket|timed? out|aborted|ECONN|ENOTFOUND/i.test(error?.message || ''));
      if (!transient || attempt === CRASH_REPORT_RETRY_DELAYS.length - 1) break;
      await wait(CRASH_REPORT_RETRY_DELAYS[attempt]);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Crash report upload failed.');
}

async function submitCrashRecord(record) {
  if (record.persisted !== true) await savePendingCrashRecord(record);
  const reportId = record.payload.report_id;
  if (activeCrashUploads.has(reportId)) return { success: false, pending: true };
  activeCrashUploads.add(reportId);
  crashShareStatus(record.payload.report_id, record.serverId, 'sharing', 'Sharing crash report...');
  try {
    const result = await uploadCrashRecord(record);
    await deletePendingCrashRecord(record.payload.report_id);
    crashShareStatus(record.payload.report_id, record.serverId, 'shared', 'Shared with the server.');
    return { success: true, result };
  } catch (error) {
    const permanent = error?.transient === false;
    crashShareStatus(
      record.payload.report_id,
      record.serverId,
      permanent ? 'failed' : 'pending',
      permanent ? 'Sharing failed. The report remains saved locally.' : 'Waiting to be shared.'
    );
    console.warn(`Crash report ${record.payload.report_id} is pending:`, error.message || error);
    return { success: false, error: error.message || String(error) };
  } finally {
    activeCrashUploads.delete(reportId);
  }
}

async function readPendingCrashRecords() {
  let names = [];
  try { names = await fs.readdir(crashReportsPendingDir()); } catch { return []; }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(crashReportsPendingDir(), name), 'utf8'));
      if (record?.payload?.report_id && record?.serverId) records.push(record);
    } catch {}
  }
  return records;
}

async function deletePendingCrashReportsForServer(serverId) {
  const records = await readPendingCrashRecords();
  await Promise.all(records.filter((record) => record.serverId === serverId).map((record) => deletePendingCrashRecord(record.payload.report_id)));
}

async function retryPendingCrashReports(serverId = null) {
  const servers = new Map(getServers().map((server) => [server.id, server]));
  const records = await readPendingCrashRecords();
  for (const record of records) {
    if (serverId && record.serverId !== serverId) continue;
    const server = servers.get(record.serverId);
    if (!server || normalizeCrashSharingPreference(server.crashReportSharing) === 'never') {
      await deletePendingCrashRecord(record.payload.report_id);
      continue;
    }
    if (server.manifest?.crash_reports?.enabled !== true) continue;
    record.host = server.host;
    record.manifestPort = server.manifestPort;
    record.persisted = true;
    await submitCrashRecord(record);
  }
}

async function prepareCrashSharing({ server, profile, profileDir, logPath, launchedAt, code, signal, authData, crashLog }) {
  const supported = server.manifest?.crash_reports?.enabled === true;
  const preference = normalizeCrashSharingPreference(server.crashReportSharing);
  if (!supported || preference === 'never') {
    return {
      eventData: {
        sharingSupported: supported,
        sharePromptRequired: false,
        shareStatus: supported ? 'not-shared' : 'unsupported'
      }
    };
  }
  const payload = await buildCrashReportPayload({ server, profile, profileDir, logPath, launchedAt, code, signal, authData, crashLog });
  const record = {
    serverId: server.id,
    host: server.host,
    manifestPort: server.manifestPort,
    approvedAt: preference === 'always' ? new Date().toISOString() : null,
    payload
  };
  if (preference === 'ask') {
    pendingCrashConsents.set(payload.report_id, record);
    return {
      eventData: {
        reportId: payload.report_id,
        sharingSupported: true,
        sharePromptRequired: true,
        shareStatus: 'awaiting-consent'
      }
    };
  }
  await savePendingCrashRecord(record);
  record.persisted = true;
  return {
    record,
    eventData: {
      reportId: payload.report_id,
      sharingSupported: true,
      sharePromptRequired: false,
      shareStatus: 'sharing'
    }
  };
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

function parseImpulseDeepLink(raw) {
  const url = new URL(String(raw));
  if (url.protocol !== 'impulse:' || url.hostname !== 'server') throw new Error('Invalid Impulse invitation.');
  const address = url.searchParams.get('address');
  if (!address) throw new Error('The invitation is missing a server address.');
  parseServerAddress(address);
  const manifestPort = Math.max(1, Math.min(65535, Number(url.searchParams.get('manifest_port')) || 25850));
  const action = url.searchParams.get('action') === 'launch' ? 'launch' : 'add';
  const optional = [...new Set(String(url.searchParams.get('optional') || '').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
  const manifestKey = normalizeManifestPublicKey(url.searchParams.get('manifest_key'));
  return { raw: url.toString(), address, manifestPort, action, optional, manifestKey };
}

function normalizeManifestPublicKey(value) {
  const clean = String(value || '').trim().replace(/=+$/, '');
  if (!clean) return null;
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(clean)) throw new Error('The invitation contains an invalid manifest signing key.');
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(clean, 'base64url'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
  } catch {
    throw new Error('The invitation contains an invalid Ed25519 manifest signing key.');
  }
  return clean;
}

function manifestKeyFingerprint(publicKey) {
  return crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
}

function verifyManifestEnvelope(body, headers, expectedPublicKey = null) {
  const algorithm = String(headers.get('x-impulse-signature-algorithm') || '').trim();
  const publicKey = normalizeManifestPublicKey(headers.get('x-impulse-public-key'));
  const signatureValue = String(headers.get('x-impulse-signature') || '').trim();
  const declaredFingerprint = String(headers.get('x-impulse-key-id') || '').trim().toLowerCase();
  const hasSigningHeaders = !!(algorithm || publicKey || signatureValue || declaredFingerprint);
  if (!hasSigningHeaders) {
    if (expectedPublicKey) throw new Error('Manifest security check failed: this server stopped signing its manifest.');
    return { signed: false, publicKey: null, fingerprint: null };
  }
  if (algorithm.toLowerCase() !== 'ed25519' || !publicKey || !signatureValue) {
    throw new Error('Manifest security check failed: incomplete Ed25519 signature headers.');
  }
  const fingerprint = manifestKeyFingerprint(publicKey);
  if (declaredFingerprint && declaredFingerprint !== fingerprint) {
    throw new Error('Manifest security check failed: the signing key fingerprint is invalid.');
  }
  if (expectedPublicKey && expectedPublicKey !== publicKey) {
    throw new Error(`Manifest signing key changed. Expected ${manifestKeyFingerprint(expectedPublicKey)}, received ${fingerprint}.`);
  }
  let valid = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    valid = crypto.verify(null, body, key, Buffer.from(signatureValue, 'base64url'));
  } catch {}
  if (!valid) throw new Error('Manifest security check failed: invalid Ed25519 signature.');
  return { signed: true, publicKey, fingerprint };
}

function deliverDeepLink(raw) {
  let invitation;
  try { invitation = parseImpulseDeepLink(raw); }
  catch (error) { invitation = { raw: String(raw), error: error.message }; }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('impulse-deep-link', invitation);
  } else {
    pendingDeepLinks.push(invitation);
  }
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

function isImpulseModEntry(mod) {
  const id = String(mod?.id || mod?.mod_id || '').trim().toLowerCase();
  const name = String(mod?.name || '').trim().toLowerCase();
  const fileName = safeManifestFileName(mod?.file_name || '', '').toLowerCase();
  return id === 'impulse'
    || name === 'impulse'
    || /^impulse(?:[-_.].*)?\.jar$/i.test(fileName);
}

function compareModVersions(left, right) {
  const parse = (value) => String(value || '').split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    if (typeof av === 'number') return 1;
    if (typeof bv === 'number') return -1;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

async function officialImpulseReleases(timeoutMs) {
  if (officialImpulseReleasesCache.expiresAt > Date.now()) return officialImpulseReleasesCache.releases;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(3000, timeoutMs));
  try {
    const response = await fetch(IMPULSE_MOD_INDEX_URL, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json', 'User-Agent': 'ImpulseLauncher/1.1' }
    });
    if (!response.ok) throw new Error(`official mod index returned HTTP ${response.status}`);
    const index = await response.json();
    if (!Array.isArray(index?.releases)) throw new Error('official mod index is invalid');
    officialImpulseReleasesCache = { expiresAt: Date.now() + 5 * 60 * 1000, releases: index.releases };
    return index.releases;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('official Impulse mod lookup timed out');
    throw new Error(`Unable to find the latest official Impulse mod: ${error.message || error}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function latestOfficialImpulseMod(minecraft, timeoutMs) {
  const releases = await officialImpulseReleases(timeoutMs);
  const release = releases
    .filter((item) => String(item?.minecraft_version) === String(minecraft.version))
    .filter((item) => String(item?.loader || '').toLowerCase() === String(minecraft.loader || '').toLowerCase())
    .filter((item) => (item?.channel || (String(item?.version || '').includes('-') ? 'beta' : 'stable')) === 'stable')
    .sort((left, right) => compareModVersions(right.version, left.version))[0];
  if (!release) {
    throw new Error(`No official Impulse mod is available for Minecraft ${minecraft.version} ${minecraft.loader}.`);
  }
  const sha512 = String(release.sha512 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sha512)) throw new Error(`Official Impulse ${release.version} is missing its SHA-512 checksum.`);
  let downloadUrl;
  try {
    const parsed = new URL(String(release.download_url || ''));
    if (parsed.protocol !== 'https:' || parsed.origin !== UPDATE_FEED_URL || !parsed.pathname.startsWith('/mods/')) throw new Error('invalid origin');
    downloadUrl = parsed.toString();
  } catch {
    throw new Error(`Official Impulse ${release.version} has an invalid download URL.`);
  }
  return {
    id: 'impulse',
    name: 'Impulse',
    description: `Official Impulse client mod ${release.version}.`,
    file_name: safeManifestFileName(release.file_name || `impulse-${minecraft.loader}-${minecraft.version}-${release.version}.jar`),
    download_url: downloadUrl,
    sha512,
    sha1: String(release.sha1 || '').trim().toLowerCase() || null,
    sha256: String(release.sha256 || '').trim().toLowerCase() || null,
    size: Number(release.size || 0),
    required: true,
    source: 'impulse-official',
    category_id: null,
    dependencies: [],
    conflicts: []
  };
}

async function useLatestOfficialImpulseMod(manifest, timeoutMs) {
  const officialMod = await latestOfficialImpulseMod(manifest.minecraft, timeoutMs);
  return {
    ...manifest,
    mods: [...(manifest.mods || []).filter((mod) => !isImpulseModEntry(mod)), officialMod],
    optional_mods: (manifest.optional_mods || []).filter((mod) => !isImpulseModEntry(mod))
  };
}

function normalizeManifestMod(mod, host, manifestPort, fallbackPath, requiredFallback) {
  const fileName = safeManifestFileName(mod.file_name || mod.name || 'mod.jar');
  const stableId = String(mod.id || mod.mod_id || mod.sha512 || mod.sha1 || fileName).trim().toLowerCase();
  return {
    id: stableId,
    name: String(mod.name || fileName || 'mod'),
    description: String(mod.description || ''),
    file_name: fileName,
    download_url: absoluteManifestUrl(host, manifestPort, mod.download_url, fallbackPath),
    sha512: mod.sha512 ? String(mod.sha512).toLowerCase() : null,
    sha1: mod.sha1 ? String(mod.sha1).toLowerCase() : null,
    size: Number(mod.size || 0),
    required: mod.required !== undefined ? mod.required !== false : requiredFallback,
    source: mod.source || 'url',
    category_id: mod.category_id ? String(mod.category_id) : null,
    dependencies: Array.isArray(mod.dependencies) ? [...new Set(mod.dependencies.map((value) => String(value).trim().toLowerCase()).filter(Boolean))] : [],
    conflicts: Array.isArray(mod.conflicts) ? [...new Set(mod.conflicts.map((value) => String(value).trim().toLowerCase()).filter(Boolean))] : []
  };
}

function normalizeOptionalCategory(category, index) {
  const fallbackId = `category-${index + 1}`;
  const id = String(category?.id || fallbackId).trim() || fallbackId;
  return {
    id,
    name: String(category?.name || id),
    description: String(category?.description || ''),
    default_enabled: boolValue(category?.default_enabled ?? category?.defaultEnabled, false),
    order: Number.isFinite(Number(category?.order)) ? Number(category.order) : index
  };
}

function safePublicUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function normalizeContentList(value, kind) {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  return value.map((entry, index) => ({
    id: String(entry?.id || `${kind}-${index + 1}`),
    title: String(entry?.title || ''),
    body: String(entry?.body || ''),
    description: String(entry?.description || ''),
    severity: ['info', 'warning', 'critical'].includes(entry?.severity) ? entry.severity : 'info',
    version: String(entry?.version || ''),
    link: safePublicUrl(entry?.link),
    image: safePublicUrl(entry?.image),
    publish_time: entry?.publish_time ? String(entry.publish_time) : null,
    publication_time: entry?.publication_time ? String(entry.publication_time) : null,
    expiry: entry?.expiry ? String(entry.expiry) : null,
    start: entry?.start ? String(entry.start) : null,
    end: entry?.end ? String(entry.end) : null,
    order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : index
  })).filter((entry) => {
    if (!entry.title) return false;
    if (kind === 'announcement') {
      const publish = entry.publish_time ? Date.parse(entry.publish_time) : 0;
      const expiry = entry.expiry ? Date.parse(entry.expiry) : 0;
      return (!publish || publish <= now) && (!expiry || expiry > now);
    }
    if (kind === 'event') {
      const end = entry.end ? Date.parse(entry.end) : 0;
      return !end || end > now;
    }
    return true;
  });
}

function verificationStatusProblematic(status) {
  return status !== 'Matched on Modrinth' && status !== 'Matched on CurseForge' && status !== 'Recognized by Impulse';
}

function finalVerificationProblems(profile, serverEntry) {
  const manifestMods = new Map(
    [...(serverEntry.manifest?.mods || []), ...(serverEntry.manifest?.optional_mods || [])]
      .map((mod) => [String(mod.sha512 || '').toLowerCase(), mod])
  );
  return (profile.mods || [])
    .map((mod) => manifestMods.get(String(mod.sha512 || '').toLowerCase()))
    .filter((mod) => mod && verificationStatusProblematic(mod.verification?.status));
}

function finalVerificationSignature(mods) {
  return mods.map((mod) => `${mod.sha512}:${mod.verification?.status || 'Verification unavailable'}`).sort().join('|');
}

function normalizeSecurityHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

async function fetchBlockedServers(timeoutMs = 5000) {
  if (Array.isArray(blockedServersCache.servers) && blockedServersCache.expiresAt > Date.now()) return blockedServersCache.servers;
  try {
    const response = await fetch(IMPULSE_BLOCKED_SERVERS_URL, {
      signal: AbortSignal.timeout(Math.max(3000, timeoutMs)),
      cache: 'no-store',
      headers: { Accept: 'application/json', 'User-Agent': 'ImpulseLauncher/1.2' }
    });
    if (!response.ok) throw new Error(`Impulse security registry returned HTTP ${response.status}`);
    const body = await response.json();
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    blockedServersCache = { expiresAt: Date.now() + 5 * 60 * 1000, servers };
    store.set('blockedServersCache', { expiresAt: Date.now() + 24 * 60 * 60 * 1000, servers });
    return servers;
  } catch (error) {
    const saved = store.get('blockedServersCache');
    if (Array.isArray(saved?.servers) && Number(saved.expiresAt) > Date.now()) {
      blockedServersCache = saved;
      return saved.servers;
    }
    console.warn('[Impulse security] Server blacklist unavailable:', error.message || error);
    return [];
  }
}

function restrictedServerError(entry) {
  const reason = SERVER_RESTRICTION_REASONS[String(entry?.reason_code || '').trim().toLowerCase()] || UNKNOWN_SERVER_RESTRICTION;
  const error = new Error(`${SERVER_ACCESS_RESTRICTED_HEADING}. ${reason[0]}: ${reason[1]}`);
  error.code = 'SERVER_ACCESS_RESTRICTED';
  error.details = {
    restrictionKind: 'server-security',
    title: SERVER_ACCESS_RESTRICTED_HEADING,
    reasonTitle: reason[0],
    description: reason[1],
    reasonCode: String(entry?.reason_code || 'policy_violation')
  };
  return error;
}

async function assertServerAllowed(host) {
  const normalizedHost = normalizeSecurityHost(host);
  if (!normalizedHost) return;
  const blocked = await fetchBlockedServers(getNetworkTimeout());
  if (!blocked.length) return;
  const exact = blocked.find((entry) => normalizeSecurityHost(entry?.host) === normalizedHost);
  if (exact) throw restrictedServerError(exact);

  let addresses = [];
  if (net.isIPv4(normalizedHost)) addresses = [normalizedHost];
  else {
    try { addresses = await dns.resolve4(normalizedHost); }
    catch (error) { console.warn(`[Impulse security] Could not resolve ${normalizedHost} for blacklist check:`, error.message || error); }
  }
  const addressSet = new Set(addresses.map(normalizeSecurityHost));
  const matchingIp = blocked.find((entry) => (entry?.ipv4 || []).some((address) => addressSet.has(normalizeSecurityHost(address))));
  if (matchingIp) throw restrictedServerError(matchingIp);
}

async function fetchRecognizedMods(timeoutMs) {
  if (recognizedModsCache.mods && recognizedModsCache.expiresAt > Date.now()) return recognizedModsCache.mods;
  try {
    const response = await fetch(IMPULSE_RECOGNIZED_MODS_URL, {
      signal: AbortSignal.timeout(Math.max(3000, timeoutMs)),
      headers: { Accept: 'application/json', 'User-Agent': 'ImpulseLauncher/1.2' }
    });
    if (!response.ok) throw new Error(`Impulse registry returned HTTP ${response.status}`);
    const body = await response.json();
    const mods = body && typeof body.mods === 'object' && !Array.isArray(body.mods) ? body.mods : {};
    recognizedModsCache = { expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, mods };
    store.set('recognizedModsCache', recognizedModsCache);
    return mods;
  } catch (error) {
    const saved = store.get('recognizedModsCache');
    if (saved?.mods && Number(saved.expiresAt) > Date.now()) {
      recognizedModsCache = saved;
      return saved.mods;
    }
    throw error;
  }
}

async function verifyManifestModOrigins(manifest, timeoutMs) {
  const all = [...(manifest.mods || []), ...(manifest.optional_mods || [])];
  const hashes = [...new Set(all.map((mod) => String(mod.sha512 || '').toLowerCase()).filter((hash) => /^[0-9a-f]{128}$/.test(hash)))];
  let recognized = null;
  let modrinth = null;
  try { recognized = await fetchRecognizedMods(timeoutMs); } catch (error) { console.warn('[Impulse verification] Registry unavailable:', error.message); }
  try {
    const response = await fetch(MODRINTH_VERSION_FILES_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(Math.max(3000, timeoutMs)),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'ImpulseLauncher/1.2 (https://impulsemc.com)' },
      body: JSON.stringify({ hashes, algorithm: 'sha512' })
    });
    if (!response.ok) throw new Error(`Modrinth returned HTTP ${response.status}`);
    modrinth = await response.json();
  } catch (error) {
    console.warn('[Impulse verification] Modrinth unavailable:', error.message);
  }
  const savedVerification = store.get('modVerificationCache') || {};
  for (const mod of all) {
    const hash = String(mod.sha512 || '').toLowerCase();
    let status = 'Pending CurseForge verification';
    let modrinthStatus = 'Verification unavailable';
    if (mod.source === 'impulse-official') status = 'Recognized by Impulse';
    else if (recognized && recognized[hash]) status = 'Recognized by Impulse';
    else if (modrinth) {
      const version = modrinth[hash];
      if (!version) modrinthStatus = 'Unverified';
      else {
        const games = Array.isArray(version.game_versions) ? version.game_versions.map(String) : [];
        const loaders = Array.isArray(version.loaders) ? version.loaders.map((value) => String(value).toLowerCase()) : [];
        modrinthStatus = games.includes(String(manifest.minecraft.version)) && loaders.includes(String(manifest.minecraft.loader).toLowerCase())
          ? 'Matched on Modrinth'
          : 'Incompatible Modrinth listing';
        if (modrinthStatus === 'Matched on Modrinth') status = modrinthStatus;
      }
    }
    const cached = savedVerification[hash];
    if (status === 'Pending CurseForge verification' && cached && Number(cached.expiresAt) > Date.now()
      && ['Matched on Modrinth', 'Recognized by Impulse'].includes(cached.status)) status = cached.status;
    mod.verification = { status, modrinth_status: modrinthStatus };
    if (status !== 'Pending CurseForge verification') {
      const entry = { status, expiresAt: Date.now() + (verificationStatusProblematic(status) ? 24 : 30 * 24) * 60 * 60 * 1000 };
      modVerificationCache.set(hash, entry);
      if (hash) savedVerification[hash] = entry;
    }
  }
  store.set('modVerificationCache', savedVerification);
  return manifest;
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
  const optionalCategories = Array.isArray(manifest.optional_mod_categories) ? manifest.optional_mod_categories : [];
  return {
    manifest_version: Number(manifest.manifest_version || 1),
    impulse_version: String(manifest.impulse_version || manifest.impulse?.version || '1.0.0'),
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
    maintenance: {
      enabled: boolValue(manifest.maintenance?.enabled, false),
      title: String(manifest.maintenance?.title || 'Maintenance'),
      message: String(manifest.maintenance?.message || ''),
      estimated_end: manifest.maintenance?.estimated_end ? String(manifest.maintenance.estimated_end) : null
    },
    crash_reports: {
      enabled: manifest.crash_reports?.enabled === true,
      max_upload_bytes: Math.max(65536, Math.min(Number(manifest.crash_reports?.max_upload_bytes) || CRASH_REPORT_UPLOAD_LIMIT, CRASH_REPORT_UPLOAD_LIMIT))
    },
    announcements: normalizeContentList(manifest.announcements, 'announcement'),
    changelog: normalizeContentList(manifest.changelog, 'changelog'),
    events: normalizeContentList(manifest.events, 'event'),
    mods: mods.map((mod) => normalizeManifestMod(mod, host, manifestPort, '/impulse/mods', true)),
    optional_mods: optionalMods.map((mod) => normalizeManifestMod(mod, host, manifestPort, '/impulse/optional-mods', false)),
    optional_mod_categories: optionalCategories
      .map(normalizeOptionalCategory)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
  };
}

async function fetchManifest(host, port, manifestPort, timeoutMs = getNetworkTimeout(), expectedPublicKey = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `http://${host}:${manifestPort}/impulse/server.json`;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'ImpulseLauncher/0.1' }
    });
    if (!response.ok) throw new Error(`Manifest returned HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const security = verifyManifestEnvelope(body, response.headers, expectedPublicKey);
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch (error) { throw new Error(`The server returned an invalid manifest: ${error.message}`); }
    const manifest = normalizeManifest(parsed, host, port, manifestPort);
    manifest.security = security;
    return await verifyManifestModOrigins(await useLatestOfficialImpulseMod(manifest, timeoutMs), timeoutMs);
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
    crashReportSharing: normalizeCrashSharingPreference(server?.crashReportSharing),
    manifestPublicKey: server?.manifestPublicKey || server?.manifest?.security?.publicKey || null,
    manifestUnsignedAllowed: server?.manifestUnsignedAllowed === true,
    outdatedImpulseWarningDismissed: server?.outdatedImpulseWarningDismissed === true,
    status: server?.status || { online: false, error: SERVER_OFFLINE_MESSAGE },
    manifest: server?.manifest || { mods: [], optional_mods: [], optional_mod_categories: [] }
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
  return String(mod?.sha512 || mod?.sha1 || mod?.file_name || mod?.name || '').toLowerCase();
}

function optionalModSignature(manifest) {
  const optionalMods = Array.isArray(manifest?.optional_mods) ? manifest.optional_mods : [];
  const requiredRelationships = (Array.isArray(manifest?.mods) ? manifest.mods : [])
    .map((mod) => `required:${mod.id || optionalModKey(mod)}:d=${(mod.dependencies || []).slice().sort().join(',')}:c=${(mod.conflicts || []).slice().sort().join(',')}`);
  const categoryRules = (Array.isArray(manifest?.optional_mod_categories) ? manifest.optional_mod_categories : [])
    .map((category) => `category:${category.id}:${category.default_enabled === true}`);
  const payload = optionalMods
    .map((mod) => `${optionalModKey(mod)}:${mod.id || ''}:${safeManifestFileName(mod.file_name || mod.name || 'mod.jar')}:${mod.size || 0}:d=${(mod.dependencies || []).slice().sort().join(',')}:c=${(mod.conflicts || []).slice().sort().join(',')}`)
    .concat(requiredRelationships, categoryRules)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function reconcileOptionalMods(server, markPrompted = false) {
  const optionalMods = Array.isArray(server?.manifest?.optional_mods) ? server.manifest.optional_mods : [];
  const signature = optionalModSignature(server.manifest);
  const existingChoices = server.optionalModChoices || server.optionalModSelections || {};
  const nextChoices = {};
  const firstSelection = !server.optionalModPromptedSignature && Object.keys(existingChoices).length === 0;
  const categories = new Map((server?.manifest?.optional_mod_categories || []).map((category) => [String(category.id), category]));
  for (const mod of optionalMods) {
    const key = optionalModKey(mod);
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(existingChoices, key)) {
      nextChoices[key] = existingChoices[key] === true;
      continue;
    }
    const category = mod.category_id ? categories.get(String(mod.category_id)) : null;
    nextChoices[key] = firstSelection && category?.default_enabled === true;
  }
  const relationshipState = deriveOptionalSelections(server.manifest, nextChoices);
  return {
    ...server,
    optionalModChoices: nextChoices,
    optionalModSelections: relationshipState.selections,
    optionalModRequiredBy: relationshipState.requiredBy,
    optionalModRelationshipErrors: relationshipState.errors,
    optionalModSignature: signature,
    optionalModPromptedSignature: markPrompted ? signature : (server.optionalModPromptedSignature || null)
  };
}

function deriveOptionalSelections(manifest, choices) {
  const requiredMods = Array.isArray(manifest?.mods) ? manifest.mods : [];
  const optionalMods = Array.isArray(manifest?.optional_mods) ? manifest.optional_mods : [];
  const all = new Map([...requiredMods, ...optionalMods].map((mod) => [String(mod.id || '').toLowerCase(), mod]).filter(([id]) => id));
  const optionalById = new Map(optionalMods.map((mod) => [String(mod.id || '').toLowerCase(), mod]).filter(([id]) => id));
  const requiredIds = new Set(requiredMods.map((mod) => String(mod.id || '').toLowerCase()).filter(Boolean));
  const selectedIds = new Set(requiredIds);
  const requiredBy = {};
  const errors = [];
  const queue = Array.from(requiredIds);

  for (const mod of optionalMods) {
    if (choices[optionalModKey(mod)] === true) {
      const id = String(mod.id || '').toLowerCase();
      if (id) { selectedIds.add(id); queue.push(id); }
    }
  }
  while (queue.length) {
    const parentId = queue.shift();
    const parent = all.get(parentId);
    for (const dependencyId of parent?.dependencies || []) {
      const dependency = all.get(String(dependencyId).toLowerCase());
      if (!dependency) {
        errors.push(`Missing dependency ${dependencyId} required by ${parent?.name || parentId}`);
        continue;
      }
      const cleanId = String(dependency.id).toLowerCase();
      if (optionalById.has(cleanId)) {
        requiredBy[optionalModKey(dependency)] = [...new Set([...(requiredBy[optionalModKey(dependency)] || []), parent?.name || parentId])];
      }
      if (!selectedIds.has(cleanId)) { selectedIds.add(cleanId); queue.push(cleanId); }
    }
  }
  const seenConflicts = new Set();
  for (const id of selectedIds) {
    const mod = all.get(id);
    for (const conflictId of mod?.conflicts || []) {
      const cleanConflict = String(conflictId).toLowerCase();
      if (!selectedIds.has(cleanConflict)) continue;
      const pair = [id, cleanConflict].sort().join('|');
      if (seenConflicts.has(pair)) continue;
      seenConflicts.add(pair);
      errors.push(`${mod?.name || id} conflicts with ${all.get(cleanConflict)?.name || cleanConflict}`);
    }
  }
  const selections = {};
  for (const mod of optionalMods) selections[optionalModKey(mod)] = selectedIds.has(String(mod.id || '').toLowerCase());
  return { selections, requiredBy, errors, selectedIds, requiredIds };
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

async function discoverServer(input, manifestPort = null, event = null, expectedPublicKey = null) {
  const parsed = parseServerAddress(input);
  const port = Number(parsed.port || 25565);
  await assertServerAllowed(parsed.host);
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
    manifest = await fetchManifest(parsed.host, port, resolvedManifestPort, getNetworkTimeout(), expectedPublicKey);
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
    manifestPublicKey: manifest.security?.publicKey || expectedPublicKey || null,
    manifestUnsignedAllowed: manifest.security?.signed !== true,
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    profileId: `impulse-${id}`
  };
}

async function refreshSavedServer(existing, options = {}) {
  await assertServerAllowed(existing.host);
  const status = await pingMinecraftServer(existing.host, existing.port);
  if (!status.online) {
    const offline = offlineServerEntry(existing, status);
    if (options.event) offline.offlineDetails = await emitServerOffline(options.event, 0);
    if (options.strict) throw serverOfflineError(offline);
    return offline;
  }

  let manifest;
  try {
    manifest = await fetchManifest(existing.host, existing.port, existing.manifestPort, options.timeout || 10000, existing.manifestPublicKey || null);
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
    manifestPublicKey: manifest.security?.publicKey || existing.manifestPublicKey || null,
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
  const transfer = {
    startedAt: Date.now(),
    totalBytes: 0,
    completedBytes: 0,
    active: new Map(),
    completedFiles: 0,
    retries: 0
  };

  for (let i = 0; i < mods.length; i += 1) {
    const mod = mods[i];
    const label = safeManifestFileName(mod.file_name || mod.name || 'mod.jar');
    const ext = path.extname(label) || '.jar';
    if (!/^[0-9a-f]{128}$/.test(String(mod.sha512 || ''))) {
      throw new Error('This server uses an outdated mod manifest that does not provide SHA-512 hashes. Ask the server owner to update Impulse.');
    }
    if (!mod.download_url) throw new Error(`The mod "${label}" is missing download_url.`);

    let cached = await cacheManager.hasFile('mods', mod.sha512, ext);
    if (!cached && /^[0-9a-f]{40}$/.test(String(mod.sha1 || '')) && await cacheManager.hasFile('mods', mod.sha1, ext)) {
      const legacyPath = cacheManager.getCachePath('mods', mod.sha1, ext);
      if (await cacheManager.verifyFileSha512(legacyPath, mod.sha512).catch(() => false)) {
        await fs.copyFile(legacyPath, cacheManager.getCachePath('mods', mod.sha512, ext));
        cached = true;
      }
    }
    if (cached) {
      const cachePath = cacheManager.getCachePath('mods', mod.sha512, ext);
      const valid = await cacheManager.verifyFileSha512(cachePath, mod.sha512).catch(() => false);
      if (valid) continue;
      await fs.rm(cachePath, { force: true });
    }

    downloads.push({ mod, label, ext });
    transfer.totalBytes += Math.max(0, Number(mod.size) || 0);
  }

  let completed = mods.length - downloads.length;
  const sendDownloadProgress = (label, status = 'downloading-mods') => {
    const activeBytes = Array.from(transfer.active.values()).reduce((total, value) => total + value, 0);
    const downloadedBytes = transfer.completedBytes + activeBytes;
    const elapsedSeconds = Math.max((Date.now() - transfer.startedAt) / 1000, 0.1);
    const speed = downloadedBytes / elapsedSeconds;
    const remaining = Math.max(0, transfer.totalBytes - downloadedBytes);
    event.sender.send('impulse-launch-progress', {
      status,
      message: downloads.length
        ? `Downloading mods (${Math.min(completed + 1, mods.length)}/${mods.length}): ${label}`
        : `Using cached mods (${completed}/${mods.length}).`,
      progress: 65 + Math.floor((completed / Math.max(mods.length, 1)) * 20),
      total: 100,
      details: {
        downloadedBytes,
        totalBytes: transfer.totalBytes,
        speedBytesPerSecond: speed,
        etaSeconds: speed > 0 ? remaining / speed : null,
        activeFiles: Array.from(transfer.active.keys()),
        completedFiles: transfer.completedFiles,
        totalFiles: downloads.length,
        retries: transfer.retries,
        concurrency
      }
    });
  };

  if (downloads.length) sendDownloadProgress(downloads[0].label);

  let cursor = 0;
  async function worker() {
    while (cursor < downloads.length) {
      const current = downloads[cursor++];
      if (activeLaunch?.controller.signal.aborted) throw Object.assign(new Error('Launch cancelled.'), { code: 'LAUNCH_CANCELLED' });
      transfer.active.set(current.label, 0);
      sendDownloadProgress(current.label);
      let failed = false;
      try {
        await cacheManager.downloadAndStore('mods', current.mod.download_url, current.mod.sha512, current.ext, {
          algorithm: 'sha512',
          timeout,
          attempts: 3,
          signal: activeLaunch?.controller.signal,
          retryDelays: [500, 1500, 3000],
          onProgress: ({ receivedBytes }) => {
            transfer.active.set(current.label, receivedBytes);
            sendDownloadProgress(current.label);
          },
          onRetry: ({ attempt, maxAttempts }) => {
            transfer.retries += 1;
            sendDownloadProgress(`${current.label} (attempt ${attempt}/${maxAttempts})`, 'retrying-download');
          }
        });
      } catch (error) {
        failed = true;
        if (error?.code === 'LAUNCH_CANCELLED') throw error;
        const status = await pingMinecraftServer(serverEntry.host, serverEntry.port);
        activeLaunch?.controller.abort();
        if (!status.online) {
          const updated = markServerOffline(serverEntry.id, serverEntry, status);
          updated.offlineDetails = await emitServerOffline(event, 0);
          throw serverOfflineError(updated);
        }
        throw new Error(`Failed to download mod "${current.label}" from ${current.mod.download_url}: ${error.message}`);
      } finally {
        const bytes = transfer.active.get(current.label) || 0;
        transfer.active.delete(current.label);
        if (!failed) {
          transfer.completedBytes += Math.max(bytes, Number(current.mod.size) || 0);
          transfer.completedFiles += 1;
        }
        completed += 1;
        if (!failed) sendDownloadProgress(current.label);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const profileDir = profileManager.getProfileDir(profileId);
  const items = mods.map((mod) => ({
    category: 'mods',
    sha512: mod.sha512,
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
    const actual = await cacheManager.computeFileSha512(profileModPath).catch((error) => {
      throw new Error(`Downloaded mod is missing from profile: ${fileName} (${error.message})`);
    });
    if (actual.toLowerCase() !== String(mod.sha512).toLowerCase()) {
      throw new Error(`Profile mod SHA-512 mismatch for ${fileName}: expected ${mod.sha512}, got ${actual}`);
    }
  }

  event.sender.send('impulse-launch-progress', {
    status: 'mods-ready',
    message: mods.length ? `Synced ${mods.length} mod(s).` : 'No server mods to sync.',
    progress: 86,
    total: 100
  });
}

function curseForgeMurmur2(buffer) {
  const normalized = Buffer.allocUnsafe(buffer.length);
  let length = 0;
  for (const value of buffer) {
    if (value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20) continue;
    normalized[length++] = value;
  }
  const bytes = normalized.subarray(0, length);
  const multiplier = 0x5bd1e995;
  let hash = (1 ^ length) >>> 0;
  let offset = 0;
  while (length - offset >= 4) {
    let chunk = bytes.readUInt32LE(offset);
    chunk = Math.imul(chunk, multiplier) >>> 0;
    chunk ^= chunk >>> 24;
    chunk = Math.imul(chunk, multiplier) >>> 0;
    hash = (Math.imul(hash, multiplier) ^ chunk) >>> 0;
    offset += 4;
  }
  switch (length - offset) {
    case 3: hash ^= bytes[offset + 2] << 16;
    case 2: hash ^= bytes[offset + 1] << 8;
    case 1: hash ^= bytes[offset]; hash = Math.imul(hash, multiplier) >>> 0;
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, multiplier) >>> 0;
  hash ^= hash >>> 15;
  return hash >>> 0;
}

async function curseForgeFingerprint(filePath, sha512) {
  const key = String(sha512 || '').toLowerCase();
  const saved = store.get('curseForgeFingerprintCache') || {};
  const cached = Number(saved[key]);
  if (Number.isSafeInteger(cached) && cached >= 0 && cached <= 0xffffffff) return cached;
  const fingerprint = curseForgeMurmur2(await fs.readFile(filePath));
  saved[key] = fingerprint;
  const keys = Object.keys(saved);
  if (keys.length > 5000) for (const stale of keys.slice(0, keys.length - 5000)) delete saved[stale];
  store.set('curseForgeFingerprintCache', saved);
  return fingerprint;
}

async function finalizeManifestModVerification(minecraftPath, profile, serverEntry) {
  const profileDir = new ProfileManager(minecraftPath).getProfileDir(serverEntry.profileId);
  const activeMods = profile.mods || [];
  const byHash = new Map();
  for (const mod of [...(serverEntry.manifest.mods || []), ...(serverEntry.manifest.optional_mods || [])]) {
    if (mod.sha512) byHash.set(String(mod.sha512).toLowerCase(), mod);
  }
  const unresolved = [];
  for (const profileMod of activeMods) {
    const hash = String(profileMod.sha512 || '').toLowerCase();
    const mod = byHash.get(hash);
    if (!mod || ['Matched on Modrinth', 'Matched on CurseForge', 'Recognized by Impulse'].includes(mod.verification?.status)) continue;
    const fileName = safeManifestFileName(profileMod.file_name || profileMod.name || 'mod.jar');
    const filePath = path.join(profileDir, 'mods', fileName);
    unresolved.push({ mod, sha512: hash, fingerprint: await curseForgeFingerprint(filePath, hash) });
  }
  if (!unresolved.length) return serverEntry;

  let available = true;
  const results = {};
  try {
    for (let offset = 0; offset < unresolved.length; offset += 100) {
      const chunk = unresolved.slice(offset, offset + 100);
      const response = await fetch(IMPULSE_CURSEFORGE_VERIFICATION_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(Math.max(5000, getNetworkTimeout())),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'ImpulseLauncher/1.2 (https://impulsemc.com)' },
        body: JSON.stringify({
          minecraft_version: serverEntry.manifest.minecraft.version,
          loader: serverEntry.manifest.minecraft.loader,
          files: chunk.map(({ sha512, fingerprint }) => ({ sha512, fingerprint }))
        })
      });
      if (!response.ok) throw new Error(`Impulse CurseForge verification returned HTTP ${response.status}`);
      const body = await response.json();
      Object.assign(results, body?.matches || {});
    }
  } catch (error) {
    available = false;
    console.warn('[Impulse verification] CurseForge unavailable:', error.message);
  }

  for (const { mod, sha512 } of unresolved) {
    const modrinthStatus = mod.verification?.modrinth_status || 'Verification unavailable';
    const curseForgeStatus = results[sha512]?.status;
    let status;
    if (curseForgeStatus === 'Matched on CurseForge') status = curseForgeStatus;
    else if (modrinthStatus === 'Incompatible Modrinth listing') status = modrinthStatus;
    else if (curseForgeStatus === 'Incompatible CurseForge listing') status = curseForgeStatus;
    else if (available) status = 'Unverified';
    else status = 'Verification unavailable';
    mod.verification = {
      ...mod.verification,
      status,
      ...(results[sha512] ? { curseforge: results[sha512] } : {})
    };
  }
  return serverEntry;
}

function minecraftOsName() {
  switch (process.platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'osx';
    default: return 'linux';
  }
}

function minecraftArchSuffix() {
  return process.arch === 'x64' ? '64' : '32';
}

function isMinecraftRuleAllowed(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const osName = minecraftOsName();
  let allowed = false;
  for (const rule of rules) {
    const applies = !rule.os || rule.os.name === osName;
    if (!applies) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

function minecraftLibraryArtifacts(versionData) {
  const artifacts = [];
  const seen = new Set();
  const osName = minecraftOsName();

  for (const library of versionData?.libraries || []) {
    if (!isMinecraftRuleAllowed(library?.rules)) continue;
    const pushArtifact = (artifact) => {
      if (!artifact?.path || seen.has(artifact.path)) return;
      seen.add(artifact.path);
      artifacts.push(artifact);
    };

    pushArtifact(library?.downloads?.artifact);

    const nativeKey = library?.natives?.[osName];
    if (nativeKey && library?.downloads?.classifiers) {
      const resolvedKey = nativeKey.replace('${arch}', minecraftArchSuffix());
      pushArtifact(library.downloads.classifiers[resolvedKey]);
    }
  }

  return artifacts;
}

async function readMergedMinecraftVersion(minecraftPath, versionId, seen = new Set()) {
  if (!versionId || seen.has(versionId)) throw new Error(`Invalid inherited Minecraft version chain at ${versionId || 'unknown'}`);
  seen.add(versionId);

  const versionJsonPath = path.join(minecraftPath, 'versions', versionId, `${versionId}.json`);
  const versionData = JSON.parse(await fs.readFile(versionJsonPath, 'utf8'));
  if (!versionData.inheritsFrom) return versionData;

  const parentData = await readMergedMinecraftVersion(minecraftPath, versionData.inheritsFrom, seen);
  return {
    ...parentData,
    ...versionData,
    libraries: [
      ...(parentData.libraries || []),
      ...(versionData.libraries || []),
    ],
    arguments: {
      ...(parentData.arguments || {}),
      ...(versionData.arguments || {}),
      game: [
        ...((parentData.arguments || {}).game || []),
        ...((versionData.arguments || {}).game || []),
      ],
      jvm: [
        ...((parentData.arguments || {}).jvm || []),
        ...((versionData.arguments || {}).jvm || []),
      ],
    },
  };
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

  let versionData;
  try {
    versionData = await readMergedMinecraftVersion(minecraftPath, launchVersion);
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

  const libraryFailures = [];
  const libraryArtifacts = minecraftLibraryArtifacts(versionData);
  for (const artifact of libraryArtifacts) {
    const artifactPath = artifact?.path;
    if (!artifactPath) continue;
    const libraryPath = path.join(minecraftPath, 'libraries', artifactPath);
    try {
      await fs.access(libraryPath);
      if (artifact.sha1) {
        const actual = await cacheManager.computeFileSha1(libraryPath);
        if (actual.toLowerCase() !== String(artifact.sha1).toLowerCase()) {
          libraryFailures.push(`SHA1 mismatch ${artifactPath}`);
        }
      }
    } catch (error) {
      libraryFailures.push(error?.code === 'ENOENT' ? `missing ${artifactPath}` : `${artifactPath}: ${error.message}`);
    }
  }
  if (libraryFailures.length) {
    throw new Error(`Launch check failed: ${libraryFailures.length} Minecraft/loader ${libraryFailures.length === 1 ? 'library is' : 'libraries are'} invalid (${libraryFailures.slice(0, 3).join(', ')})`);
  }

  const expectedMods = (profile.mods || []).map((mod) => ({
    fileName: safeManifestFileName(mod.file_name || mod.name || 'mod.jar'),
    sha512: String(mod.sha512 || '').toLowerCase()
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
    if (!/^[0-9a-f]{128}$/.test(mod.sha512)) throw new Error('This server uses an outdated mod manifest that does not provide SHA-512 hashes. Ask the server owner to update Impulse.');
    const actualSha512 = await cacheManager.computeFileSha512(modPath).catch((error) => {
      throw new Error(`Launch check failed: unable to read ${mod.fileName} (${error.message})`);
    });
    if (actualSha512.toLowerCase() !== mod.sha512) {
      throw new Error(`Launch check failed: SHA-512 mismatch for ${mod.fileName}`);
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
  return { verifiedMods: expectedMods.length, launchVersion, loader: loaderLabel, repairedFiles: [], failures: [] };
}

function throwIfLaunchCancelled() {
  if (!activeLaunch?.controller.signal.aborted) return;
  const error = new Error('Launch cancelled.');
  error.code = 'LAUNCH_CANCELLED';
  throw error;
}

async function installOrResolveLoader(event, launcher, minecraftPath, version, loader, loaderVersion, force = false) {
  const loaderLabel = loader === 'neoforge' ? 'NeoForge' : 'Forge';
  let launchVersion = force ? null : await (loader === 'neoforge'
    ? resolveNeoForgeLaunchVersion(minecraftPath, version, loaderVersion)
    : resolveForgeLaunchVersion(minecraftPath, version, loaderVersion)).catch(() => null);
  if (launchVersion) {
    event.sender.send('impulse-launch-progress', { status: loader, message: `${loaderLabel} ${loaderVersion} already installed.`, progress: 45, total: 100 });
    return launchVersion;
  }
  event.sender.send('impulse-launch-progress', { status: loader, message: `Installing ${loaderLabel} ${loaderVersion}...`, progress: 45, total: 100 });
  const installed = loader === 'neoforge'
    ? await launcher.manager.installNeoForge(version, loaderVersion, minecraftPath, (data) => event.sender.send('impulse-launch-progress', data))
    : await launcher.manager.installForge(version, loaderVersion, minecraftPath, (data) => event.sender.send('impulse-launch-progress', data));
  return loader === 'neoforge'
    ? resolveNeoForgeLaunchVersion(minecraftPath, version, loaderVersion, installed)
    : resolveForgeLaunchVersion(minecraftPath, version, loaderVersion, installed);
}

async function prepareServerFiles(event, serverId, options = {}) {
  const minecraftPath = store.get('minecraftPath');
  await ensureDirectories(minecraftPath);
  const server = getServers().find((entry) => entry.id === serverId);
  if (!server) throw new Error('Server not found.');
  await assertServerAllowed(server.host);
  throwIfLaunchCancelled();

  event.sender.send('impulse-launch-progress', { status: 'checking-server', message: 'Refreshing server manifest...', progress: 5, total: 100 });
  let merged;
  try {
    merged = reconcileOptionalMods(await refreshSavedServer(server, { strict: true, timeout: getNetworkTimeout(), event }), false);
    merged = saveServerEntry(serverId, merged);
  } catch (error) {
    if (isServerOfflineError(error) && error.server) saveServerEntry(serverId, error.server);
    throw error;
  }
  if (merged.manifest?.maintenance?.enabled) {
    const error = new Error(merged.manifest.maintenance.message || 'This server is currently under maintenance.');
    error.code = 'SERVER_MAINTENANCE';
    error.details = merged.manifest.maintenance;
    throw error;
  }
  if ((merged.optionalModRelationshipErrors || []).length) {
    throw new Error(`Optional mod relationships are invalid: ${merged.optionalModRelationshipErrors.join('; ')}`);
  }
  throwIfLaunchCancelled();

  const profile = await createOrSyncProfile(minecraftPath, merged);
  const launcher = createLauncher();
  const { version, loader = 'forge', loader_version: loaderVersion } = profile.minecraft;
  event.sender.send('impulse-launch-progress', { status: 'installing', message: `Installing Minecraft ${version}...`, progress: 10, total: 100 });
  await launcher.installMinecraft({ version, minecraftPath, progressCallback: (data) => event.sender.send('impulse-launch-progress', data) });
  throwIfLaunchCancelled();

  let launchVersion = await installOrResolveLoader(event, launcher, minecraftPath, version, loader, loaderVersion);
  await downloadProfileMods(event, minecraftPath, profile, merged);
  throwIfLaunchCancelled();

  const report = { repairedFiles: [], failures: [], verifiedMods: 0, launchVersion };
  try {
    Object.assign(report, await verifyLaunchReadiness(event, minecraftPath, profile, merged, launchVersion, loader, loaderVersion));
  } catch (firstError) {
    const repairedFiles = [
      launchVersion ? `versions/${launchVersion}` : `${loader} ${loaderVersion}`,
      `Minecraft ${version} installation`,
      `profiles/${merged.profileId}/mods`
    ];
    event.sender.send('impulse-launch-progress', { status: 'repairing-files', message: 'Repairing launch files...', progress: 87, total: 100 });
    if (launchVersion) await fs.rm(path.join(minecraftPath, 'versions', launchVersion), { recursive: true, force: true });
    await launcher.installMinecraft({ version, minecraftPath, progressCallback: (data) => event.sender.send('impulse-launch-progress', data) });
    launchVersion = await installOrResolveLoader(event, launcher, minecraftPath, version, loader, loaderVersion, true);
    await downloadProfileMods(event, minecraftPath, profile, merged);
    try {
      Object.assign(report, await verifyLaunchReadiness(event, minecraftPath, profile, merged, launchVersion, loader, loaderVersion));
      report.repairedFiles = [...repairedFiles, 'Minecraft, loader, cache, and profile mods were repaired.'];
    } catch (repairError) {
      report.failures.push(repairError.message);
      repairError.repairReport = report;
      throw repairError;
    }
  }
  if (!options.skipFinalPing) await assertServerOnline(merged, event, 94);
  await finalizeManifestModVerification(minecraftPath, profile, merged);
  merged = saveServerEntry(serverId, merged);
  const verificationProblems = finalVerificationProblems(profile, merged);
  const verificationSignature = finalVerificationSignature(verificationProblems);
  if (options.requireVerificationAcceptance !== false && verificationSignature && verificationSignature !== merged.acceptedUnverifiedModSignature) {
    const error = new Error('Server mod verification requires confirmation.');
    error.code = 'MOD_VERIFICATION_REQUIRED';
    error.server = merged;
    throw error;
  }
  return { minecraftPath, merged, profile, launcher, launchVersion, loader, loaderVersion, version, report };
}

async function launchServer(event, serverId) {
  if (activeGame) {
    throw new Error('Minecraft is already running.');
  }
  const server = getServers().find((entry) => entry.id === serverId);
  if (!server) throw new Error('Server not found.');

  const authData = await refreshActiveMicrosoftAccountIfNeeded();
  if (!authData) throw new Error('Log in with an offline username before launching.');
  const rpcSettings = discordRpcSettings();
  const serverDisplayName = server.manifest?.name || server.host || 'Impulse Server';
  updateLauncherDiscordActivity('syncing', {
    serverName: serverDisplayName,
    ...serverRpcImages(server)
  });

  const prepared = await prepareServerFiles(event, serverId);
  const { minecraftPath, merged, profile, launcher, launchVersion, loader, version } = prepared;
  const profileServerName = merged.manifest?.name || profile.name || profile.server?.address || serverDisplayName;
  const profileServerImages = serverRpcImages(merged);

  const loaderLabel = loader === 'neoforge' ? 'NeoForge' : 'Forge';
  console.log(`Using ${loaderLabel} launch version: ${launchVersion}`);

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
  extraJvmArgs.push(`-Dimpulse.legal.accepted=${LEGAL_DOCUMENT_VERSION}`);
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
  await ensureMicrophonePermissionForLaunch(event, profile);
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
    let crashSharing = { eventData: {} };
    if (crashed) {
      try {
        crashSharing = await prepareCrashSharing({
          server: merged,
          profile,
          profileDir,
          logPath: proc.logPath,
          launchedAt: rpcStartedAt,
          code,
          signal,
          authData,
          crashLog
        });
      } catch (error) {
        console.warn('Failed to prepare crash report sharing:', error.message || error);
        crashSharing = { eventData: { sharingSupported: true, sharePromptRequired: false, shareStatus: 'failed', shareMessage: 'Sharing failed.' } };
      }
    }
    event.sender.send('impulse-game-closed', {
      code,
      signal,
      serverId,
      logPath: proc.logPath,
      diagnosticsDir: proc.diagnosticsDir,
      crashed,
      crashLog,
      ...crashSharing.eventData
    });
    if (crashSharing.record) void submitCrashRecord(crashSharing.record);
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

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = argv.find((value) => String(value).startsWith('impulse://'));
    if (link) deliverDeepLink(link);
    else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('impulse');
  Menu.setApplicationMenu(null);
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(impulseWindowIcon());
  }
  createWindow();
  mainWindow?.webContents.once('did-finish-load', () => {
    const startupLink = process.argv.find((value) => String(value).startsWith('impulse://'));
    if (startupLink) {
      try { pendingDeepLinks.push(parseImpulseDeepLink(startupLink)); }
      catch (error) { pendingDeepLinks.push({ raw: startupLink, error: error.message }); }
    }
  });
  if (legalConsentStatus().accepted) {
    startConsentDependentServices();
    void retryPendingCrashReports();
  }
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

ipcMain.handle('get-legal-consent', async () => legalConsentStatus());

ipcMain.handle('accept-legal-consent', async (_event, payload) => {
  if (payload?.privacyAccepted !== true || payload?.termsAccepted !== true) {
    return { success: false, error: 'Both documents must be accepted.' };
  }
  store.set('legalAcceptance', {
    version: LEGAL_DOCUMENT_VERSION,
    acceptedAt: new Date().toISOString()
  });
  startConsentDependentServices();
  void retryPendingCrashReports();
  return { success: true, ...legalConsentStatus() };
});

ipcMain.handle('open-external', async (_event, rawUrl) => {
  try {
    const url = new URL(String(rawUrl || ''));
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported link.');
    await shell.openExternal(url.toString());
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to open link.' };
  }
});

ipcMain.handle('offline-login', async (_event, username) => {
  requireLegalConsent();
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
    requireLegalConsent();
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
  try {
    const servers = getServers();
    let entry = reconcileOptionalMods(await discoverServer(payload.address, payload.manifestPort || null, null, payload.manifestKey || null), false);
    const existing = servers.find((server) => server.id === entry.id);
    if (existing) entry = reconcileOptionalMods({
      ...entry,
      optionalModChoices: existing.optionalModChoices || existing.optionalModSelections,
      optionalModPromptedSignature: existing.optionalModPromptedSignature,
      readAnnouncementIds: existing.readAnnouncementIds || [],
      crashReportSharing: normalizeCrashSharingPreference(existing.crashReportSharing),
      outdatedImpulseWarningDismissed: existing.outdatedImpulseWarningDismissed === true
    }, false);
    const next = [entry, ...servers.filter((server) => server.id !== entry.id)];
    setServers(next);
    return { success: true, server: entry, servers: next };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to add server.', details: error.details };
  }
});

ipcMain.handle('impulse-preview-invitation', async (_event, raw) => {
  try {
    const invitation = typeof raw === 'string' ? parseImpulseDeepLink(raw) : parseImpulseDeepLink(raw?.raw);
    const server = reconcileOptionalMods(await discoverServer(invitation.address, invitation.manifestPort, null, invitation.manifestKey), false);
    const knownIds = new Set((server.manifest.optional_mods || []).map((mod) => mod.id));
    return { success: true, invitation: { ...invitation, optional: invitation.optional.filter((id) => knownIds.has(id)) }, server };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('impulse-consume-deep-links', async () => pendingDeepLinks.splice(0));

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
    if (refreshed.status?.online !== false) void retryPendingCrashReports(serverId);
    return { success: true, server: refreshed, servers: next, details: refreshed.offlineDetails };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to refresh server manifest.', details: error.details };
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
    const candidate = reconcileOptionalMods({
      ...existing,
      optionalModChoices: cleaned
    }, markPrompted === true);
    if ((candidate.optionalModRelationshipErrors || []).length) {
      return { success: false, error: candidate.optionalModRelationshipErrors.join('; '), conflicts: candidate.optionalModRelationshipErrors };
    }
    const updated = candidate;
    const next = servers.map((server) => (server.id === serverId ? updated : server));
    setServers(next);
    return { success: true, server: updated, servers: next };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to update optional mods.' };
  }
});

ipcMain.handle('impulse-dismiss-outdated-version-warning', async (_event, serverId) => {
  try {
    const servers = getServers();
    const existing = servers.find((server) => server.id === serverId);
    if (!existing) return { success: false, error: 'Server not found.' };
    const updated = { ...existing, outdatedImpulseWarningDismissed: true };
    const next = servers.map((server) => (server.id === serverId ? updated : server));
    setServers(next);
    return { success: true, server: updated, servers: next };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to save the warning preference.' };
  }
});

ipcMain.handle('impulse-accept-unverified-mods', async (_event, serverId, signature) => {
  try {
    const servers = getServers();
    const existing = servers.find((server) => server.id === serverId);
    if (!existing) return { success: false, error: 'Server not found.' };
    const cleanSignature = String(signature || '').slice(0, 65536);
    const updated = { ...existing, acceptedUnverifiedModSignature: cleanSignature };
    const next = servers.map((server) => server.id === serverId ? updated : server);
    setServers(next);
    return { success: true, server: updated, servers: next };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to save mod verification choice.' };
  }
});

ipcMain.handle('impulse-respond-crash-sharing', async (_event, reportId, share, remember = true) => {
  try {
    const record = pendingCrashConsents.get(String(reportId || ''));
    if (!record) return { success: false, error: 'Crash report consent request was not found.' };
    pendingCrashConsents.delete(String(reportId));
    let servers = getServers();
    const existing = servers.find((server) => server.id === record.serverId);
    if (!existing) return { success: false, error: 'Server not found.' };
    if (remember === true) {
      const preference = share === true ? 'always' : 'never';
      servers = servers.map((server) => server.id === record.serverId ? { ...server, crashReportSharing: preference } : server);
      setServers(servers);
      if (preference === 'never') await deletePendingCrashReportsForServer(record.serverId);
    }
    if (share !== true) {
      crashShareStatus(record.payload.report_id, record.serverId, 'not-shared', 'Not shared.');
      return { success: true, shared: false, servers };
    }
    record.approvedAt = new Date().toISOString();
    await savePendingCrashRecord(record);
    record.persisted = true;
    void submitCrashRecord(record);
    return { success: true, shared: true, servers };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to save crash report sharing choice.' };
  }
});

ipcMain.handle('impulse-update-crash-sharing', async (_event, serverId, preference) => {
  try {
    const normalized = normalizeCrashSharingPreference(preference);
    const servers = getServers();
    const existing = servers.find((server) => server.id === serverId);
    if (!existing) return { success: false, error: 'Server not found.' };
    const next = servers.map((server) => server.id === serverId ? { ...server, crashReportSharing: normalized } : server);
    setServers(next);
    if (normalized === 'never') {
      for (const [reportId, record] of pendingCrashConsents.entries()) {
        if (record.serverId === serverId) pendingCrashConsents.delete(reportId);
      }
      await deletePendingCrashReportsForServer(serverId);
    }
    return { success: true, server: next.find((server) => server.id === serverId), servers: next };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to update crash report sharing.' };
  }
});

ipcMain.handle('impulse-retry-crash-reports', async (_event, serverId = null) => {
  try {
    await retryPendingCrashReports(serverId || null);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Unable to retry pending crash reports.' };
  }
});

ipcMain.handle('impulse-mark-announcements-read', async (_event, serverId, ids) => {
  const servers = getServers();
  const existing = servers.find((server) => server.id === serverId);
  if (!existing) return { success: false, error: 'Server not found.' };
  const allowed = new Set((existing.manifest?.announcements || []).map((item) => String(item.id)));
  const readAnnouncementIds = [...new Set((ids || []).map(String).filter((id) => allowed.has(id)))];
  const updated = { ...existing, readAnnouncementIds };
  const next = servers.map((server) => server.id === serverId ? updated : server);
  setServers(next);
  return { success: true, server: updated, servers: next };
});

ipcMain.handle('impulse-remove-server', async (_event, serverId) => {
  const next = getServers().filter((server) => server.id !== serverId);
  setServers(next);
  for (const [reportId, record] of pendingCrashConsents.entries()) {
    if (record.serverId === serverId) pendingCrashConsents.delete(reportId);
  }
  await deletePendingCrashReportsForServer(serverId);
  return { success: true, servers: next };
});

ipcMain.handle('impulse-launch-server', async (event, serverId) => {
  requireLegalConsent();
  if (activeLaunch) return { success: false, error: 'Another launch operation is already running.' };
  activeLaunch = { serverId, controller: new AbortController(), startedAt: Date.now() };
  try {
    return await launchServer(event, serverId);
  } catch (error) {
    if (error?.code === 'MOD_VERIFICATION_REQUIRED' && error.server) {
      return { success: false, verificationRequired: true, server: error.server };
    }
    const details = isServerOfflineError(error) ? (error.offlineDetails || await offlineDetails()) : error.details;
    event.sender.send('impulse-launch-error', { error: error.message, serverId, details });
    return { success: false, error: error.message, details };
  } finally {
    if (activeLaunch?.serverId === serverId) activeLaunch = null;
  }
});

ipcMain.handle('impulse-cancel-launch', async (_event, serverId) => {
  if (!activeLaunch || (serverId && activeLaunch.serverId !== serverId)) return { success: false, error: 'No matching launch is running.' };
  activeLaunch.controller.abort();
  return { success: true };
});

ipcMain.handle('impulse-verify-server-files', async (event, serverId) => {
  if (activeGame) return { success: false, error: 'Close Minecraft before verifying game files.' };
  if (activeLaunch) return { success: false, error: 'Another launch operation is already running.' };
  activeLaunch = { serverId, controller: new AbortController(), startedAt: Date.now() };
  try {
    const prepared = await prepareServerFiles(event, serverId, { skipFinalPing: false, requireVerificationAcceptance: false });
    return { success: true, report: prepared.report, server: prepared.merged };
  } catch (error) {
    const details = isServerOfflineError(error) ? (error.offlineDetails || await offlineDetails()) : error.details;
    return { success: false, error: error.message, details, report: error.repairReport || null };
  } finally {
    if (activeLaunch?.serverId === serverId) activeLaunch = null;
  }
});

ipcMain.handle('get-launcher-settings', async () => ({
  minecraftPath: store.get('minecraftPath'),
  updateChannel: updateChannel(),
  javaRuntime: normalizeJavaRuntime(store.get('javaRuntime')),
  javaPath: store.get('javaPath'),
  minMemory: store.get('minMemory'),
  maxMemory: store.get('maxMemory'),
  downloadSettings: store.get('downloadSettings'),
  discordRpc: discordRpcSettings()
}));

ipcMain.handle('get-microphone-permission', async () => microphonePermissionStatus());

ipcMain.handle('request-microphone-permission', async () => requestMicrophonePermission());

ipcMain.handle('update-launcher-settings', async (_event, settings) => {
  const previousUpdateChannel = updateChannel();
  for (const [key, value] of Object.entries(settings || {})) {
    if (value === undefined) continue;
    if (key === 'discordRpc') {
      const normalized = normalizeDiscordRpcSettings(value);
      normalized.userConfigured = true;
      store.set(key, normalized);
      if (!normalized.enabled) destroyDiscordRpcClient().catch(() => {});
      else updateLauncherDiscordActivity(activeGame ? 'connecting' : 'browsing');
    } else if (key === 'downloadSettings') {
      const current = store.get('downloadSettings') || {};
      store.set(key, {
        concurrentDownloads: Math.max(1, Math.min(8, Number(value?.concurrentDownloads) || Number(current.concurrentDownloads) || 4)),
        connectionsPerHost: Math.max(1, Number(value?.connectionsPerHost) || Number(current.connectionsPerHost) || 16),
        timeout: Math.max(30000, Number(value?.timeout) || Number(current.timeout) || 120000)
      });
    } else if (key === 'javaRuntime') {
      const normalized = normalizeJavaRuntime(value, store.get('javaPath'));
      store.set(key, normalized);
      if (normalized === 'auto') store.set('javaPath', null);
    } else if (key === 'updateChannel') {
      store.set(key, normalizeUpdateChannel(value));
    } else {
      store.set(key, value);
    }
  }
  const nextUpdateChannel = updateChannel();
  if (app.isPackaged && nextUpdateChannel !== previousUpdateChannel) {
    configureAutoUpdaterChannel(nextUpdateChannel);
    sendUpdateStatus({ status: 'checking' });
    autoUpdater.checkForUpdates().catch((error) => {
      sendUpdateStatus({ status: 'error', message: error.message || String(error) });
    });
  }
  return { success: true, updateChannel: nextUpdateChannel };
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

ipcMain.handle('get-game-storage', async () => {
  try {
    const minecraftPath = store.get('minecraftPath') || getImpulseMinecraftPath();
    const cache = new CacheManager(minecraftPath);
    const profilesDir = path.join(minecraftPath, 'profiles');
    const [storage, gameBytes] = await Promise.all([
      cache.inspectStorage(profilesDir),
      directorySize(minecraftPath)
    ]);
    return { success: true, storage: { ...storage, cacheFiles: undefined, gameBytes } };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('verify-game-cache', async (event) => {
  if (activeGame || activeLaunch) return { success: false, error: 'Close Minecraft and wait for the current launch before scanning the cache.' };
  try {
    const minecraftPath = store.get('minecraftPath') || getImpulseMinecraftPath();
    const cache = new CacheManager(minecraftPath);
    const result = await cache.verifyCache(path.join(minecraftPath, 'profiles'), (progress) => {
      event.sender.send('impulse-storage-progress', progress);
    });
    for (const file of result.corrupt) await fs.rm(file.filePath, { force: true });
    return { success: true, result: { checked: result.checked, valid: result.valid, corruptRemoved: result.corrupt.length } };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clean-game-cache', async () => {
  if (activeGame || activeLaunch) return { success: false, error: 'Close Minecraft and wait for the current launch before cleaning the cache.' };
  try {
    const minecraftPath = store.get('minecraftPath') || getImpulseMinecraftPath();
    const cache = new CacheManager(minecraftPath);
    const before = await cache.inspectStorage(path.join(minecraftPath, 'profiles'));
    const result = await cache.cleanOrphanedCache(path.join(minecraftPath, 'profiles'));
    return { success: true, removed: result.removed, bytesFreed: before.orphanBytes };
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
    mainWindow.webContents.send('update-status', { ...payload, channel: updateChannel() });
  }
}

function startConsentDependentServices() {
  if (consentDependentServicesStarted) return;
  consentDependentServicesStarted = true;
  setupAutoUpdater();
  updateLauncherDiscordActivity('browsing');
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  configureAutoUpdaterChannel();

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
