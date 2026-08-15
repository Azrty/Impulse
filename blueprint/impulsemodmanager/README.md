# Impulse Mod Manager

Blueprint extension for Pterodactyl v1.12+ that adds an **Impulse** tab to Forge and NeoForge Minecraft servers.

## Install

1. Export this folder from a current Blueprint installation, or install the included `impulsemodmanager.blueprint` archive.
2. Run Blueprint's extension migrations during installation.
3. Open a Minecraft server and select **Impulse**.

The extension never powers a server on, off, or restarts it. Server-side changes show a restart-required notice so the owner chooses when to load them.

## Access

Panel administrators and server owners have access. A subuser needs all of these Pterodactyl permissions:

- `file.read`
- `file.create`
- `file.update`
- `file.delete`

## Managed paths

```text
mods/                              Server jars
impulse/mods/                      Required Impulse client jars
impulse/optionnal_mods/<category>/ Optional Impulse client jars
impulse/assets/                    Media selected by Impulse config
impulse/.manager/state.json        Manager ownership state
impulse/.manager/public-index.json Launcher dependency/conflict index
impulse/content.json               Announcements, changelog, and events
```

On each Impulse-tab refresh, the manager hashes jars in all managed paths and identifies them through Modrinth's batch file-hash API. Recognized copies are grouped into one tracked mod and written to `impulse/.manager/state.json`. Files discovered this way remain externally owned and are never deleted automatically. Jars installed by the addon are tracked separately as addon-owned files. Unrecognized jars remain local and use embedded Forge/NeoForge metadata for their display name.

## Optional categories

Each category folder contains a `config.json` file. Folder names remain authoritative.

```json
{
  "id": "optimization",
  "name": "Optimization",
  "description": "Client performance improvements.",
  "default_enabled": false,
  "order": 10
}
```

The manager rejects duplicate optional client filenames because the launcher sync folder is flat. Root-level jars in `impulse/optionnal_mods` remain compatible and appear in the launcher as **Ungrouped**.

## Modrinth

Search and version results are filtered to the detected Minecraft version and Forge/NeoForge loader. Required dependencies are resolved into the transaction before files are downloaded. Files are staged through Wings, hash-checked against Modrinth SHA-1, then moved into place. If a managed replacement fails, its previous managed files are restored.

The first inventory scan reads each jar once to calculate SHA-1 and embedded metadata. Results are cached by path and size; unchanged jars do not need to be read again. Hash and project identities are resolved in batches and unknown hashes are retried periodically.

The manager also publishes dependency and conflict rules to the launcher, supports pinned/release/beta/alpha update policies, and keeps every update manually approved. The Content section manages launcher announcements, changelogs, and events. Saving Impulse configuration or published content sends `impulse reload` to a running server; if it cannot be delivered, the panel reports that reload is pending until startup.

When an update is available, use **Update** beside the installed mod. The complete update and dependency plan is added to the bottom queue; select **Apply** there to begin. Explicitly approved updates may take ownership of the affected tracked files, replace old filenames transactionally, and restore the previous files if the operation fails.
