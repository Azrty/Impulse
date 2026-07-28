import { FormEvent, useEffect, useMemo, useState } from 'react';
import ReactPlayer from 'react-player';
import {
  AlertTriangle,
  ArrowRight,
  Gauge,
  Loader2,
  LogOut,
  Maximize2,
  Minus,
  Play,
  Plus,
  Server,
  Settings,
  Trash2,
  X
} from 'lucide-react';
import type { CrashReport, DiscordRpcSettings, ImpulseMod, LaunchProgress, OfflineDetails, RunningGame, SavedServer, User as ImpulseUser } from './types';
import impulseIcon from '../assets/icon.png';

type UpdateStatus = {
  status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error';
  startup?: boolean;
  version?: string;
  message?: string;
  percent?: number;
};

const defaultDiscordRpcSettings: DiscordRpcSettings = {
  enabled: true,
  clientId: '1531038946409320539',
  showServer: true,
  showAddress: false,
  showDimension: true,
  showLoader: true,
  showElapsed: true,
  privacyMode: false
};
type JavaRuntimeMode = 'auto' | 'custom';

function normalizeJavaRuntime(value: unknown, javaPath?: string | null): JavaRuntimeMode {
  if (value === 'custom') return 'custom';
  if (value === 'auto') return 'auto';
  if (!value && javaPath) return 'custom';
  return 'auto';
}

