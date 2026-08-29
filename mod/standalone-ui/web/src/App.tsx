import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, ChevronRight, Download, ExternalLink, FileWarning,
  Globe2, ImageOff, LoaderCircle, LockKeyhole, MoreHorizontal, Package, Play, Plus,
  RefreshCw, Search, Server, Settings2, ShieldCheck, Trash2, Wrench, X,
} from 'lucide-react';
import { heartbeat, invoke } from './bridge';
import type { GlobalMod, InstallPlan, Manifest, Mod, Operation, Profile, Project, SearchProject, State, Version } from './types';

type Tab = 'overview' | 'mods';
type ModView = 'installed' | 'search' | 'project' | 'versions';
type Warning = { mods: Mod[]; signature: string };

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
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [modManagerOpen, setModManagerOpen] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);
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

  useEffect(() => { if (pageRef.current) pageRef.current.scrollTop = 0; }, [state?.selected_profile?.id, tab]);

  const watchOperation = useCallback((id: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const next = await invoke<Operation>('operation', { id });
        setOperation(next);
        if (next.status === 'running') return;
        if (pollRef.current) window.clearInterval(pollRef.current);
        if (next.status === 'error') {
          setError(next.error || 'The operation failed.');
          await loadState();
          return;
        }
        const result = next.result as { confirmation_required?: boolean; mods?: Mod[]; signature?: string } | State | undefined;
        if (result && 'confirmation_required' in result && result.confirmation_required) {
          setWarning({ mods: result.mods || [], signature: result.signature || '' });
        } else if (result && 'profiles' in result) {
          setState(result as State);
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

  const profile = state.selected_profile;
  const manifest = state.manifest;
  const busy = operation?.status === 'running';
  const progress = operation ? Math.min(1, (operation.completed || 0) / Math.max(1, operation.total || 1)) : 0;

  const selectProfile = async (profileId: string) => {
    setState(await invoke<State>('selectProfile', { profile_id: profileId }));
    setTab('overview');
  };

  const launch = (acceptUnverified = false) => profile && start('play', { profile_id: profile.id, accept_unverified: acceptUnverified });

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">↝</span><strong>IMPULSE</strong><span>Standalone</span></div>
        <div className="channel" aria-label="Update channel">
          <span>Updates</span>
          {(['stable', 'beta'] as const).map(channel => <button key={channel} className={state.update_channel === channel ? 'active' : ''} onClick={async () => setState(await invoke<State>('setUpdateChannel', { channel }))}>{channel}</button>)}
        </div>
      </header>

      <main className="workspace">
        <aside className="server-rail">
          <div className="rail-label">Servers</div>
          <div className="server-list">
            {state.profiles.map(item => <ServerRow key={item.id} profile={item} selected={item.id === profile?.id} onClick={() => selectProfile(item.id)} />)}
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
                  <span className="play-content">{busy ? <LoaderCircle className="spin" size={19} /> : <Play size={19} fill="currentColor" />}{busy ? operation?.message : 'Play'}</span>
                </button>
                <button className="icon-button" title="Profile actions" onClick={() => setDeleteOpen(true)}><MoreHorizontal size={20} /></button>
              </div>
            </>
          )}
        </section>
      </main>

      {error && <div className="toast error"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setError('')}><X size={17} /></button></div>}
      {adding && <AddServer address={address} setAddress={setAddress} busy={busy} onClose={() => setAdding(false)} onAdd={() => { setAdding(false); start('add', { address }); }} />}
      {deleteOpen && profile && <Confirm title="Remove this server?" text="This removes its managed files and settings. Your global mods are not changed." confirm="Remove server" destructive onClose={() => setDeleteOpen(false)} onConfirm={() => { setDeleteOpen(false); start('delete', { profile_id: profile.id }); }} />}
      {optionalOpen && profile && manifest && <OptionalMods profile={profile} manifest={manifest} onClose={() => setOptionalOpen(false)} onSave={ids => { setOptionalOpen(false); start('optional', { profile_id: profile.id, ids }); }} />}
      {warning && <VerificationWarning warning={warning} onCancel={() => setWarning(undefined)} onContinue={() => { setWarning(undefined); launch(true); }} />}
      {modManagerOpen && profile && <ModManager profile={profile} state={state} start={start} operation={operation} onClose={async () => { setModManagerOpen(false); await loadState(); }} />}
    </div>
  );
}

function Boot({ error }: { error: string }) {
  return <div className="boot"><div className="boot-logo">IMPULSE</div>{error ? <><AlertTriangle /><strong>Web interface could not start</strong><p>{error}</p></> : <><LoaderCircle className="spin" /><p>Opening your servers...</p></>}</div>;
}

