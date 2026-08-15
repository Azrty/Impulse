export interface ImpulseMod {
  id: string;
  name: string;
  description: string;
  file_name: string;
  download_url: string | null;
  sha1: string | null;
  size: number;
  required: boolean;
  source?: string;
  category_id?: string | null;
  dependencies: string[];
  conflicts: string[];
}

export interface OptionalModCategory {
  id: string;
  name: string;
  description: string;
  default_enabled: boolean;
  order: number;
}

export interface ImpulseManifest {
  manifest_version: number;
  impulse_version: string;
  name: string;
  description: string;
  icon_url: string | null;
  banner_url: string | null;
  video_background_url: string | null;
  server: {
    address: string;
    port: number;
    auto_connect: boolean;
  };
  minecraft: {
    version: string;
    loader: 'forge' | 'neoforge';
    loader_version: string;
  };
  menu: {
    enabled: boolean;
    skin: 'default' | 'classic';
    title: string;
    subtitle: string;
    hide_server_name_from_play_button: boolean;
    singleplayer_enabled: boolean;
    multiplayer_enabled: boolean;
  };
  mods: ImpulseMod[];
  optional_mods: ImpulseMod[];
  optional_mod_categories: OptionalModCategory[];
  maintenance: {
    enabled: boolean;
    title: string;
    message: string;
    estimated_end: string | null;
  };
  crash_reports: {
    enabled: boolean;
    max_upload_bytes: number;
  };
  announcements: ImpulseAnnouncement[];
  changelog: ImpulseChangelog[];
  events: ImpulseEvent[];
}

export interface ImpulseAnnouncement {
  id: string; title: string; body: string; severity: 'info' | 'warning' | 'critical'; link: string | null;
  publish_time: string | null; expiry: string | null; order: number;
}
export interface ImpulseChangelog {
  id: string; version: string; title: string; body: string; publication_time: string | null;
}
export interface ImpulseEvent {
  id: string; title: string; description: string; start: string | null; end: string | null; image: string | null; link: string | null;
}

export interface ServerStatus {
  online: boolean;
  error?: string;
  version?: string | null;
  protocol?: number | null;
  impulseManifestPort?: number | null;
  players?: {
    online: number;
    max: number;
  };
  description?: string | null;
}

export interface SavedServer {
  id: string;
  host: string;
  port: number;
  manifestPort: number;
  status: ServerStatus;
  manifest: ImpulseManifest;
  optionalModSelections?: Record<string, boolean>;
  optionalModChoices?: Record<string, boolean>;
  optionalModRequiredBy?: Record<string, string[]>;
  optionalModRelationshipErrors?: string[];
  readAnnouncementIds?: string[];
  optionalModSignature?: string;
  optionalModPromptedSignature?: string | null;
  crashReportSharing?: 'ask' | 'always' | 'never';
  outdatedImpulseWarningDismissed?: boolean;
  addedAt: string;
  updatedAt: string;
  profileId: string;
}

export interface User {
  type: 'offline' | 'microsoft';
  username: string;
  uuid: string;
  accountId?: string;
  minecraftExpiresAt?: string | null;
}

export interface MinecraftAccount {
  id: string;
  type: 'offline' | 'microsoft';
  username: string;
  uuid: string;
  minecraftExpiresAt?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface LaunchProgress {
  status: string;
  message: string;
  progress?: number;
  total?: number;
  details?: Record<string, unknown>;
}

export interface RepairReport {
  repairedFiles: string[];
  failures: string[];
  verifiedMods: number;
  launchVersion: string;
  loader?: string;
}

export interface GameStorage {
  gameBytes: number;
  profileBytes: number;
  cacheBytes: number;
  orphanBytes: number;
  deduplicatedBytes: number;
  profileCount: number;
}

export interface ImpulseInvitation {
  raw: string;
  address: string;
  manifestPort: number;
  action: 'add' | 'launch';
  optional: string[];
  error?: string;
}

export interface OfflineDetails {
  offlineKind: 'server' | 'internet';
  title: string;
  description: string;
}

export interface RunningGame {
  serverId: string;
  pid?: number;
  logPath?: string;
  diagnosticsDir?: string;
}

export interface CrashReport {
  serverId: string;
  code: number | null;
  signal?: string | null;
  logPath?: string;
  diagnosticsDir?: string;
  crashLog?: string;
  reportId?: string;
  sharingSupported?: boolean;
  sharePromptRequired?: boolean;
  shareStatus?: CrashShareStatus;
  shareMessage?: string;
}

export type CrashShareStatus = 'unsupported' | 'awaiting-consent' | 'sharing' | 'shared' | 'pending' | 'failed' | 'not-shared';

export interface DiscordRpcSettings {
  enabled: boolean;
  clientId: string;
  showServer: boolean;
  showAddress: boolean;
  showDimension: boolean;
  showLoader: boolean;
  showElapsed: boolean;
  privacyMode: boolean;
}
