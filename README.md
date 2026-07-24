# Impulse

Impulse is an isolated Minecraft Forge/NeoForge launcher and server manifest mod.

## Layout

- `app/` - Vite, React, and Electron launcher.
- `mod/` - Gradle multi-module Forge and NeoForge server mod.

## Launcher

Run from `Impulse/app`:

```sh
npm install
npm run electron:dev
```

The launcher stores Minecraft files in the Impulse app-data path, not the global `.minecraft` folder. Add servers with `host[:port]`; the launcher pings the Minecraft server first and looks for an Impulse manifest-port hint in the server status response. If no hint is present, it fetches `http://host:25850/impulse/server.json`.

To advertise a custom manifest port through the server ping, put a token like this anywhere in the server MOTD:

```text
[impulse:25851]
```

The launcher strips that token from the displayed description after reading it.

## Server Mod

Run from `Impulse/mod`:

```sh
gradle -PimpulseTargets=forge-1.12.2 :forge-1.12.2:build
gradle -PimpulseTargets=neoforge-1.21.1 :neoforge-1.21.1:build
```

On first server start, the mod creates `config/impulse-server.properties`.

Important settings:

- `public.host` - hostname/IP clients can reach.
- `minecraft.version` - Minecraft version exposed to the launcher.
- `minecraft.loader` - `forge` or `neoforge`.
- `loader.version` - Forge/NeoForge loader version exposed to the launcher.
- `forge.version` - legacy Forge version key still supported for older configs.
- `manifest.port` - HTTP manifest server port, default `25850`.
- `mods.directory` - directory scanned for served mod jars, default `mods`.
- `mods.exclude` - comma-separated substrings excluded from the manifest.

The server mod serves:

- `/impulse/server.json`
- `/impulse/mods/<file-name>.jar`
