import { FormEvent, Fragment, useEffect, useMemo, useState } from 'react';
import ReactPlayer from 'react-player';
import {
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  FileText,
  Gauge,
  HardDrive,
  Loader2,
  LockKeyhole,
  LogOut,
  Maximize2,
  Mic,
  Minus,
  Play,
  Plus,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react';
import type { CrashReport, DiscordRpcSettings, GameStorage, ImpulseInvitation, ImpulseMod, LaunchProgress, OfflineDetails, OptionalModCategory, RunningGame, SavedServer, User as ImpulseUser } from './types';
import { IMPULSE_MOD_VERSION } from './version';
import impulseIcon from '../assets/icon.png';

type UpdateStatus = {
  status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error';
  channel?: UpdateChannel;
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
type UpdateChannel = 'stable' | 'beta';

function isBareJavaCommand(value?: string | null): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'java' || normalized === 'java.exe';
}

function normalizeJavaRuntime(value: unknown, javaPath?: string | null): JavaRuntimeMode {
  if (value === 'custom') return isBareJavaCommand(javaPath) ? 'auto' : 'custom';
  if (value === 'auto') return 'auto';
  if (!value && javaPath && !isBareJavaCommand(javaPath)) return 'custom';
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

type OptionalModGroup = OptionalModCategory & { mods: ImpulseMod[] };

function optionalModGroups(server: SavedServer): OptionalModGroup[] {
  const categories = [...(server.manifest.optional_mod_categories || [])]
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  const groups = new Map<string, OptionalModGroup>();
  for (const category of categories) groups.set(category.id, { ...category, mods: [] });
  const ungrouped: OptionalModGroup = {
    id: 'ungrouped',
    name: 'Ungrouped',
    description: '',
    default_enabled: false,
    order: Number.MAX_SAFE_INTEGER,
    mods: []
  };
  for (const mod of server.manifest.optional_mods || []) {
    const group = mod.category_id ? groups.get(mod.category_id) : null;
    (group || ungrouped).mods.push(mod);
  }
  const visible = Array.from(groups.values()).filter((group) => group.mods.length > 0);
  if (ungrouped.mods.length > 0) visible.push(ungrouped);
  return visible;
}

function optionalSignature(server: SavedServer) {
  return server.optionalModSignature || '';
}

function needsOptionalPrompt(server: SavedServer) {
  return (server.manifest.optional_mods || []).length > 0
    && server.optionalModPromptedSignature !== optionalSignature(server);
}

function deriveOptionalUiState(server: SavedServer, choices: Record<string, boolean>) {
  const required = server.manifest.mods || [];
  const optional = server.manifest.optional_mods || [];
  const cleanId = (value: string) => String(value || '').toLowerCase();
  const all = new Map([...required, ...optional].map((mod) => [cleanId(mod.id), mod]));
  const selectedIds = new Set(required.map((mod) => cleanId(mod.id)).filter(Boolean));
  const requiredBy: Record<string, string[]> = {};
  const queue: string[] = Array.from(selectedIds);
  optional.forEach((mod) => {
    const id = cleanId(mod.id);
    if (choices[optionalModKey(mod)] === true && id) { selectedIds.add(id); queue.push(id); }
  });
  while (queue.length) {
    const parent = all.get(queue.shift() || '');
    for (const dependencyId of parent?.dependencies || []) {
      const id = cleanId(dependencyId);
      const dependency = all.get(id);
      if (!dependency) continue;
      if (!dependency.required) requiredBy[optionalModKey(dependency)] = [...new Set([...(requiredBy[optionalModKey(dependency)] || []), parent?.name || parent?.id || 'another mod'])];
      if (selectedIds.has(id)) continue;
      selectedIds.add(id);
      queue.push(id);
    }
  }
  return {
    selections: Object.fromEntries(optional.map((mod) => [optionalModKey(mod), selectedIds.has(cleanId(mod.id))])),
    requiredBy,
    selectedIds
  };
}

type OptionalConflictDecision = {
  next: Record<string, boolean>;
  requestedNames: string[];
  disableNames: string[];
  blockedMessage?: string;
};

function planOptionalChange(
  server: SavedServer,
  choices: Record<string, boolean>,
  requestedMods: ImpulseMod[],
  enabled: boolean
): OptionalConflictDecision {
  const next = { ...choices };
  requestedMods.forEach((mod) => { next[optionalModKey(mod)] = enabled; });
  const requestedNames = requestedMods.map((mod) => mod.name);
  if (!enabled) return { next, requestedNames, disableNames: [] };

  const required = server.manifest.mods || [];
  const optional = server.manifest.optional_mods || [];
  const allMods = [...required, ...optional];
  const cleanId = (value: string) => String(value || '').toLowerCase();
  const byId = new Map(allMods.map((mod) => [cleanId(mod.id), mod]));
  const requiredIds = new Set(required.map((mod) => cleanId(mod.id)).filter(Boolean));
  const protectedIds = new Set(requiredIds);
  const dependencyQueue = requestedMods.map((mod) => cleanId(mod.id)).filter(Boolean);
  dependencyQueue.forEach((id) => protectedIds.add(id));

  while (dependencyQueue.length) {
    const parent = byId.get(dependencyQueue.shift() || '');
    for (const dependencyValue of parent?.dependencies || []) {
      const dependencyId = cleanId(dependencyValue);
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        return {
          next: choices,
          requestedNames,
          disableNames: [],
          blockedMessage: `${parent?.name || 'This mod'} requires ${dependencyValue}, but the server did not publish that dependency.`
        };
      }
      if (protectedIds.has(dependencyId)) continue;
      protectedIds.add(dependencyId);
      dependencyQueue.push(dependencyId);
    }
  }

  const selected = deriveOptionalUiState(server, next).selectedIds;
  const optionalIds = new Set(optional.map((mod) => cleanId(mod.id)).filter(Boolean));
  const disableIds = new Set<string>();
  const visitedPairs = new Set<string>();

  for (const sourceId of selected) {
    const source = byId.get(sourceId);
    if (!source) continue;
    for (const conflictValue of source.conflicts || []) {
      const targetId = cleanId(conflictValue);
      if (!selected.has(targetId) || sourceId === targetId) continue;
      const pair = [sourceId, targetId].sort().join('|');
      if (visitedPairs.has(pair)) continue;
      visitedPairs.add(pair);
      const sourceProtected = protectedIds.has(sourceId);
      const targetProtected = protectedIds.has(targetId);
      if (!sourceProtected && !targetProtected) continue;
      if (sourceProtected && targetProtected) {
        const sourceName = byId.get(sourceId)?.name || sourceId;
        const targetName = byId.get(targetId)?.name || targetId;
        return {
          next: choices,
          requestedNames,
          disableNames: [],
          blockedMessage: `${sourceName} conflicts with ${targetName}. Both are required by this selection, so they cannot be enabled together.`
        };
      }
      const disableId = sourceProtected ? targetId : sourceId;
      if (!optionalIds.has(disableId)) {
        const requiredName = byId.get(disableId)?.name || disableId;
        return {
          next: choices,
          requestedNames,
          disableNames: [],
          blockedMessage: `This selection conflicts with required mod ${requiredName}.`
        };
      }
      disableIds.add(disableId);
    }
  }

  const disabledMods = optional.filter((mod) => disableIds.has(cleanId(mod.id)));
  disabledMods.forEach((mod) => { next[optionalModKey(mod)] = false; });
  return { next, requestedNames, disableNames: disabledMods.map((mod) => mod.name) };
}

function OptionalConflictModal({ decision, onCancel, onConfirm }: {
  decision: OptionalConflictDecision;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const blocked = !!decision.blockedMessage;
  const summarize = (names: string[]) => names.length <= 3
    ? names.join(', ')
    : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/80 p-5 backdrop-blur-sm">
      <div className="w-full max-w-md border border-white/15 bg-[#080808] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-white/10 p-5">
          <div className="grid h-9 w-9 shrink-0 place-items-center border border-white/15 bg-white/[0.04]"><AlertTriangle size={18} /></div>
          <div className="min-w-0">
            <h2 className="font-semibold">{blocked ? 'Mod conflict' : 'Resolve mod conflict'}</h2>
            <p className="mt-1 text-sm leading-5 text-white/50">
              {blocked
                ? decision.blockedMessage
                : `Enabling ${summarize(decision.requestedNames)} requires disabling ${summarize(decision.disableNames)}.`}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4">
          {!blocked && <button onClick={onCancel} className="h-10 border border-white/15 px-4 text-sm hover:bg-white/10">Cancel</button>}
          <button onClick={blocked ? onCancel : onConfirm} className="h-10 bg-white px-4 text-sm font-medium text-black hover:bg-white/85">
            {blocked ? 'Close' : 'Disable conflicts and continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CrashShareModal({ server, onDecision }: {
  server: SavedServer;
  onDecision: (share: boolean, remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const decide = async (share: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    onDecision(share, remember);
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg border border-white/15 bg-[#080808] shadow-2xl">
        <div className="border-b border-white/10 p-5">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center border border-white/15 bg-white/[0.05]"><FileText size={19} /></div>
            <div>
              <h2 className="text-xl font-semibold">Share crash report?</h2>
              <p className="mt-0.5 text-sm text-white/45">Help {server.manifest.name} diagnose this crash.</p>
            </div>
          </div>
        </div>
        <div className="space-y-4 p-5">
          <p className="text-sm leading-6 text-white/65">
            The report may include your Minecraft username and UUID, game and loader versions, installed mods, the Minecraft crash report, and technical launcher logs. Secrets and local home paths are removed before sharing.
          </p>
          <label className="flex cursor-pointer items-center gap-3 border border-white/10 bg-white/[0.025] p-3 text-sm">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.currentTarget.checked)} className="h-4 w-4 accent-white" />
            Remember my choice for this server
          </label>
          <div className="flex justify-end gap-2">
            <button disabled={submitting} onClick={() => void decide(false)} className="h-10 border border-white/15 px-4 text-sm hover:bg-white/10 disabled:opacity-50">No</button>
            <button disabled={submitting} onClick={() => void decide(true)} className="h-10 bg-white px-4 text-sm font-medium text-black hover:bg-white/85 disabled:opacity-50">Yes, share</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function crashShareLabel(crash: CrashReport) {
  if (crash.shareStatus === 'sharing') return 'Sharing crash report...';
  if (crash.shareStatus === 'shared') return 'Shared with the server.';
  if (crash.shareStatus === 'pending') return 'Waiting to be shared.';
  if (crash.shareStatus === 'failed') return crash.shareMessage || 'Sharing failed.';
  if (crash.shareStatus === 'not-shared') return 'Crash report not shared.';
  return '';
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

function SafeMarkdown({ value }: { value: string }) {
  const text = String(value || '').replace(/<\/?[^>]+>/g, '');
  const parts = text.split(/(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*)/g);
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-white/65">
      {parts.map((part, index) => {
        const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
        if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="underline decoration-white/35 underline-offset-2 hover:text-white">{link[1]}</a>;
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={index} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </p>
  );
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

function LegalConsent({ privacyUrl, termsUrl, onAccepted }: {
  privacyUrl: string;
  termsUrl: string;
  onAccepted: () => void;
}) {
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (!privacyAccepted || !termsAccepted) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.api?.acceptLegalConsent({ privacyAccepted, termsAccepted });
      if (!result?.success) {
        setError(result?.error || 'Unable to save your acceptance.');
        return;
      }
      onAccepted();
    } catch (acceptError) {
      setError(acceptError instanceof Error ? acceptError.message : 'Unable to save your acceptance.');
    } finally {
      setSubmitting(false);
    }
  };

  const open = async (url: string) => {
    const result = await window.api?.openExternal(url);
    if (result && !result.success) setError(result.error || 'Unable to open this document.');
  };

  return (
    <div className="impulse-auth-surface relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-black p-5">
      <div className="impulse-auth-grid absolute inset-0 pointer-events-none" />
      <div className="impulse-auth-vignette absolute inset-0 pointer-events-none" />
      <section className="impulse-auth-card relative z-10 w-full max-w-xl rounded-lg border border-white/10 bg-[#0b0b0d]/90 p-7 shadow-[0_28px_80px_rgba(0,0,0,0.62)] backdrop-blur-2xl sm:p-9">
        <div className="mb-7 flex items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-white/15 bg-white text-black">
            <LockKeyhole size={22} />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Before you continue</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Review and accept</h1>
            <p className="mt-2 text-sm leading-6 text-white/55">Please read the documents that explain how Impulse works, what information it uses, and the rules that apply.</p>
          </div>
        </div>

        <div className="grid gap-3">
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-white/10 bg-black/50 p-4 hover:border-white/25">
            <input type="checkbox" checked={privacyAccepted} onChange={(event) => setPrivacyAccepted(event.target.checked)} className="mt-1 accent-white" />
            <span className="min-w-0 flex-1 text-sm text-white/75">I have read and accept the <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void open(privacyUrl); }} className="app-no-drag inline-flex items-center gap-1 font-semibold text-white underline underline-offset-4">Privacy Policy <ExternalLink size={12} /></button>.</span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-white/10 bg-black/50 p-4 hover:border-white/25">
            <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} className="mt-1 accent-white" />
            <span className="min-w-0 flex-1 text-sm text-white/75">I have read and accept the <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void open(termsUrl); }} className="app-no-drag inline-flex items-center gap-1 font-semibold text-white underline underline-offset-4">Terms of Service <ExternalLink size={12} /></button>.</span>
          </label>
        </div>

        {error && <div className="mt-4 flex items-start gap-3 rounded-md border border-red-300/20 bg-red-300/[0.08] p-3 text-sm text-red-200"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{error}</span></div>}

        <button type="button" onClick={() => void accept()} disabled={!privacyAccepted || !termsAccepted || submitting} className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-35">
          {submitting ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
          {submitting ? 'Saving...' : 'Accept and Continue'}
        </button>
        <p className="mt-4 text-center text-xs leading-5 text-white/35">Your acceptance is stored locally. Impulse will ask again when these documents change materially.</p>
      </section>
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
    updateChannel: 'stable' as UpdateChannel,
    javaRuntime: 'auto' as JavaRuntimeMode,
    javaPath: '',
    minMemory: 1024,
    maxMemory: 4096,
    downloadConcurrency: 4,
    discordRpc: defaultDiscordRpcSettings
  });
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [storage, setStorage] = useState<GameStorage | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  const [microphone, setMicrophone] = useState<{ supported: boolean; status: string; granted: boolean; error?: string } | null>(null);
  const [microphoneBusy, setMicrophoneBusy] = useState(false);

  const refreshStorage = async () => {
    const result = await window.api?.getGameStorage();
    if (result?.success && result.storage) setStorage(result.storage);
  };

  useEffect(() => {
    window.api?.getLauncherSettings().then((data) => {
      setSettings({
        minecraftPath: data.minecraftPath,
        updateChannel: data.updateChannel === 'beta' ? 'beta' : 'stable',
        javaRuntime: normalizeJavaRuntime(data.javaRuntime, data.javaPath),
        javaPath: data.javaPath || '',
        minMemory: data.minMemory,
        maxMemory: data.maxMemory,
        downloadConcurrency: Math.max(1, Math.min(8, data.downloadSettings?.concurrentDownloads || 4)),
        discordRpc: { ...defaultDiscordRpcSettings, ...(data.discordRpc || {}) }
      });
      refreshStorage();
      window.api?.getMicrophonePermission?.().then((result) => setMicrophone(result));
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
      updateChannel: settings.updateChannel,
      javaRuntime: settings.javaRuntime,
      javaPath: settings.javaPath || null,
      minMemory: Number(settings.minMemory),
      maxMemory: Number(settings.maxMemory),
      downloadSettings: { concurrentDownloads: settings.downloadConcurrency },
      discordRpc: settings.discordRpc
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const verifyCache = async () => {
    setStorageBusy(true);
    setStorageMessage(null);
    const result = await window.api?.verifyGameCache();
    setStorageMessage(result?.success
      ? `Checked ${result.result?.checked || 0} cached files; removed ${result.result?.corruptRemoved || 0} corrupt files.`
      : result?.error || 'Cache scan failed.');
    await refreshStorage();
    setStorageBusy(false);
  };

  const cleanCache = async () => {
    setStorageBusy(true);
    setStorageMessage(null);
    const result = await window.api?.cleanGameCache();
    setStorageMessage(result?.success
      ? `Removed ${result.removed || 0} unreferenced files and freed ${formatBytes(result.bytesFreed || 0)}.`
      : result?.error || 'Cache cleanup failed.');
    await refreshStorage();
    setStorageBusy(false);
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

  const requestMicrophone = async () => {
    setMicrophoneBusy(true);
    const result = await window.api?.requestMicrophonePermission?.();
    if (result) setMicrophone(result);
    setMicrophoneBusy(false);
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
          {window.api?.platform === 'darwin' && (
            <div className="border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <Mic size={18} className="mt-0.5 text-white/70" />
                  <div>
                    <p className="text-sm font-semibold text-white">Voice Chat Microphone</p>
                    <p className="mt-1 text-xs text-white/50">
                      Required on macOS for Minecraft voice chat mods.
                    </p>
                    <p className="mt-2 text-xs text-white/45">
                      Status: <span className="text-white/75">{microphone?.status || 'unknown'}</span>
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={requestMicrophone}
                  disabled={microphoneBusy || microphone?.granted}
                  className="inline-flex h-10 items-center justify-center gap-2 border border-white/15 px-3 text-sm font-medium text-white transition hover:bg-white hover:text-black disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-white"
                >
                  {microphoneBusy ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />}
                  {microphone?.granted ? 'Allowed' : 'Request Access'}
                </button>
              </div>
              {microphone?.status === 'denied' && (
                <p className="mt-3 text-xs text-amber-200/80">
                  Microphone access is denied. Enable it in macOS System Settings &gt; Privacy &amp; Security &gt; Microphone.
                </p>
              )}
              {microphone?.error && <p className="mt-3 text-xs text-red-300">{microphone.error}</p>}
            </div>
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
          <label className="block">
            <span className="text-xs uppercase tracking-[0.18em] text-white/50">Parallel Mod Downloads</span>
            <input
              className="mt-2 h-11 w-full border border-white/15 bg-black px-3 outline-none focus:border-white"
              value={settings.downloadConcurrency}
              min={1}
              max={8}
              type="number"
              onChange={(event) => setSettings({ ...settings, downloadConcurrency: Math.max(1, Math.min(8, Number(event.target.value) || 1)) })}
            />
            <p className="mt-2 text-xs text-white/45">Choose between 1 and 8 simultaneous mod downloads.</p>
          </label>
          <div className="border border-white/10 bg-white/[0.03] p-4">
            <div>
              <p className="text-sm font-semibold text-white">Update Channel</p>
              <p className="mt-1 text-xs text-white/50">Choose which Impulse launcher releases you receive.</p>
            </div>
            <div className="mt-3 grid grid-cols-2 border border-white/15 bg-black p-1">
              {([
                ['stable', 'Stable'],
                ['beta', 'Beta']
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSettings({ ...settings, updateChannel: value })}
                  className={`h-9 text-sm font-medium transition ${settings.updateChannel === value ? 'bg-white text-black' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-white/45">
              {settings.updateChannel === 'beta'
                ? 'Receive early Impulse features and every stable release. Beta builds may contain unfinished changes.'
                : 'Receive fully released and tested Impulse updates.'}
            </p>
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
          <div className="border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start gap-3">
              <HardDrive size={18} className="mt-0.5 text-white/70" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Game Storage</p>
                <p className="mt-1 text-xs text-white/50">Inspect the shared SHA-1 cache and safely remove files no saved profile references.</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden border border-white/10 bg-white/10 text-xs sm:grid-cols-3">
              {[
                ['Total', storage?.gameBytes],
                ['Profiles', storage?.profileBytes],
                ['Shared cache', storage?.cacheBytes],
                ['Space saved', storage?.deduplicatedBytes],
                ['Cleanable', storage?.orphanBytes],
                ['Profiles', storage?.profileCount]
              ].map(([label, value], index) => (
                <div key={`${label}-${index}`} className="bg-black p-3">
                  <div className="text-white/40">{label}</div>
                  <div className="mt-1 font-medium">{label === 'Profiles' && index === 5 ? String(value ?? 0) : formatBytes(Number(value || 0))}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button disabled={storageBusy} onClick={verifyCache} className="inline-flex h-9 items-center gap-2 border border-white/15 px-3 text-xs hover:bg-white/10 disabled:opacity-50">
                {storageBusy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Verify Cache
              </button>
              <button disabled={storageBusy} onClick={cleanCache} className="inline-flex h-9 items-center gap-2 border border-white/15 px-3 text-xs hover:bg-white/10 disabled:opacity-50">
                <Trash2 size={14} /> Clean Unreferenced
              </button>
            </div>
            {storageMessage && <p className="mt-3 text-xs text-white/55">{storageMessage}</p>}
          </div>
          <div className="border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm font-semibold text-white">Legal</p>
            <p className="mt-1 text-xs text-white/50">Review the documents accepted when Impulse was first opened.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void window.api?.openExternal('https://impulsemc.com/privacy/')} className="inline-flex h-9 items-center gap-2 border border-white/15 px-3 text-xs hover:bg-white/10"><FileText size={14} />Privacy Policy</button>
              <button type="button" onClick={() => void window.api?.openExternal('https://impulsemc.com/terms/')} className="inline-flex h-9 items-center gap-2 border border-white/15 px-3 text-xs hover:bg-white/10"><FileText size={14} />Terms of Service</button>
            </div>
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
  onCancel,
  onVerify,
  onMarkAnnouncementsRead,
  onCrashSharingChange,
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
  onCancel: () => void;
  onVerify: () => void;
  onMarkAnnouncementsRead: (ids: string[]) => void;
  onCrashSharingChange: (serverId: string, preference: 'ask' | 'always' | 'never') => void;
  onOptionalChange: (serverId: string, selections: Record<string, boolean>) => void;
}) {
  const [view, setView] = useState<'overview' | 'mods' | 'news'>('overview');
  const [now, setNow] = useState(Date.now());
  const [inviteCopied, setInviteCopied] = useState(false);
  const [conflictDecision, setConflictDecision] = useState<OptionalConflictDecision | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const ids = (server?.manifest.announcements || []).map((item) => item.id);
    const read = new Set(server?.readAnnouncementIds || []);
    if (view === 'news' && server && ids.some((id) => !read.has(id))) onMarkAnnouncementsRead(ids);
  }, [view, server?.id, server?.manifest.announcements, onMarkAnnouncementsRead]);
  useEffect(() => setConflictDecision(null), [server?.id]);
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
  const optionalGroups = optionalModGroups(server);
  const optionalChoices = server.optionalModChoices || server.optionalModSelections || {};
  const optionalState = deriveOptionalUiState(server, optionalChoices);
  const optionalSelections = optionalState.selections;
  const busy = launching || running;
  const maintenance = manifest.maintenance?.enabled === true;
  const offlineCard = offlineDetailsFromProgress(progress);

  const applyOptionalChange = (mods: ImpulseMod[], enabled: boolean) => {
    const decision = planOptionalChange(server, optionalChoices, mods, enabled);
    if (decision.blockedMessage || decision.disableNames.length) setConflictDecision(decision);
    else onOptionalChange(server.id, decision.next);
  };

  const setOptionalEnabled = (mod: ImpulseMod, enabled: boolean) => applyOptionalChange([mod], enabled);
  const setOptionalGroupEnabled = (group: OptionalModGroup, enabled: boolean) => applyOptionalChange(group.mods, enabled);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      {conflictDecision && (
        <OptionalConflictModal
          decision={conflictDecision}
          onCancel={() => setConflictDecision(null)}
          onConfirm={() => {
            onOptionalChange(server.id, conflictDecision.next);
            setConflictDecision(null);
          }}
        />
      )}
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
            <button onClick={onLaunch} disabled={busy || maintenance} className="flex h-11 items-center gap-2 bg-white px-5 font-medium text-black hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-60">
              {running ? <Gauge size={17} /> : <Play size={17} />}
              {running ? 'Running' : maintenance ? 'Maintenance' : launching ? 'Launching...' : 'Launch'}
            </button>
            {launching && (
              <button onClick={onCancel} className="flex h-11 items-center gap-2 border border-white/20 px-4 text-sm hover:bg-white/10">
                <X size={16} /> Cancel
              </button>
            )}
            <div className="ml-auto flex items-center gap-2 text-sm text-white/70">
              <span className={`h-2 w-2 rounded-full ${server.status.online ? 'bg-white' : 'bg-red-300'}`} />
              {server.status.online ? `${server.status.players?.online ?? 0}/${server.status.players?.max ?? 0} online` : server.status.error || 'Offline'}
            </div>
          </div>
        </div>
      </div>

      <nav className="flex border-b border-white/10 bg-[#050505] px-6" aria-label="Server views">
        {([['overview', 'Overview'], ['mods', 'Mods'], ['news', 'News & Events']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} className={`h-12 border-b-2 px-4 text-sm transition ${view === key ? 'border-white text-white' : 'border-transparent text-white/45 hover:text-white/75'}`}>{label}</button>
        ))}
      </nav>

      <div className="grid gap-5 p-6 lg:grid-cols-[1fr_330px]">
        <section className="border border-white/10 bg-white/[0.025] p-5">
          {maintenance && (
            <div className="mb-5 border border-white/20 bg-white/[0.045] p-4">
              <div className="font-semibold">{manifest.maintenance.title || 'Maintenance'}</div>
              <p className="mt-1 text-sm leading-6 text-white/60">{manifest.maintenance.message || 'This server is temporarily unavailable while maintenance is in progress.'}</p>
              {manifest.maintenance.estimated_end && <p className="mt-2 text-xs text-white/40">Estimated end: {new Date(manifest.maintenance.estimated_end).toLocaleString()}</p>}
            </div>
          )}
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
          {view === 'overview' && <><h2 className="mb-2 text-lg font-semibold">Server</h2><p className="text-sm leading-6 text-white/70">{manifest.description || 'No description provided.'}</p></>}

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
              {crash && crashShareLabel(crash) && (
                <div className={`mt-3 border px-3 py-2 text-xs ${crash.shareStatus === 'failed' ? 'border-red-300/20 text-red-200' : 'border-white/10 text-white/55'}`}>
                  {crashShareLabel(crash)}
                </div>
              )}
              {!error && !crash && (
                <>
                  <div className="h-2 bg-white/10">
                    <div className="h-full bg-white transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  {progress?.details && Number(progress.details.totalBytes || 0) > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
                      <span>{formatBytes(Number(progress.details.downloadedBytes || 0))} / {formatBytes(Number(progress.details.totalBytes || 0))}</span>
                      <span>{formatBytes(Number(progress.details.speedBytesPerSecond || 0))}/s</span>
                      {Number.isFinite(Number(progress.details.etaSeconds)) && <span>{Math.ceil(Number(progress.details.etaSeconds))}s remaining</span>}
                      <span>{Number(progress.details.completedFiles || 0)}/{Number(progress.details.totalFiles || 0)} files</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {view === 'mods' && <div className="mt-1">
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
          </div>}

          {view === 'mods' && <div className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-medium">Optional Mods</h3>
              <span className="text-sm text-white/50">{optionalMods.length} files</span>
            </div>
            <div className="divide-y divide-white/10 border border-white/10">
              {optionalMods.length === 0 ? (
                <div className="p-4 text-sm text-white/50">No optional server mods.</div>
              ) : (
                optionalGroups.map((group) => {
                  const enabled = group.mods.length > 0 && group.mods.every((mod) => optionalSelections[optionalModKey(mod)] === true);
                  const partial = !enabled && group.mods.some((mod) => optionalSelections[optionalModKey(mod)] === true);
                  return (
                    <Fragment key={group.id}>
                      <div className="flex items-start justify-between gap-4 border-b border-white/10 bg-white/[0.025] px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-wide text-white/70">{group.name}</p>
                          {group.description && <p className="mt-0.5 text-xs text-white/40">{group.description}</p>}
                        </div>
                        <label className="flex shrink-0 items-center gap-2 text-xs text-white/55">
                          <input
                            type="checkbox"
                            checked={enabled}
                            ref={(node) => { if (node) node.indeterminate = partial; }}
                            onChange={(event) => setOptionalGroupEnabled(group, event.currentTarget.checked)}
                            className="h-4 w-4 accent-white"
                          />
                          {enabled ? 'Enabled' : partial ? 'Partial' : 'Disabled'}
                        </label>
                      </div>
                      {group.mods.map((mod) => {
                        const checked = optionalSelections[optionalModKey(mod)] === true;
                        return (
                          <label key={`${group.id}-${mod.sha1}-${mod.file_name}`} className="flex cursor-pointer items-center justify-between gap-4 p-3 transition hover:bg-white/[0.035]">
                            <div className="flex min-w-0 flex-1 items-start gap-3">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={(optionalState.requiredBy[optionalModKey(mod)] || []).length > 0}
                                onChange={(event) => setOptionalEnabled(mod, event.currentTarget.checked)}
                                className="mt-1 h-4 w-4 accent-white"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{mod.name}</p>
                                <p className="mod-description-clamp text-xs text-white/45">{mod.description || mod.file_name}</p>
                                {(optionalState.requiredBy[optionalModKey(mod)] || []).length > 0 && <p className="mt-1 text-xs text-white/65">Required by {optionalState.requiredBy[optionalModKey(mod)].join(', ')}</p>}
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
                    </Fragment>
                  );
                })
              )}
            </div>
          </div>}

          {view === 'overview' && !progress && !error && !crash && (
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="border border-white/10 p-3"><div className="text-xs text-white/40">Required mods</div><div className="mt-1 text-lg font-semibold">{manifest.mods.length}</div></div>
              <div className="border border-white/10 p-3"><div className="text-xs text-white/40">Optional mods</div><div className="mt-1 text-lg font-semibold">{optionalMods.length}</div></div>
              <div className="border border-white/10 p-3"><div className="text-xs text-white/40">Loader</div><div className="mt-1 text-sm font-semibold">{manifest.minecraft.loader === 'neoforge' ? 'NeoForge' : 'Forge'} {manifest.minecraft.loader_version}</div></div>
            </div>
          )}

          {view === 'news' && (
            <div className="space-y-6">
              <div><h2 className="mb-3 text-lg font-semibold">Announcements</h2><div className="space-y-3">{(manifest.announcements || []).length === 0 ? <p className="text-sm text-white/45">No announcements.</p> : [...manifest.announcements].sort((a, b) => a.order - b.order).map((item) => <article key={item.id} className="border border-white/10 p-4"><div className="flex items-start justify-between gap-3"><h3 className="font-semibold">{item.title}</h3><span className="text-xs uppercase text-white/35">{item.severity}</span></div><div className="mt-2"><SafeMarkdown value={item.body} /></div>{item.link && <a href={item.link} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs underline">Open link</a>}</article>)}</div></div>
              <div><h2 className="mb-3 text-lg font-semibold">Events</h2><div className="grid gap-3 sm:grid-cols-2">{(manifest.events || []).length === 0 ? <p className="text-sm text-white/45">No upcoming events.</p> : manifest.events.map((item) => { const start = item.start ? new Date(item.start).getTime() : 0; const end = item.end ? new Date(item.end).getTime() : 0; const live = start > 0 && start <= now && (!end || end > now); const remaining = start > now ? Math.max(0, start - now) : 0; const days = Math.floor(remaining / 86400000); const hours = Math.floor((remaining % 86400000) / 3600000); return <article key={item.id} className="overflow-hidden border border-white/10">{item.image && <img src={item.image} alt="" className="aspect-video w-full object-cover" />}<div className="p-4"><div className="text-xs text-white/40">{live ? 'Live now' : start ? `Starts in ${days ? `${days}d ` : ''}${hours}h` : 'Event'}</div><h3 className="mt-1 font-semibold">{item.title}</h3><div className="mt-2"><SafeMarkdown value={item.description} /></div></div></article>; })}</div></div>
              <div><h2 className="mb-3 text-lg font-semibold">Changelog</h2><div className="space-y-3">{(manifest.changelog || []).length === 0 ? <p className="text-sm text-white/45">No changelog entries.</p> : manifest.changelog.map((item) => <article key={item.id} className="border-l-2 border-white/25 pl-4"><div className="text-xs text-white/40">{item.version}{item.publication_time ? ` · ${new Date(item.publication_time).toLocaleDateString()}` : ''}</div><h3 className="mt-1 font-semibold">{item.title}</h3><div className="mt-2"><SafeMarkdown value={item.body} /></div></article>)}</div></div>
            </div>
          )}
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
            <label className="block">
              <span className="text-white/45">Crash report sharing</span>
              <select
                value={server.crashReportSharing || 'ask'}
                disabled={manifest.crash_reports?.enabled !== true}
                onChange={(event) => onCrashSharingChange(server.id, event.currentTarget.value as 'ask' | 'always' | 'never')}
                className="mt-1 h-9 w-full border border-white/15 bg-black px-2 text-sm text-white outline-none focus:border-white/40 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <option value="ask">Ask every time</option>
                <option value="always">Always share</option>
                <option value="never">Never share</option>
              </select>
              {manifest.crash_reports?.enabled !== true && <span className="mt-1 block text-xs text-white/35">Not supported by this server.</span>}
            </label>
          </div>
          <button onClick={onVerify} disabled={busy} className="mt-5 flex h-10 w-full items-center justify-center gap-2 border border-white/15 text-sm hover:bg-white/10 disabled:opacity-50">
            <ShieldCheck size={16} /> Verify Files
          </button>
          <button onClick={async () => {
            const optional = (manifest.optional_mods || []).filter((mod) => optionalSelections[optionalModKey(mod)]).map((mod) => mod.id).join(',');
            const params = new URLSearchParams({ address: `${server.host}:${server.port}`, manifest_port: String(server.manifestPort), action: 'add' });
            if (optional) params.set('optional', optional);
            await navigator.clipboard.writeText(`impulse://server?${params.toString()}`);
            setInviteCopied(true); window.setTimeout(() => setInviteCopied(false), 1500);
          }} className="mt-2 flex h-10 w-full items-center justify-center gap-2 border border-white/15 text-sm hover:bg-white/10">
            {inviteCopied ? 'Invitation Copied' : 'Copy Invitation'}
          </button>
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
  const [selections, setSelections] = useState<Record<string, boolean>>(server.optionalModChoices || server.optionalModSelections || {});
  const [conflictDecision, setConflictDecision] = useState<OptionalConflictDecision | null>(null);
  const optionalMods = server.manifest.optional_mods || [];
  const optionalGroups = optionalModGroups(server);
  const changed = !!server.optionalModPromptedSignature;
  const effective = deriveOptionalUiState(server, selections);

  const applyOptionalChange = (mods: ImpulseMod[], enabled: boolean) => {
    const decision = planOptionalChange(server, selections, mods, enabled);
    if (decision.blockedMessage || decision.disableNames.length) setConflictDecision(decision);
    else setSelections(decision.next);
  };

  const setEnabled = (mod: ImpulseMod, enabled: boolean) => applyOptionalChange([mod], enabled);
  const setGroupEnabled = (group: OptionalModGroup, enabled: boolean) => applyOptionalChange(group.mods, enabled);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm">
      {conflictDecision && (
        <OptionalConflictModal
          decision={conflictDecision}
          onCancel={() => setConflictDecision(null)}
          onConfirm={() => {
            setSelections(conflictDecision.next);
            setConflictDecision(null);
          }}
        />
      )}
      <div className="w-full max-w-2xl border border-white/15 bg-[#080808] shadow-2xl">
        <div className="border-b border-white/10 p-5">
          <h2 className="text-xl font-semibold">{changed ? 'The server added new optional mods' : 'Choose optional mods'}</h2>
          <p className="mt-1 text-sm text-white/55">
            Select the optional mods you want enabled for {server.manifest.name}. You can change this later from the server mod list.
          </p>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-5">
          <div className="divide-y divide-white/10 border border-white/10">
            {optionalGroups.map((group) => {
              const enabled = group.mods.length > 0 && group.mods.every((mod) => effective.selections[optionalModKey(mod)] === true);
              const partial = !enabled && group.mods.some((mod) => effective.selections[optionalModKey(mod)] === true);
              return (
                <Fragment key={group.id}>
                  <div className="flex items-start justify-between gap-4 border-b border-white/10 bg-white/[0.025] px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-white/70">{group.name}</p>
                      {group.description && <p className="mt-0.5 text-xs text-white/40">{group.description}</p>}
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-xs text-white/55">
                      <input
                        type="checkbox"
                        checked={enabled}
                        ref={(node) => { if (node) node.indeterminate = partial; }}
                        onChange={(event) => setGroupEnabled(group, event.currentTarget.checked)}
                        className="h-4 w-4 accent-white"
                      />
                      {enabled ? 'Enabled' : partial ? 'Partial' : 'Disabled'}
                    </label>
                  </div>
                  {group.mods.map((mod) => {
                    const checked = effective.selections[optionalModKey(mod)] === true;
                    const requiredBy = effective.requiredBy[optionalModKey(mod)] || [];
                    return (
                      <label key={`${group.id}-${mod.sha1}-${mod.file_name}`} className="flex cursor-pointer items-center justify-between gap-4 p-3 transition hover:bg-white/[0.035]">
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={requiredBy.length > 0}
                            onChange={(event) => setEnabled(mod, event.currentTarget.checked)}
                            className="mt-1 h-4 w-4 accent-white"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{mod.name}</p>
                            <p className="mod-description-clamp text-xs text-white/45">{mod.description || mod.file_name}</p>
                            {requiredBy.length > 0 && <p className="mt-1 text-xs text-white/65">Required by {requiredBy.join(', ')}</p>}
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
                </Fragment>
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

function InvitationModal({ state, onClose, onConfirm }: {
  state: { loading: boolean; error?: string; invitation?: ImpulseInvitation; server?: SavedServer };
  onClose: () => void;
  onConfirm: (acceptSuggested: boolean) => void;
}) {
  const [acceptSuggested, setAcceptSuggested] = useState(false);
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-5 backdrop-blur-sm">
      <div className="w-full max-w-lg border border-white/15 bg-[#070707] p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Impulse server invitation</h2><p className="mt-1 text-sm text-white/50">Review this server before adding or launching it.</p></div><button onClick={onClose} className="p-2 hover:bg-white/10"><X size={18} /></button></div>
        {state.loading ? <div className="grid min-h-44 place-items-center"><Loader2 className="animate-spin" /></div> : state.error ? <div className="mt-5 border border-red-300/20 p-4 text-sm text-red-200">{state.error}</div> : state.server && state.invitation ? (
          <div className="mt-5 space-y-4">
            <div className="flex items-center gap-3 border border-white/10 p-4">{state.server.manifest.icon_url ? <img src={state.server.manifest.icon_url} alt="" className="h-12 w-12 object-cover" /> : <Server size={28} />}<div className="min-w-0"><h3 className="truncate font-semibold">{state.server.manifest.name}</h3><p className="text-sm text-white/45">{state.server.host}:{state.server.port}</p></div></div>
            <div className="grid grid-cols-2 gap-px border border-white/10 bg-white/10 text-xs"><div className="bg-black p-3"><span className="text-white/40">Loader</span><p className="mt-1">{state.server.manifest.minecraft.loader === 'neoforge' ? 'NeoForge' : 'Forge'} {state.server.manifest.minecraft.loader_version}</p></div><div className="bg-black p-3"><span className="text-white/40">Required mods</span><p className="mt-1">{state.server.manifest.mods.length}</p></div></div>
            {state.invitation.optional.length > 0 && <label className="flex cursor-pointer items-start gap-3 border border-white/10 p-3 text-sm"><input type="checkbox" checked={acceptSuggested} onChange={(event) => setAcceptSuggested(event.target.checked)} className="mt-1 accent-white" /><span><strong>Accept suggested optional mods</strong><span className="mt-1 block text-xs text-white/45">Enable {state.invitation.optional.length} suggested option{state.invitation.optional.length === 1 ? '' : 's'}. Existing choices remain unchanged unless accepted.</span></span></label>}
            <div className="flex justify-end gap-2"><button onClick={onClose} className="h-10 border border-white/15 px-4 text-sm hover:bg-white/10">Cancel</button><button onClick={() => onConfirm(acceptSuggested)} className="h-10 bg-white px-4 text-sm font-medium text-black hover:bg-white/85">{state.invitation.action === 'launch' ? 'Add and Launch' : 'Add Server'}</button></div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function majorMinor(version: string): [number, number] | null {
  const match = String(version || '').trim().match(/^v?(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/i);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function usesOlderImpulseMinor(server: SavedServer) {
  if (server.outdatedImpulseWarningDismissed) return false;
  const serverVersion = majorMinor(server.manifest.impulse_version);
  const supportedVersion = majorMinor(IMPULSE_MOD_VERSION);
  if (!serverVersion || !supportedVersion) return false;
  return serverVersion[0] < supportedVersion[0]
    || (serverVersion[0] === supportedVersion[0] && serverVersion[1] < supportedVersion[1]);
}

function OutdatedImpulseModal({ server, onCancel, onContinue }: {
  server: SavedServer;
  onCancel: () => void;
  onContinue: (dismiss: boolean) => Promise<void>;
}) {
  const [dismiss, setDismiss] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/80 p-5 backdrop-blur-sm">
      <div className="w-full max-w-md border border-white/15 bg-[#080808] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-white/10 p-5">
          <div className="grid h-9 w-9 shrink-0 place-items-center border border-white/15 bg-white/[0.04]"><AlertTriangle size={18} /></div>
          <div className="min-w-0">
            <h2 className="font-semibold">This server uses an older version of Impulse</h2>
            <p className="mt-2 text-sm leading-5 text-white/55">
              Some Impulse features may not work as expected. This server uses Impulse {server.manifest.impulse_version}, while this launcher supports {IMPULSE_MOD_VERSION}.
            </p>
          </div>
        </div>
        <label className="mx-5 mt-5 flex cursor-pointer items-start gap-3 text-sm text-white/70">
          <input type="checkbox" checked={dismiss} onChange={(event) => setDismiss(event.currentTarget.checked)} className="mt-0.5 h-4 w-4 accent-white" />
          <span>Don't show this warning again for this server</span>
        </label>
        <div className="flex justify-end gap-2 p-5">
          <button disabled={submitting} onClick={onCancel} className="h-10 border border-white/15 px-4 text-sm hover:bg-white/10 disabled:opacity-50">Cancel</button>
          <button
            disabled={submitting}
            onClick={async () => {
              setSubmitting(true);
              try { await onContinue(dismiss); } finally { setSubmitting(false); }
            }}
            className="flex h-10 items-center gap-2 bg-white px-4 text-sm font-medium text-black hover:bg-white/85 disabled:opacity-50"
          >
            {submitting && <Loader2 size={15} className="animate-spin" />}
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [legalChecked, setLegalChecked] = useState(false);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [legalUrls, setLegalUrls] = useState({
    privacy: 'https://impulsemc.com/privacy/',
    terms: 'https://impulsemc.com/terms/'
  });
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
  const [outdatedImpulsePromptServer, setOutdatedImpulsePromptServer] = useState<SavedServer | null>(null);
  const [invitationPreview, setInvitationPreview] = useState<{ loading: boolean; error?: string; invitation?: ImpulseInvitation; server?: SavedServer } | null>(null);

  useEffect(() => {
    if (!window.api) {
      setLegalAccepted(true);
      setLegalChecked(true);
      return;
    }
    window.api.getLegalConsent()
      .then((status) => {
        setLegalAccepted(status.accepted);
        setLegalUrls({ privacy: status.privacyUrl, terms: status.termsUrl });
      })
      .finally(() => setLegalChecked(true));
  }, []);

  useEffect(() => {
    if (!legalAccepted) return;
    const preview = async (invitation: ImpulseInvitation) => {
      if (invitation.error) { setInvitationPreview({ loading: false, error: invitation.error }); return; }
      setInvitationPreview({ loading: true, invitation });
      const result = await window.api?.previewInvitation(invitation.raw);
      setInvitationPreview(result?.success ? { loading: false, invitation: result.invitation, server: result.server } : { loading: false, error: result?.error || 'Unable to preview this invitation.' });
    };
    const cleanup = window.api?.onDeepLink((invitation) => void preview(invitation));
    window.api?.consumeDeepLinks().then((links) => links.forEach((invitation) => void preview(invitation)));
    return () => cleanup?.();
  }, [legalAccepted]);

  useEffect(() => {
    if (!legalAccepted) return;
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
  }, [legalAccepted]);

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
      window.api?.onCrashShareStatus((data) => {
        setCrashReport((current) => current?.reportId === data.reportId
          ? { ...current, shareStatus: data.status, shareMessage: data.message, sharePromptRequired: false }
          : current);
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

  const updateCrashSharing = async (serverId: string, preference: 'ask' | 'always' | 'never') => {
    const result = await window.api?.updateCrashSharing(serverId, preference);
    if (result?.servers) setServers(result.servers);
    else if (!result?.success) setLaunchError(result?.error || 'Unable to update crash report sharing.');
  };

  const respondToCrashSharing = async (share: boolean, remember: boolean) => {
    const reportId = crashReport?.reportId;
    if (!reportId) return;
    setCrashReport((current) => current ? {
      ...current,
      sharePromptRequired: false,
      shareStatus: share ? 'sharing' : 'not-shared',
      shareMessage: share ? 'Sharing crash report...' : 'Crash report not shared.'
    } : current);
    const result = await window.api?.respondCrashSharing(reportId, share, remember);
    if (result?.servers) setServers(result.servers);
    if (!result?.success) {
      setCrashReport((current) => current?.reportId === reportId
        ? { ...current, shareStatus: 'failed', shareMessage: result?.error || 'Sharing failed.' }
        : current);
    }
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

  const proceedWithLaunch = async (server: SavedServer) => {
    if (needsOptionalPrompt(server)) {
      setProgress(null);
      setOptionalPromptServer(server);
      return;
    }
    await continueLaunch(server.id);
  };

  const launchSelected = async () => {
    if (!selectedServer) return;
    const serverId = selectedServer.id;
    const refreshedServer = await refreshBeforeLaunch(serverId);
    if (!refreshedServer) return;
    if (refreshedServer.manifest.maintenance?.enabled) {
      setProgress(null);
      setLaunchError(refreshedServer.manifest.maintenance.message || 'This server is currently under maintenance.');
      setLaunchingId(null);
      return;
    }
    if (usesOlderImpulseMinor(refreshedServer)) {
      setProgress(null);
      setOutdatedImpulsePromptServer(refreshedServer);
      return;
    }
    await proceedWithLaunch(refreshedServer);
  };

  const confirmInvitation = async (acceptSuggested: boolean) => {
    const preview = invitationPreview;
    if (!preview?.server || !preview.invitation) return;
    const invitation = preview.invitation;
    const result = await window.api?.addServer({ address: invitation.address, manifestPort: invitation.manifestPort });
    if (!result?.success || !result.server) { setInvitationPreview({ ...preview, loading: false, error: result?.error || 'Unable to add this server.' }); return; }
    let saved = result.server;
    if (result.servers) setServers(result.servers);
    setSelectedId(saved.id);
    if (acceptSuggested && invitation.optional.length) {
      const choices = { ...(saved.optionalModChoices || saved.optionalModSelections || {}) };
      for (const mod of saved.manifest.optional_mods || []) if (invitation.optional.includes(mod.id)) choices[optionalModKey(mod)] = true;
      saved = await updateOptionalMods(saved.id, choices, invitation.action === 'launch') || saved;
    }
    setInvitationPreview(null);
    if (invitation.action === 'launch') {
      setLaunchingId(saved.id);
      if (usesOlderImpulseMinor(saved)) setOutdatedImpulsePromptServer(saved);
      else if (!acceptSuggested && needsOptionalPrompt(saved)) setOptionalPromptServer(saved);
      else await continueLaunch(saved.id);
    }
  };

  const cancelCurrentLaunch = async () => {
    if (!launchingId) return;
    await window.api?.cancelLaunch(launchingId);
  };

  const verifySelectedFiles = async () => {
    if (!selectedServer || runningGame || launchingId) return;
    setLaunchingId(selectedServer.id);
    setLaunchError(null);
    setCrashReport(null);
    setProgress({ status: 'verifying-launch', message: 'Preparing file verification...', progress: 0, total: 100 });
    try {
      const result = await window.api?.verifyServerFiles(selectedServer.id);
      if (!result?.success) {
        const failures = result?.report?.failures?.filter(Boolean) || [];
        setLaunchError(failures.length ? failures.join('\n') : result?.error || 'File verification failed.');
        setProgress(null);
        return;
      }
      if (result.server) setServers((current) => current.map((entry) => entry.id === result.server?.id ? result.server : entry));
      const repaired = result.report?.repairedFiles?.length || 0;
      setProgress({
        status: 'files-verified',
        message: repaired
          ? `Verification complete. Repaired ${repaired} issue${repaired === 1 ? '' : 's'} and verified ${result.report?.verifiedMods || 0} mods.`
          : `All files are ready. Verified ${result.report?.verifiedMods || 0} mods.`,
        progress: 100,
        total: 100
      });
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'File verification failed.');
      setProgress(null);
    } finally {
      setLaunchingId(null);
    }
  };

  if (!legalChecked) {
    return <div className="grid h-screen place-items-center bg-black text-white">Loading Impulse...</div>;
  }

  if (!legalAccepted) {
    return (
      <div className="flex h-screen flex-col bg-black text-white">
        <WindowControls />
        <LegalConsent privacyUrl={legalUrls.privacy} termsUrl={legalUrls.terms} onAccepted={() => setLegalAccepted(true)} />
      </div>
    );
  }

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
              onCancel={cancelCurrentLaunch}
              onVerify={verifySelectedFiles}
              onMarkAnnouncementsRead={async (ids) => {
                if (!selectedServer) return;
                const result = await window.api?.markAnnouncementsRead(selectedServer.id, ids);
                if (result?.servers) setServers(result.servers);
              }}
              onCrashSharingChange={(serverId, preference) => void updateCrashSharing(serverId, preference)}
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
          {outdatedImpulsePromptServer && (
            <OutdatedImpulseModal
              server={outdatedImpulsePromptServer}
              onCancel={() => {
                setOutdatedImpulsePromptServer(null);
                setLaunchingId(null);
              }}
              onContinue={async (dismiss) => {
                let server = outdatedImpulsePromptServer;
                if (dismiss) {
                  const result = await window.api?.dismissOutdatedVersionWarning(server.id);
                  if (!result?.success || !result.server) {
                    setLaunchError(result?.error || 'Unable to save the warning preference.');
                    setOutdatedImpulsePromptServer(null);
                    setLaunchingId(null);
                    return;
                  }
                  server = result.server;
                  if (result.servers) setServers(result.servers);
                }
                setOutdatedImpulsePromptServer(null);
                await proceedWithLaunch(server);
              }}
            />
          )}
          {invitationPreview && <InvitationModal state={invitationPreview} onClose={() => setInvitationPreview(null)} onConfirm={(accept) => void confirmInvitation(accept)} />}
          {crashReport?.sharePromptRequired && crashReport.reportId && selectedServer?.id === crashReport.serverId && (
            <CrashShareModal server={selectedServer} onDecision={(share, remember) => void respondToCrashSharing(share, remember)} />
          )}
        </div>
      )}
      <UpdateBanner update={updateStatus} />
    </div>
  );
}
