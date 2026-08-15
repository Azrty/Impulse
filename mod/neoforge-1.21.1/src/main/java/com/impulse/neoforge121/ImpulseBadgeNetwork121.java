package com.impulse.neoforge121;

import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class ImpulseBadgeNetwork121 {
    private static final Set<UUID> IMPULSE_PLAYERS = Collections.synchronizedSet(new HashSet<UUID>());
    private static final Set<UUID> CAPABLE_CLIENTS = Collections.synchronizedSet(new HashSet<UUID>());
    private static final Map<UUID, ImpulseMusicActivity121> MUSIC = Collections.synchronizedMap(new HashMap<UUID, ImpulseMusicActivity121>());
    private static final Map<UUID, String> PLAYER_ARTWORK = Collections.synchronizedMap(new HashMap<UUID, String>());
    private static final Map<String, CachedArtwork> ARTWORK = Collections.synchronizedMap(new LinkedHashMap<String, CachedArtwork>(16, 0.75F, true));
    private static final int MAX_ARTWORK_CACHE_BYTES = 8 * 1024 * 1024;
    private static volatile long nextExpiryCheckAt;

    private ImpulseBadgeNetwork121() {
    }

    public static void registerPayloads(RegisterPayloadHandlersEvent event) {
        PayloadRegistrar registrar = event.registrar("1").optional();
        registrar.playToServer(HelloPayload.TYPE, HelloPayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleHello);
        registrar.playToClient(RosterPayload.TYPE, RosterPayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleRoster);
        registrar.playToClient(UpdatePayload.TYPE, UpdatePayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleUpdate);
        registrar.playToServer(MusicActivityPayload.TYPE, MusicActivityPayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleMusicActivity);
        registrar.playToClient(MusicSnapshotPayload.TYPE, MusicSnapshotPayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleMusicSnapshot);
        registrar.playToClient(MusicUpdatePayload.TYPE, MusicUpdatePayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleMusicUpdate);
        registrar.playToServer(ArtworkUploadPayload.TYPE, ArtworkUploadPayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleArtworkUpload);
        registrar.playToServer(ArtworkRequestPayload.TYPE, ArtworkRequestPayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleArtworkRequest);
        registrar.playToClient(ArtworkRosterPayload.TYPE, ArtworkRosterPayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleArtworkRoster);
        registrar.playToClient(ArtworkUpdatePayload.TYPE, ArtworkUpdatePayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleArtworkUpdate);
        registrar.playToClient(ArtworkDataPayload.TYPE, ArtworkDataPayload.STREAM_CODEC, ImpulseBadgeNetwork121::handleArtworkData);
    }

    private static void handleHello(HelloPayload payload, IPayloadContext context) {
        if (!(context.player() instanceof ServerPlayer player)) return;
        UUID uuid = player.getUUID();
        CAPABLE_CLIENTS.add(uuid);
        boolean added = IMPULSE_PLAYERS.add(uuid);
        PacketDistributor.sendToPlayer(player, new RosterPayload(snapshot()));
        if (player.connection.hasChannel(MusicSnapshotPayload.TYPE)) {
            PacketDistributor.sendToPlayer(player, new MusicSnapshotPayload(snapshotMusic()));
        }
        if (player.connection.hasChannel(ArtworkRosterPayload.TYPE)) {
            PacketDistributor.sendToPlayer(player, new ArtworkRosterPayload(snapshotArtwork()));
        }
        if (added) broadcast(new UpdatePayload(uuid, true), uuid);
    }

    private static void handleMusicActivity(MusicActivityPayload payload, IPayloadContext context) {
        if (!(context.player() instanceof ServerPlayer player) || !CAPABLE_CLIENTS.contains(player.getUUID())) return;
        UUID uuid = player.getUUID();
        ImpulseMusicActivity121 next = payload.playing()
            ? ImpulseMusicActivity121.fresh(payload.title(), payload.artist())
            : null;
        if (next == null) MUSIC.remove(uuid);
        else {
            MUSIC.put(uuid, next);
            String artworkId = PLAYER_ARTWORK.get(uuid);
            if (artworkId != null) {
                CachedArtwork cached = ARTWORK.get(artworkId);
                if (cached != null) ARTWORK.put(artworkId, new CachedArtwork(cached.bytes(), System.currentTimeMillis() + ImpulseMusicActivity121.TTL_MS));
            }
        }
        broadcast(new MusicUpdatePayload(uuid, next != null, next == null ? "" : next.title(), next == null ? "" : next.artist()), null);
    }

    private static void handleRoster(RosterPayload payload, IPayloadContext context) {
        invokeClient("acceptRoster", new Class<?>[] { List.class }, new Object[] { payload.uuids() });
    }

    private static void handleUpdate(UpdatePayload payload, IPayloadContext context) {
        invokeClient("acceptUpdate", new Class<?>[] { UUID.class, boolean.class }, new Object[] { payload.uuid(), Boolean.valueOf(payload.present()) });
    }

    private static void handleMusicSnapshot(MusicSnapshotPayload payload, IPayloadContext context) {
        invokeClient("acceptMusicSnapshot", new Class<?>[] { List.class }, new Object[] { payload.entries() });
    }

    private static void handleMusicUpdate(MusicUpdatePayload payload, IPayloadContext context) {
        invokeClient("acceptMusicUpdate", new Class<?>[] { UUID.class, String.class, String.class, boolean.class },
            new Object[] { payload.uuid(), payload.title(), payload.artist(), Boolean.valueOf(payload.playing()) });
    }

    private static void handleArtworkUpload(ArtworkUploadPayload payload, IPayloadContext context) {
        if (!(context.player() instanceof ServerPlayer player) || !CAPABLE_CLIENTS.contains(player.getUUID())) return;
        UUID uuid = player.getUUID();
        if (payload.artworkId().isEmpty()) {
            PLAYER_ARTWORK.remove(uuid);
            broadcast(new ArtworkUpdatePayload(uuid, ""), null);
            return;
        }
        byte[] bytes = payload.bytes();
        if (bytes.length == 0 || bytes.length > ImpulseMusicActivity121.MAX_ARTWORK_BYTES || !ImpulseMusicActivity121.isSupportedArtwork(bytes)) return;
        if (!payload.artworkId().equals(ImpulseMusicActivity121.artworkId(bytes))) return;
        cacheArtwork(payload.artworkId(), bytes);
        PLAYER_ARTWORK.put(uuid, payload.artworkId());
        broadcast(new ArtworkUpdatePayload(uuid, payload.artworkId()), null);
        broadcast(new ArtworkDataPayload(payload.artworkId(), bytes), uuid);
    }

    private static void handleArtworkRequest(ArtworkRequestPayload payload, IPayloadContext context) {
        if (!(context.player() instanceof ServerPlayer player) || !CAPABLE_CLIENTS.contains(player.getUUID())) return;
        CachedArtwork cached = ARTWORK.get(payload.artworkId());
        if (cached != null && cached.expiresAt() > System.currentTimeMillis() && player.connection.hasChannel(ArtworkDataPayload.TYPE)) {
            PacketDistributor.sendToPlayer(player, new ArtworkDataPayload(payload.artworkId(), cached.bytes()));
        }
    }

    private static void handleArtworkRoster(ArtworkRosterPayload payload, IPayloadContext context) {
        invokeClient("acceptArtworkRoster", new Class<?>[] { List.class }, new Object[] { payload.entries() });
    }

    private static void handleArtworkUpdate(ArtworkUpdatePayload payload, IPayloadContext context) {
        invokeClient("acceptArtworkUpdate", new Class<?>[] { UUID.class, String.class }, new Object[] { payload.uuid(), payload.artworkId() });
    }

    private static void handleArtworkData(ArtworkDataPayload payload, IPayloadContext context) {
        invokeClient("acceptArtworkData", new Class<?>[] { String.class, byte[].class }, new Object[] { payload.artworkId(), payload.bytes() });
    }

    public static void playerLoggedOut(PlayerEvent.PlayerLoggedOutEvent event) {
        UUID uuid = event.getEntity().getUUID();
        CAPABLE_CLIENTS.remove(uuid);
        MUSIC.remove(uuid);
        PLAYER_ARTWORK.remove(uuid);
        if (IMPULSE_PLAYERS.remove(uuid)) broadcast(new UpdatePayload(uuid, false), null);
        broadcast(new MusicUpdatePayload(uuid, false, "", ""), null);
        broadcast(new ArtworkUpdatePayload(uuid, ""), null);
    }

    public static void expireMusic() {
        long now = System.currentTimeMillis();
        if (now < nextExpiryCheckAt) return;
        nextExpiryCheckAt = now + 1_000L;
        List<UUID> expired = new ArrayList<UUID>();
        synchronized (MUSIC) {
            for (Map.Entry<UUID, ImpulseMusicActivity121> entry : MUSIC.entrySet()) {
                if (entry.getValue().expiresAt() <= now) expired.add(entry.getKey());
            }
            for (UUID uuid : expired) MUSIC.remove(uuid);
        }
        for (UUID uuid : expired) broadcast(new MusicUpdatePayload(uuid, false, "", ""), null);
        for (UUID uuid : expired) {
            PLAYER_ARTWORK.remove(uuid);
            broadcast(new ArtworkUpdatePayload(uuid, ""), null);
        }
        cleanupArtwork(now);
    }

    public static void clearServerRoster() {
        IMPULSE_PLAYERS.clear();
        CAPABLE_CLIENTS.clear();
        MUSIC.clear();
        PLAYER_ARTWORK.clear();
        ARTWORK.clear();
        nextExpiryCheckAt = 0L;
    }

    private static List<UUID> snapshot() {
        synchronized (IMPULSE_PLAYERS) {
            return List.copyOf(IMPULSE_PLAYERS);
        }
    }

    private static List<PlayerMusic> snapshotMusic() {
        long now = System.currentTimeMillis();
        List<PlayerMusic> result = new ArrayList<PlayerMusic>();
        synchronized (MUSIC) {
            for (Map.Entry<UUID, ImpulseMusicActivity121> entry : MUSIC.entrySet()) {
                if (result.size() >= 200) break;
                ImpulseMusicActivity121 activity = entry.getValue();
                if (activity.expiresAt() > now) result.add(new PlayerMusic(entry.getKey(), activity.title(), activity.artist()));
            }
        }
        return List.copyOf(result);
    }

    private static List<PlayerArtwork> snapshotArtwork() {
        List<PlayerArtwork> result = new ArrayList<PlayerArtwork>();
        synchronized (PLAYER_ARTWORK) {
            for (Map.Entry<UUID, String> entry : PLAYER_ARTWORK.entrySet()) {
                if (result.size() >= 200) break;
                if (MUSIC.containsKey(entry.getKey()) && ARTWORK.containsKey(entry.getValue())) {
                    result.add(new PlayerArtwork(entry.getKey(), entry.getValue()));
                }
            }
        }
        return List.copyOf(result);
    }

    private static void cacheArtwork(String artworkId, byte[] bytes) {
        synchronized (ARTWORK) {
            ARTWORK.put(artworkId, new CachedArtwork(bytes.clone(), System.currentTimeMillis() + ImpulseMusicActivity121.TTL_MS));
            trimArtworkCache();
        }
    }

    private static void cleanupArtwork(long now) {
        synchronized (ARTWORK) {
            ARTWORK.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= now);
            trimArtworkCache();
        }
    }

    private static void trimArtworkCache() {
        int total = 0;
        for (CachedArtwork entry : ARTWORK.values()) total += entry.bytes().length;
        var iterator = ARTWORK.entrySet().iterator();
        while (total > MAX_ARTWORK_CACHE_BYTES && iterator.hasNext()) {
            Map.Entry<String, CachedArtwork> entry = iterator.next();
            total -= entry.getValue().bytes().length;
            iterator.remove();
        }
    }

    private static void broadcast(CustomPacketPayload payload, UUID excluded) {
        net.minecraft.server.MinecraftServer server = net.neoforged.neoforge.server.ServerLifecycleHooks.getCurrentServer();
        if (server == null) return;
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            UUID uuid = player.getUUID();
            if ((excluded == null || !excluded.equals(uuid)) && CAPABLE_CLIENTS.contains(uuid) && player.connection.hasChannel(payload.type())) {
                PacketDistributor.sendToPlayer(player, payload);
            }
        }
    }

    private static void invokeClient(String methodName, Class<?>[] types, Object[] args) {
        try {
            Class<?> type = Class.forName("com.impulse.neoforge121.ImpulseBadgeClient121");
            Method method = type.getMethod(methodName, types);
            method.invoke(null, args);
        } catch (Throwable error) {
            System.err.println("[Impulse] Badge client payload failed: " + error.getMessage());
        }
    }

    private static void writeMusic(RegistryFriendlyByteBuf buffer, boolean playing, String title, String artist) {
        buffer.writeBoolean(playing);
        if (playing) {
            buffer.writeUtf(ImpulseMusicActivity121.sanitize(title), ImpulseMusicActivity121.MAX_FIELD_LENGTH);
            buffer.writeUtf(ImpulseMusicActivity121.sanitize(artist), ImpulseMusicActivity121.MAX_FIELD_LENGTH);
        }
    }

    private static String readMusicField(RegistryFriendlyByteBuf buffer) {
        return ImpulseMusicActivity121.sanitize(buffer.readUtf(ImpulseMusicActivity121.MAX_FIELD_LENGTH));
    }

    private static void writeArtworkId(RegistryFriendlyByteBuf buffer, String artworkId) {
        buffer.writeUtf(ImpulseMusicActivity121.sanitizeArtworkId(artworkId), 64);
    }

    private static String readArtworkId(RegistryFriendlyByteBuf buffer) {
        return ImpulseMusicActivity121.sanitizeArtworkId(buffer.readUtf(64));
    }

    private static void writeArtworkBytes(RegistryFriendlyByteBuf buffer, byte[] bytes) {
        if (bytes.length > ImpulseMusicActivity121.MAX_ARTWORK_BYTES) throw new IllegalArgumentException("Artwork payload is too large.");
        buffer.writeByteArray(bytes);
    }

    private static byte[] readArtworkBytes(RegistryFriendlyByteBuf buffer) {
        return buffer.readByteArray(ImpulseMusicActivity121.MAX_ARTWORK_BYTES);
    }

    public record HelloPayload() implements CustomPacketPayload {
        public static final Type<HelloPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "badge_hello"));
        public static final HelloPayload INSTANCE = new HelloPayload();
        public static final StreamCodec<RegistryFriendlyByteBuf, HelloPayload> STREAM_CODEC = StreamCodec.unit(INSTANCE);

        @Override
        public Type<HelloPayload> type() {
            return TYPE;
        }
    }

    public record RosterPayload(List<UUID> uuids) implements CustomPacketPayload {
        public static final Type<RosterPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "badge_roster"));
        public static final StreamCodec<RegistryFriendlyByteBuf, RosterPayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> {
                buffer.writeVarInt(payload.uuids.size());
                for (UUID uuid : payload.uuids) buffer.writeUUID(uuid);
            },
            buffer -> {
                int count = Math.min(200, Math.max(0, buffer.readVarInt()));
                List<UUID> values = new ArrayList<UUID>(count);
                for (int i = 0; i < count; i++) values.add(buffer.readUUID());
                return new RosterPayload(List.copyOf(values));
            });

        public RosterPayload {
            uuids = List.copyOf(uuids.subList(0, Math.min(uuids.size(), 200)));
        }

        @Override
        public Type<RosterPayload> type() {
            return TYPE;
        }
    }

    public record UpdatePayload(UUID uuid, boolean present) implements CustomPacketPayload {
        public static final Type<UpdatePayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "badge_update"));
        public static final StreamCodec<RegistryFriendlyByteBuf, UpdatePayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> {
                buffer.writeUUID(payload.uuid);
                buffer.writeBoolean(payload.present);
            },
            buffer -> new UpdatePayload(buffer.readUUID(), buffer.readBoolean()));

        @Override
        public Type<UpdatePayload> type() {
            return TYPE;
        }
    }

    public record MusicActivityPayload(boolean playing, String title, String artist) implements CustomPacketPayload {
        public static final Type<MusicActivityPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "music_activity"));
        public static final StreamCodec<RegistryFriendlyByteBuf, MusicActivityPayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> writeMusic(buffer, payload.playing, payload.title, payload.artist),
            buffer -> {
                boolean playing = buffer.readBoolean();
                return playing ? new MusicActivityPayload(true, readMusicField(buffer), readMusicField(buffer)) : stopped();
            });

        public MusicActivityPayload {
            title = playing ? ImpulseMusicActivity121.sanitize(title) : "";
            artist = playing ? ImpulseMusicActivity121.sanitize(artist) : "";
            playing = playing && !title.isEmpty() && !artist.isEmpty();
        }

        public static MusicActivityPayload stopped() {
            return new MusicActivityPayload(false, "", "");
        }

        @Override
        public Type<MusicActivityPayload> type() {
            return TYPE;
        }
    }

    public record PlayerMusic(UUID uuid, String title, String artist) {
        public PlayerMusic {
            title = ImpulseMusicActivity121.sanitize(title);
            artist = ImpulseMusicActivity121.sanitize(artist);
            if (title.isEmpty() || artist.isEmpty()) throw new IllegalArgumentException("Invalid music activity.");
        }
    }

    public record MusicSnapshotPayload(List<PlayerMusic> entries) implements CustomPacketPayload {
        public static final Type<MusicSnapshotPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "music_snapshot"));
        public static final StreamCodec<RegistryFriendlyByteBuf, MusicSnapshotPayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> {
                buffer.writeVarInt(payload.entries.size());
                for (PlayerMusic entry : payload.entries) {
                    buffer.writeUUID(entry.uuid);
                    buffer.writeUtf(entry.title, ImpulseMusicActivity121.MAX_FIELD_LENGTH);
                    buffer.writeUtf(entry.artist, ImpulseMusicActivity121.MAX_FIELD_LENGTH);
                }
            },
            buffer -> {
                int count = Math.min(200, Math.max(0, buffer.readVarInt()));
                List<PlayerMusic> entries = new ArrayList<PlayerMusic>(count);
                for (int i = 0; i < count; i++) entries.add(new PlayerMusic(buffer.readUUID(), readMusicField(buffer), readMusicField(buffer)));
                return new MusicSnapshotPayload(entries);
            });

        public MusicSnapshotPayload {
            entries = List.copyOf(entries.subList(0, Math.min(entries.size(), 200)));
        }

        @Override
        public Type<MusicSnapshotPayload> type() {
            return TYPE;
        }
    }

    public record MusicUpdatePayload(UUID uuid, boolean playing, String title, String artist) implements CustomPacketPayload {
        public static final Type<MusicUpdatePayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "music_update"));
        public static final StreamCodec<RegistryFriendlyByteBuf, MusicUpdatePayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> {
                buffer.writeUUID(payload.uuid);
                writeMusic(buffer, payload.playing, payload.title, payload.artist);
            },
            buffer -> {
                UUID uuid = buffer.readUUID();
                boolean playing = buffer.readBoolean();
                return playing ? new MusicUpdatePayload(uuid, true, readMusicField(buffer), readMusicField(buffer)) : new MusicUpdatePayload(uuid, false, "", "");
            });

        public MusicUpdatePayload {
            title = playing ? ImpulseMusicActivity121.sanitize(title) : "";
            artist = playing ? ImpulseMusicActivity121.sanitize(artist) : "";
            playing = playing && !title.isEmpty() && !artist.isEmpty();
        }

        @Override
        public Type<MusicUpdatePayload> type() {
            return TYPE;
        }
    }

    private record CachedArtwork(byte[] bytes, long expiresAt) {
        private CachedArtwork {
            bytes = bytes.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }

    public record ArtworkUploadPayload(String artworkId, byte[] bytes) implements CustomPacketPayload {
        public static final Type<ArtworkUploadPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "music_artwork_upload"));
        public static final StreamCodec<RegistryFriendlyByteBuf, ArtworkUploadPayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> { writeArtworkId(buffer, payload.artworkId); writeArtworkBytes(buffer, payload.bytes); },
            buffer -> new ArtworkUploadPayload(readArtworkId(buffer), readArtworkBytes(buffer)));

        public ArtworkUploadPayload {
            artworkId = ImpulseMusicActivity121.sanitizeArtworkId(artworkId);
            bytes = bytes == null ? new byte[0] : bytes.clone();
            if (artworkId.isEmpty() != (bytes.length == 0)) throw new IllegalArgumentException("Artwork id and bytes must be provided together.");
            if (bytes.length > ImpulseMusicActivity121.MAX_ARTWORK_BYTES) throw new IllegalArgumentException("Artwork payload is too large.");
        }

        @Override public byte[] bytes() { return bytes.clone(); }
        @Override public Type<ArtworkUploadPayload> type() { return TYPE; }
    }

    public record ArtworkRequestPayload(String artworkId) implements CustomPacketPayload {
        public static final Type<ArtworkRequestPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "music_artwork_request"));
        public static final StreamCodec<RegistryFriendlyByteBuf, ArtworkRequestPayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> writeArtworkId(buffer, payload.artworkId), buffer -> new ArtworkRequestPayload(readArtworkId(buffer)));
        public ArtworkRequestPayload { artworkId = ImpulseMusicActivity121.sanitizeArtworkId(artworkId); }
        @Override public Type<ArtworkRequestPayload> type() { return TYPE; }
    }

    public record PlayerArtwork(UUID uuid, String artworkId) {
        public PlayerArtwork { artworkId = ImpulseMusicActivity121.sanitizeArtworkId(artworkId); }
    }

    public record ArtworkRosterPayload(List<PlayerArtwork> entries) implements CustomPacketPayload {
        public static final Type<ArtworkRosterPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "music_artwork_roster"));
        public static final StreamCodec<RegistryFriendlyByteBuf, ArtworkRosterPayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> {
                buffer.writeVarInt(payload.entries.size());
                for (PlayerArtwork entry : payload.entries) { buffer.writeUUID(entry.uuid); writeArtworkId(buffer, entry.artworkId); }
            },
            buffer -> {
                int count = Math.min(200, Math.max(0, buffer.readVarInt()));
                List<PlayerArtwork> entries = new ArrayList<PlayerArtwork>(count);
                for (int index = 0; index < count; index++) entries.add(new PlayerArtwork(buffer.readUUID(), readArtworkId(buffer)));
                return new ArtworkRosterPayload(entries);
            });
        public ArtworkRosterPayload { entries = List.copyOf(entries.subList(0, Math.min(entries.size(), 200))); }
        @Override public Type<ArtworkRosterPayload> type() { return TYPE; }
    }

    public record ArtworkUpdatePayload(UUID uuid, String artworkId) implements CustomPacketPayload {
        public static final Type<ArtworkUpdatePayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "music_artwork_update"));
        public static final StreamCodec<RegistryFriendlyByteBuf, ArtworkUpdatePayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> { buffer.writeUUID(payload.uuid); writeArtworkId(buffer, payload.artworkId); },
            buffer -> new ArtworkUpdatePayload(buffer.readUUID(), readArtworkId(buffer)));
        public ArtworkUpdatePayload { artworkId = ImpulseMusicActivity121.sanitizeArtworkId(artworkId); }
        @Override public Type<ArtworkUpdatePayload> type() { return TYPE; }
    }

    public record ArtworkDataPayload(String artworkId, byte[] bytes) implements CustomPacketPayload {
        public static final Type<ArtworkDataPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath("impulse", "music_artwork_data"));
        public static final StreamCodec<RegistryFriendlyByteBuf, ArtworkDataPayload> STREAM_CODEC = StreamCodec.of(
            (buffer, payload) -> { writeArtworkId(buffer, payload.artworkId); writeArtworkBytes(buffer, payload.bytes); },
            buffer -> new ArtworkDataPayload(readArtworkId(buffer), readArtworkBytes(buffer)));
        public ArtworkDataPayload {
            artworkId = ImpulseMusicActivity121.sanitizeArtworkId(artworkId);
            bytes = bytes == null ? new byte[0] : bytes.clone();
            if (bytes.length == 0 || bytes.length > ImpulseMusicActivity121.MAX_ARTWORK_BYTES || !ImpulseMusicActivity121.isSupportedArtwork(bytes)
                || !artworkId.equals(ImpulseMusicActivity121.artworkId(bytes))) {
                throw new IllegalArgumentException("Invalid artwork payload.");
            }
        }
        @Override public byte[] bytes() { return bytes.clone(); }
        @Override public Type<ArtworkDataPayload> type() { return TYPE; }
    }
}
