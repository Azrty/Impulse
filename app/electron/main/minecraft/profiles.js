const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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

/**
 * Profile Manager - Manages Minecraft profiles (instances) with JSON manifests.
 * Each profile = a self-contained Minecraft configuration (server, version, loader, mods, etc.)
 * 
 * Directory structure:
 *   <minecraftPath>/
 *     profiles/
 *       <profileId>/
 *         profile.json         # The manifest
 *         mods/                # Symlinks (or copies) from cache
 *         resourcepacks/
 *         shaderpacks/
 *         config/
 *         saves/
 *     cache/
 *       mods/<sha1>.jar
 *       resourcepacks/<sha1>.zip
 *       shaderpacks/<sha1>.zip
 *     versions/               # Shared vanilla + loader versions
 *     assets/                 # Shared assets
 *     libraries/              # Shared libraries
 */

/**
 * Create a blank profile manifest
 */
function createProfileManifest(overrides = {}) {
  return {
    id: overrides.id || uuidv4(),
    name: overrides.name || 'New Profile',
    icon: overrides.icon || null,
    server_description: overrides.server_description || null,
    banner_url: overrides.banner_url || null,
    video_background_url: overrides.video_background_url || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),

    // Source: 'custom' | 'server'
    source: overrides.source || 'custom',
    // If source=server, the Erozion server that owns this profile
    erozion_server_id: overrides.erozion_server_id || null,

    // Server connection info
    server: {
      address: overrides.server?.address || '',
      port: overrides.server?.port || 25565,
      auto_connect: overrides.server?.auto_connect ?? true,
    },

    // Minecraft configuration
    minecraft: {
      version: overrides.minecraft?.version || '1.20.4',
      loader: overrides.minecraft?.loader || 'vanilla', // vanilla | forge | neoforge | fabric | quilt
      loader_version: overrides.minecraft?.loader_version || null,
    },

    menu: {
      enabled: boolValue(overrides.menu?.enabled, true),
      skin: menuSkinValue(overrides.menu?.skin),
      title: overrides.menu?.title || 'IMPULSE',
      subtitle: overrides.menu?.subtitle || 'A focused way into your server',
      hide_server_name_from_play_button: boolValue(overrides.menu?.hide_server_name_from_play_button ?? overrides.menu?.hideServerNameFromPlayButton, false),
      singleplayer_enabled: boolValue(overrides.menu?.singleplayer_enabled ?? overrides.menu?.singleplayerEnabled, false),
      multiplayer_enabled: boolValue(overrides.menu?.multiplayer_enabled ?? overrides.menu?.multiplayerEnabled, false),
    },

    // Mod list
    mods: overrides.mods || [],
    // Each mod: { name, file_name, source: 'modrinth'|'curseforge'|'url'|'custom',
    //             source_id, version_id, download_url, sha1, size, required: bool }

    // Resource packs
    resourcePacks: overrides.resourcePacks || [],
    // Each: { name, file_name, source, source_id, version_id, download_url, sha1, size }

    // Shader packs
    shaderPacks: overrides.shaderPacks || [],
    // Each: { name, file_name, source, source_id, version_id, download_url, sha1, size }

    // JVM settings (per-profile overrides, null = use global)
    jvm: {
      min_memory: overrides.jvm?.min_memory || null,
      max_memory: overrides.jvm?.max_memory || null,
      extra_args: overrides.jvm?.extra_args || [],
      java_path: overrides.jvm?.java_path || null,
    },

    // Server admin controls
    allow_user_mods: overrides.allow_user_mods ?? true,

    // Manifest versioning (for server sync)
    manifest_version: overrides.manifest_version || 1,
    last_synced_at: overrides.last_synced_at || null,

    // Status
    last_played_at: overrides.last_played_at || null,
  };
}

class ProfileManager {
  constructor(minecraftPath) {
    this.minecraftPath = minecraftPath;
    this.profilesDir = path.join(minecraftPath, 'profiles');
  }

  /**
   * Ensure the profiles directory exists
   */
  async init() {
    await fs.mkdir(this.profilesDir, { recursive: true });
  }

  /**
   * Get the directory path for a profile
   */
  getProfileDir(profileId) {
    // Prevent path traversal
    const sanitized = path.basename(profileId);
    return path.join(this.profilesDir, sanitized);
  }

  /**
   * Get the profile.json path for a profile
   */
  getProfileJsonPath(profileId) {
    return path.join(this.getProfileDir(profileId), 'profile.json');
  }