function Legal({ state, onAccepted }: { state: State; onAccepted: (state: State) => void }) {
  const [privacy, setPrivacy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = (url: string) => invoke('openExternal', { url });
  return <div className="legal-screen"><div className="legal-card"><div className="legal-icon"><ShieldCheck /></div><span className="eyebrow">Before you continue</span><h1>Welcome to Impulse</h1><p>Impulse needs your agreement to its Privacy Policy and Terms of Service. These documents explain how the software works, the services it contacts, and the rules that apply when you use it.</p><div className="legal-links"><button onClick={() => open(state.privacy_url)}>Privacy Policy <ExternalLink size={15} /></button><button onClick={() => open(state.terms_url)}>Terms of Service <ExternalLink size={15} /></button></div><label className="check"><input type="checkbox" checked={privacy} onChange={e => setPrivacy(e.target.checked)} /><span><Check size={14} /></span>I have read and accept the Privacy Policy.</label><label className="check"><input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} /><span><Check size={14} /></span>I have read and accept the Terms of Service.</label><div className="modal-actions"><button className="secondary" onClick={() => invoke('quit')}>Quit Minecraft</button><button className="primary" disabled={!privacy || !terms || busy} onClick={async () => { setBusy(true); onAccepted(await invoke<State>('acceptLegal')); }}>Accept and continue</button></div></div></div>;
}

function ServerRow({ profile, selected, onClick }: { profile: Profile; selected: boolean; onClick: () => void }) {
  return <button className={`server-row ${selected ? 'selected' : ''}`} onClick={onClick}><span className="server-icon"><Server /></span><span><strong>{profile.name || 'Minecraft Server'}</strong><small>{profile.address}</small></span><i /></button>;
}

function EmptyServer({ onAdd }: { onAdd: () => void }) {
  return <div className="empty-server"><div><Server /><h1>Add your first server</h1><p>Enter a Minecraft server address and Impulse will prepare everything you need to join.</p><button className="primary" onClick={onAdd}><Plus size={18} /> Add server</button></div></div>;
}

function ServerHero({ profile, manifest }: { profile: Profile; manifest?: Manifest }) {
  const banner = useNativeImage(manifest?.banner_url);
  const icon = useNativeImage(manifest?.icon_url);
  return <div className="server-hero" style={banner ? { backgroundImage: `linear-gradient(90deg, rgba(4,4,4,.82), rgba(4,4,4,.22)), url(${banner})` } : undefined}><div className="hero-noise" /><div className="hero-details">{icon ? <img src={icon} alt="" /> : <span className="hero-icon"><Server /></span>}<div><h1>{manifest?.name || profile.name || 'Minecraft Server'}</h1><p>{profile.address}</p><div className="hero-meta"><span><i className="online" /> Ready</span><span>{manifest?.minecraft?.version || 'Minecraft'}</span><span>{manifest?.minecraft?.loader || 'NeoForge'} {manifest?.minecraft?.loader_version}</span></div></div></div></div>;
}

function Overview({ manifest }: { manifest?: Manifest }) {
  const required = manifest?.mods?.length || 0;
  const optional = manifest?.optional_mods?.length || 0;
  return <div className="overview-grid"><section className="panel server-about"><span className="eyebrow">Server</span><h2>{manifest?.name || 'Minecraft Server'}</h2><p>{manifest?.description || 'This server is ready to be managed through Impulse.'}</p></section><section className="metric"><Package /><span>Required mods</span><strong>{required}</strong></section><section className="metric"><Settings2 /><span>Optional mods</span><strong>{optional}</strong></section><section className="metric wide"><ShieldCheck /><span>Compatibility</span><strong>{manifest ? 'Ready' : 'Refresh required'}</strong><small>{manifest ? `${manifest.minecraft?.loader || 'NeoForge'} ${manifest.minecraft?.loader_version || ''}` : 'Check this server to continue.'}</small></section></div>;
}

function Mods({ manifest, onOptional, onCustom }: { manifest?: Manifest; onOptional: () => void; onCustom: () => void }) {
  return <div className="mods-view"><div className="section-heading"><div><span className="eyebrow">Profile content</span><h2>Mods</h2><p>Required additions are prepared automatically. Optional and personal additions stay under your control.</p></div><div><button className="secondary" onClick={onOptional}><Settings2 size={16} /> Optional mods</button><button className="primary" onClick={onCustom}><Plus size={16} /> Add custom mods</button></div></div><ModGroup title="Required" mods={manifest?.mods || []} /><ModGroup title="Optional" mods={manifest?.optional_mods || []} /></div>;
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

function AddServer({ address, setAddress, busy, onClose, onAdd }: { address: string; setAddress: (value: string) => void; busy: boolean; onClose: () => void; onAdd: () => void }) {
  return <Modal><button className="modal-close" onClick={onClose}><X /></button><span className="eyebrow">New profile</span><h2>Add a server</h2><p>Enter the Minecraft server address, then select Check server.</p><label className="field"><span>Server address</span><input autoFocus value={address} onChange={event => setAddress(event.target.value)} placeholder="play.example.com:25565" onKeyDown={event => event.key === 'Enter' && address.trim() && onAdd()} /></label><div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !address.trim()} onClick={onAdd}>Check server <ChevronRight /></button></div></Modal>;
}

