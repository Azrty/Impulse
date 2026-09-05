import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Bug, Check, ChevronLeft, ChevronRight, CircleHelp, Cog, Download, ExternalLink, FileWarning,
  Flag, Globe2, History, ImageOff, LoaderCircle, LockKeyhole, MoreHorizontal, Package, PackagePlus, Paperclip, Play, Plus,
  RefreshCw, Rocket, ScanSearch, Search, Server, Settings2, ShieldCheck, Sparkles, Trash2, Wrench, X,
} from 'lucide-react';
import eruda from 'eruda';
import { heartbeat, invoke } from './bridge';
import impulseLogo from './generated/impulse-logo.png';
import type { CustomMod, GlobalMod, InstallPlan, Manifest, Mod, Operation, Profile, Project, SearchProject, State, UpdatePublication, UpdateSection, Version } from './types';

type Tab = 'overview' | 'mods';
type ModView = 'installed' | 'search' | 'project' | 'versions';
type Warning = { mods: Mod[]; signature: string };

let developerToolsInitialized = false;
function showDeveloperTools() {
  if (!developerToolsInitialized) {
    eruda.init({ defaults: { displaySize: 55, transparency: 0.96 } });
    developerToolsInitialized = true;
  }
  eruda.show();
}

function hideDeveloperTools() {
  if (!developerToolsInitialized) return;
  eruda.hide();
  eruda.destroy();
  developerToolsInitialized = false;
}

const fmtBytes = (value = 0) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
};

function useNativeImage(url?: string) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    setSource(undefined);
    if (!url) return;
    const load = async () => {
      try {
        const value = await invoke<{ status: string; data?: string }>('image', { url });
        if (!active) return;
        if (value.status === 'done' && value.data) setSource(value.data);
        else if (value.status === 'loading') timer = window.setTimeout(load, 250);
      } catch { /* Placeholder remains visible. */ }
    };
    void load();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [url]);
  return source;
}

function NativeImage({ url, className, alt = '' }: { url?: string; className?: string; alt?: string }) {
  const source = useNativeImage(url);
  return source ? <img className={className} src={source} alt={alt} draggable={false} /> : <div className={`${className || ''} image-placeholder`}><ImageOff /></div>;
}