  /**
   * List all profiles
   */
  async listProfiles() {
    await this.init();
    const entries = await fs.readdir(this.profilesDir, { withFileTypes: true });
    const profiles = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const jsonPath = path.join(this.profilesDir, entry.name, 'profile.json');
        const raw = await fs.readFile(jsonPath, 'utf8');
        profiles.push(JSON.parse(raw));
      } catch {
        // Skip broken profiles
      }
    }

    // Sort: last played first, then by name
    profiles.sort((a, b) => {
      if (a.last_played_at && b.last_played_at) return new Date(b.last_played_at) - new Date(a.last_played_at);
      if (a.last_played_at) return -1;
      if (b.last_played_at) return 1;
      return a.name.localeCompare(b.name);
    });

    return profiles;
  }

  /**
   * Get a single profile by ID
   */
  async getProfile(profileId) {
    const jsonPath = this.getProfileJsonPath(profileId);
    const raw = await fs.readFile(jsonPath, 'utf8');
    return JSON.parse(raw);
  }

  /**
   * Create a new profile and its directory structure
   */
  async createProfile(data = {}) {
    const manifest = createProfileManifest(data);
    const profileDir = this.getProfileDir(manifest.id);

    // Create profile subdirectories
    const subdirs = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'saves'];
    await fs.mkdir(profileDir, { recursive: true });
    for (const sub of subdirs) {
      await fs.mkdir(path.join(profileDir, sub), { recursive: true });
    }

    // Write profile.json
    await fs.writeFile(
      path.join(profileDir, 'profile.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    return manifest;
  }

  /**
   * Update an existing profile
   */
  async updateProfile(profileId, updates) {
    const existing = await this.getProfile(profileId);
    
    // Merge updates (shallow merge for top-level, deep merge for objects)
    const merged = { ...existing };

    if (updates.name !== undefined) merged.name = updates.name;
    if (updates.icon !== undefined) merged.icon = updates.icon;
    if (updates.server_description !== undefined) merged.server_description = updates.server_description;
    if (updates.server) merged.server = { ...merged.server, ...updates.server };
    if (updates.minecraft) merged.minecraft = { ...merged.minecraft, ...updates.minecraft };
    if (updates.menu) merged.menu = { ...merged.menu, ...updates.menu };
    if (updates.mods !== undefined) merged.mods = updates.mods;
    if (updates.resourcePacks !== undefined) merged.resourcePacks = updates.resourcePacks;
    if (updates.shaderPacks !== undefined) merged.shaderPacks = updates.shaderPacks;
    if (updates.jvm) merged.jvm = { ...merged.jvm, ...updates.jvm };
    if (updates.allow_user_mods !== undefined) merged.allow_user_mods = updates.allow_user_mods;
    if (updates.manifest_version !== undefined) merged.manifest_version = updates.manifest_version;
    if (updates.last_synced_at !== undefined) merged.last_synced_at = updates.last_synced_at;
    if (updates.last_played_at !== undefined) merged.last_played_at = updates.last_played_at;

    merged.updated_at = new Date().toISOString();

    await fs.writeFile(
      this.getProfileJsonPath(profileId),
      JSON.stringify(merged, null, 2),
      'utf8'
    );

    return merged;
  }

  /**
   * Delete a profile and its directory
   */
  async deleteProfile(profileId) {
    const profileDir = this.getProfileDir(profileId);
    await fs.rm(profileDir, { recursive: true, force: true });
    return { success: true };
  }

  /**
   * Duplicate a profile  
   */
  async duplicateProfile(profileId) {
    const source = await this.getProfile(profileId);
    const newProfile = {
      ...source,
      id: uuidv4(),
      name: `${source.name} (copie)`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_played_at: null,
      source: 'custom',
      erozion_server_id: null,
      allow_user_mods: true,
    };

    return await this.createProfile(newProfile);
  }

  /**
   * Apply a server manifest to a profile (sync from server)
   * Returns { updated: boolean, changes: string[] }
   */
  async applyServerManifest(profileId, serverManifest) {
    const profile = await this.getProfile(profileId);
    const changes = [];

    const normalizeFileList = (items = []) => items
      .map((item) => ({
        sha1: String(item.sha1 || '').toLowerCase(),
        file_name: item.file_name || item.name || '',
        download_url: item.download_url || '',
        size: Number(item.size || 0),
        required: item.required !== false,
      }))
      .sort((a, b) => `${a.sha1}:${a.file_name}`.localeCompare(`${b.sha1}:${b.file_name}`));
    const sameFileList = (left = [], right = []) => {
      const a = normalizeFileList(left);
      const b = normalizeFileList(right);
      return JSON.stringify(a) === JSON.stringify(b);
    };

    const mediaChanged =
      (serverManifest.server_description !== undefined && serverManifest.server_description !== profile.server_description)
      ||
      (serverManifest.banner_url !== undefined && serverManifest.banner_url !== profile.banner_url)
      || (serverManifest.video_background_url !== undefined && serverManifest.video_background_url !== profile.video_background_url);
    const nameChanged = serverManifest.name !== undefined && serverManifest.name !== profile.name;
    const menuChanged = serverManifest.menu !== undefined && JSON.stringify(serverManifest.menu || {}) !== JSON.stringify(profile.menu || {});
    const serverChanged = serverManifest.server !== undefined && JSON.stringify(serverManifest.server || {}) !== JSON.stringify(profile.server || {});
    const modsChanged = serverManifest.mods !== undefined && !sameFileList(
      profile.allow_user_mods ? profile.mods.filter((mod) => mod.required !== false) : profile.mods,
      serverManifest.mods
    );
    const resourcePacksChanged = serverManifest.resourcePacks !== undefined && !sameFileList(profile.resourcePacks, serverManifest.resourcePacks);
    const shaderPacksChanged = serverManifest.shaderPacks !== undefined && !sameFileList(profile.shaderPacks, serverManifest.shaderPacks);

    // Only sync if server manifest is newer
    if (
      serverManifest.manifest_version <= profile.manifest_version
      && profile.last_synced_at
      && !nameChanged
      && !mediaChanged
      && !menuChanged
      && !serverChanged
      && !modsChanged
      && !resourcePacksChanged
      && !shaderPacksChanged
    ) {
      return { updated: false, changes: [] };
    }

    if (serverManifest.name !== undefined && serverManifest.name !== profile.name) {
      changes.push(`Name: ${profile.name} -> ${serverManifest.name}`);
      profile.name = serverManifest.name;
    }

    // Update minecraft version/loader if changed
    if (serverManifest.minecraft) {
      if (serverManifest.minecraft.version !== profile.minecraft.version) {
        changes.push(`Version: ${profile.minecraft.version} -> ${serverManifest.minecraft.version}`);
      }
      if (serverManifest.minecraft.loader !== profile.minecraft.loader) {
        changes.push(`Loader: ${profile.minecraft.loader} -> ${serverManifest.minecraft.loader}`);
      }
      profile.minecraft = { ...profile.minecraft, ...serverManifest.minecraft };
    }

    // Update server connection info
    if (serverManifest.server) {
      profile.server = { ...profile.server, ...serverManifest.server };
    }

    if (serverManifest.menu) {
      profile.menu = { ...(profile.menu || {}), ...serverManifest.menu };
    }

    // Merge mods: server profiles replace all synced mods; custom profiles may keep user mods.
    if (serverManifest.mods) {
      const keepUserMods = serverManifest.allow_user_mods !== false && profile.allow_user_mods;
      const userMods = keepUserMods ? profile.mods.filter(m => !m.required) : [];
      const serverMods = serverManifest.mods.map(m => ({
        ...m,
        required: m.required !== undefined ? !!m.required : true,
      }));
      
      const addedMods = serverMods.filter(sm => !profile.mods.find(pm => pm.sha1 === sm.sha1));
      const removedMods = profile.mods.filter(pm => !serverMods.find(sm => sm.sha1 === pm.sha1) && (!keepUserMods || pm.required));
      
      if (addedMods.length) changes.push(`+${addedMods.length} mod(s) added`);
      if (removedMods.length) changes.push(`-${removedMods.length} mod(s) removed`);

      profile.mods = [...serverMods, ...userMods];
    }

    // Replace resource packs and shaders from server
    if (serverManifest.resourcePacks) {
      profile.resourcePacks = serverManifest.resourcePacks;
      changes.push('Resource packs updated');
    }
    if (serverManifest.shaderPacks) {
      profile.shaderPacks = serverManifest.shaderPacks;
      changes.push('Shaders updated');
    }

    // Update admin control flags
    if (serverManifest.allow_user_mods !== undefined) {
      profile.allow_user_mods = serverManifest.allow_user_mods;
    }

    if (serverManifest.banner_url !== undefined) {
      profile.banner_url = serverManifest.banner_url;
    }
    if (serverManifest.server_description !== undefined) {
      profile.server_description = serverManifest.server_description;
    }
    if (serverManifest.video_background_url !== undefined) {
      profile.video_background_url = serverManifest.video_background_url;
    }

    profile.manifest_version = serverManifest.manifest_version;
    profile.last_synced_at = new Date().toISOString();
    profile.updated_at = new Date().toISOString();

    await fs.writeFile(
      this.getProfileJsonPath(profileId),
      JSON.stringify(profile, null, 2),
      'utf8'
    );

    return { updated: true, changes };
  }
}

module.exports = { ProfileManager, createProfileManifest };
