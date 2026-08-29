export type Mod = {
  id?: string;
  name?: string;
  description?: string;
  file_name?: string;
  size?: number;
  category_id?: string;
  required?: boolean;
  verification?: { status?: string };
  sha512?: string;
};

export type Category = { id: string; name: string; description?: string; default_enabled?: boolean };
export type Manifest = {
  name?: string;
  description?: string;
  icon_url?: string;
  banner_url?: string;
  minecraft?: { version?: string; loader?: string; loader_version?: string };
  server?: { address?: string; port?: number; auto_connect?: boolean };
  mods?: Mod[];
  optional_mods?: Mod[];
  optional_mod_categories?: Category[];
};
export type Profile = {
  id: string;
  name?: string;
  address: string;
  selected_optional_ids?: string[];
};
export type Restriction = { heading: string; title: string; description: string; host: string; reason_code: string };
export type CustomMod = { project_id: string; name?: string; description?: string; version_number?: string; update_version_number?: string; icon_url?: string; location?: string; explicit?: boolean; required_by?: string[] };
export type SearchProject = { project_id: string; slug?: string; title: string; description?: string; author?: string; icon_url?: string; downloads?: number };
export type Project = SearchProject & { body?: string; authors?: string[]; featured_gallery?: string; gallery?: { url: string; title?: string; description?: string }[]; license_name?: string; categories?: string[] };
export type Version = { id: string; name?: string; version_number: string; version_type?: string; changelog?: string; date_published?: string; files?: { filename: string; size: number }[] };
export type InstallPlan = { channel: string; items: Record<string, { project: Project; version: Version; file: { filename: string; size: number }; explicit: boolean; required_by?: string[] }>; optional_dependencies?: { project_id: string; name: string }[] };
export type GlobalMod = { file_name: string; name?: string; project_id?: string; version_number?: string; compatibility?: string; reason?: string; icon_url?: string; size?: number; managed?: boolean };
export type Operation = { id: string; kind: string; status: 'running' | 'done' | 'error' | 'cancelled'; message: string; completed?: number; total?: number; result?: unknown; error?: string };
export type State = {
  legal_accepted: boolean;
  legal_version: string;
  privacy_url: string;
  terms_url: string;
  profiles: Profile[];
  active_profile_id?: string;
  selected_profile?: Profile;
  manifest?: Manifest;
  restriction?: Restriction;
  update_channel: 'stable' | 'beta';
  custom_mods?: CustomMod[];
  minecraft_version: string;
  loader: string;
};