function formatBytes(value: number) {
  if (!value) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function progressPercent(progress?: LaunchProgress) {
  if (!progress?.total) return 0;
  return Math.max(0, Math.min(100, Math.round(((progress.progress || 0) / progress.total) * 100)));
}

function optionalModKey(mod: ImpulseMod) {
  return String(mod.sha1 || mod.file_name || mod.name || '').toLowerCase();
}

function optionalSignature(server: SavedServer) {
  return server.optionalModSignature || '';
}

function needsOptionalPrompt(server: SavedServer) {
  return (server.manifest.optional_mods || []).length > 0
    && server.optionalModPromptedSignature !== optionalSignature(server);
}

function minecraftAvatarUrl(user: ImpulseUser | null) {
  const username = String(user?.username || '').trim();
  return username ? `https://api.mcheads.org/head/${encodeURIComponent(username)}/80` : '';
}

function offlineDetailsFromProgress(progress: LaunchProgress | null): OfflineDetails | null {
  if (progress?.status !== 'server-offline') return null;
  const details = progress.details || {};
  const title = typeof details.title === 'string' ? details.title : '';
  const description = typeof details.description === 'string' ? details.description : '';
  const offlineKind = details.offlineKind === 'internet' ? 'internet' : 'server';
  if (!title || !description) {
    return {
      offlineKind,
      title: 'This server seems to be offline',
      description: 'Your internet connection is working, but Impulse cannot reach this Minecraft server right now. Try again later or contact the server owner.'
    };
  }
  return { offlineKind, title, description };
}

function UserAvatar({ user }: { user: ImpulseUser }) {
  const [failed, setFailed] = useState(false);
  const [steveFailed, setSteveFailed] = useState(false);
  const avatar = minecraftAvatarUrl(user);
  const steveAvatar = 'https://api.mcheads.org/head/Steve/80';
  return (
    <div className="grid h-10 w-10 place-items-center overflow-hidden bg-white text-black">
      {avatar && !failed ? (
        <img src={avatar} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : !steveFailed ? (
        <img src={steveAvatar} alt="" className="h-full w-full object-cover" onError={() => setSteveFailed(true)} />
      ) : (
        <span className="text-sm font-semibold">{user.username.slice(0, 1).toUpperCase()}</span>
      )}
    </div>
  );
}

function WindowControls() {
  return (
    <div className="app-drag h-10 flex items-center justify-between border-b border-white/10 bg-black">
      <div className="flex items-center gap-2 px-4 text-sm font-medium tracking-wide text-white">
        <img src={impulseIcon} alt="" className="h-5 w-5 rounded object-cover" />
        <span>Impulse</span>
      </div>
      <div className="app-no-drag flex h-full">
        <button className="w-11 hover:bg-white/10 flex items-center justify-center" onClick={() => window.api?.minimizeWindow()} aria-label="Minimize">
          <Minus size={16} />
        </button>
        <button className="w-11 hover:bg-white/10 flex items-center justify-center" onClick={() => window.api?.maximizeWindow()} aria-label="Maximize">
          <Maximize2 size={14} />
        </button>
        <button className="w-11 hover:bg-white hover:text-black flex items-center justify-center" onClick={() => window.api?.closeWindow()} aria-label="Close">
          <X size={17} />
        </button>
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (user: ImpulseUser) => void }) {
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [offlineLoading, setOfflineLoading] = useState(false);
  const [microsoftLoading, setMicrosoftLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setOfflineLoading(true);
    const result = await window.api?.offlineLogin(username.trim());
    if (result?.success && result.user) onLogin(result.user);
    else setError(result?.error || 'Unable to log in.');
    setOfflineLoading(false);
  };

  const loginWithMicrosoft = async () => {
    setError(null);
    setMicrosoftLoading(true);
    try {
      const result = await window.api?.microsoftLogin();
      if (result?.success && result.user) onLogin(result.user);
      else setError(result?.error || 'Microsoft sign-in failed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microsoft sign-in failed.');
    } finally {
      setMicrosoftLoading(false);
    }
  };

  return (
    <div className="impulse-auth-surface relative flex-1 overflow-hidden bg-black">
      <div className="impulse-auth-grid absolute inset-0 pointer-events-none" />
      <div className="impulse-auth-vignette absolute inset-0 pointer-events-none" />

      <div className="relative z-10 flex min-h-full flex-col lg:flex-row">
        <section className="hidden flex-1 items-center px-14 py-12 lg:flex xl:px-20">
          <div className="impulse-auth-hero max-w-xl">
            <div className="mb-10 flex items-center gap-4">
              <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-lg border border-white/20 bg-white shadow-[0_0_34px_rgba(255,255,255,0.18)]">
                <img src={impulseIcon} alt="" className="h-full w-full object-cover" />
              </div>
              <div>
                <div className="text-2xl font-semibold text-white">Impulse</div>
                <div className="mt-1 text-xs uppercase tracking-[0.22em] text-white/40">Minecraft Launcher</div>
              </div>
            </div>

            <h1 className="max-w-lg text-5xl font-semibold leading-[1.05] text-white xl:text-6xl">
              Launch clean. Sync fast. Connect ready.
            </h1>
            <p className="mt-6 max-w-md text-base leading-7 text-white/60">
              A focused modded launcher for servers that ship the right profile before Minecraft opens.
            </p>

            <div className="mt-12 grid max-w-md grid-cols-3 border border-white/10 bg-white/[0.025]">
              <div className="border-r border-white/10 p-4">
                <div className="text-lg font-semibold text-white">01</div>
                <div className="mt-1 text-xs uppercase tracking-[0.18em] text-white/40">Discover</div>
              </div>
              <div className="border-r border-white/10 p-4">
                <div className="text-lg font-semibold text-white">02</div>
                <div className="mt-1 text-xs uppercase tracking-[0.18em] text-white/40">Sync</div>
              </div>
              <div className="p-4">
                <div className="text-lg font-semibold text-white">03</div>
                <div className="mt-1 text-xs uppercase tracking-[0.18em] text-white/40">Play</div>
              </div>
            </div>
          </div>
        </section>

        <section className="flex min-h-full w-full items-center justify-center px-5 py-10 lg:w-[440px] lg:shrink-0 lg:border-l lg:border-white/10 lg:bg-white/[0.015] xl:w-[480px]">
          <form onSubmit={submit} className="impulse-auth-card w-full max-w-sm rounded-lg border border-white/10 bg-[#0b0b0d]/80 p-7 shadow-[0_28px_80px_rgba(0,0,0,0.62)] backdrop-blur-2xl sm:p-8">
            <div className="mb-8 lg:hidden">
              <div className="mb-4 grid h-14 w-14 place-items-center overflow-hidden rounded-lg border border-white/20 bg-white shadow-[0_0_34px_rgba(255,255,255,0.18)]">
                <img src={impulseIcon} alt="" className="h-full w-full object-cover" />
              </div>
              <h1 className="text-3xl font-semibold text-white">Impulse</h1>
              <p className="mt-2 text-sm leading-6 text-white/55">Launch clean. Sync fast. Connect ready.</p>
            </div>

            <div className="mb-7 hidden lg:block">
              <p className="text-xs uppercase tracking-[0.22em] text-white/40">Welcome back</p>
              <h2 className="mt-3 text-2xl font-semibold text-white">Sign in to Impulse</h2>
              <p className="mt-2 text-sm leading-6 text-white/55">Premium Minecraft access for synced server profiles.</p>
            </div>

            <button
              type="button"
              onClick={loginWithMicrosoft}
              disabled={microsoftLoading || offlineLoading}
              className="group flex h-12 w-full items-center justify-center gap-3 rounded-lg bg-white px-4 text-sm font-semibold text-black transition hover:bg-white/[0.88] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {microsoftLoading ? (
                <Loader2 size={17} className="animate-spin" />
              ) : (
                <span className="grid grid-cols-2 gap-0.5">
                  <span className="h-2.5 w-2.5 bg-black" />
                  <span className="h-2.5 w-2.5 bg-black" />
                  <span className="h-2.5 w-2.5 bg-black" />
                  <span className="h-2.5 w-2.5 bg-black" />
                </span>
              )}
              <span>{microsoftLoading ? 'Waiting for Microsoft...' : 'Sign in with Microsoft'}</span>
              {!microsoftLoading && <ArrowRight size={16} className="transition group-hover:translate-x-0.5" />}
            </button>

            <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-[0.18em] text-white/35">
              <span className="h-px flex-1 bg-white/10" />
              Offline profile
              <span className="h-px flex-1 bg-white/10" />
            </div>

            <label className="block text-xs uppercase tracking-[0.18em] text-white/50">Username</label>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-2 h-12 w-full rounded-lg border border-white/[0.12] bg-black/70 px-3 text-white outline-none transition placeholder:text-white/25 focus:border-white/60 focus:bg-black"
              placeholder="Player"
            />

            {error && (
              <div className="mt-4 flex items-start gap-3 rounded-lg border border-red-300/20 bg-red-300/[0.08] p-3 text-sm text-red-200">
                <AlertTriangle className="mt-0.5 shrink-0" size={16} />
                <span className="break-words">{error}</span>
              </div>
            )}

            <button
              disabled={offlineLoading || microsoftLoading}
              className="mt-5 flex h-12 w-full items-center justify-center rounded-lg border border-white/[0.12] px-4 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
            >
              {offlineLoading ? (
                <>
                  <Loader2 size={16} className="mr-2 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Continue Offline'
              )}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function AddServerModal({
  onClose,
  onAdded
}: {
  onClose: () => void;
  onAdded: (servers: SavedServer[], selectedId: string) => void;
}) {
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await window.api?.addServer({
        address
      });
      if (result?.success && result.servers && result.server) {
        onAdded(result.servers, result.server.id);
        onClose();
      } else {
        setError(result?.error || 'Unable to add server.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add server.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 px-5">
      <form onSubmit={submit} className="w-full max-w-md border border-white/15 bg-[#050505] p-5 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Add Server</h2>
            <p className="text-sm text-white/55">Impulse discovers the manifest port from the server ping, then falls back to 25850.</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-white/10" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <label className="block text-xs uppercase tracking-[0.18em] text-white/50">Server IP</label>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          className="mt-2 h-11 w-full border border-white/15 bg-black px-3 text-white outline-none focus:border-white"
          placeholder="play.example.com:25565"
        />
        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
        <button disabled={loading} className="mt-5 h-11 w-full bg-white font-medium text-black hover:bg-white/85 disabled:opacity-60">
          {loading ? 'Discovering...' : 'Add Server'}
        </button>
      </form>
    </div>
  );
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState({
    minecraftPath: '',
    javaRuntime: 'auto' as JavaRuntimeMode,
    javaPath: '',
    minMemory: 1024,
    maxMemory: 4096,
    discordRpc: defaultDiscordRpcSettings
  });
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);

  useEffect(() => {
    window.api?.getLauncherSettings().then((data) => {
      setSettings({
        minecraftPath: data.minecraftPath,
        javaRuntime: normalizeJavaRuntime(data.javaRuntime, data.javaPath),
        javaPath: data.javaPath || '',
        minMemory: data.minMemory,
        maxMemory: data.maxMemory,
        discordRpc: { ...defaultDiscordRpcSettings, ...(data.discordRpc || {}) }
      });
    });
  }, []);

  const setDiscordRpc = (patch: Partial<DiscordRpcSettings>) => {
    setSettings((current) => ({
      ...current,
      discordRpc: {
        ...current.discordRpc,
        ...patch
      }
    }));
  };

  const save = async () => {
    await window.api?.updateLauncherSettings({
      minecraftPath: settings.minecraftPath,
      javaRuntime: settings.javaRuntime,
      javaPath: settings.javaPath || null,
      minMemory: Number(settings.minMemory),
      maxMemory: Number(settings.maxMemory),
      discordRpc: settings.discordRpc
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const clearGameFiles = async () => {
    const confirmed = window.confirm(
      'Clear downloaded Minecraft versions, libraries, assets, profiles, cached mods, logs, and bundled Java runtimes for Impulse? Accounts and saved servers will stay.'
    );
    if (!confirmed) return;

    setClearing(true);
    setClearMessage(null);
    setClearError(null);
    try {
      const result = await window.api?.clearGameFiles();
      if (!result?.success) {
        setClearError(result?.error || 'Unable to clear game files.');
        return;
      }
      setClearMessage('Game files cleared. Impulse will redownload what it needs on next launch.');
    } catch (error) {
      setClearError(error instanceof Error ? error.message : 'Unable to clear game files.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 px-5">
      <div className="max-h-[calc(100vh-48px)] w-full max-w-xl overflow-y-auto border border-white/15 bg-[#050505] p-5">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Launcher Settings</h2>
          <button onClick={onClose} className="p-2 hover:bg-white/10" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="grid gap-4">
          <label className="block">
            <span className="text-xs uppercase tracking-[0.18em] text-white/50">Minecraft Path</span>
            <input className="mt-2 h-11 w-full border border-white/15 bg-black px-3 outline-none focus:border-white" value={settings.minecraftPath} onChange={(event) => setSettings({ ...settings, minecraftPath: event.target.value })} />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-[0.18em] text-white/50">Java Runtime</span>
            <select
              className="mt-2 h-11 w-full border border-white/15 bg-black px-3 outline-none focus:border-white"
              value={settings.javaRuntime}
              onChange={(event) => setSettings({ ...settings, javaRuntime: event.target.value as JavaRuntimeMode })}
            >
              <option value="auto">Auto / Mojang Java</option>
              <option value="custom">Custom Java Path</option>
            </select>
            <p className="mt-2 text-xs text-white/45">
              {settings.javaRuntime === 'custom'
                ? 'Use a specific java or java.exe executable.'
                : 'Impulse uses the managed Mojang Java runtime.'}
            </p>
          </label>
          {settings.javaRuntime === 'custom' && (
            <label className="block">
              <span className="text-xs uppercase tracking-[0.18em] text-white/50">Custom Java Path</span>
              <input className="mt-2 h-11 w-full border border-white/15 bg-black px-3 outline-none focus:border-white" value={settings.javaPath} onChange={(event) => setSettings({ ...settings, javaPath: event.target.value })} placeholder="C:\\Java\\bin\\java.exe" />
            </label>
          )}
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs uppercase tracking-[0.18em] text-white/50">Min Memory MB</span>
              <input className="mt-2 h-11 w-full border border-white/15 bg-black px-3 outline-none focus:border-white" value={settings.minMemory} type="number" onChange={(event) => setSettings({ ...settings, minMemory: Number(event.target.value) })} />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-[0.18em] text-white/50">Max Memory MB</span>
              <input className="mt-2 h-11 w-full border border-white/15 bg-black px-3 outline-none focus:border-white" value={settings.maxMemory} type="number" onChange={(event) => setSettings({ ...settings, maxMemory: Number(event.target.value) })} />
            </label>
          </div>
          <div className="border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">Discord Rich Presence</p>
                <p className="mt-1 text-xs text-white/50">Show Impulse and live Minecraft context in Discord.</p>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-white/70">
                <input
                  type="checkbox"
                  checked={settings.discordRpc.enabled}
                  onChange={(event) => setDiscordRpc({ enabled: event.target.checked })}
                />
                Enabled
              </label>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {[
                ['showServer', 'Show server name'],
                ['showAddress', 'Show server address'],
                ['showDimension', 'Show dimension'],
                ['showLoader', 'Show version/loader'],
                ['showElapsed', 'Show elapsed time'],
                ['privacyMode', 'Privacy mode']
              ].map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2 border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/70">
                  <input
                    type="checkbox"
                    checked={settings.discordRpc[key as keyof DiscordRpcSettings] as boolean}
                    onChange={(event) => setDiscordRpc({ [key]: event.target.checked } as Partial<DiscordRpcSettings>)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="border border-red-300/20 bg-red-950/10 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-white">Game Files</p>
                <p className="mt-1 text-xs text-white/50">Clear downloaded Minecraft data for a fresh reinstall.</p>
              </div>
              <button
                onClick={clearGameFiles}
                disabled={clearing}
                className="inline-flex h-10 items-center justify-center gap-2 border border-red-200/25 px-3 text-sm font-medium text-red-100 transition hover:border-red-100/60 hover:bg-red-200/10 disabled:opacity-50"
              >
                {clearing ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                {clearing ? 'Clearing...' : 'Clear Game Files'}
              </button>
            </div>
            {clearMessage && <p className="mt-3 text-xs text-white/55">{clearMessage}</p>}
            {clearError && <p className="mt-3 text-xs text-red-300">{clearError}</p>}
          </div>
        </div>
        <button onClick={save} className="mt-5 h-11 w-full bg-white font-medium text-black hover:bg-white/85">
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function UpdateBanner({ update }: { update: UpdateStatus | null }) {
  if (!update || update.status === 'up-to-date' || update.status === 'checking') return null;

  const label = update.status === 'available'
    ? `Update ${update.version || ''} available`
    : update.status === 'downloading'
      ? `Downloading update ${Math.round(update.percent || 0)}%`
      : update.status === 'ready'
        ? `Update ${update.version || ''} ready`
        : update.message || 'Update check failed';

  return (
    <div className="app-no-drag fixed bottom-5 right-5 z-40 w-[min(360px,calc(100vw-40px))] rounded-lg border border-white/15 bg-black/85 p-4 text-white shadow-2xl backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <img src={impulseIcon} alt="" className="mt-0.5 h-8 w-8 rounded object-cover" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{label}</p>
          <p className="mt-1 text-xs text-white/50">Impulse updates are served from impulse.epivalent.com.</p>
          {update.status === 'downloading' && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-white transition-all" style={{ width: `${Math.max(0, Math.min(100, update.percent || 0))}%` }} />
            </div>
          )}
          {update.status === 'available' && (
            <button onClick={() => window.api?.downloadUpdate()} className="mt-3 rounded-md border border-white/20 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white hover:text-black">
              Download
            </button>
          )}
          {update.status === 'ready' && (
            <button onClick={() => window.api?.installUpdate()} className="mt-3 rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-white/85">
              Restart
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ServerDetail({
  server,
  progress,
  error,
  launching,
  running,
  crash,
  onLaunch,
  onRemove,
  onOptionalChange
}: {
  server: SavedServer | null;
  progress: LaunchProgress | null;
  error: string | null;
  launching: boolean;
  running: boolean;
  crash: CrashReport | null;
  onLaunch: () => void;
  onRemove: () => void;
  onOptionalChange: (serverId: string, selections: Record<string, boolean>) => void;
}) {
  if (!server) {
    return (
      <div className="flex h-full items-center justify-center text-center text-white/55">
        <div>
          <Server size={42} className="mx-auto mb-4 text-white/40" />
          <p>Add a server to sync its modded profile.</p>
        </div>
      </div>
    );
  }

  const manifest = server.manifest;
  const pct = progressPercent(progress || undefined);
  const optionalMods = manifest.optional_mods || [];
  const optionalSelections = server.optionalModSelections || {};
  const busy = launching || running;
  const offlineCard = offlineDetailsFromProgress(progress);

  const setOptionalEnabled = (mod: ImpulseMod, enabled: boolean) => {
    onOptionalChange(server.id, {
      ...optionalSelections,
      [optionalModKey(mod)]: enabled
    });
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="relative min-h-[310px] border-b border-white/10 bg-[#070707]">
        {manifest.video_background_url ? (
          <ReactPlayer className="media-video absolute inset-0" url={manifest.video_background_url} playing muted loop width="100%" height="100%" />
        ) : manifest.banner_url ? (
          <img src={manifest.banner_url} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/65 to-black/25" />
        <button
          onClick={onRemove}
          className="absolute right-6 top-6 z-20 grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-black/35 text-white shadow-[0_10px_34px_rgba(0,0,0,0.35)] backdrop-blur-md transition hover:border-white/40 hover:bg-white/85 hover:text-black"
          aria-label="Remove server"
          title="Remove server"
        >
          <Trash2 size={18} />
        </button>
        <div className="relative z-10 flex min-h-[310px] flex-col justify-end p-8">
          <div className="mb-5 flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center overflow-hidden border border-white/20 bg-white text-black">
              {manifest.icon_url ? <img src={manifest.icon_url} className="h-full w-full object-cover" alt="" /> : <Server size={28} />}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-4xl font-semibold">{manifest.name}</h1>
              <p className="mt-1 text-sm text-white/65">{server.host}:{server.port}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={onLaunch} disabled={busy} className="flex h-11 items-center gap-2 bg-white px-5 font-medium text-black hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-60">
              {running ? <Gauge size={17} /> : <Play size={17} />}
              {running ? 'Running' : launching ? 'Launching...' : 'Launch'}
            </button>
            <div className="ml-auto flex items-center gap-2 text-sm text-white/70">
              <span className={`h-2 w-2 rounded-full ${server.status.online ? 'bg-white' : 'bg-red-300'}`} />
              {server.status.online ? `${server.status.players?.online ?? 0}/${server.status.players?.max ?? 0} online` : server.status.error || 'Offline'}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 p-6 lg:grid-cols-[1fr_330px]">
        <section className="border border-white/10 bg-white/[0.025] p-5">
          {offlineCard && (
            <div className="mb-5 border border-red-300/20 bg-black p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 shrink-0 text-red-300" size={18} />
                <div className="min-w-0">
                  <div className="font-medium">{offlineCard.title}</div>
                  <p className="mt-1 break-words text-sm leading-6 text-white/60">{offlineCard.description}</p>
                </div>
              </div>
            </div>
          )}
          <h2 className="mb-2 text-lg font-semibold">Server</h2>
          <p className="text-sm leading-6 text-white/70">{manifest.description || 'No description provided.'}</p>

          {(progress || error || crash) && !offlineCard && (
            <div className="mt-5 border border-white/10 bg-black p-4">
              <div className="mb-3 flex items-start gap-3">
                {error || crash ? <AlertTriangle className="mt-0.5 text-red-300" size={18} /> : <Gauge className="mt-0.5 text-white" size={18} />}
                <div className="min-w-0">
                  <div className="font-medium">{error || crash ? 'Launch Error' : progress?.status || 'Working'}</div>
                  <p className="break-words text-sm text-white/60">
                    {error || (crash ? `Minecraft crashed with exit code ${crash.code ?? 'unknown'}.` : progress?.message)}
                  </p>
                  {crash?.logPath && <p className="mt-1 break-words text-xs text-white/35">{crash.logPath}</p>}
                </div>
              </div>
              {crash?.crashLog && (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-white/70 scrollbar-thin">
                  {crash.crashLog}
                </pre>
              )}
              {!error && !crash && (
                <div className="h-2 bg-white/10">
                  <div className="h-full bg-white transition-all" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          )}

          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-medium">Required Mods</h3>
              <span className="text-sm text-white/50">{manifest.mods.length} files</span>
            </div>
            <div className="divide-y divide-white/10 border border-white/10">
              {manifest.mods.length === 0 ? (
                <div className="p-4 text-sm text-white/50">No required server mods.</div>
              ) : (
                manifest.mods.map((mod) => (
                  <div key={`${mod.sha1}-${mod.file_name}`} className="flex items-center justify-between gap-4 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{mod.name}</p>
                      <p className="mod-description-clamp text-xs text-white/45">{mod.description || mod.file_name}</p>
                      {mod.description && <p className="truncate text-xs text-white/30">{mod.file_name}</p>}
                    </div>
                    <div className="shrink-0 text-right text-xs text-white/45">
                      <div>{formatBytes(mod.size)}</div>
                      <div>Required</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-medium">Optional Mods</h3>
              <span className="text-sm text-white/50">{optionalMods.length} files</span>
            </div>
            <div className="divide-y divide-white/10 border border-white/10">
              {optionalMods.length === 0 ? (
                <div className="p-4 text-sm text-white/50">No optional server mods.</div>
              ) : (
                optionalMods.map((mod) => {
                  const checked = optionalSelections[optionalModKey(mod)] === true;
                  return (
                    <label key={`${mod.sha1}-${mod.file_name}`} className="flex cursor-pointer items-center justify-between gap-4 p-3 transition hover:bg-white/[0.035]">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => setOptionalEnabled(mod, event.currentTarget.checked)}
                          className="mt-1 h-4 w-4 accent-white"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{mod.name}</p>
                          <p className="mod-description-clamp text-xs text-white/45">{mod.description || mod.file_name}</p>
                          {mod.description && <p className="truncate text-xs text-white/30">{mod.file_name}</p>}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-xs text-white/45">
                        <div>{formatBytes(mod.size)}</div>
                        <div>{checked ? 'Enabled' : 'Disabled'}</div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </section>

        <aside className="border border-white/10 bg-white/[0.025] p-5">
          <h2 className="mb-4 text-lg font-semibold">Profile</h2>
          <div className="space-y-4 text-sm">
            <div>
              <div className="text-white/45">Minecraft</div>
              <div>{manifest.minecraft.version}</div>
            </div>
            <div>
              <div className="text-white/45">{manifest.minecraft.loader === 'neoforge' ? 'NeoForge' : 'Forge'}</div>
              <div>{manifest.minecraft.loader_version}</div>
            </div>
            <div>
              <div className="text-white/45">Auto Connect</div>
              <div>{manifest.server.auto_connect ? `${manifest.server.address}:${manifest.server.port}` : 'Disabled'}</div>
            </div>
            <div>
              <div className="text-white/45">Manifest Endpoint</div>
              <div>{server.host}:{server.manifestPort}</div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function OptionalModsModal({
  server,
  onCancel,
  onLaunch
}: {
  server: SavedServer;
  onCancel: () => void;
  onLaunch: (selections: Record<string, boolean>) => void;
}) {
  const [selections, setSelections] = useState<Record<string, boolean>>(server.optionalModSelections || {});
  const optionalMods = server.manifest.optional_mods || [];
  const changed = !!server.optionalModPromptedSignature;

  const setEnabled = (mod: ImpulseMod, enabled: boolean) => {
    setSelections((current) => ({ ...current, [optionalModKey(mod)]: enabled }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm">
      <div className="w-full max-w-2xl border border-white/15 bg-[#080808] shadow-2xl">
        <div className="border-b border-white/10 p-5">
          <h2 className="text-xl font-semibold">{changed ? 'The server added new optional mods' : 'Choose optional mods'}</h2>
          <p className="mt-1 text-sm text-white/55">
            Select the optional mods you want enabled for {server.manifest.name}. You can change this later from the server mod list.
          </p>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-5">
          <div className="divide-y divide-white/10 border border-white/10">
            {optionalMods.map((mod) => {
              const checked = selections[optionalModKey(mod)] === true;
              return (
                <label key={`${mod.sha1}-${mod.file_name}`} className="flex cursor-pointer items-center justify-between gap-4 p-3 transition hover:bg-white/[0.035]">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => setEnabled(mod, event.currentTarget.checked)}
                      className="mt-1 h-4 w-4 accent-white"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{mod.name}</p>
                      <p className="mod-description-clamp text-xs text-white/45">{mod.description || mod.file_name}</p>
                      {mod.description && <p className="truncate text-xs text-white/30">{mod.file_name}</p>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-white/45">
                    <div>{formatBytes(mod.size)}</div>
                    <div>{checked ? 'Enabled' : 'Disabled'}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-white/10 p-5">
          <button onClick={onCancel} className="h-10 border border-white/15 px-4 text-sm text-white/70 hover:bg-white/10">
            Cancel
          </button>
          <button onClick={() => onLaunch(selections)} className="flex h-10 items-center gap-2 bg-white px-4 text-sm font-medium text-black hover:bg-white/85">
            <Play size={16} />
            Launch
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<ImpulseUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [progress, setProgress] = useState<LaunchProgress | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [runningGame, setRunningGame] = useState<RunningGame | null>(null);
  const [crashReport, setCrashReport] = useState<CrashReport | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [optionalPromptServer, setOptionalPromptServer] = useState<SavedServer | null>(null);

  useEffect(() => {
    let cancelled = false;

    window.api?.getCurrentUser().then((result) => {
      if (cancelled) return;
      if (result.success && result.user) setUser(result.user);
      setAuthChecked(true);
    });

    const loadServers = async () => {
      const data = await window.api?.listServers();
      if (cancelled || !data) return;

      setServers(data);
      setSelectedId((current) => current || data[0]?.id || null);

      await Promise.allSettled(data.map(async (server) => {
        if (cancelled) return;
        try {
          const result = await window.api?.refreshServer(server.id);
          if (!cancelled && result?.success && result.server) {
            setServers((current) => current.map((entry) => (
              entry.id === result.server?.id ? result.server : entry
            )));
          }
        } catch {
          // Startup refresh is best-effort; keep the saved server visible.
        }
      }));
    };

    loadServers();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanups = [
      window.api?.onLaunchProgress((data) => {
        setProgress(data);
        setLaunchError(null);
        setCrashReport(null);
      }),
      window.api?.onLaunchError((data) => {
        if (data.error === 'The server is offline') {
          setProgress({ status: 'server-offline', message: 'The server is offline', progress: 0, total: 100, details: data.details });
          setLaunchError(null);
        } else {
          setLaunchError(data.error);
          setProgress(null);
        }
        setLaunchingId(null);
        setRunningGame(null);
      }),
      window.api?.onLaunched((data) => {
        setRunningGame(data);
        setProgress(null);
        setLaunchingId(null);
      }),
      window.api?.onGameClosed((data) => {
        setRunningGame((current) => (current?.serverId === data.serverId ? null : current));
        setLaunchingId((current) => (current === data.serverId ? null : current));
        if (data.crashed) {
          setLaunchError(null);
          setCrashReport(data);
        }
      }),
      window.api?.onUpdateStatus((data) => {
        setUpdateStatus(data);
      })
    ].filter(Boolean) as Array<() => void>;
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedId) || null,
    [servers, selectedId]
  );
  const selectedServerIsLaunching = !!selectedServer && launchingId === selectedServer.id;
  const selectedProgress = selectedServer && (selectedServerIsLaunching || progress?.status === 'server-offline') ? progress : null;

  const removeSelected = async () => {
    if (!selectedServer) return;
    const result = await window.api?.removeServer(selectedServer.id);
    if (result?.success && result.servers) {
      setServers(result.servers);
      setSelectedId(result.servers[0]?.id || null);
    }
  };

  const updateOptionalMods = async (serverId: string, selections: Record<string, boolean>, markPrompted = false) => {
    const result = await window.api?.updateOptionalMods(serverId, selections, markPrompted);
    if (result?.success && result.servers) setServers(result.servers);
    if (result?.success && result.server) return result.server;
    if (!result?.success) setLaunchError(result?.error || 'Unable to update optional mods.');
    return null;
  };

  const continueLaunch = async (serverId: string) => {
    if (runningGame) return;
    setCrashReport(null);
    setProgress({ status: 'queued', message: 'Preparing launch...', progress: 0, total: 100 });
    let result;
    try {
      result = await window.api?.launchServer(serverId);
    } catch (err) {
      setProgress(null);
      setLaunchError(err instanceof Error ? err.message : 'Launch failed.');
      setLaunchingId(null);
      return;
    }
    if (!result?.success) {
      if (result?.error === 'The server is offline') {
        setProgress({ status: 'server-offline', message: 'The server is offline', progress: 0, total: 100, details: result.details });
        setLaunchError(null);
      } else {
        setProgress(null);
        setLaunchError(result?.error || 'Launch failed.');
      }
      setLaunchingId(null);
    }
  };

  const refreshBeforeLaunch = async (serverId: string) => {
    if (runningGame) return null;
    setProgress({ status: 'refreshing', message: 'Refreshing server manifest...', progress: 0, total: 100 });
    setLaunchError(null);
    setCrashReport(null);
    setLaunchingId(serverId);

    let refreshResult;
    try {
      refreshResult = await window.api?.refreshServer(serverId);
    } catch (err) {
      setProgress(null);
      setLaunchError(err instanceof Error ? err.message : 'Refresh failed.');
      setLaunchingId(null);
      return;
    }
    if (!refreshResult?.success) {
      setProgress(null);
      setLaunchError(refreshResult?.error || 'Refresh failed.');
      setLaunchingId(null);
      return;
    }
    if (refreshResult.servers) setServers(refreshResult.servers);
    const refreshedServer = refreshResult.server || refreshResult.servers?.find((server) => server.id === serverId) || null;
    if (refreshedServer?.status?.online === false) {
      setProgress({
        status: 'server-offline',
        message: refreshedServer.status.error || 'The server is offline',
        progress: 0,
        total: 100,
        details: refreshResult.details
      });
      setLaunchingId(null);
      return null;
    }
    return refreshedServer;
  };

  const launchSelected = async () => {
    if (!selectedServer) return;
    const serverId = selectedServer.id;
    const refreshedServer = await refreshBeforeLaunch(serverId);
    if (!refreshedServer) return;
    if (needsOptionalPrompt(refreshedServer)) {
      setProgress(null);
      setOptionalPromptServer(refreshedServer);
      return;
    }
    await continueLaunch(serverId);
  };

  if (!authChecked) {
    return <div className="grid h-screen place-items-center bg-black text-white">Loading Impulse...</div>;
  }

  return (
    <div className="flex h-screen flex-col bg-black text-white">
      <WindowControls />
      {!user ? (
        <Login onLogin={setUser} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r border-white/10 bg-[#050505]">
            <div className="border-b border-white/10 p-4">
              <div className="flex items-center gap-3">
                <UserAvatar user={user} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{user.username}</p>
                  <p className="text-xs text-white/45">{user.type === 'microsoft' ? 'Microsoft account' : 'Offline account'}</p>
                </div>
                <button onClick={async () => { await window.api?.logout(); setUser(null); }} className="p-2 hover:bg-white/10" aria-label="Logout">
                  <LogOut size={17} />
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">Servers</h2>
              <button onClick={() => setShowAdd(true)} className="p-2 hover:bg-white/10" aria-label="Add server">
                <Plus size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin">
              {servers.length === 0 ? (
                <button onClick={() => setShowAdd(true)} className="w-full border border-dashed border-white/15 p-4 text-left text-sm text-white/55 hover:border-white/35">
                  Add your first Impulse server.
                </button>
              ) : (
                <div className="space-y-1">
                  {servers.map((server) => (
                    <button
                      key={server.id}
                      onClick={() => {
                        setSelectedId(server.id);
                        if (progress?.status === 'server-offline') setProgress(null);
                      }}
                      className={`group flex w-full items-center gap-3 rounded-md p-3 text-left transition ${
                        selectedId === server.id
                          ? 'bg-white text-black shadow-[0_8px_24px_rgba(255,255,255,0.08)] hover:bg-white'
                          : 'text-white hover:bg-white/[0.07]'
                      }`}
                    >
                      <div className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded border transition ${
                        selectedId === server.id
                          ? 'border-black/15 bg-black text-white'
                          : 'border-white/10 bg-white/[0.06] text-white group-hover:border-white/20 group-hover:bg-white/[0.1]'
                      }`}>
                        {server.manifest.icon_url ? <img src={server.manifest.icon_url} alt="" className="h-full w-full object-cover" /> : <Server size={18} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{server.manifest.name}</p>
                        <p className={`truncate text-xs ${selectedId === server.id ? 'text-black/60' : 'text-white/45'}`}>{server.host}:{server.port}</p>
                      </div>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${server.status.online ? (selectedId === server.id ? 'bg-black' : 'bg-white/70') : 'bg-red-300'}`} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="border-t border-white/10 p-3">
              <button onClick={() => setShowSettings(true)} className="flex w-full items-center gap-2 p-3 text-sm text-white/70 hover:bg-white/10">
                <Settings size={17} />
                Settings
              </button>
            </div>
          </aside>
          <main className="min-w-0 flex-1">
            <ServerDetail
              server={selectedServer}
              progress={selectedProgress}
              error={launchError}
              launching={selectedServerIsLaunching}
              running={!!runningGame}
              crash={selectedServer && crashReport?.serverId === selectedServer.id ? crashReport : null}
              onLaunch={launchSelected}
              onRemove={removeSelected}
              onOptionalChange={updateOptionalMods}
            />
          </main>
          {showAdd && (
            <AddServerModal
              onClose={() => setShowAdd(false)}
              onAdded={(nextServers, nextSelectedId) => {
                setServers(nextServers);
                setSelectedId(nextSelectedId);
              }}
            />
          )}
          {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
          {optionalPromptServer && (
            <OptionalModsModal
              server={optionalPromptServer}
              onCancel={() => {
                setOptionalPromptServer(null);
                setLaunchingId(null);
              }}
              onLaunch={async (selections) => {
                const updated = await updateOptionalMods(optionalPromptServer.id, selections, true);
                if (!updated) return;
                setOptionalPromptServer(null);
                await continueLaunch(updated.id);
              }}
            />
          )}
        </div>
      )}
      <UpdateBanner update={updateStatus} />
    </div>
  );
}