export function App() {
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [operation, setOperation] = useState<Operation>();
  const [warning, setWarning] = useState<Warning>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [modManagerOpen, setModManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newsOpen, setNewsOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [developerToolsOpen, setDeveloperToolsOpen] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);
  const updatesRefreshed = useRef(false);
  const pageRef = useRef<HTMLDivElement>(null);

  const loadState = useCallback(async () => {
    try { setState(await invoke<State>('state')); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);

  useEffect(() => {
    void invoke('ready').then(loadState).catch(reason => setError(String(reason)));
    heartbeat();
    const id = window.setInterval(heartbeat, 5000);
    return () => window.clearInterval(id);
  }, [loadState]);

  const toggleDeveloperTools = useCallback(() => {
    setDeveloperToolsOpen(open => {
      if (open) hideDeveloperTools();
      else showDeveloperTools();
      return !open;
    });
  }, []);

  useEffect(() => {
    if (!state?.developer_tools_enabled) return;
    const handleToolsShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const inspectShortcut = event.key === 'F12' || event.code === 'F12'
        || ((key === 'i' || event.code === 'KeyI') && event.ctrlKey && event.shiftKey)
        || ((key === 'i' || event.code === 'KeyI') && event.metaKey && (event.altKey || event.shiftKey));
      const closeShortcut = event.key === 'Escape' && developerToolsOpen;
      if (!inspectShortcut && !closeShortcut) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (closeShortcut) {
        hideDeveloperTools();
        setDeveloperToolsOpen(false);
      } else {
        toggleDeveloperTools();
      }
    };
    window.addEventListener('keydown', handleToolsShortcut, true);
    return () => window.removeEventListener('keydown', handleToolsShortcut, true);
  }, [developerToolsOpen, state?.developer_tools_enabled, toggleDeveloperTools]);

  useEffect(() => {
    if (state?.developer_tools_enabled || !developerToolsOpen) return;
    hideDeveloperTools();
    setDeveloperToolsOpen(false);
  }, [developerToolsOpen, state?.developer_tools_enabled]);

  useEffect(() => {
    if (!state?.legal_accepted || updatesRefreshed.current) return;
    updatesRefreshed.current = true;
    void invoke<State>('refreshUpdates').then(setState).catch(() => undefined);
  }, [state?.legal_accepted]);

  useEffect(() => {
    const edit = async (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!['a', 'c', 'x', 'v'].includes(key)) return;
      const target = event.target;
      const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (key === 'a') {
        if (editable) {
          event.preventDefault();
          target.select();
          return;
        }
        if (target instanceof HTMLElement && target.isContentEditable) {
          event.preventDefault();
          const range = document.createRange();
          range.selectNodeContents(target);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        return;
      }
      if (key === 'v') {
        if (!editable || target.disabled || target.readOnly) return;
        event.preventDefault();
        try {
          const value = await invoke<string>('clipboardRead');
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          target.setRangeText(value, start, end, 'end');
          target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
        } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        return;
      }
      let value = '';
      if (editable) {
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? start;
        value = target.value.slice(start, end);
        if (key === 'x' && value && !target.disabled && !target.readOnly) {
          target.setRangeText('', start, end, 'start');
          target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByCut' }));
        }
      } else {
        value = window.getSelection()?.toString() || '';
      }
      if (!value) return;
      event.preventDefault();
      try { await invoke('clipboardWrite', { text: value }); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    window.addEventListener('keydown', edit);
    return () => window.removeEventListener('keydown', edit);
  }, []);

  useEffect(() => { if (pageRef.current) pageRef.current.scrollTop = 0; }, [state?.selected_profile?.id, tab]);

  const watchOperation = useCallback((id: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const next = await invoke<Operation>('operation', { id });
        setOperation(next);
        if (next.status === 'running') return;
        if (pollRef.current) window.clearInterval(pollRef.current);
        if (next.status === 'cancelled') {
          await loadState();
          setOperation(undefined);
          return;
        }
        if (next.status === 'error') {
          await loadState();
          setError(next.error || 'The operation failed.');
          setOperation(next);
          return;
        }
        const result = next.result as { confirmation_required?: boolean; mods?: Mod[]; signature?: string; report_submitted?: boolean; report_id?: string } | State | undefined;
        if (result && 'confirmation_required' in result && result.confirmation_required) {
          setWarning({ mods: result.mods || [], signature: result.signature || '' });
        } else if (result && 'report_submitted' in result && result.report_submitted) {
          setNotice(`Report submitted${result.report_id ? ` · ${result.report_id}` : ''}`);
          window.setTimeout(() => setNotice(''), 5000);
        } else if (result && 'profiles' in result) {
          setState(result as State);
          if (next.kind === 'add') {
            setAdding(false);
            setAddress('');
          }
        } else {
          await loadState();
        }
      } catch (reason) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void poll();
    pollRef.current = window.setInterval(poll, 300);
  }, [loadState]);

  const start = useCallback(async (kind: string, payload: Record<string, unknown> = {}) => {
    setError('');
    setOperation({ id: '', kind, status: 'running', message: 'Starting', completed: 0, total: 1 });
    try { watchOperation(await invoke<string>('start', { kind, ...payload })); }
    catch (reason) { setOperation(undefined); setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [watchOperation]);

  if (!state) return <Boot error={error} />;
  if (!state.legal_accepted) return <Legal state={state} onAccepted={setState} />;
  if (!state.onboarding_completed) return <Onboarding onComplete={async () => setState(await invoke<State>('completeOnboarding'))} />;

  const pendingPublication = (state.publications || []).find(publication =>
    publication.versions.includes(state.impulse_version) && !(state.dismissed_update_ids || []).includes(publication.id));
  if (pendingPublication) return <WhatsNew publication={pendingPublication} mode="automatic" onClose={async () => setState(await invoke<State>('dismissUpdate', { id: pendingPublication.id }))} />;

  const profile = state.selected_profile;
  const manifest = state.manifest;
  const busy = operation?.status === 'running';
  const progress = operation ? Math.min(1, (operation.completed || 0) / Math.max(1, operation.total || 1)) : 0;

  const selectProfile = async (profileId: string) => {
    setState(await invoke<State>('selectProfile', { profile_id: profileId }));
    setTab('overview');
  };

  const launch = (acceptUnverified = false) => {
    setProfileMenuOpen(false);
    if (profile) start('play', { profile_id: profile.id, accept_unverified: acceptUnverified });
  };
  const cancelLaunch = async () => {
    if (!operation?.id || operation.kind !== 'play' || operation.status !== 'running') return;
    try {
      setOperation(current => current ? { ...current, message: 'Cancelling' } : current);
      await invoke('cancelOperation', { id: operation.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><img src={impulseLogo} alt="" /></span><strong>IMPULSE</strong></div>
        <div className="topbar-actions">
          <button className="whats-new-button" onClick={() => setNewsOpen(true)}><Sparkles size={15} /> What’s new</button>
          <button className="icon-button" title="Report a bug" aria-label="Report a bug" onClick={() => setBugReportOpen(true)}><CircleHelp size={17} /></button>
          <button className="icon-button topbar-settings" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Cog size={17} /></button>
        </div>
      </header>

      <main className="workspace">
        <aside className="server-rail">
          <div className="rail-label">Servers</div>
          <div className="server-list">
            {state.profiles.map(item => <ServerRow key={item.id} profile={item} iconUrl={state.profile_icons?.[item.id]} selected={item.id === profile?.id} onClick={() => selectProfile(item.id)} />)}
            {!state.profiles.length && <div className="empty-rail">Your servers will appear here.</div>}
          </div>
          <button className="add-server" onClick={() => setAdding(true)}><Plus size={17} /> Add server</button>
        </aside>

        <section className="content">
          {state.restriction ? (
            <Restriction state={state} canRemove={!!profile} onBack={async () => setState(await invoke<State>('clearRestriction'))} onRemove={() => setDeleteOpen(true)} />
          ) : !profile ? <EmptyServer onAdd={() => setAdding(true)} /> : (
            <>
              <ServerHero profile={profile} manifest={manifest} />
              <nav className="tabs">
                <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
                <button className={tab === 'mods' ? 'active' : ''} onClick={() => setTab('mods')}>Mods</button>
              </nav>
              <div className="page-scroll" ref={pageRef}>
                {tab === 'overview' ? <Overview manifest={manifest} /> : <Mods manifest={manifest} onOptional={() => setOptionalOpen(true)} onCustom={() => setModManagerOpen(true)} />}
              </div>
              <div className="playbar">
                <button className="icon-button" title="Refresh server" disabled={busy} onClick={() => start('refresh', { profile_id: profile.id })}><RefreshCw size={18} /></button>
                <button className="play-button" disabled={busy || !manifest} onClick={() => launch(false)}>
                  <span className="play-fill" style={{ width: busy ? `${Math.max(5, progress * 100)}%` : '0%' }} />
                  <span className="play-content">{busy ? <LoaderCircle className="spin" size={19} /> : <Play size={19} fill="currentColor" />}<span className="play-label">{busy ? operation?.message : 'Play'}</span></span>
                </button>
                <div className="profile-actions">
                  {busy && operation?.kind === 'play'
                    ? <button className="icon-button cancel-launch" title="Cancel launch" aria-label="Cancel launch" onClick={cancelLaunch}><X size={20} /></button>
                    : <button className="icon-button" title="Profile actions" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen(value => !value)}><MoreHorizontal size={20} /></button>}
                  {!busy && profileMenuOpen && <div className="context-menu">
                    <button onClick={() => { setProfileMenuOpen(false); setReportOpen(true); }}><Flag size={16} /> Report server</button>
                    <div />
                    <button className="destructive" onClick={() => { setProfileMenuOpen(false); setDeleteOpen(true); }}><Trash2 size={16} /> Remove server</button>
                  </div>}
                </div>
              </div>
            </>
          )}
        </section>
      </main>

      {error && <div className="toast error"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setError('')}><X size={17} /></button></div>}
      {notice && <div className="toast success"><Check size={18} /><span>{notice}</span><button onClick={() => setNotice('')}><X size={17} /></button></div>}
      {adding && <AddServer address={address} setAddress={value => { setAddress(value); if (error) setError(''); }} busy={busy} error={operation?.kind === 'add' ? error : ''} onClose={() => !busy && setAdding(false)} onAdd={() => start('add', { address })} />}
      {deleteOpen && profile && <Confirm title="Remove this server?" text="This removes its managed files and settings. Your global mods are not changed." confirm="Remove server" destructive onClose={() => setDeleteOpen(false)} onConfirm={() => { setDeleteOpen(false); start('delete', { profile_id: profile.id }); }} />}
      {reportOpen && profile && <ReportServer profile={profile} busy={busy} onClose={() => setReportOpen(false)} onSubmit={(category, details) => { setReportOpen(false); start('report', { profile_id: profile.id, category, details }); }} />}
      {optionalOpen && profile && manifest && <OptionalMods profile={profile} manifest={manifest} onClose={() => setOptionalOpen(false)} onSave={ids => { setOptionalOpen(false); start('optional', { profile_id: profile.id, ids }); }} />}
      {warning && <VerificationWarning warning={warning} onCancel={() => setWarning(undefined)} onContinue={() => { setWarning(undefined); launch(true); }} />}
      {modManagerOpen && profile && <ModManager profile={profile} state={state} start={start} operation={operation} onClose={async () => { setModManagerOpen(false); await loadState(); }} />}
      {settingsOpen && <StandaloneSettings state={state} developerToolsOpen={developerToolsOpen} onToggleDeveloperTools={toggleDeveloperTools} onClose={() => setSettingsOpen(false)} onChange={setState} onReplay={async () => { setSettingsOpen(false); setState(await invoke<State>('replayOnboarding')); }} onNews={() => { setSettingsOpen(false); setNewsOpen(true); }} onReportBug={() => { setSettingsOpen(false); setBugReportOpen(true); }} />}
      {newsOpen && <NewsHistory publications={state.publications || []} currentVersion={state.impulse_version} dismissed={state.dismissed_update_ids || []} onClose={() => setNewsOpen(false)} />}
      {bugReportOpen && <BugReport operation={operation?.kind === 'reportBug' ? operation : undefined} onClose={() => setBugReportOpen(false)} onSubmit={(description, includeDiagnostics, screenshots) => start('reportBug', { description, include_diagnostics: includeDiagnostics, screenshots })} />}
    </div>
  );
}

function Boot({ error }: { error: string }) {
  return <div className="boot"><div className="boot-logo"><img src={impulseLogo} alt="Impulse" /><strong>IMPULSE</strong></div>{error ? <><AlertTriangle /><strong>Web interface could not start</strong><p>{error}</p></> : <><LoaderCircle className="spin" /><p>Opening your servers...</p></>}</div>;
}

function Legal({ state, onAccepted }: { state: State; onAccepted: (state: State) => void }) {
  const [privacy, setPrivacy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = (url: string) => invoke('openExternal', { url });
  return <div className="legal-screen"><div className="legal-card"><div className="legal-icon"><ShieldCheck /></div><span className="eyebrow">Before you continue</span><h1>Welcome to Impulse</h1><p>Impulse needs your agreement to its Privacy Policy and Terms of Service. These documents explain how the software works, the services it contacts, and the rules that apply when you use it.</p><div className="legal-links"><button onClick={() => open(state.privacy_url)}>Privacy Policy <ExternalLink size={15} /></button><button onClick={() => open(state.terms_url)}>Terms of Service <ExternalLink size={15} /></button></div><label className="check"><input type="checkbox" checked={privacy} onChange={e => setPrivacy(e.target.checked)} /><span><Check size={14} /></span>I have read and accept the Privacy Policy.</label><label className="check"><input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} /><span><Check size={14} /></span>I have read and accept the Terms of Service.</label><div className="modal-actions"><button className="secondary" onClick={() => invoke('quit')}>Quit Minecraft</button><button className="primary" disabled={!privacy || !terms || busy} onClick={async () => { setBusy(true); onAccepted(await invoke<State>('acceptLegal')); }}>Accept and continue</button></div></div></div>;
}

const onboardingPages = [
  { eyebrow: 'Welcome to Impulse', title: 'Your servers, ready to play', body: 'Keep every server in one place. Add an address once, choose it whenever you want to play, and let Impulse handle the preparation.', icon: Server, visual: 'servers' },
  { eyebrow: 'Prepared for you', title: 'Ready when you are', body: 'Impulse checks the server and prepares the right files before Minecraft continues, so joining stays simple even when the server changes.', icon: Rocket, visual: 'ready' },
  { eyebrow: 'Your experience', title: 'Make it yours', body: 'Choose optional server mods or discover compatible personal mods from Modrinth. Every choice stays attached to that server profile.', icon: PackagePlus, visual: 'mods' },
  { eyebrow: 'Built with care', title: 'Launch with confidence', body: 'Modern file verification, automatic repairs and clear security warnings help you understand what will run before you press Play.', icon: ShieldCheck, visual: 'secure' },
] as const;

function Onboarding({ onComplete }: { onComplete: () => Promise<void> }) {
  const [page, setPage] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const current = onboardingPages[page];
  const Icon = current.icon;
  const finish = async () => { setLeaving(true); await onComplete(); };
  return <div className={`onboarding ${leaving ? 'leaving' : ''}`}>
    <div className="onboarding-backdrop" />
    <header><div className="brand"><span className="brand-mark"><img src={impulseLogo} alt="" /></span><strong>IMPULSE</strong></div><button className="onboarding-close" title="Close onboarding" onClick={finish}><X /></button></header>
    <main key={page}>
      <section className="onboarding-copy"><span className="eyebrow">{current.eyebrow}</span><h1>{current.title}</h1><p>{current.body}</p></section>
      <section className={`onboarding-visual ${current.visual}`} aria-hidden="true"><div className="visual-core"><Icon /></div></section>
    </main>
    <footer><div className="onboarding-progress">{onboardingPages.map((_, index) => <button key={index} aria-label={`Page ${index + 1}`} className={index === page ? 'active' : index < page ? 'complete' : ''} onClick={() => setPage(index)} />)}</div><div className="onboarding-actions"><button className="secondary" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft /> Back</button>{page < onboardingPages.length - 1 ? <button className="primary" onClick={() => setPage(value => value + 1)}>Next <ChevronRight /></button> : <button className="primary" onClick={finish}>Get started <ChevronRight /></button>}</div></footer>
  </div>;
}

function updateIcon(name: UpdateSection['icon']) {
  if (name === 'shield-check') return ShieldCheck;
  if (name === 'package-plus') return PackagePlus;
  if (name === 'scan-check') return ScanSearch;
  if (name === 'wrench') return Wrench;
  if (name === 'rocket') return Rocket;
  if (name === 'server') return Server;
  if (name === 'download') return Download;
  return Sparkles;
}

function WhatsNew({ publication, mode, onClose, onPrevious, onNext, position }: { publication: UpdatePublication; mode: 'automatic' | 'history'; onClose: () => void | Promise<void>; onPrevious?: () => void; onNext?: () => void; position?: string }) {
  const hero = useNativeImage(publication.hero_image_url || undefined);
  return <div className="whats-new-screen">
    <div className="news-ambient" style={hero ? { backgroundImage: `linear-gradient(90deg, rgba(3,3,3,.93), rgba(3,3,3,.62)), url(${hero})` } : undefined} />
    <header><div className="brand"><span className="brand-mark"><img src={impulseLogo} alt="" /></span><strong>IMPULSE</strong><span>{mode === 'automatic' ? 'Updated' : 'What’s new'}</span></div><button className="onboarding-close" title="Close" onClick={onClose}><X /></button></header>
    <main><div className="news-heading"><span className="eyebrow">{mode === 'automatic' ? 'Impulse just got better' : new Date(publication.published_at).toLocaleDateString()}</span><h1>{publication.title}</h1><p>{publication.subtitle}</p><div className="news-versions">For {publication.versions.join(' · ')}</div></div><div className="news-sections">{publication.sections.map(section => { const Icon = updateIcon(section.icon); return <article key={`${publication.id}-${section.title}`}><span><Icon /></span><div><h2>{section.title}</h2><p>{section.body}</p></div></article>; })}</div></main>
    <footer>{mode === 'history' ? <><button className="secondary news-nav" disabled={!onPrevious} onClick={onPrevious}><ChevronLeft /> Newer</button><span>{position}</span><button className="secondary news-nav" disabled={!onNext} onClick={onNext}>Older <ChevronRight /></button></> : <><span>Discover what changed, then continue to your servers.</span><button className="primary" onClick={onClose}>Continue <ChevronRight /></button></>}</footer>
  </div>;
}

function NewsHistory({ publications, currentVersion, dismissed, onClose }: { publications: UpdatePublication[]; currentVersion: string; dismissed: string[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  if (!publications.length) return <div className="modal-backdrop"><div className="modal"><button className="modal-close" onClick={onClose}><X /></button><span className="eyebrow">What’s new</span><h2>No publications yet</h2><p>There are no Impulse update notes available right now.</p><div className="modal-actions"><button className="primary" onClick={onClose}>Close</button></div></div></div>;
  const publication = publications[Math.min(index, publications.length - 1)];
  return <div className="news-history-layer"><WhatsNew publication={publication} mode="history" onClose={onClose} onPrevious={index > 0 ? () => setIndex(value => value - 1) : undefined} onNext={index < publications.length - 1 ? () => setIndex(value => value + 1) : undefined} position={`${index + 1} of ${publications.length}${publication.versions.includes(currentVersion) ? ' · This version' : ''}${dismissed.includes(publication.id) ? ' · Read' : ''}`} /></div>;
}

type BugScreenshot = { id: string; name: string; mime: string; base64: string; preview: string; size: number };
type BugReportInfo = { attachments: { name: string; size: number; kind: string }[] };
type PickedScreenshot = { name: string; mime: string; base64: string };

async function compressScreenshot(file: File): Promise<BugScreenshot> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(`${file.name} is not a supported image.`);
  const bitmap = await createImageBitmap(file);
  if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); throw new Error(`${file.name} is larger than 40 megapixels.`); }
  let scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  let blob: Blob | null = null;
  for (let pass = 0; pass < 8; pass += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) { bitmap.close(); throw new Error('Impulse could not process this screenshot.'); }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const quality = Math.max(.48, .9 - pass * .07);
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= 5 * 1024 * 1024) break;
    scale *= .82;
  }
  bitmap.close();
  if (!blob || blob.size > 5 * 1024 * 1024) throw new Error(`${file.name} could not be compressed below 5 MiB.`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { id: crypto.randomUUID(), name: file.name, mime: 'image/jpeg', base64: btoa(binary), preview: URL.createObjectURL(blob), size: blob.size };
}

function BugReport({ operation, onClose, onSubmit }: { operation?: Operation; onClose: () => void; onSubmit: (description: string, includeDiagnostics: boolean, screenshots: Omit<BugScreenshot, 'preview' | 'id' | 'name' | 'size'>[]) => void }) {
  const [description, setDescription] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [screenshots, setScreenshots] = useState<BugScreenshot[]>([]);
  const [info, setInfo] = useState<BugReportInfo>({ attachments: [] });
  const [localError, setLocalError] = useState('');
  const [processing, setProcessing] = useState(false);
  const screenshotsRef = useRef<BugScreenshot[]>([]);
  const busy = operation?.status === 'running';
  const result = operation?.status === 'done' ? operation.result as { report_submitted?: boolean; report_id?: string } : undefined;
  useEffect(() => { void invoke<BugReportInfo>('bugReportInfo').then(setInfo).catch(() => undefined); }, []);
  useEffect(() => { screenshotsRef.current = screenshots; }, [screenshots]);
  useEffect(() => () => screenshotsRef.current.forEach(item => URL.revokeObjectURL(item.preview)), []);
  const pickImages = async () => {
    if (busy || processing || screenshots.length >= 5 || result?.report_submitted) return;
    setProcessing(true); setLocalError('');
    try {
      const picked = await invoke<PickedScreenshot[]>('pickScreenshots');
      if (screenshots.length + picked.length > 5) throw new Error('You can attach up to five screenshots.');
      const added: BugScreenshot[] = [];
      for (const item of picked) {
        const binary = atob(item.base64);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        added.push(await compressScreenshot(new File([bytes], item.name, { type: item.mime })));
      }
      setScreenshots(current => [...current, ...added]);
    } catch (reason) { setLocalError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setProcessing(false); }
  };
  const remove = (id: string) => setScreenshots(current => { const item = current.find(value => value.id === id); if (item) URL.revokeObjectURL(item.preview); return current.filter(value => value.id !== id); });
  const valid = description.trim().length >= 20 && description.trim().length <= 10000;
  return <div className="bug-report-screen"><header><div className="brand"><span className="brand-mark"><img src={impulseLogo} alt="" /></span><strong>IMPULSE</strong><span>Support</span></div><button className="onboarding-close" disabled={busy} onClick={onClose}><X /></button></header><main><section className="bug-report-copy"><span className="eyebrow">Report a bug</span><h1>Help us make Impulse better</h1><p>Describe what happened and what you expected. Technical details are only included when the option below is enabled.</p><label className="field"><span>What happened?</span><textarea autoFocus disabled={busy || !!result?.report_submitted} value={description} maxLength={10000} onChange={event => setDescription(event.target.value)} placeholder="Tell us what you were doing, what went wrong, and whether you can reproduce it." /><small>{description.trim().length}/10,000 · minimum 20 characters</small></label><label className="diagnostics-check"><input type="checkbox" checked={includeDiagnostics} disabled={busy || !!result?.report_submitted} onChange={event => setIncludeDiagnostics(event.target.checked)} /><span><Check /></span><div><strong>Include diagnostics</strong><small>Attach anonymous technical details from the previous launch.</small></div></label>{includeDiagnostics && <details className="diagnostic-files" open><summary>{info.attachments.length} diagnostic file{info.attachments.length === 1 ? '' : 's'} selected</summary>{info.attachments.length ? info.attachments.map(file => <div key={`${file.kind}-${file.name}`}><Paperclip /><span>{file.name}</span><small>{fmtBytes(file.size)}</small></div>) : <p>No previous-launch diagnostics are available.</p>}</details>}</section><aside className="bug-screenshots"><div><span className="eyebrow">Screenshots</span><h2>Add visual context</h2><p>Up to five images. Impulse compresses them before upload.</p></div><button type="button" className="screenshot-picker" disabled={busy || processing || screenshots.length >= 5 || !!result?.report_submitted} onClick={() => void pickImages()}><Plus /><strong>{processing ? 'Processing images…' : 'Add screenshots'}</strong><small>PNG, JPEG or WebP · 5 MiB each after compression</small></button><div className="screenshot-grid">{screenshots.map(item => <figure key={item.id}><img src={item.preview} alt={item.name} /><button disabled={busy} onClick={() => remove(item.id)}><X /></button><figcaption>{fmtBytes(item.size)}</figcaption></figure>)}</div></aside></main><footer><div>{(localError || operation?.error) && <span className="bug-error"><AlertTriangle />{localError || operation?.error}</span>}{result?.report_submitted && <span className="bug-success"><Check />Report received · {result.report_id}</span>}</div><div><button className="secondary" disabled={busy} onClick={onClose}>{result?.report_submitted ? 'Close' : 'Cancel'}</button>{!result?.report_submitted && <button className="primary" disabled={!valid || busy || processing} onClick={() => onSubmit(description.trim(), includeDiagnostics, screenshots.map(({ mime, base64 }) => ({ mime, base64 })))}>{busy ? <><LoaderCircle className="spin" /> Sending…</> : operation?.status === 'error' ? 'Try again' : 'Submit report'}</button>}</div></footer></div>;
}

function StandaloneSettings({ state, developerToolsOpen, onToggleDeveloperTools, onClose, onChange, onReplay, onNews, onReportBug }: { state: State; developerToolsOpen: boolean; onToggleDeveloperTools: () => void; onClose: () => void; onChange: (state: State) => void; onReplay: () => void; onNews: () => void; onReportBug: () => void }) {
  return <div className="modal-backdrop"><div className="modal settings-modal"><button className="modal-close" onClick={onClose}><X /></button><span className="eyebrow">Impulse</span><h2>Settings</h2><p>Manage how this Impulse installation behaves.</p><section className="settings-section"><div><strong>Update channel</strong><small>Stable receives production releases. Beta also receives previews.</small></div><div className="segments">{(['stable', 'beta'] as const).map(channel => <button key={channel} className={state.update_channel === channel ? 'active' : ''} onClick={async () => onChange(await invoke<State>('setUpdateChannel', { channel }))}>{channel}</button>)}</div></section><section className="settings-section"><div><strong>Developer tools</strong><small>{state.developer_tools_enabled ? 'Toggle with F12, Ctrl+Shift+I, or Cmd+Option+I. Press Escape to close.' : 'Enable the embedded inspector and its keyboard shortcuts.'}</small></div><div className="settings-tools-actions"><div className="segments"><button className={!state.developer_tools_enabled ? 'active' : ''} onClick={async () => onChange(await invoke<State>('setDeveloperTools', { enabled: false }))}>Off</button><button className={state.developer_tools_enabled ? 'active' : ''} onClick={async () => onChange(await invoke<State>('setDeveloperTools', { enabled: true }))}>On</button></div>{state.developer_tools_enabled && <button className="secondary" onClick={onToggleDeveloperTools}>{developerToolsOpen ? 'Close' : 'Open'}</button>}</div></section><section className="settings-section"><div><strong>Report a bug</strong><small>Send feedback with optional launch diagnostics and screenshots.</small></div><button className="secondary" onClick={onReportBug}><Bug /> Open</button></section><section className="settings-section"><div><strong>What’s new</strong><small>Read current and previous Impulse update notes.</small></div><button className="secondary" onClick={onNews}><History /> Open</button></section><section className="settings-section"><div><strong>Onboarding</strong><small>Replay the introduction to Impulse.</small></div><button className="secondary" onClick={onReplay}><Rocket /> Replay</button></section><footer className="settings-about"><span>Installed version</span><strong>{state.impulse_version}</strong></footer></div></div>;
}

function ServerRow({ profile, iconUrl, selected, onClick }: { profile: Profile; iconUrl?: string; selected: boolean; onClick: () => void }) {
  const icon = useNativeImage(iconUrl);
  return <button className={`server-row ${selected ? 'selected' : ''}`} onClick={onClick}><span className="server-icon">{icon ? <img src={icon} alt="" /> : <Server />}</span><span><strong>{profile.name || 'Minecraft Server'}</strong><small>{profile.address}</small></span><i /></button>;
}

function EmptyServer({ onAdd }: { onAdd: () => void }) {
  return <div className="empty-server"><div><Server /><h1>Add your first server</h1><p>Enter a Minecraft server address and Impulse will prepare everything you need to join.</p><button className="primary" onClick={onAdd}><Plus size={18} /> Add server</button></div></div>;
}

function ServerHero({ profile, manifest }: { profile: Profile; manifest?: Manifest }) {
  const banner = useNativeImage(manifest?.banner_url);
  const icon = useNativeImage(manifest?.icon_url);
  const [videoFailed, setVideoFailed] = useState(false);
  const video = manifest?.video_background_url;
  useEffect(() => setVideoFailed(false), [video]);
  const showVideo = Boolean(video && !videoFailed);
  return <div className="server-hero" style={!showVideo && banner ? { backgroundImage: `linear-gradient(90deg, rgba(4,4,4,.82), rgba(4,4,4,.22)), url(${banner})` } : undefined}>{showVideo && <video className="hero-video" src={video} autoPlay muted loop playsInline onError={() => setVideoFailed(true)} />}<div className="hero-shade" /><div className="hero-noise" /><div className="hero-details">{icon ? <img src={icon} alt="" /> : <span className="hero-icon"><Server /></span>}<div><h1>{manifest?.name || profile.name || 'Minecraft Server'}</h1><p>{profile.address}</p><div className="hero-meta"><span><i className="online" /> Ready</span><span>{manifest?.minecraft?.version || 'Minecraft'}</span><span>{manifest?.minecraft?.loader || 'NeoForge'} {manifest?.minecraft?.loader_version}</span></div></div></div></div>;
}

function Overview({ manifest }: { manifest?: Manifest }) {
  const required = manifest?.mods?.length || 0;
  const optional = manifest?.optional_mods?.length || 0;
  return <div className="overview-grid"><section className="panel server-about"><span className="eyebrow">Server</span><h2>{manifest?.name || 'Minecraft Server'}</h2><p>{manifest?.description || 'This server is ready to be managed through Impulse.'}</p></section><section className="metric"><Package /><span>Required mods</span><strong>{required}</strong></section><section className="metric"><Settings2 /><span>Optional mods</span><strong>{optional}</strong></section><section className="metric wide"><ShieldCheck /><span>Compatibility</span><strong>{manifest ? 'Ready' : 'Refresh required'}</strong><small>{manifest ? `${manifest.minecraft?.loader || 'NeoForge'} ${manifest.minecraft?.loader_version || ''}` : 'Check this server to continue.'}</small></section></div>;
}

function Mods({ manifest, onOptional, onCustom }: { manifest?: Manifest; onOptional: () => void; onCustom: () => void }) {
  return <div className="mods-view"><div className="section-heading"><div><span className="eyebrow">Profile content</span><h2>Mods</h2><p>Required additions are prepared automatically. Optional and personal additions stay under your control.</p></div><div className="heading-actions"><button className="secondary" onClick={onOptional}><Settings2 size={16} /> Optional mods</button><button className="primary" onClick={onCustom}><Plus size={16} /> Add custom mods</button></div></div><ModGroup title="Required" mods={manifest?.mods || []} /><ModGroup title="Optional" mods={manifest?.optional_mods || []} /></div>;
}

function ModGroup({ title, mods }: { title: string; mods: Mod[] }) {
  return <section className="mod-group"><header><h3>{title}</h3><span>{mods.length} files</span></header>{mods.length ? <div className="mod-list">{mods.map((mod, index) => <div className="mod-row" key={mod.id || mod.file_name || index}><span className="mod-glyph"><Package /></span><div><strong>{mod.name || mod.file_name}</strong><p>{mod.description || mod.file_name}</p></div><small>{fmtBytes(mod.size)}</small></div>)}</div> : <div className="empty-inline">No {title.toLowerCase()} mods.</div>}</section>;
}

function Restriction({ state, canRemove, onBack, onRemove }: { state: State; canRemove: boolean; onBack: () => void; onRemove: () => void }) {
  const item = state.restriction!;
  return <div className="restriction"><div className="restriction-art"><div className="shield-ring"><LockKeyhole /></div></div><span className="eyebrow">Impulse Security</span><h1>{item.heading}</h1><h2>{item.title}</h2><p>{item.description}</p><div className="restricted-host"><Globe2 /><span><small>Restricted address</small>{item.host}</span></div><div className="restriction-actions"><button className="secondary" onClick={onBack}><ArrowLeft /> Back</button>{canRemove && <button className="danger" onClick={onRemove}><Trash2 /> Remove server</button>}</div></div>;
}

function Modal({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop"><div className={`modal ${wide ? 'wide' : ''}`}>{children}</div></div>;
}

function AddServer({ address, setAddress, busy, error, onClose, onAdd }: { address: string; setAddress: (value: string) => void; busy: boolean; error: string; onClose: () => void; onAdd: () => void }) {
  return <Modal><button className="modal-close" disabled={busy} onClick={onClose}><X /></button><span className="eyebrow">New profile</span><h2>Add a server</h2><p>Enter the Minecraft server address. Impulse will verify it before adding it to your profiles.</p><label className="field"><span>Server address</span><input autoFocus disabled={busy} value={address} onChange={event => setAddress(event.target.value)} placeholder="play.example.com:25565" onKeyDown={event => event.key === 'Enter' && !busy && address.trim() && onAdd()} /></label>{error && <div className="inline-error"><AlertTriangle size={16} /><span>{error}</span></div>}<div className="modal-actions"><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !address.trim()} onClick={onAdd}>{busy ? <><LoaderCircle className="spin" /> Adding server...</> : <>Add server <Plus /></>}</button></div></Modal>;
}

function Confirm({ title, text, confirm, destructive, onClose, onConfirm }: { title: string; text: string; confirm: string; destructive?: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Modal><button className="modal-close" onClick={onClose}><X /></button><h2>{title}</h2><p>{text}</p><div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className={destructive ? 'danger' : 'primary'} onClick={onConfirm}>{confirm}</button></div></Modal>;
}

const REPORT_CATEGORIES = [
  ['malicious_files', 'Malicious or suspicious files'],
  ['credential_theft', 'Credential theft or phishing'],
  ['impersonation', 'Impersonation'],
  ['fraud', 'Fraud or scam'],
  ['abuse', 'Severe abusive activity'],
  ['other_security', 'Other security concern'],
] as const;

function ReportServer({ profile, busy, onClose, onSubmit }: { profile: Profile; busy: boolean; onClose: () => void; onSubmit: (category: string, details: string) => void }) {
  const [category, setCategory] = useState<string>(REPORT_CATEGORIES[0][0]);
  const [details, setDetails] = useState('');
  const valid = details.trim().length >= 20 && details.trim().length <= 2000;
  return <Modal><button className="modal-close" onClick={onClose}><X /></button><span className="eyebrow">Impulse Security</span><h2>Report this server</h2><p>Tell Impulse about a security or safety concern. Reports are reviewed before any restriction is applied.</p><div className="report-target"><Server size={17} /><span><strong>{profile.name || 'Minecraft Server'}</strong><small>{profile.address}</small></span></div><label className="field"><span>Reason</span><select value={category} onChange={event => setCategory(event.target.value)}>{REPORT_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>What happened?</span><textarea autoFocus value={details} maxLength={2000} onChange={event => setDetails(event.target.value)} placeholder="Describe what you observed and include enough detail for the report to be reviewed." /><small>{details.trim().length}/2000 · minimum 20 characters</small></label><div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !valid} onClick={() => onSubmit(category, details.trim())}><Flag size={16} /> Submit report</button></div></Modal>;
}

function OptionalMods({ profile, manifest, onClose, onSave }: { profile: Profile; manifest: Manifest; onClose: () => void; onSave: (ids: string[]) => void }) {
  const [selected, setSelected] = useState(new Set(profile.selected_optional_ids || []));
  const categories = manifest.optional_mod_categories || [];
  const uncategorized = (manifest.optional_mods || []).filter(mod => !mod.category_id || !categories.some(category => category.id === mod.category_id));
  const toggle = (id?: string) => id && setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  return <Modal wide><button className="modal-close" onClick={onClose}><X /></button><span className="eyebrow">Server profile</span><h2>Optional mods</h2><p>Choose the additions you want to use. Required dependencies are enabled automatically when the profile is prepared.</p><div className="optional-scroll">{categories.map(category => <OptionalCategory key={category.id} name={category.name} description={category.description} mods={(manifest.optional_mods || []).filter(mod => mod.category_id === category.id)} selected={selected} toggle={toggle} />)}{uncategorized.length > 0 && <OptionalCategory name="Other" mods={uncategorized} selected={selected} toggle={toggle} />}</div><div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSave([...selected])}>Save choices</button></div></Modal>;
}

function OptionalCategory({ name, description, mods, selected, toggle }: { name: string; description?: string; mods: Mod[]; selected: Set<string>; toggle: (id?: string) => void }) {
  return <section className="optional-category"><header><div><h3>{name}</h3>{description && <p>{description}</p>}</div><span>{mods.length}</span></header>{mods.map(mod => <label className="optional-row" key={mod.id}><input type="checkbox" checked={!!mod.id && selected.has(mod.id)} onChange={() => toggle(mod.id)} /><span className="toggle"><i /></span><div><strong>{mod.name || mod.file_name}</strong><p>{mod.description || mod.file_name}</p></div><small>{fmtBytes(mod.size)}</small></label>)}</section>;
}

function VerificationWarning({ warning, onCancel, onContinue }: { warning: Warning; onCancel: () => void; onContinue: () => void }) {
  const [seconds, setSeconds] = useState(5);
  useEffect(() => { const timer = window.setInterval(() => setSeconds(value => Math.max(0, value - 1)), 1000); return () => window.clearInterval(timer); }, []);
  return <Modal wide><div className="warning-head"><span><FileWarning /></span><div><span className="eyebrow">Security check</span><h2>Some server mods could not be independently verified</h2></div></div><p>Impulse confirmed that these files match the SHA-512 hashes declared by the server, but some could not be matched to a compatible Modrinth or CurseForge release, or the Impulse recognized-mod registry. Minecraft mods can run code on your computer. Continue only if you trust this server or reviewed these files yourself.</p><div className="warning-list">{warning.mods.map((mod, index) => <div key={mod.sha512 || index}><div><strong>{mod.name || mod.file_name}</strong><span>{mod.verification?.status || 'Verification unavailable'}</span></div><small>{mod.file_name}</small><code>{mod.sha512}</code></div>)}</div><div className="modal-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={seconds > 0} onClick={onContinue}>{seconds > 0 ? `Continue anyway (${seconds})` : 'Continue anyway'}</button></div></Modal>;
}

function ModManager({ profile, state, start, operation, onClose }: { profile: Profile; state: State; start: (kind: string, payload?: Record<string, unknown>) => void; operation?: Operation; onClose: () => void }) {
  const [view, setView] = useState<ModView>('installed');
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState<'release' | 'beta' | 'all'>('release');
  const [results, setResults] = useState<SearchProject[]>([]);
  const [project, setProject] = useState<Project>();
  const [versions, setVersions] = useState<Version[]>([]);
  const [globalMods, setGlobalMods] = useState<GlobalMod[]>([]);
  const [customMods, setCustomMods] = useState(state.custom_mods || []);
  const [installPlan, setInstallPlan] = useState<InstallPlan>();
  const [installLocation, setInstallLocation] = useState<'profile' | 'global'>('profile');
  const [optionalProjects, setOptionalProjects] = useState(new Set<string>());
  const [lightbox, setLightbox] = useState<string>();
  const [removeTarget, setRemoveTarget] = useState<CustomMod>();
  const lastOperation = useRef('');

  useEffect(() => { start('globalMods', { profile_id: profile.id }); }, [profile.id]);

  useEffect(() => {
    if (!operation || operation.status !== 'done' || operation.id === lastOperation.current) return;
    lastOperation.current = operation.id;
    if (operation.kind === 'searchMods') { setResults((operation.result as SearchProject[]) || []); setView('search'); }
    if (operation.kind === 'project') { setProject(operation.result as Project); setView('project'); }
    if (operation.kind === 'versions') { setVersions((operation.result as Version[]) || []); setView('versions'); }
    if (operation.kind === 'globalMods') setGlobalMods((operation.result as GlobalMod[]) || []);
    if (operation.kind === 'planMod') { setInstallPlan(operation.result as InstallPlan); setOptionalProjects(new Set()); }
    if (['installMod', 'removeMod', 'repairMod', 'checkUpdates'].includes(operation.kind)) {
      const result = operation.result as { mods?: State['custom_mods'] };
      if (result?.mods) setCustomMods(result.mods);
      setInstallPlan(undefined);
      if (operation.kind === 'removeMod') setView('installed');
      window.setTimeout(() => start('globalMods', { profile_id: profile.id }), 0);
    }
  }, [operation]);

  const openProject = (id: string) => start('project', { profile_id: profile.id, project_id: id });
  const search = () => query.trim() && start('searchMods', { profile_id: profile.id, query });
  const planInstall = (versionId = '') => project && start('planMod', { profile_id: profile.id, project_id: project.project_id, version_id: versionId, channel });
  const install = () => project && start('installMod', { profile_id: profile.id, project_id: project.project_id, version_id: installPlan ? Object.values(installPlan.items)[0]?.version.id : '', channel, location: installLocation, optional_projects: [...optionalProjects] });
  const busy = operation?.status === 'running';
  const installedProject = project ? customMods.find(mod => mod.project_id === project.project_id) : undefined;

  return <div className="manager-overlay"><div className="manager"><header className="manager-header"><div><button className="icon-button" onClick={view === 'installed' ? onClose : () => setView(view === 'versions' ? 'project' : 'installed')}><ArrowLeft /></button><span><strong>Custom mods</strong><small>{profile.name || profile.address}</small></span></div><button className="icon-button" onClick={onClose}><X /></button></header><div className="manager-toolbar"><div className="searchbox"><Search /><input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder="Search Modrinth" /><button onClick={search}>Search</button></div><div className="segments">{(['release', 'beta', 'all'] as const).map(item => <button className={channel === item ? 'active' : ''} onClick={() => setChannel(item)} key={item}>{item}</button>)}</div></div><div className="manager-content">{view === 'installed' && <InstalledMods customMods={customMods} globalMods={globalMods} onProject={openProject} start={start} profile={profile} />}{view === 'search' && <SearchResults results={results} onProject={openProject} />}{view === 'project' && project && <ProjectPage project={project} installed={installedProject} onVersions={() => start('versions', { profile_id: profile.id, project_id: project.project_id, channel })} onInstall={() => planInstall()} onRepair={() => start('repairMod', { profile_id: profile.id, project_id: project.project_id })} onRemove={() => installedProject && setRemoveTarget(installedProject)} onImage={setLightbox} />}{view === 'versions' && <Versions versions={versions} onInstall={id => planInstall(id)} />}</div>{busy && <div className="manager-progress"><LoaderCircle className="spin" /><span>{operation?.message}</span><progress value={operation?.completed || 0} max={operation?.total || 1} /></div>}</div>{lightbox && <div className="lightbox" onClick={() => setLightbox(undefined)}><NativeImage url={lightbox} /><button><X /></button></div>}{installPlan && <InstallConfirmation plan={installPlan} location={installLocation} setLocation={setInstallLocation} optional={optionalProjects} setOptional={setOptionalProjects} onClose={() => setInstallPlan(undefined)} onInstall={install} />}{removeTarget && <Confirm title={`Remove ${removeTarget.name || 'this mod'}?`} text={`The managed jar will be removed from ${removeTarget.location === 'global' ? 'the global /mods folder' : 'this profile'}. Dependencies still required by another mod will be kept.`} confirm="Remove mod" destructive onClose={() => setRemoveTarget(undefined)} onConfirm={() => { const projectId = removeTarget.project_id; setRemoveTarget(undefined); start('removeMod', { profile_id: profile.id, project_id: projectId }); }} />}</div>;
}

function InstalledMods({ customMods, globalMods, onProject, start, profile }: { customMods: State['custom_mods']; globalMods: GlobalMod[]; onProject: (id: string) => void; start: (kind: string, payload?: Record<string, unknown>) => void; profile: Profile }) {
  const mods = (customMods || []).filter(mod => mod.location !== 'global');
  return <div className="browser-list"><div className="section-heading compact"><div><span className="eyebrow">This profile</span><h2>Installed custom mods</h2></div><button className="secondary" onClick={() => start('checkUpdates', { profile_id: profile.id })}><RefreshCw /> Check updates</button></div>{mods.length ? mods.map(mod => <button className="browser-row" key={mod.project_id} onClick={() => onProject(mod.project_id)}><NativeImage url={mod.icon_url} className="project-icon" /><span><strong>{mod.name || mod.project_id}</strong><p>{mod.description || `Version ${mod.version_number || 'unknown'}`}</p><small>{mod.location === 'global' ? 'Global /mods' : 'Profile'}{mod.update_version_number ? ` · Update ${mod.update_version_number} available` : ''}</small></span><ChevronRight /></button>) : <div className="empty-inline">No profile-specific custom mods.</div>}<div className="section-heading compact global-heading"><div><span className="eyebrow">Minecraft instance</span><h2>Global /mods</h2></div></div>{globalMods.length ? globalMods.map(mod => <button className={`browser-row ${mod.compatibility === 'incompatible' ? 'incompatible' : ''}`} key={mod.file_name} onClick={() => mod.project_id && onProject(mod.project_id)}><NativeImage url={mod.icon_url} className="project-icon" /><span><strong>{mod.name || mod.file_name}</strong><p>{mod.reason || mod.file_name}</p><small>{mod.version_number || 'Local jar'} · {fmtBytes(mod.size)}</small></span>{mod.project_id && <ChevronRight />}</button>) : <div className="empty-inline">No global mods detected.</div>}</div>;
}

function InstallConfirmation({ plan, location, setLocation, optional, setOptional, onClose, onInstall }: { plan: InstallPlan; location: 'profile' | 'global'; setLocation: (value: 'profile' | 'global') => void; optional: Set<string>; setOptional: (value: Set<string>) => void; onClose: () => void; onInstall: () => void }) {
  const items = Object.values(plan.items);
  const total = items.reduce((sum, item) => sum + (item.file?.size || 0), 0);
  return <Modal wide><button className="modal-close" onClick={onClose}><X /></button><span className="eyebrow">Review installation</span><h2>Install {items[0]?.project.title || 'custom mod'}?</h2><p>Impulse resolved {items.length} compatible file{items.length === 1 ? '' : 's'}, including required dependencies.</p><div className="install-plan">{items.map(item => <div key={item.project.project_id}><Package /><span><strong>{item.project.title}</strong><small>{item.version.version_number}{!item.explicit ? ' · Required dependency' : ''}</small></span><small>{fmtBytes(item.file.size)}</small></div>)}</div>{!!plan.optional_dependencies?.length && <div className="optional-deps"><span className="eyebrow">Suggested dependencies</span>{plan.optional_dependencies.map(item => <label key={item.project_id}><input type="checkbox" checked={optional.has(item.project_id)} onChange={() => { const next = new Set(optional); next.has(item.project_id) ? next.delete(item.project_id) : next.add(item.project_id); setOptional(next); }} /> {item.name}</label>)}</div>}<div className="install-location"><button className={location === 'profile' ? 'active' : ''} onClick={() => setLocation('profile')}><strong>This profile</strong><span>Isolated to this server</span></button><button className={location === 'global' ? 'active' : ''} onClick={() => setLocation('global')}><strong>Global /mods</strong><span>Loaded for every profile</span></button></div><div className="modal-actions"><span className="install-total">{fmtBytes(total)}</span><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={onInstall}>Install</button></div></Modal>;
}

function SearchResults({ results, onProject }: { results: SearchProject[]; onProject: (id: string) => void }) {
  return <div className="browser-list"><div className="section-heading compact"><div><span className="eyebrow">Modrinth</span><h2>{results.length} compatible results</h2></div></div>{results.map(item => <button className="browser-row" key={item.project_id} onClick={() => onProject(item.project_id)}><NativeImage url={item.icon_url} className="project-icon" /><span><strong>{item.title}</strong><p>{item.description}</p><small>by {item.author || 'Unknown author'} · {(item.downloads || 0).toLocaleString()} downloads</small></span><ChevronRight /></button>)}</div>;
}

function ProjectPage({ project, installed, onVersions, onInstall, onRepair, onRemove, onImage }: { project: Project; installed?: CustomMod; onVersions: () => void; onInstall: () => void; onRepair: () => void; onRemove: () => void; onImage: (url: string) => void }) {
  return <article className="project-page"><header><NativeImage url={project.icon_url} className="project-large-icon" /><div><span className="eyebrow">{project.authors?.join(', ') || project.author || 'Modrinth project'}</span><h1>{project.title}</h1><p>{project.description}</p><div className="project-facts"><span>{(project.downloads || 0).toLocaleString()} downloads</span>{project.license_name && <span>{project.license_name}</span>}{installed && <span>Installed in {installed.location === 'global' ? 'Global /mods' : 'this profile'}</span>}</div></div><div className="project-actions">{installed ? <><button className="primary" onClick={onInstall}><Download /> {installed.update_version_number ? 'Update' : 'Reinstall latest'}</button><button className="secondary" onClick={onRepair}><Wrench /> Repair</button><button className="danger" disabled={installed.explicit === false && !!installed.required_by?.length} title={installed.explicit === false && installed.required_by?.length ? 'This mod is required by another installed mod.' : undefined} onClick={onRemove}><Trash2 /> Remove</button></> : <button className="primary" onClick={onInstall}><Download /> Install latest</button>}<button className="secondary" onClick={onVersions}>Versions</button></div></header>{project.gallery && project.gallery.length > 0 && <div className="gallery">{project.gallery.slice(0, 8).map((image, index) => <button key={image.url} className={index === 0 ? 'featured' : ''} onClick={() => onImage(image.url)}><NativeImage url={image.url} /><span>{image.title}</span></button>)}</div>}<div className="project-body">{(project.body || project.description || '').split(/\n+/).filter(Boolean).map((line, index) => line.startsWith('#') ? <h3 key={index}>{line.replace(/^#+\s*/, '')}</h3> : <p key={index}>{line}</p>)}</div></article>;
}

function Versions({ versions, onInstall }: { versions: Version[]; onInstall: (id: string) => void }) {
  return <div className="versions"><div className="section-heading compact"><div><span className="eyebrow">Compatible builds</span><h2>Versions</h2></div></div>{versions.map(version => <article key={version.id}><div><strong>{version.name || version.version_number}</strong><span className={`release ${version.version_type}`}>{version.version_type}</span><p>{version.changelog || 'No changelog provided.'}</p><small>{version.date_published ? new Date(version.date_published).toLocaleDateString() : ''} · {fmtBytes(version.files?.[0]?.size)}</small></div><button className="secondary" onClick={() => onInstall(version.id)}>Install</button></article>)}</div>;
}
