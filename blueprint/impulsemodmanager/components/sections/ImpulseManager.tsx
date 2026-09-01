import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import PageContentBlock from '@/components/elements/PageContentBlock';
import http from '@/api/http';
import '../impulsemodmanager.css';

type Loader = 'forge' | 'neoforge';
type Tab = 'mods' | 'browse' | 'queue' | 'categories' | 'relationships' | 'content' | 'impulse' | 'activity';
type Runtime = {
    minecraftVersion: string | null;
    loader: Loader | null;
    confidence: 'high' | 'medium' | 'low';
    sources: string[];
    override?: boolean;
    needsSetup?: boolean;
};
type ManagedMod = {
    key: string;
    name: string;
    description?: string;
    filename: string;
    version?: string;
    placement: string;
    categoryId?: string | null;
    managed: boolean;
    externallyOwned?: boolean;
    update?: { version: string } | null;
};
type Category = {
    id: string;
    folder: string;
    name: string;
    description: string;
    default_enabled: boolean;
    order: number;
    modCount: number;
};
type Asset = { name: string; size: number; directory: boolean };
type Operation = {
    id: string;
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
    summary: string;
    logs: string[];
    createdAt: string;
};
type Overview = {
    runtime: Runtime;
    impulse: {
        installed: boolean;
        configPath: string;
        manifestPaths: string[];
        properties?: Record<string, string>;
    };
    mods: ManagedMod[];
    inventory?: { total: number; recognized: number; local: number };
    categories: Category[];
    assets: Asset[];
    restartRequired: boolean;
    operations: Operation[];
    relationships: {
        mods: Array<{ id: string; name: string; required: boolean; dependencies: string[]; conflicts: string[]; update_policy: 'pinned' | 'release' | 'beta' | 'alpha' }>;
        errors: string[];
    };
    content: ContentData;
};
type ContentData = {
    announcements: Array<Record<string, any>>;
    changelog: Array<Record<string, any>>;
    events: Array<Record<string, any>>;
};
type SearchHit = {
    project_id: string;
    slug: string;
    title: string;
    description: string;
    icon_url?: string;
    client_side: string;
    server_side: string;
    downloads: number;
};
type ProjectDetails = {
    title?: string;
    description?: string;
    body?: string;
    client_side?: string;
    server_side?: string;
    categories?: string[];
    issues_url?: string | null;
    source_url?: string | null;
    wiki_url?: string | null;
    discord_url?: string | null;
    gallery?: Array<{ url: string; title?: string; description?: string }>;
    authors?: Array<{ user?: { id: string; username: string; avatar_url?: string } }>;
};
type Version = {
    id: string;
    version_number: string;
    name: string;
    version_type: 'release' | 'beta' | 'alpha';
    date_published?: string;
    changelog?: string | null;
    client_side?: string;
    server_side?: string;
    files: Array<{
        filename: string;
        url: string;
        hashes: { sha1: string };
        size: number;
        primary: boolean;
    }>;
    dependencies: Array<{ project_id?: string; version_id?: string; dependency_type: string }>;
};
type InstallQueueItem = {
    projectId: string;
    projectName: string;
    iconUrl?: string;
    versionId: string;
    versionNumber: string;
    filename: string;
    size: number;
    placement: string;
    categoryId: string | null;
    updatePolicy: 'pinned' | 'release' | 'beta' | 'alpha';
    allowConflicts: boolean;
    takeOwnership?: boolean;
    plan: Array<{ projectId: string; name: string; versionId: string; version: string; filename: string; size: number; sha1: string; paths: string[]; dependency: boolean }>;
};
type InstallationBatch = {
    status: 'idle' | 'submitting' | 'applying' | 'success' | 'error';
    operationIds: string[];
    total: number;
    submissionError?: boolean;
};

const emptyInstallationBatch = (): InstallationBatch => ({ status: 'idle', operationIds: [], total: 0 });

const tabs: Array<[Tab, string]> = [
    ['mods', 'Installed'],
    ['browse', 'Modrinth'],
    ['queue', 'Queue'],
    ['categories', 'Categories'],
    ['relationships', 'Relationships'],
    ['content', 'Content'],
    ['impulse', 'Configuration'],
    ['activity', 'Activity'],
];

const placementOptions = [
    ['server', 'Server only'],
    ['required', 'Required server + client'],
    ['optional-both', 'Optional server + client'],
    ['optional-client', 'Optional client only'],
] as const;

function placementLabel(value: string) {
    if (value === 'client-required') return 'Required client only';
    return placementOptions.find(([key]) => key === value)?.[1] || value;
}

function preferredPlacement(project: Pick<SearchHit, 'client_side' | 'server_side'> | ProjectDetails): string {
    if (project.server_side === 'unsupported' && project.client_side !== 'unsupported') return 'optional-client';
    if (project.client_side === 'unsupported') return 'server';
    return 'required';
}

function placementAllowed(value: string, project: Pick<SearchHit, 'client_side' | 'server_side'> | ProjectDetails | null): boolean {
    if (!project) return true;
    const needsServer = value === 'server' || value === 'required' || value === 'optional-both';
    const needsClient = value !== 'server';
    return (!needsServer || project.server_side !== 'unsupported') && (!needsClient || project.client_side !== 'unsupported');
}

type ConfigField = {
    key: string;
    label: string;
    type?: 'text' | 'number' | 'textarea' | 'boolean' | 'select';
    options?: Array<[string, string]>;
};

const configFields: ConfigField[] = [
    { key: 'server.name', label: 'Server name' },
    { key: 'server.description', label: 'Description', type: 'textarea' },
    { key: 'server.autoConnect', label: 'Auto connect', type: 'boolean' },
    { key: 'public.host', label: 'Public host' },
    { key: 'minecraft.version', label: 'Minecraft version' },
    { key: 'minecraft.loader', label: 'Mod loader', type: 'select', options: [['forge', 'Forge'], ['neoforge', 'NeoForge']] },
    { key: 'loader.version', label: 'Loader version' },
    { key: 'minecraft.port', label: 'Minecraft port', type: 'number' },
    { key: 'manifest.port', label: 'Manifest port', type: 'number' },
    { key: 'manifest.version', label: 'Manifest version', type: 'number' },
    { key: 'manifest.signing.enabled', label: 'Sign manifest with Ed25519', type: 'boolean' },
    { key: 'manifest.signing.privateKey', label: 'Manifest private key path' },
    { key: 'manifest.signing.publicKey', label: 'Manifest public key path' },
    { key: 'mods.directory', label: 'Required client mods directory' },
    { key: 'optionalmods.directory', label: 'Optional client mods directory' },
    { key: 'mods.exclude', label: 'Excluded mod filenames' },
    { key: 'media.directory', label: 'Assets directory' },
    { key: 'menu.enabled', label: 'Custom Impulse menu', type: 'boolean' },
    { key: 'menu.skin', label: 'Menu skin', type: 'select', options: [['default', 'Default'], ['classic', 'Classic']] },
    { key: 'menu.title', label: 'Menu title' },
    { key: 'menu.subtitle', label: 'Menu subtitle' },
    { key: 'menu.hideServerNameFromPlayButton', label: 'Hide server name in Play', type: 'boolean' },
    { key: 'singleplayerenabled', label: 'Singleplayer access', type: 'boolean' },
    { key: 'multiplayerenabled', label: 'Multiplayer access', type: 'boolean' },
    { key: 'maintenance.enabled', label: 'Maintenance mode', type: 'boolean' },
    { key: 'maintenance.title', label: 'Maintenance title' },
    { key: 'maintenance.message', label: 'Maintenance message', type: 'textarea' },
    { key: 'maintenance.estimatedEnd', label: 'Estimated maintenance end' },
    { key: 'media.iconUrl', label: 'Icon URL' },
    { key: 'media.bannerUrl', label: 'Banner URL' },
    { key: 'media.videoBackgroundUrl', label: 'Background video URL' },
];

