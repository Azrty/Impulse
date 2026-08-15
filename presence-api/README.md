# Impulse Presence API

Ephemeral identity verification and player presence for Impulse badges. Users may also opt in to sharing the title, artist, and a small cover thumbnail currently playing in Spotify Desktop. Music and thumbnails expire after 30 seconds, are never added to a history, and are not stored in a database. The service never receives Minecraft server addresses.

```bash
npm install
cp .env.example .env
sed -i "s/replace-with-at-least-32-random-characters/$(openssl rand -hex 32)/" .env
npm run dev
```

The API automatically loads `presence-api/.env`. Environment variables supplied by Docker or the operating system take priority over values in that file.

Build the production container with `docker build -t impulse-presence .`. Run exactly one replica because state is intentionally in memory, and expose it behind HTTPS at `api.impulsemc.com`.

The client proves ownership with Mojang's session server. Access tokens never leave Minecraft; the API receives only a one-time challenge, username, UUID verification result, request IP metadata, and short-lived presence calls. Music fields are optional, client-declared, limited to 128 characters each, and can be cleared by sending `music: null` in a heartbeat. Optional cover thumbnails are SHA-256-addressed JPEG/PNG files limited to 24 KiB and remain in memory for the same short activity lifetime.
