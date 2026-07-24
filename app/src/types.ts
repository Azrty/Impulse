export interface ImpulseMod {
  name: string;
  file_name: string;
  download_url: string | null;
  sha1: string | null;
  size: number;
  required: boolean;
  source?: string;
}

export interface ImpulseManifest {
  manifest_version: number;
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
  };
  mods: ImpulseMod[];
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