function apiPath(server: string, path: string) {
    return `/api/client/extensions/impulsemodmanager/servers/${server}${path}`;
}

function errorMessage(error: any, fallback: string) {
    const response = error?.response?.data;
    return response?.message
        || response?.error
        || response?.errors?.[0]?.detail
        || response?.errors?.[0]?.title
        || error?.message
        || fallback;
}

function formatBytes(bytes: number) {
    if (!bytes) return 'Unknown size';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDownloads(downloads: number) {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(downloads || 0);
}

const Panel = ({ title, description, action, children }: {
    title: string;
    description?: string;
    action?: React.ReactNode;
    children: React.ReactNode;
}) => (
    <section className="imm-panel">
        <header className="imm-panel-header">
            <div className="imm-panel-heading">
                <h2>{title}</h2>
                {description && <p>{description}</p>}
            </div>
            {action && <div className="imm-panel-action">{action}</div>}
        </header>
        <div className="imm-panel-body">{children}</div>
    </section>
);

const EmptyState = ({ children }: { children: React.ReactNode }) => <div className="imm-empty">{children}</div>;

const ImpulseManager = () => {
    const { id: server } = useParams<{ id: string }>();
    const [overview, setOverview] = useState<Overview | null>(null);
    const [tab, setTab] = useState<Tab>('mods');
    const [pageError, setPageError] = useState<string | null>(null);
    const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [action, setAction] = useState<string | null>(null);

    const [query, setQuery] = useState('');
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [hasSearched, setHasSearched] = useState(false);
    const [selected, setSelected] = useState<SearchHit | null>(null);
    const [projectDetails, setProjectDetails] = useState<ProjectDetails | null>(null);
    const [versions, setVersions] = useState<Version[]>([]);
    const [channel, setChannel] = useState<'release' | 'beta' | 'alpha'>('release');
    const [placement, setPlacement] = useState<string>('required');
    const [categoryId, setCategoryId] = useState('');
    const [allowConflicts, setAllowConflicts] = useState(false);
    const [installQueue, setInstallQueue] = useState<InstallQueueItem[]>([]);
    const [installationBatch, setInstallationBatch] = useState<InstallationBatch>(emptyInstallationBatch);
    const [editingCategory, setEditingCategory] = useState<Category | null>(null);
    const [relationshipDraft, setRelationshipDraft] = useState<Record<string, { conflicts: string[]; policy: 'pinned' | 'release' | 'beta' | 'alpha' }>>({});
    const [content, setContent] = useState<ContentData>({ announcements: [], changelog: [], events: [] });

    const [config, setConfig] = useState<Record<string, string>>({});
    const [runtimeOverride, setRuntimeOverride] = useState<{ minecraftVersion: string; loader: Loader }>({
        minecraftVersion: '',
        loader: 'forge',
    });
    const [runtimeDialog, setRuntimeDialog] = useState(false);
    const [runtimeError, setRuntimeError] = useState<string | null>(null);

    const refresh = useCallback(async (resetForms = false) => {
        if (!server) return;
        setRefreshing(true);
        try {
            // The first scan streams and hashes every uncached jar through Wings.
            // Keep the request alive for large modpacks; later scans are cached.
            const { data } = await http.get(apiPath(server, '/overview'), { timeout: 300000 });
            setOverview(data);
            if (resetForms) {
                setConfig(data.impulse?.properties || {});
                setRuntimeOverride({
                    minecraftVersion: data.runtime?.minecraftVersion || '',
                    loader: data.runtime?.loader || 'forge',
                });
                setRuntimeDialog(Boolean(data.runtime?.needsSetup));
            }
            setRelationshipDraft(Object.fromEntries((data.relationships?.mods || []).map((mod: any) => [mod.id, { conflicts: mod.conflicts || [], policy: mod.update_policy || 'release' }])));
            setContent(data.content || { announcements: [], changelog: [], events: [] });
            setPageError(null);
        } catch (error: any) {
            setPageError(errorMessage(error, `Unable to load the Impulse manager (${error?.response?.status || 'network error'}).`));
        } finally {
            setRefreshing(false);
        }
    }, [server]);

    useEffect(() => {
        void refresh(true);
    }, [refresh]);

    const activeOperation = overview?.operations.some((operation) => operation.state === 'queued' || operation.state === 'running');
    useEffect(() => {
        if (!activeOperation) return;
        const timeout = window.setTimeout(() => void refresh(false), 3000);
        return () => window.clearTimeout(timeout);
    }, [activeOperation, overview?.operations, refresh]);

    useEffect(() => {
        if (!server || installationBatch.status !== 'applying' || installationBatch.operationIds.length === 0) return;
        let cancelled = false;
        let timeout: number | undefined;

        const poll = async () => {
            try {
                const operations = await Promise.all(installationBatch.operationIds.map(async (id) => {
                    const { data } = await http.get(apiPath(server, `/operations/${encodeURIComponent(id)}`));
                    return data as Operation;
                }));
                if (cancelled) return;

                const complete = operations.every((operation) => ['succeeded', 'failed', 'rolled_back'].includes(operation.state));
                const failed = operations.some((operation) => operation.state === 'failed' || operation.state === 'rolled_back');
                if (complete) {
                    setInstallationBatch((current) => ({
                        ...current,
                        status: failed || current.submissionError ? 'error' : 'success',
                    }));
                    await refresh(false);
                    return;
                }
                timeout = window.setTimeout(() => void poll(), 1500);
            } catch {
                if (!cancelled) timeout = window.setTimeout(() => void poll(), 3000);
            }
        };

        void poll();
        return () => {
            cancelled = true;
            if (timeout !== undefined) window.clearTimeout(timeout);
        };
    }, [installationBatch.operationIds, installationBatch.status, refresh, server]);

    const runtimeLabel = useMemo(() => {
        if (!overview?.runtime.loader || !overview.runtime.minecraftVersion) return 'Choose server target';
        return `${overview.runtime.loader === 'neoforge' ? 'NeoForge' : 'Forge'} ${overview.runtime.minecraftVersion}`;
    }, [overview]);

    const filteredVersions = useMemo(() => {
        const priority = { release: 0, beta: 1, alpha: 2 };
        return versions.filter((version) => priority[version.version_type || 'release'] <= priority[channel]);
    }, [versions, channel]);

    const search = async (event: FormEvent) => {
        event.preventDefault();
        if (!server || !query.trim()) return;
        setAction('search');
        setSearchError(null);
        setHasSearched(true);
        setSelected(null);
        setProjectDetails(null);
        setVersions([]);
        try {
            const { data } = await http.get(apiPath(server, '/modrinth/search'), { params: { query: query.trim() } });
            setHits(Array.isArray(data.hits) ? data.hits : []);
        } catch (error: any) {
            setHits([]);
            setSearchError(errorMessage(error, 'Modrinth search failed.'));
        } finally {
            setAction(null);
        }
    };

    const chooseProject = async (project: SearchHit) => {
        if (!server) return;
        setSelected(project);
        setProjectDetails(null);
        setPlacement(preferredPlacement(project));
        setCategoryId('');
        setAllowConflicts(false);
        setVersions([]);
        setSearchError(null);
        setAction('versions');
        try {
            const [versionsResult, projectResult] = await Promise.allSettled([
                http.get(apiPath(server, `/modrinth/projects/${project.project_id}/versions`)),
                http.get(apiPath(server, `/modrinth/projects/${project.project_id}`)),
            ]);
            if (versionsResult.status === 'rejected') throw versionsResult.reason;
            setVersions(Array.isArray(versionsResult.value.data?.versions) ? versionsResult.value.data.versions : []);
            if (projectResult.status === 'fulfilled') {
                const details = projectResult.value.data?.project as ProjectDetails | undefined;
                setProjectDetails(details || null);
                setPlacement(preferredPlacement(details || project));
            }
        } catch (error: any) {
            setSearchError(errorMessage(error, `Unable to load versions for ${project.title}.`));
        } finally {
            setAction(null);
        }
    };

    const queueInstall = async (version: Version) => {
        if (!selected || !server) return;
        const file = version.files.find((candidate) => candidate.primary) || version.files[0];
        if (!file) {
            setNotice({ kind: 'error', text: 'This Modrinth version has no downloadable file.' });
            return;
        }

        setAction(`plan:${version.id}`);
        setNotice(null);
        try {
            const { data } = await http.post(apiPath(server, '/operations/preview'), {
                projectId: selected.project_id,
                versionId: version.id,
                placement,
                categoryId: categoryId || null,
                allowConflicts,
            });
            const item: InstallQueueItem = {
            projectId: selected.project_id,
            projectName: selected.title,
            iconUrl: selected.icon_url,
            versionId: version.id,
            versionNumber: version.version_number,
            filename: file.filename,
            size: file.size,
            placement,
            categoryId: categoryId || null,
            updatePolicy: channel,
                allowConflicts,
                plan: Array.isArray(data.plan) ? data.plan : [],
            };
            if (installationBatch.status === 'success' || installationBatch.status === 'error') {
                setInstallationBatch(emptyInstallationBatch());
            }
            const replacing = installQueue.some((queued) => queued.projectId === item.projectId);
            setInstallQueue((current) => [...current.filter((queued) => queued.projectId !== item.projectId), item]);
            setNotice({ kind: 'info', text: replacing ? `${selected.title} was updated in the queue.` : `${selected.title} and its required dependencies were added to the queue.` });
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, `Unable to prepare the installation plan for ${selected.title}.`) });
        } finally {
            setAction(null);
        }
    };

    const applyInstallQueue = async () => {
        if (!server || installQueue.length === 0 || action === 'apply-queue' || installationBatch.status === 'applying') return;
        const queuedItems = [...installQueue];
        setAction('apply-queue');
        setInstallationBatch({ status: 'submitting', operationIds: [], total: queuedItems.length });
        setNotice(null);
        const failed: Array<{ item: InstallQueueItem; message: string }> = [];
        const operationIds: string[] = [];

        for (const item of queuedItems) {
            try {
                const { data } = await http.post(apiPath(server, '/operations'), {
                    projectId: item.projectId,
                    projectName: item.projectName,
                    versionId: item.versionId,
                    placement: item.placement,
                    categoryId: item.categoryId,
                    updatePolicy: item.updatePolicy,
                    allowConflicts: item.allowConflicts,
                    takeOwnership: item.takeOwnership === true,
                });
                if (!data?.operation?.id) throw new Error(`The server did not return an operation ID for ${item.projectName}.`);
                operationIds.push(data.operation.id);
            } catch (error: any) {
                failed.push({ item, message: errorMessage(error, `Unable to queue ${item.projectName}.`) });
            }
        }

        setInstallQueue(failed.map(({ item }) => item));
        if (operationIds.length > 0) {
            setInstallationBatch({
                status: 'applying',
                operationIds,
                total: queuedItems.length,
                submissionError: failed.length > 0,
            });
        } else {
            setInstallationBatch({ status: 'error', operationIds: [], total: queuedItems.length, submissionError: true });
        }
        if (failed.length > 0) setNotice({ kind: 'error', text: failed[0].message });
        await refresh(false);
        setAction(null);
    };

    const queueUpdate = async (mod: ManagedMod) => {
        if (!server || !mod.update || action === `update:${mod.key}`) return;
        setAction(`update:${mod.key}`);
        setNotice(null);
        try {
            const { data } = await http.post(apiPath(server, `/mods/${encodeURIComponent(mod.key)}/update/preview`));
            const item: InstallQueueItem = {
                projectId: data.projectId,
                projectName: data.projectName || mod.name,
                versionId: data.versionId,
                versionNumber: data.versionNumber,
                filename: data.filename,
                size: Number(data.size || 0),
                placement: data.placement,
                categoryId: data.categoryId || null,
                updatePolicy: data.updatePolicy || 'release',
                allowConflicts: false,
                takeOwnership: data.takeOwnership === true,
                plan: Array.isArray(data.plan) ? data.plan : [],
            };
            if (installationBatch.status === 'success' || installationBatch.status === 'error') setInstallationBatch(emptyInstallationBatch());
            setInstallQueue((current) => [...current.filter((queued) => queued.projectId !== item.projectId), item]);
            setNotice({ kind: 'info', text: `${mod.name} ${item.versionNumber} was added to the update queue.` });
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, `Unable to prepare the update for ${mod.name}.`) });
        } finally {
            setAction(null);
        }
    };

    const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!server) return;
        setAction('category');
        setNotice(null);
        const form = event.currentTarget;
        const values = Object.fromEntries(new FormData(form).entries());
        try {
            const { data } = await http.post(apiPath(server, '/categories'), {
                ...values,
                default_enabled: values.default_enabled === 'on',
                order: Number(values.order || 0),
            });
            form.reset();
            setNotice({ kind: data.reload?.reloaded ? 'success' : 'info', text: data.reload?.message || 'Optional category created.' });
            await refresh(false);
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, 'Unable to create this category.') });
        } finally {
            setAction(null);
        }
    };

    const saveConfig = async (event?: FormEvent) => {
        event?.preventDefault();
        if (!server) return;
        setAction('config');
        setNotice(null);
        try {
            const { data } = await http.put(apiPath(server, '/impulse/configuration'), { properties: config });
            setNotice({ kind: data.reload?.reloaded ? 'success' : 'info', text: data.reload?.message || 'Impulse configuration saved. Comments and unknown properties were preserved.' });
            await refresh(false);
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, 'Unable to save Impulse configuration.') });
        } finally {
            setAction(null);
        }
    };

    const saveRuntimeOverride = async (event: FormEvent) => {
        event.preventDefault();
        if (!server) return;
        setAction('runtime');
        setRuntimeError(null);
        try {
            await http.put(apiPath(server, '/runtime'), runtimeOverride);
            setRuntimeDialog(false);
            setNotice({ kind: 'success', text: `Server target saved. MC_VERSION is now ${runtimeOverride.minecraftVersion}.` });
            await refresh(false);
        } catch (error: any) {
            setRuntimeError(errorMessage(error, 'Unable to save this server target.'));
        } finally {
            setAction(null);
        }
    };

    const removeManagedMod = async (mod: ManagedMod) => {
        if (!server || !window.confirm(`Remove ${mod.name}? Unmanaged files will remain untouched.`)) return;
        setAction(`remove:${mod.key}`);
        setNotice(null);
        try {
            await http.delete(apiPath(server, `/mods/${encodeURIComponent(mod.key)}`));
            setNotice({ kind: 'success', text: `${mod.name} was queued for removal.` });
            await refresh(false);
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, `Unable to remove ${mod.name}.`) });
        } finally {
            setAction(null);
        }
    };

    const updateCategory = async (category: Category, changes: Partial<Category>) => {
        if (!server) return;
        setAction(`category:${category.id}`);
        setNotice(null);
        try {
            const { data } = await http.patch(apiPath(server, `/categories/${encodeURIComponent(category.id)}`), changes);
            setNotice({ kind: data.reload?.reloaded ? 'success' : 'info', text: data.reload?.message || `${category.name} was updated.` });
            await refresh(false);
            return true;
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, `Unable to update ${category.name}.`) });
            return false;
        } finally {
            setAction(null);
        }
    };

    const deleteCategory = async (category: Category) => {
        if (!server || !window.confirm(`Delete ${category.name}? The category must be empty.`)) return;
        setAction(`category:${category.id}`);
        setNotice(null);
        try {
            const { data } = await http.delete(apiPath(server, `/categories/${encodeURIComponent(category.id)}`));
            setNotice({ kind: data.reload?.reloaded ? 'success' : 'info', text: data.reload?.message || `${category.name} was deleted.` });
            await refresh(false);
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, `Unable to delete ${category.name}.`) });
        } finally {
            setAction(null);
        }
    };

    const saveEditedCategory = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!editingCategory) return;
        const form = event.currentTarget;
        const values = Object.fromEntries(new FormData(form).entries());
        const saved = await updateCategory(editingCategory, {
            folder: String(values.folder || editingCategory.folder),
            name: String(values.name || editingCategory.name),
            description: String(values.description || ''),
            default_enabled: values.default_enabled === 'on',
            order: Number(values.order || 0),
        });
        if (saved) setEditingCategory(null);
    };

    const dismissRestartRequired = async () => {
        if (!server) return;
        setAction('dismiss-restart');
        try {
            await http.post(apiPath(server, '/restart-required/dismiss'));
            await refresh(false);
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, 'Unable to dismiss the restart reminder.') });
        } finally {
            setAction(null);
        }
    };

    const saveRelationships = async () => {
        if (!server) return;
        setAction('relationships');
        setNotice(null);
        try {
            const conflicts = Object.fromEntries(Object.entries(relationshipDraft).map(([id, value]) => [id, value.conflicts]));
            const policies = Object.fromEntries(Object.entries(relationshipDraft).map(([id, value]) => [id, value.policy]));
            const { data } = await http.put(apiPath(server, '/relationships'), { conflicts, policies });
            setNotice({ kind: data.reload?.reloaded ? 'success' : 'info', text: data.reload?.message || 'Relationships and update policies saved.' });
            await refresh(false);
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, 'Unable to save relationships.') });
        } finally {
            setAction(null);
        }
    };

    const toggleConflict = (left: string, right: string, enabled: boolean) => {
        setRelationshipDraft((current) => {
            const next = { ...current };
            for (const [id, other] of [[left, right], [right, left]]) {
                const value = next[id] || { conflicts: [], policy: 'release' as const };
                next[id] = { ...value, conflicts: enabled ? [...new Set([...value.conflicts, other])] : value.conflicts.filter((item) => item !== other) };
            }
            return next;
        });
    };

    const addContentItem = (section: keyof ContentData) => {
        const id = `${section.slice(0, -1)}-${Date.now()}`;
        const item = section === 'announcements'
            ? { id, title: 'New announcement', body: '', severity: 'info', link: '', publish_time: new Date().toISOString(), expiry: '', order: content[section].length }
            : section === 'changelog'
                ? { id, version: '', title: 'New changelog entry', body: '', publication_time: new Date().toISOString() }
                : { id, title: 'New event', description: '', start: new Date().toISOString(), end: '', image: '', link: '' };
        setContent((current) => ({ ...current, [section]: [...current[section], item] }));
    };

    const updateContentItem = (section: keyof ContentData, index: number, key: string, value: any) => {
        setContent((current) => ({ ...current, [section]: current[section].map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item) }));
    };

    const saveContent = async () => {
        if (!server) return;
        setAction('content');
        setNotice(null);
        try {
            const { data } = await http.put(apiPath(server, '/content'), content);
            setContent(data.content || content);
            setNotice({ kind: data.reload?.reloaded ? 'success' : 'info', text: data.reload?.message || 'Server content saved.' });
        } catch (error: any) {
            setNotice({ kind: 'error', text: errorMessage(error, 'Unable to save server content.') });
        } finally {
            setAction(null);
        }
    };

    if (!overview) {
        return (
            <PageContentBlock title="Impulse">
                <div className={`imm-alert ${pageError ? 'imm-alert-error' : 'imm-alert-neutral'}`}>
                    <strong>{pageError ? 'Impulse manager could not load' : 'Loading Impulse manager...'}</strong>
                    {pageError && <p>{pageError}</p>}
                    {pageError && <button className="imm-button imm-button-secondary" onClick={() => void refresh(true)}>Try again</button>}
                </div>
            </PageContentBlock>
        );
    }

    return (
        <PageContentBlock title="Impulse">
            <div className={`imm-shell ${installQueue.length > 0 || installationBatch.status !== 'idle' ? 'has-queue' : ''}`}>
                <header className="imm-toolbar">
                    <div className="imm-toolbar-main">
                        <span className={`imm-status-dot ${overview.runtime.loader ? 'is-online' : 'is-warning'}`} />
                        <div className="imm-toolbar-copy">
                            <h1>{runtimeLabel}</h1>
                            <p>Compatibility target for Modrinth and managed mods</p>
                        </div>
                    </div>
                    <div className="imm-toolbar-meta">
                        <span className={`imm-badge ${overview.impulse.installed ? 'is-positive' : 'is-muted'}`}>
                            {overview.impulse.installed ? 'Impulse detected' : 'Impulse not detected'}
                        </span>
                        <button
                            className="imm-button imm-button-secondary"
                            onClick={() => {
                                setRuntimeOverride({
                                    minecraftVersion: overview.runtime.minecraftVersion || '',
                                    loader: overview.runtime.loader || 'forge',
                                });
                                setRuntimeError(null);
                                setRuntimeDialog(true);
                            }}
                        >
                            Change
                        </button>
                        <button className="imm-icon-button" title="Refresh" disabled={refreshing} onClick={() => void refresh(false)}>
                            {refreshing ? '…' : '↻'}
                        </button>
                    </div>
                </header>

                {pageError && <div className="imm-alert imm-alert-error"><strong>Refresh failed</strong><p>{pageError}</p></div>}
                {overview.restartRequired && (
                    <div className="imm-alert imm-alert-warning">
                        <strong>Restart required</strong>
                        <p>Server-side mod files changed. Restart the Minecraft server whenever you are ready to load them.</p>
                        <button className="imm-button imm-button-secondary" disabled={action === 'dismiss-restart'} onClick={() => void dismissRestartRequired()}>
                            {action === 'dismiss-restart' ? 'Dismissing…' : 'Dismiss'}
                        </button>
                    </div>
                )}
                {notice && <div className={`imm-alert imm-alert-${notice.kind}`}><p>{notice.text}</p></div>}

                <nav className="imm-tabs" aria-label="Impulse sections">
                    {tabs.map(([key, label]) => (
                        <button key={key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>
                            {label}{key === 'queue' && installQueue.length > 0 ? ` (${installQueue.length})` : ''}
                        </button>
                    ))}
                </nav>

                {runtimeDialog && (
                    <div className="imm-dialog-backdrop" role="presentation">
                        <section className="imm-dialog" role="dialog" aria-modal="true" aria-labelledby="imm-runtime-title">
                            <div className="imm-dialog-header">
                                <span className="imm-dialog-mark">I</span>
                                <div>
                                    <h2 id="imm-runtime-title">Set up this server</h2>
                                    <p>Confirm the Minecraft version and mod loader used by this server.</p>
                                </div>
                            </div>
                            <form onSubmit={saveRuntimeOverride}>
                                <div className="imm-dialog-fields">
                                    <label className="imm-field">
                                        <span>Minecraft version</span>
                                        <input
                                            autoFocus
                                            required
                                            value={runtimeOverride.minecraftVersion}
                                            onChange={(event) => {
                                                const minecraftVersion = event.currentTarget.value;
                                                setRuntimeOverride((value) => ({ ...value, minecraftVersion }));
                                            }}
                                            placeholder="1.21.1"
                                        />
                                    </label>
                                    <label className="imm-field">
                                        <span>Mod loader</span>
                                        <select value={runtimeOverride.loader} onChange={(event) => {
                                            const loader = event.currentTarget.value as Loader;
                                            setRuntimeOverride((value) => ({ ...value, loader }));
                                        }}>
                                            <option value="forge">Forge</option>
                                            <option value="neoforge">NeoForge</option>
                                        </select>
                                    </label>
                                </div>
                                <div className="imm-dialog-note">
                                    Saving also updates the egg variable <code>MC_VERSION</code>. The server is not restarted automatically.
                                </div>
                                {runtimeError && <div className="imm-inline-error"><strong>Could not save the target</strong><span>{runtimeError}</span></div>}
                                <div className="imm-dialog-actions">
                                    {!overview.runtime.needsSetup && <button type="button" className="imm-button imm-button-secondary" onClick={() => setRuntimeDialog(false)}>Cancel</button>}
                                    <button className="imm-button imm-button-primary" disabled={action === 'runtime' || !runtimeOverride.minecraftVersion.trim()}>
                                        {action === 'runtime' ? 'Saving…' : 'Confirm server'}
                                    </button>
                                </div>
                            </form>
                        </section>
                    </div>
                )}

                {editingCategory && (
                    <div className="imm-dialog-backdrop" role="presentation">
                        <section className="imm-dialog" role="dialog" aria-modal="true" aria-labelledby="imm-category-title">
                            <div className="imm-dialog-header">
                                <span className="imm-dialog-mark">I</span>
                                <div>
                                    <h2 id="imm-category-title">Edit category</h2>
                                    <p>Changes are saved to this category's config.json immediately.</p>
                                </div>
                            </div>
                            <form onSubmit={(event) => void saveEditedCategory(event)}>
                                <div className="imm-form-stack">
                                    <label className="imm-field"><span>Folder</span><input name="folder" required pattern="[A-Za-z0-9_-]+" defaultValue={editingCategory.folder} /></label>
                                    <label className="imm-field"><span>Display name</span><input name="name" required defaultValue={editingCategory.name} /></label>
                                    <label className="imm-field"><span>Description</span><textarea name="description" rows={4} defaultValue={editingCategory.description} /></label>
                                    <div className="imm-field-row">
                                        <label className="imm-check"><input name="default_enabled" type="checkbox" defaultChecked={editingCategory.default_enabled} /><span>Enable by default</span></label>
                                        <label className="imm-field imm-order"><span>Order</span><input name="order" type="number" defaultValue={editingCategory.order} /></label>
                                    </div>
                                </div>
                                <div className="imm-dialog-actions">
                                    <button type="button" className="imm-button imm-button-secondary" onClick={() => setEditingCategory(null)}>Cancel</button>
                                    <button className="imm-button imm-button-primary" disabled={action === `category:${editingCategory.id}`}>{action === `category:${editingCategory.id}` ? 'Saving…' : 'Save category'}</button>
                                </div>
                            </form>
                        </section>
                    </div>
                )}

                {tab === 'mods' && (
                    <Panel title="Installed mods" description={overview.inventory ? `${overview.inventory.recognized} Modrinth mod${overview.inventory.recognized === 1 ? '' : 's'} identified · ${overview.inventory.local} local mod${overview.inventory.local === 1 ? '' : 's'}` : `${overview.mods.length} jars found across server and Impulse client paths.`} action={<button className="imm-button imm-button-primary" onClick={() => setTab('browse')}>Add mod</button>}>
                        {overview.mods.length === 0 ? <EmptyState>No mods were found. Add one from Modrinth or upload a local jar through Files.</EmptyState> : (
                            <div className="imm-list">
                                {overview.mods.map((mod) => (
                                    <div className="imm-mod-row" key={`${mod.key}:${mod.placement}:${mod.filename}`}>
                                        <div className="imm-mod-main">
                                            <div className="imm-mod-title"><strong>{mod.name}</strong>{mod.update && <span className="imm-badge is-update">Update {mod.update.version}</span>}</div>
                                            {mod.description && <span className="imm-mod-description">{mod.description}</span>}
                                            <span className="imm-filename">{mod.filename}{mod.version ? ` · ${mod.version}` : ''}</span>
                                        </div>
                                        <div className="imm-mod-placement"><span>{mod.placement}</span>{mod.categoryId && <small>{mod.categoryId}</small>}</div>
                                        <div className="imm-mod-state">{mod.managed ? (mod.externallyOwned ? 'Tracked · local file preserved' : 'Managed') : 'Local / unmanaged'}</div>
                                        <div className="imm-row-action">
                                            {mod.update && <button className="imm-button imm-button-primary" disabled={action === `update:${mod.key}`} onClick={() => void queueUpdate(mod)}>{action === `update:${mod.key}` ? 'Preparing…' : 'Update'}</button>}
                                            {mod.managed && !mod.externallyOwned && <button className="imm-button imm-button-danger" disabled={action === `remove:${mod.key}`} onClick={() => void removeManagedMod(mod)}>Remove</button>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Panel>
                )}

                {tab === 'browse' && (
                    <div className="imm-browser-layout">
                        <div className="imm-browser-main">
                            <Panel title="Browse Modrinth" description={`Filtered for ${runtimeLabel}.`}>
                                <form className="imm-search" onSubmit={search}>
                                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search mods, for example JEI or Sodium" autoComplete="off" />
                                    <button className="imm-button imm-button-primary" disabled={action === 'search' || !query.trim()}>{action === 'search' ? 'Searching…' : 'Search'}</button>
                                </form>
                                {searchError && <div className="imm-inline-error"><strong>Modrinth request failed</strong><span>{searchError}</span></div>}
                                {hasSearched && !searchError && hits.length === 0 && action !== 'search' && <EmptyState>No compatible projects matched this search.</EmptyState>}
                                {hits.length > 0 && (
                                    <div className="imm-search-results">
                                        {hits.map((hit) => (
                                            <button key={hit.project_id} className={`imm-project ${selected?.project_id === hit.project_id ? 'is-selected' : ''}`} onClick={() => void chooseProject(hit)}>
                                                <span className="imm-project-icon">{hit.icon_url ? <img src={hit.icon_url} alt="" /> : hit.title.slice(0, 1).toUpperCase()}</span>
                                                <span className="imm-project-copy">
                                                    <strong>{hit.title}</strong>
                                                    <span>{hit.description}</span>
                                                    <small>{formatDownloads(hit.downloads)} downloads · Client {hit.client_side} · Server {hit.server_side}</small>
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </Panel>
                        </div>

                        <aside className="imm-browser-side">
                            <Panel title={selected ? selected.title : 'Select a mod'} description={selected ? 'Review its details, then choose placement and a compatible version.' : 'Project details will appear here.'}>
                                {!selected ? <EmptyState>Select a Modrinth result to continue.</EmptyState> : (
                                    <>
                                        {projectDetails && (
                                            <div className="imm-project-details">
                                                <div className="imm-project-details-meta">
                                                    <span>Client {projectDetails.client_side || selected.client_side}</span>
                                                    <span>Server {projectDetails.server_side || selected.server_side}</span>
                                                    {(projectDetails.categories || []).slice(0, 4).map((item) => <span key={item}>{item}</span>)}
                                                </div>
                                                <p>{projectDetails.description || selected.description}</p>
                                                {projectDetails.body && <div className="imm-project-description">{projectDetails.body}</div>}
                                                {(projectDetails.authors || []).length > 0 && <p><strong>Authors:</strong> {(projectDetails.authors || []).map((member) => member.user?.username).filter(Boolean).join(', ')}</p>}
                                                {(projectDetails.gallery || []).length > 0 && <div className="imm-project-gallery">{(projectDetails.gallery || []).slice(0, 4).map((image) => <a key={image.url} href={image.url} target="_blank" rel="noreferrer"><img src={image.url} alt={image.title || image.description || ''} /></a>)}</div>}
                                                <div className="imm-project-links">
                                                    {[['Issues', projectDetails.issues_url], ['Source', projectDetails.source_url], ['Wiki', projectDetails.wiki_url], ['Discord', projectDetails.discord_url]].filter(([, url]) => Boolean(url)).map(([label, url]) => <a key={label} href={String(url)} target="_blank" rel="noreferrer">{label}</a>)}
                                                </div>
                                            </div>
                                        )}
                                        <div className="imm-form-stack">
                                            <label className="imm-field"><span>Placement</span><select value={placement} onChange={(event) => setPlacement(event.currentTarget.value)}>{placementOptions.map(([value, label]) => <option key={value} value={value} disabled={!placementAllowed(value, projectDetails || selected)}>{label}{!placementAllowed(value, projectDetails || selected) ? ' (unsupported)' : ''}</option>)}</select></label>
                                            {placement.startsWith('optional') && <label className="imm-field"><span>Optional category</span><select value={categoryId} onChange={(event) => setCategoryId(event.currentTarget.value)}><option value="">Choose a category</option>{overview.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
                                            <label className="imm-field"><span>Release channel</span><select value={channel} onChange={(event) => setChannel(event.currentTarget.value as typeof channel)}><option value="release">Release only</option><option value="beta">Release + beta</option><option value="alpha">All versions</option></select></label>
                                            <label className="imm-check"><input type="checkbox" checked={allowConflicts} onChange={(event) => setAllowConflicts(event.currentTarget.checked)} /><span>Allow owner-configured conflicts for this installation</span></label>
                                        </div>
                                        {action === 'versions' ? <EmptyState>Loading compatible versions…</EmptyState> : filteredVersions.length === 0 ? <EmptyState>No versions match this release channel.</EmptyState> : (
                                            <div className="imm-version-list">
                                                {filteredVersions.map((version) => {
                                                    const file = version.files.find((candidate) => candidate.primary) || version.files[0];
                                                    const versionPlacement = version.client_side || version.server_side
                                                        ? { client_side: version.client_side || selected.client_side, server_side: version.server_side || selected.server_side }
                                                        : (projectDetails || selected);
                                                    const blocked = (placement.startsWith('optional') && !categoryId) || !placementAllowed(placement, versionPlacement);
                                                    const queued = installQueue.some((item) => item.projectId === selected.project_id
                                                        && item.versionId === version.id
                                                        && item.placement === placement
                                                        && item.categoryId === (categoryId || null));
                                                    return (
                                                        <div className="imm-version" key={version.id}>
                                                            <div><strong>{version.version_number}</strong><span>{version.version_type} · {file ? formatBytes(file.size) : 'No file'} · {version.dependencies.filter((dependency) => dependency.dependency_type === 'required').length} dependencies{!placementAllowed(placement, versionPlacement) ? ' · Unsupported for this placement' : ''}</span>{version.changelog && <details><summary>Changelog</summary><p className="imm-project-description">{version.changelog}</p></details>}</div>
                                                            <button className={`imm-button ${queued ? 'imm-button-secondary' : 'imm-button-primary'}`} disabled={blocked || queued || action === `plan:${version.id}` || installationBatch.status === 'submitting' || installationBatch.status === 'applying'} onClick={() => void queueInstall(version)}>{queued ? 'Queued' : action === `plan:${version.id}` ? 'Checking…' : installationBatch.status === 'submitting' || installationBatch.status === 'applying' ? 'Applying…' : 'Add'}</button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </>
                                )}
                            </Panel>
                        </aside>
                    </div>
                )}

                {tab === 'queue' && (
                    <Panel
                        title="Installation queue"
                        description="Review the selected mods, then apply the complete batch. Nothing is downloaded before you apply."
                        action={installQueue.length > 0 ? <button className="imm-button imm-button-danger" disabled={action === 'apply-queue'} onClick={() => setInstallQueue([])}>Clear</button> : undefined}
                    >
                        {installQueue.length === 0 ? <EmptyState>The installation queue is empty. Browse Modrinth to add mods.</EmptyState> : (
                            <>
                                <div className="imm-queue-list">
                                    {installQueue.map((item) => (
                                        <div className="imm-queue-row" key={item.projectId}>
                                            <span className="imm-project-icon">{item.iconUrl ? <img src={item.iconUrl} alt="" /> : item.projectName.slice(0, 1).toUpperCase()}</span>
                                            <div className="imm-queue-copy">
                                                <strong>{item.projectName}</strong>
                                                <span>{item.versionNumber} · {item.filename} · {formatBytes(item.size)}</span>
                                                <small>{placementLabel(item.placement)}{item.categoryId ? ` · ${item.categoryId}` : ''} · {item.updatePolicy}{item.allowConflicts ? ' · Conflict override' : ''}</small>
                                                <details className="imm-plan"><summary>{item.plan.length} file{item.plan.length === 1 ? '' : 's'} in complete plan</summary>{item.plan.map((planned) => <div key={`${planned.projectId}:${planned.versionId}`}><strong>{planned.name || planned.filename}</strong><span>{planned.dependency ? 'Required dependency' : 'Selected mod'} · {formatBytes(planned.size)}</span><small>{planned.filename} · {planned.paths.join(' · ')}</small></div>)}</details>
                                            </div>
                                            <button className="imm-button imm-button-danger" disabled={action === 'apply-queue'} onClick={() => setInstallQueue((current) => current.filter((queued) => queued.projectId !== item.projectId))}>Remove</button>
                                        </div>
                                    ))}
                                </div>
                                <div className="imm-panel-footer">
                                    <button className="imm-button imm-button-primary" disabled={action === 'apply-queue'} onClick={() => void applyInstallQueue()}>
                                        {action === 'apply-queue' ? 'Applying…' : `Apply ${installQueue.length} item${installQueue.length === 1 ? '' : 's'}`}
                                    </button>
                                </div>
                            </>
                        )}
                    </Panel>
                )}

                {tab === 'categories' && (
                    <div className="imm-two-column">
                        <Panel title="New category" description="Creates a folder and its config.json.">
                            <form className="imm-form-stack" onSubmit={saveCategory}>
                                <label className="imm-field"><span>Folder</span><input name="folder" required pattern="[A-Za-z0-9_-]+" placeholder="Optimization" /></label>
                                <label className="imm-field"><span>Display name</span><input name="name" required placeholder="Optimization" /></label>
                                <label className="imm-field"><span>Description</span><textarea name="description" rows={3} placeholder="Client performance improvements." /></label>
                                <div className="imm-field-row">
                                    <label className="imm-check"><input name="default_enabled" type="checkbox" /><span>Enable by default</span></label>
                                    <label className="imm-field imm-order"><span>Order</span><input name="order" type="number" defaultValue="0" /></label>
                                </div>
                                <button className="imm-button imm-button-primary" disabled={action === 'category'}>{action === 'category' ? 'Creating…' : 'Create category'}</button>
                            </form>
                        </Panel>
                        <Panel title="Published categories" description={`${overview.categories.length} category folders.`}>
                            {overview.categories.length === 0 ? <EmptyState>No optional categories yet.</EmptyState> : (
                                <div className="imm-category-list">
                                    {overview.categories.map((category) => (
                                        <div className="imm-category" key={category.id}>
                                            <div className="imm-category-copy"><strong>{category.name}</strong><p>{category.description || 'No description'}</p><small>{category.modCount} mods · Order {category.order} · {category.default_enabled ? 'Default on' : 'Default off'}</small><code>impulse/optionnal_mods/{category.folder}</code></div>
                                            <div className="imm-category-actions">
                                                <label className="imm-switch"><input type="checkbox" checked={category.default_enabled} disabled={action === `category:${category.id}`} onChange={(event) => void updateCategory(category, { default_enabled: event.currentTarget.checked })} /><span /></label>
                                                <button className="imm-button imm-button-secondary" disabled={action === `category:${category.id}`} onClick={() => setEditingCategory(category)}>Edit</button>
                                                <button className="imm-button imm-button-danger" disabled={category.modCount > 0 || action === `category:${category.id}`} onClick={() => void deleteCategory(category)}>Delete</button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </Panel>
                    </div>
                )}

                {tab === 'relationships' && (
                    <Panel title="Mod relationships" description="Required Modrinth dependencies are read-only. Conflicts are symmetric and updates always require approval." action={<button className="imm-button imm-button-primary" disabled={action === 'relationships'} onClick={() => void saveRelationships()}>{action === 'relationships' ? 'Saving…' : 'Save relationships'}</button>}>
                        {(overview.relationships?.errors || []).map((error) => <div key={error} className="imm-inline-error"><strong>Relationship warning</strong><span>{error}</span></div>)}
                        {(overview.relationships?.mods || []).length === 0 ? <EmptyState>Install managed mods to configure relationships.</EmptyState> : (
                            <div className="imm-list">
                                {overview.relationships.mods.map((mod) => (
                                    <div className="imm-relationship" key={mod.id}>
                                        <div className="imm-mod-main"><strong>{mod.name}</strong><span className="imm-filename">{mod.id}{mod.required ? ' · Required client mod' : ''}</span>{mod.dependencies.length > 0 && <small>Depends on {mod.dependencies.join(', ')}</small>}</div>
                                        <label className="imm-field"><span>Update policy</span><select value={relationshipDraft[mod.id]?.policy || 'release'} onChange={(event) => setRelationshipDraft((current) => ({ ...current, [mod.id]: { conflicts: current[mod.id]?.conflicts || [], policy: event.currentTarget.value as any } }))}><option value="pinned">Pinned</option><option value="release">Release</option><option value="beta">Beta</option><option value="alpha">Alpha</option></select></label>
                                        <div className="imm-conflicts"><span>Conflicts</span>{overview.relationships.mods.filter((target) => target.id !== mod.id).map((target) => <label key={target.id} className="imm-check"><input type="checkbox" checked={(relationshipDraft[mod.id]?.conflicts || []).includes(target.id)} onChange={(event) => toggleConflict(mod.id, target.id, event.currentTarget.checked)} /><span>{target.name}</span></label>)}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Panel>
                )}

                {tab === 'content' && (
                    <Panel title="Launcher content" description="Safe Markdown is supported. Raw HTML and unsafe links are rejected." action={<button className="imm-button imm-button-primary" disabled={action === 'content'} onClick={() => void saveContent()}>{action === 'content' ? 'Saving…' : 'Save content'}</button>}>
                        {(['announcements', 'events', 'changelog'] as Array<keyof ContentData>).map((section) => (
                            <section className="imm-content-section" key={section}>
                                <div className="imm-content-heading"><div><h3>{section === 'changelog' ? 'Changelog' : section[0].toUpperCase() + section.slice(1)}</h3><p>{content[section].length} entries</p></div><button className="imm-button imm-button-secondary" onClick={() => addContentItem(section)}>Add</button></div>
                                {content[section].length === 0 ? <EmptyState>No {section} yet.</EmptyState> : content[section].map((item, index) => (
                                    <div className="imm-content-card" key={item.id || index}>
                                        <div className="imm-content-fields">
                                            <label className="imm-field"><span>ID</span><input value={item.id || ''} onChange={(event) => updateContentItem(section, index, 'id', event.currentTarget.value)} /></label>
                                            {section === 'changelog' && <label className="imm-field"><span>Version</span><input value={item.version || ''} onChange={(event) => updateContentItem(section, index, 'version', event.currentTarget.value)} /></label>}
                                            <label className="imm-field"><span>Title</span><input value={item.title || ''} onChange={(event) => updateContentItem(section, index, 'title', event.currentTarget.value)} /></label>
                                            {section === 'announcements' && <label className="imm-field"><span>Severity</span><select value={item.severity || 'info'} onChange={(event) => updateContentItem(section, index, 'severity', event.currentTarget.value)}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label>}
                                        </div>
                                        <label className="imm-field"><span>{section === 'events' ? 'Description' : 'Markdown body'}</span><textarea rows={4} value={section === 'events' ? item.description || '' : item.body || ''} onChange={(event) => updateContentItem(section, index, section === 'events' ? 'description' : 'body', event.currentTarget.value)} /></label>
                                        <div className="imm-content-fields">
                                            {section === 'announcements' && <><label className="imm-field"><span>Publish time</span><input value={item.publish_time || ''} onChange={(event) => updateContentItem(section, index, 'publish_time', event.currentTarget.value)} /></label><label className="imm-field"><span>Expiry</span><input value={item.expiry || ''} onChange={(event) => updateContentItem(section, index, 'expiry', event.currentTarget.value)} /></label><label className="imm-field"><span>Link</span><input value={item.link || ''} onChange={(event) => updateContentItem(section, index, 'link', event.currentTarget.value)} /></label></>}
                                            {section === 'events' && <><label className="imm-field"><span>Start</span><input value={item.start || ''} onChange={(event) => updateContentItem(section, index, 'start', event.currentTarget.value)} /></label><label className="imm-field"><span>End</span><input value={item.end || ''} onChange={(event) => updateContentItem(section, index, 'end', event.currentTarget.value)} /></label><label className="imm-field"><span>Image URL</span><input value={item.image || ''} onChange={(event) => updateContentItem(section, index, 'image', event.currentTarget.value)} /></label></>}
                                            {section === 'changelog' && <label className="imm-field"><span>Publication time</span><input value={item.publication_time || ''} onChange={(event) => updateContentItem(section, index, 'publication_time', event.currentTarget.value)} /></label>}
                                        </div>
                                        <button className="imm-button imm-button-danger" onClick={() => setContent((current) => ({ ...current, [section]: current[section].filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button>
                                    </div>
                                ))}
                            </section>
                        ))}
                    </Panel>
                )}

                {tab === 'impulse' && (
                    <>
                        <div className={`imm-health ${overview.impulse.installed ? 'is-good' : 'is-missing'}`}>
                            <span className="imm-status-dot" />
                            <div><strong>{overview.impulse.installed ? 'Impulse mod detected' : 'Impulse mod not detected'}</strong><p>{overview.impulse.installed ? `Configuration: ${overview.impulse.configPath}` : 'This manager will not install or update the Impulse jar.'}</p></div>
                        </div>
                        <Panel title="Server manifest" description="Only known properties are edited; comments and custom keys remain intact.">
                            <div className="imm-panel-footer imm-invite-action"><button type="button" className="imm-button imm-button-secondary" onClick={async () => {
                                const host = config['public.host'] || 'localhost';
                                const port = config['minecraft.port'] || '25565';
                                const manifestPort = config['manifest.port'] || '25850';
                                const params = new URLSearchParams({ address: `${host}:${port}`, manifest_port: manifestPort, action: 'add' });
                                await navigator.clipboard.writeText(`impulse://server?${params.toString()}`);
                                setNotice({ kind: 'success', text: 'Impulse invitation copied.' });
                            }}>Copy invitation</button></div>
                            <form className="imm-config-grid" onSubmit={saveConfig}>
                                {configFields.map((field) => {
                                    const onChange = (value: string) => setConfig((current) => ({ ...current, [field.key]: value }));
                                    const value = config[field.key] || '';
                                    if (field.type === 'textarea') return <label className="imm-field" key={field.key}><span>{field.label}</span><textarea rows={3} value={value} onChange={(event) => onChange(event.currentTarget.value)} /></label>;
                                    if (field.type === 'boolean') return <label className="imm-field" key={field.key}><span>{field.label}</span><select value={value || 'false'} onChange={(event) => onChange(event.currentTarget.value)}><option value="true">Enabled</option><option value="false">Disabled</option></select></label>;
                                    if (field.type === 'select') return <label className="imm-field" key={field.key}><span>{field.label}</span><select value={value} onChange={(event) => onChange(event.currentTarget.value)}>{field.options?.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
                                    return <label className="imm-field" key={field.key}><span>{field.label}</span><input type={field.type === 'number' ? 'number' : 'text'} value={value} onChange={(event) => onChange(event.currentTarget.value)} /></label>;
                                })}
                                <div className="imm-config-submit"><button className="imm-button imm-button-primary" disabled={action === 'config'}>{action === 'config' ? 'Saving…' : 'Save configuration'}</button></div>
                            </form>
                        </Panel>
                        <Panel title="Assets" description="Upload media through Files into impulse/assets, then select it here.">
                            <div className="imm-config-grid">
                                {([['media.iconFile', 'Icon'], ['media.bannerFile', 'Banner'], ['media.videoBackgroundFile', 'Background media']] as const).map(([key, label]) => (
                                    <label className="imm-field" key={key}><span>{label}</span><select value={config[key] || ''} onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setConfig((current) => ({ ...current, [key]: value }));
                                    }}><option value="">No local asset</option>{overview.assets.filter((asset) => !asset.directory).map((asset) => <option key={asset.name} value={asset.name}>{asset.name}</option>)}</select></label>
                                ))}
                            </div>
                            <div className="imm-panel-footer"><button className="imm-button imm-button-secondary" disabled={action === 'config'} onClick={() => void saveConfig()}>{action === 'config' ? 'Saving…' : 'Save asset selection'}</button></div>
                        </Panel>
                    </>
                )}

                {tab === 'activity' && (
                    <Panel title="Operations" description="File changes are applied immediately; the server is never restarted automatically.">
                        {overview.operations.length === 0 ? <EmptyState>No mod operations yet.</EmptyState> : (
                            <div className="imm-operation-list">
                                {overview.operations.map((operation) => (
                                    <details className="imm-operation" key={operation.id} open={operation.state === 'running' || operation.state === 'failed'}>
                                        <summary><span><strong>{operation.summary}</strong><small>{operation.createdAt || 'Recently'}</small></span><span className={`imm-badge is-${operation.state}`}>{operation.state.replace('_', ' ')}</span></summary>
                                        {operation.logs.length > 0 ? <pre>{operation.logs.join('\n')}</pre> : <p>No logs were recorded.</p>}
                                    </details>
                                ))}
                            </div>
                        )}
                    </Panel>
                )}

                {(installQueue.length > 0 || installationBatch.status !== 'idle') && (
                    <div className={`imm-queue-bar is-${installationBatch.status}`} role="status" aria-live="polite">
                        {installationBatch.status === 'idle' ? (
                            <>
                                <div className="imm-queue-summary">
                                    <strong>{installQueue.length} item{installQueue.length === 1 ? '' : 's'} queued</strong>
                                    <span>Ready to apply to this server</span>
                                </div>
                                <div className="imm-queue-bar-actions">
                                    <button className="imm-button imm-button-primary" onClick={() => void applyInstallQueue()}>Apply</button>
                                    <button className="imm-button imm-button-secondary" onClick={() => setTab('queue')}>View</button>
                                </div>
                            </>
                        ) : installationBatch.status === 'submitting' || installationBatch.status === 'applying' ? (
                            <>
                                <div className="imm-queue-status">
                                    <span className="imm-spinner" aria-hidden="true" />
                                    <div className="imm-queue-summary">
                                        <strong>Applying {installationBatch.total} item{installationBatch.total === 1 ? '' : 's'}…</strong>
                                        <span>Downloading, verifying, and moving mod files</span>
                                    </div>
                                </div>
                                <div className="imm-queue-bar-actions">
                                    <button className="imm-button imm-button-secondary" onClick={() => setTab('activity')}>View</button>
                                </div>
                            </>
                        ) : installationBatch.status === 'success' ? (
                            <>
                                <div className="imm-queue-summary">
                                    <strong>Installed</strong>
                                    <span>{installationBatch.total} item{installationBatch.total === 1 ? '' : 's'} installed successfully</span>
                                </div>
                                <div className="imm-queue-bar-actions">
                                    <button className="imm-button imm-button-secondary" onClick={() => setInstallationBatch(emptyInstallationBatch())}>Close</button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="imm-queue-summary">
                                    <strong>An error occurred during installation</strong>
                                    <span>Open Activity to see the operation logs</span>
                                </div>
                                <div className="imm-queue-bar-actions">
                                    <button className="imm-button imm-button-secondary" onClick={() => setTab('activity')}>View</button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </PageContentBlock>
    );
};

export default ImpulseManager;