function Confirm({ title, text, confirm, destructive, onClose, onConfirm }: { title: string; text: string; confirm: string; destructive?: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Modal><button className="modal-close" onClick={onClose}><X /></button><h2>{title}</h2><p>{text}</p><div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className={destructive ? 'danger' : 'primary'} onClick={onConfirm}>{confirm}</button></div></Modal>;
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
    }
  }, [operation]);

  const openProject = (id: string) => start('project', { profile_id: profile.id, project_id: id });
  const search = () => query.trim() && start('searchMods', { profile_id: profile.id, query });
  const planInstall = (versionId = '') => project && start('planMod', { profile_id: profile.id, project_id: project.project_id, version_id: versionId, channel });
  const install = () => project && start('installMod', { profile_id: profile.id, project_id: project.project_id, version_id: installPlan ? Object.values(installPlan.items)[0]?.version.id : '', channel, location: installLocation, optional_projects: [...optionalProjects] });
  const busy = operation?.status === 'running';

  return <div className="manager-overlay"><div className="manager"><header className="manager-header"><div><button className="icon-button" onClick={view === 'installed' ? onClose : () => setView(view === 'versions' ? 'project' : 'installed')}><ArrowLeft /></button><span><strong>Custom mods</strong><small>{profile.name || profile.address}</small></span></div><button className="icon-button" onClick={onClose}><X /></button></header><div className="manager-toolbar"><div className="searchbox"><Search /><input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder="Search Modrinth" /><button onClick={search}>Search</button></div><div className="segments">{(['release', 'beta', 'all'] as const).map(item => <button className={channel === item ? 'active' : ''} onClick={() => setChannel(item)} key={item}>{item}</button>)}</div></div><div className="manager-content">{view === 'installed' && <InstalledMods customMods={customMods} globalMods={globalMods} onProject={openProject} start={start} profile={profile} />}{view === 'search' && <SearchResults results={results} onProject={openProject} />}{view === 'project' && project && <ProjectPage project={project} onVersions={() => start('versions', { profile_id: profile.id, project_id: project.project_id, channel })} onInstall={() => planInstall()} onImage={setLightbox} />}{view === 'versions' && <Versions versions={versions} onInstall={id => planInstall(id)} />}</div>{busy && <div className="manager-progress"><LoaderCircle className="spin" /><span>{operation?.message}</span><progress value={operation?.completed || 0} max={operation?.total || 1} /></div>}</div>{lightbox && <div className="lightbox" onClick={() => setLightbox(undefined)}><NativeImage url={lightbox} /><button><X /></button></div>}{installPlan && <InstallConfirmation plan={installPlan} location={installLocation} setLocation={setInstallLocation} optional={optionalProjects} setOptional={setOptionalProjects} onClose={() => setInstallPlan(undefined)} onInstall={install} />}</div>;
}

function InstalledMods({ customMods, globalMods, onProject, start, profile }: { customMods: State['custom_mods']; globalMods: GlobalMod[]; onProject: (id: string) => void; start: (kind: string, payload?: Record<string, unknown>) => void; profile: Profile }) {
  const mods = customMods || [];
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

function ProjectPage({ project, onVersions, onInstall, onImage }: { project: Project; onVersions: () => void; onInstall: () => void; onImage: (url: string) => void }) {
  return <article className="project-page"><header><NativeImage url={project.icon_url} className="project-large-icon" /><div><span className="eyebrow">{project.authors?.join(', ') || project.author || 'Modrinth project'}</span><h1>{project.title}</h1><p>{project.description}</p><div className="project-facts"><span>{(project.downloads || 0).toLocaleString()} downloads</span>{project.license_name && <span>{project.license_name}</span>}</div></div><div className="project-actions"><button className="primary" onClick={onInstall}><Download /> Install latest</button><button className="secondary" onClick={onVersions}>Versions</button></div></header>{project.gallery && project.gallery.length > 0 && <div className="gallery">{project.gallery.slice(0, 8).map((image, index) => <button key={image.url} className={index === 0 ? 'featured' : ''} onClick={() => onImage(image.url)}><NativeImage url={image.url} /><span>{image.title}</span></button>)}</div>}<div className="project-body">{(project.body || project.description || '').split(/\n+/).filter(Boolean).map((line, index) => line.startsWith('#') ? <h3 key={index}>{line.replace(/^#+\s*/, '')}</h3> : <p key={index}>{line}</p>)}</div></article>;
}

function Versions({ versions, onInstall }: { versions: Version[]; onInstall: (id: string) => void }) {
  return <div className="versions"><div className="section-heading compact"><div><span className="eyebrow">Compatible builds</span><h2>Versions</h2></div></div>{versions.map(version => <article key={version.id}><div><strong>{version.name || version.version_number}</strong><span className={`release ${version.version_type}`}>{version.version_type}</span><p>{version.changelog || 'No changelog provided.'}</p><small>{version.date_published ? new Date(version.date_published).toLocaleDateString() : ''} · {fmtBytes(version.files?.[0]?.size)}</small></div><button className="secondary" onClick={() => onInstall(version.id)}>Install</button></article>)}</div>;
}
