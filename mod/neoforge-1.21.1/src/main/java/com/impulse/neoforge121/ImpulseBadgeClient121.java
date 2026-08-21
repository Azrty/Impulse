package com.impulse.neoforge121;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.impulse.modern121.ImpulseStandaloneClient121;
import com.mojang.authlib.minecraft.MinecraftSessionService;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.LightTexture;
import net.minecraft.client.renderer.entity.EntityRenderDispatcher;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.network.ConnectionProtocol;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.EntityAttachment;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.scores.Team;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.client.ClientHooks;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.RenderNameTagEvent;
import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.registration.NetworkRegistry;
import org.joml.Matrix4f;

import java.io.File;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.awt.image.BufferedImage;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.imageio.ImageIO;

public final class ImpulseBadgeClient121 {
    public static final String LEGAL_VERSION = "2026-08-20.2";
    private static final ResourceLocation BADGE_FONT = ResourceLocation.fromNamespaceAndPath("impulse", "player_badge");
    private static final ResourceLocation MUSIC_FONT = ResourceLocation.fromNamespaceAndPath("impulse", "music_presence");
    private static final Gson GSON = new Gson();
    private static final ExecutorService NETWORK = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "Impulse Presence");
        thread.setDaemon(true);
        return thread;
    });
    private static final Set<UUID> VERIFIED = Collections.synchronizedSet(new HashSet<UUID>());
    private static final Map<UUID, ImpulseMusicActivity121> MUSIC = Collections.synchronizedMap(new HashMap<UUID, ImpulseMusicActivity121>());
    private static final Map<String, byte[]> ARTWORK_BYTES = Collections.synchronizedMap(new LinkedHashMap<String, byte[]>(16, 0.75F, true));
    private static final Map<String, ResourceLocation> ARTWORK_TEXTURES = Collections.synchronizedMap(new LinkedHashMap<String, ResourceLocation>(16, 0.75F, true));
    private static final Set<String> ARTWORK_REQUESTED = Collections.synchronizedSet(new HashSet<String>());
    private static final Set<String> ARTWORK_FAILED = Collections.synchronizedSet(new HashSet<String>());
    private static final int MAX_ARTWORK_TEXTURES = 64;
    private static final AtomicBoolean NETWORK_BUSY = new AtomicBoolean(false);

    private static volatile boolean connected;
    private static volatile boolean impulseServer;
    private static volatile boolean impulseMusicServer;
    private static volatile boolean impulseArtworkServer;
    private static volatile String token;
    private static volatile long nextAuthAt;
    private static volatile long nextHeartbeatAt;
    private static volatile long nextQueryAt;
    private static volatile long nextDirectMusicAt;
    private static volatile long apiCacheExpiresAt;
    private static volatile int lastRosterHash;
    private static volatile boolean preferencesLoaded;
    private static volatile boolean enabled = true;
    private static volatile boolean shareMusic = true;
    private static volatile boolean showMusic = true;
    private static volatile boolean musicDirty = true;
    private static volatile String lastSentArtworkId = "";
    private static volatile String lastApiArtworkId = "";
    private static volatile String state = "Disconnected";
    private static volatile String detail = "Join a multiplayer server to start verified presence.";
    private static volatile String lastError = "";
    private static volatile long lastSuccessAt;

    public static ImpulseStandaloneClient121.PresenceController controller() {
        return new ImpulseStandaloneClient121.PresenceController() {
            @Override
            public ImpulseStandaloneClient121.PresenceStatus status() {
                ensurePreferencesLoaded();
                syncDetector();
                ImpulseSpotifyDetector121.Status spotify = ImpulseSpotifyDetector121.status();
                String musicState;
                String musicDetail;
                if (shareMusic && !enabled) {
                    musicState = "Presence disabled";
                    musicDetail = "Turn Player badges on to share Spotify activity.";
                } else if (shareMusic && !centralPresenceAllowed()) {
                    musicState = "Legal acknowledgement required";
                    musicDetail = "Accept the current Privacy Policy and Terms before sharing Spotify activity.";
                } else {
                    musicState = spotify.state();
                    musicDetail = spotify.detail() + " " + spotify.artworkState() + ". Music is currently visible from " + MUSIC.size() + " player(s).";
                }
                return new ImpulseStandaloneClient121.PresenceStatus(enabled, state, detail, apiBaseForDisplay(), VERIFIED.size(), lastSuccessAt, lastError,
                    shareMusic, showMusic, musicState, musicDetail, spotify.currentTrack(), spotify.lastSuccessAt(), spotify.lastError());
            }

            @Override
            public void setEnabled(boolean value) {
                setPresenceEnabled(value);
            }

            @Override
            public void setShareMusic(boolean value) {
                ImpulseBadgeClient121.setShareMusic(value);
            }

            @Override
            public void setShowMusic(boolean value) {
                ImpulseBadgeClient121.setShowMusic(value);
            }

            @Override
            public void retry() {
                retryPresence();
            }
        };
    }

    @SubscribeEvent
    public void onLogin(ClientPlayerNetworkEvent.LoggingIn event) {
        clearSession();
        connected = true;
        ensurePreferencesLoaded();
        syncDetector();
        if (!enabled) {
            state = "Disabled";
            detail = "Player badges are disabled on this Minecraft profile.";
            return;
        }
        impulseServer = NetworkRegistry.hasChannel(event.getConnection(), ConnectionProtocol.PLAY, ImpulseBadgeNetwork121.HelloPayload.TYPE.id());
        impulseMusicServer = NetworkRegistry.hasChannel(event.getConnection(), ConnectionProtocol.PLAY, ImpulseBadgeNetwork121.MusicActivityPayload.TYPE.id());
        impulseArtworkServer = NetworkRegistry.hasChannel(event.getConnection(), ConnectionProtocol.PLAY, ImpulseBadgeNetwork121.ArtworkUploadPayload.TYPE.id());
        if (impulseServer) {
            state = "Connecting through Impulse server";
            detail = impulseMusicServer
                ? "Waiting for the server's verified player roster."
                : "Waiting for the player roster; music will use the presence API.";
            PacketDistributor.sendToServer(ImpulseBadgeNetwork121.HelloPayload.INSTANCE);
        } else if (centralPresenceAllowed()) {
            state = "Connecting to presence API";
            detail = "Verifying your Minecraft identity with Mojang.";
            nextAuthAt = 0L;
        } else {
            state = "Legal acknowledgement required";
            detail = "Accept the current Privacy Policy and Terms to use central presence. Gameplay is unaffected.";
        }
    }

    @SubscribeEvent
    public void onLogout(ClientPlayerNetworkEvent.LoggingOut event) {
        clearSession();
        state = enabled ? "Disconnected" : "Disabled";
        detail = enabled ? "Join a multiplayer server to start verified presence." : "Player badges are disabled on this Minecraft profile.";
    }

    @SubscribeEvent
    public void onClientTick(ClientTickEvent.Post event) {
        ensurePreferencesLoaded();
        syncDetector();
        expireMusic();
        if (!enabled || !connected) return;
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft.getConnection() == null || minecraft.player == null) return;
        long now = System.currentTimeMillis();
        if (impulseMusicServer) {
            publishDirectMusic(now);
            if (impulseArtworkServer) return;
        }
        if (!centralPresenceAllowed()) return;
        if (apiCacheExpiresAt > 0L && now > apiCacheExpiresAt) {
            if (!impulseServer) VERIFIED.clear();
            MUSIC.clear();
        }
        int rosterHash = rosterHash(minecraft);
        if (rosterHash != lastRosterHash) {
            lastRosterHash = rosterHash;
            nextQueryAt = 0L;
        }
        if (NETWORK_BUSY.get()) return;
        if (token == null && now >= nextAuthAt) {
            runAsync(ImpulseBadgeClient121::authenticate);
        } else if (token != null && (now >= nextHeartbeatAt || now >= nextQueryAt || musicDirty)) {
            final boolean heartbeat = now >= nextHeartbeatAt || musicDirty;
            final boolean query = now >= nextQueryAt;
            final List<UUID> roster = query ? currentRoster() : List.of();
            runAsync(() -> updatePresence(heartbeat, query, roster));
        }
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onRenderNameTag(RenderNameTagEvent event) {
        if (!enabled || !(event.getEntity() instanceof Player player) || !isVerified(player.getUUID())) return;
        ImpulseMusicActivity121 music = showMusic ? freshMusic(player.getUUID()) : null;
        if (music != null && shouldShowMusic(event, player)) renderMusicTag(event, player, music);
        MutableComponent badge = Component.literal("\uE000").withStyle(style -> style.withFont(BADGE_FONT).withColor(0xFFFFFF));
        event.setContent(Component.empty().append(badge).append(Component.literal(" ")).append(event.getContent()));
    }

    public static void acceptRoster(List<UUID> uuids) {
        if (!enabled) return;
        VERIFIED.clear();
        VERIFIED.addAll(uuids);
        apiCacheExpiresAt = Long.MAX_VALUE;
        state = "Connected through Impulse server";
        detail = "The server is securely providing its Impulse player roster.";
        lastError = "";
        lastSuccessAt = System.currentTimeMillis();
    }

    public static void acceptUpdate(UUID uuid, boolean present) {
        if (!enabled) return;
        if (present) VERIFIED.add(uuid);
        else {
            VERIFIED.remove(uuid);
            MUSIC.remove(uuid);
        }
        lastSuccessAt = System.currentTimeMillis();
    }

    public static void acceptMusicSnapshot(List<ImpulseBadgeNetwork121.PlayerMusic> entries) {
        MUSIC.clear();
        if (!enabled || !showMusic) return;
        for (ImpulseBadgeNetwork121.PlayerMusic entry : entries) {
            try {
                MUSIC.put(entry.uuid(), ImpulseMusicActivity121.fresh(entry.title(), entry.artist()));
            } catch (IllegalArgumentException ignored) {
            }
        }
    }

    public static void acceptMusicUpdate(UUID uuid, String title, String artist, boolean playing) {
        if (!enabled || !showMusic || !playing) {
            MUSIC.remove(uuid);
            return;
        }
        try {
            MUSIC.put(uuid, ImpulseMusicActivity121.fresh(title, artist));
        } catch (IllegalArgumentException ignored) {
            MUSIC.remove(uuid);
        }
    }

    public static void acceptArtworkRoster(List<ImpulseBadgeNetwork121.PlayerArtwork> entries) {
        if (!enabled || !showMusic) return;
        for (ImpulseBadgeNetwork121.PlayerArtwork entry : entries) acceptArtworkUpdate(entry.uuid(), entry.artworkId());
    }

    public static void acceptArtworkUpdate(UUID uuid, String artworkId) {
        ImpulseMusicActivity121 current = MUSIC.get(uuid);
        if (current == null) return;
        String normalized;
        try {
            normalized = ImpulseMusicActivity121.sanitizeArtworkId(artworkId);
        } catch (IllegalArgumentException ignored) {
            return;
        }
        byte[] bytes = normalized.isEmpty() ? null : ARTWORK_BYTES.get(normalized);
        MUSIC.put(uuid, ImpulseMusicActivity121.fresh(current.title(), current.artist(), normalized, bytes));
        if (!normalized.isEmpty() && bytes == null && impulseArtworkServer && ARTWORK_REQUESTED.add(normalized)) {
            PacketDistributor.sendToServer(new ImpulseBadgeNetwork121.ArtworkRequestPayload(normalized));
        }
    }

    public static void acceptArtworkData(String artworkId, byte[] bytes) {
        try {
            String normalized = ImpulseMusicActivity121.sanitizeArtworkId(artworkId);
            if (!normalized.equals(ImpulseMusicActivity121.artworkId(bytes))) return;
            ARTWORK_BYTES.put(normalized, bytes.clone());
            trimArtworkBytes();
            ARTWORK_REQUESTED.remove(normalized);
            ARTWORK_FAILED.remove(normalized);
            synchronized (MUSIC) {
                for (Map.Entry<UUID, ImpulseMusicActivity121> entry : MUSIC.entrySet()) {
                    ImpulseMusicActivity121 value = entry.getValue();
                    if (normalized.equals(value.artworkId())) {
                        entry.setValue(ImpulseMusicActivity121.fresh(value.title(), value.artist(), normalized, bytes));
                    }
                }
            }
        } catch (IllegalArgumentException ignored) {
        }
    }

    private static void publishDirectMusic(long now) {
        if (!impulseMusicServer || (!musicDirty && now < nextDirectMusicAt)) return;
        boolean changed = musicDirty;
        ImpulseMusicActivity121 current = sharedMusic();
        PacketDistributor.sendToServer(current == null
            ? ImpulseBadgeNetwork121.MusicActivityPayload.stopped()
            : new ImpulseBadgeNetwork121.MusicActivityPayload(true, current.title(), current.artist()));
        if (impulseArtworkServer && (changed || !java.util.Objects.equals(lastSentArtworkId, current == null ? "" : current.artworkId()))) {
            if (current == null || current.artworkId().isEmpty() || current.artwork() == null) {
                PacketDistributor.sendToServer(new ImpulseBadgeNetwork121.ArtworkUploadPayload("", new byte[0]));
                lastSentArtworkId = "";
            } else {
                PacketDistributor.sendToServer(new ImpulseBadgeNetwork121.ArtworkUploadPayload(current.artworkId(), current.artwork()));
                lastSentArtworkId = current.artworkId();
            }
        }
        musicDirty = false;
        nextDirectMusicAt = current == null ? Long.MAX_VALUE : now + 15_000L;
    }

    private static ImpulseMusicActivity121 sharedMusic() {
        return enabled && shareMusic && centralPresenceAllowed() ? ImpulseSpotifyDetector121.currentActivity() : null;
    }

    private static void localMusicChanged(ImpulseMusicActivity121 activity) {
        musicDirty = true;
        nextHeartbeatAt = 0L;
        nextDirectMusicAt = 0L;
    }

    private static ImpulseMusicActivity121 freshMusic(UUID uuid) {
        ImpulseMusicActivity121 value = MUSIC.get(uuid);
        if (value != null && value.isFresh()) return value;
        if (value != null) MUSIC.remove(uuid);
        return null;
    }

    private static void expireMusic() {
        long now = System.currentTimeMillis();
        synchronized (MUSIC) {
            MUSIC.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= now);
        }
    }

    private static boolean isVerified(UUID uuid) {
        return VERIFIED.contains(uuid) && (impulseServer || System.currentTimeMillis() <= apiCacheExpiresAt);
    }

    private static boolean shouldShowMusic(RenderNameTagEvent event, Player player) {
        if (event.canRender().isFalse()) return false;
        if (event.canRender().isTrue()) return true;
        Minecraft minecraft = Minecraft.getInstance();
        LocalPlayer local = minecraft.player;
        if (local == null) return false;
        EntityRenderDispatcher dispatcher = minecraft.getEntityRenderDispatcher();
        float distance = player.isDiscrete() ? 32.0F : 64.0F;
        if (dispatcher.distanceToSqr(player) >= distance * distance) return false;
        boolean visible = !player.isInvisibleTo(local);
        if (player != local) {
            Team team = player.getTeam();
            Team localTeam = local.getTeam();
            if (team != null) {
                return switch (team.getNameTagVisibility()) {
                    case ALWAYS -> visible;
                    case NEVER -> false;
                    case HIDE_FOR_OTHER_TEAMS -> localTeam == null ? visible : team.isAlliedTo(localTeam) && (team.canSeeFriendlyInvisibles() || visible);
                    case HIDE_FOR_OWN_TEAM -> localTeam == null ? visible : !team.isAlliedTo(localTeam) && visible;
                };
            }
        }
        return Minecraft.renderNames() && player != minecraft.getCameraEntity() && visible && !player.isVehicle();
    }

    private static void renderMusicTag(RenderNameTagEvent event, Player player, ImpulseMusicActivity121 music) {
        Minecraft minecraft = Minecraft.getInstance();
        EntityRenderDispatcher dispatcher = minecraft.getEntityRenderDispatcher();
        if (!ClientHooks.isNameplateInRenderDistance(player, dispatcher.distanceToSqr(player))) return;
        Vec3 position = player.getAttachments().getNullable(EntityAttachment.NAME_TAG, 0, player.getViewYRot(event.getPartialTick()));
        if (position == null) return;
        PoseStack poseStack = event.getPoseStack();
        MultiBufferSource buffers = event.getMultiBufferSource();
        boolean seeThrough = !player.isDiscrete();
        poseStack.pushPose();
        poseStack.translate(position.x, position.y + 0.60, position.z);
        poseStack.mulPose(dispatcher.cameraOrientation());
        poseStack.scale(0.018F, -0.018F, 0.018F);
        Matrix4f matrix = poseStack.last().pose();
        Font font = event.getEntityRenderer().getFont();

        int frame = (int)((System.currentTimeMillis() / 200L) % 4L);
        MutableComponent equalizer = Component.literal(String.valueOf((char)('\uE001' + frame)))
            .withStyle(style -> style.withFont(MUSIC_FONT).withColor(0xFFFFFF));
        String title = ellipsize(font, music.title(), 72);
        String artist = ellipsize(font, music.artist(), 61);
        float textWidth = Math.max(font.width(title), font.width(equalizer) + 3.0F + font.width(artist));
        float contentWidth = 16.0F + 4.0F + textWidth;
        float left = -contentWidth / 2.0F;
        float artworkLeft = left;
        float textLeft = left + 20.0F;

        ResourceLocation artworkTexture = textureFor(music);
        if (artworkTexture != null) {
            if (seeThrough) drawTextureQuad(buffers, matrix, artworkTexture, artworkLeft, -18.0F, artworkLeft + 16.0F, -2.0F, true, 32);
            drawTextureQuad(buffers, matrix, artworkTexture, artworkLeft, -18.0F, artworkLeft + 16.0F, -2.0F, false, 255);
        }

        if (artworkTexture == null) {
            drawNameplateText(font, equalizer, artworkLeft + 4.0F, -12.0F, 0xFFFFFFFF, seeThrough, matrix, buffers, event.getPackedLight());
        }

        drawNameplateText(font, Component.literal(title), textLeft, -18.0F, 0xFFFFFFFF, seeThrough, matrix, buffers, event.getPackedLight());
        drawNameplateText(font, equalizer, textLeft, -8.0F, 0xFFC8C8C8, seeThrough, matrix, buffers, event.getPackedLight());
        drawNameplateText(font, Component.literal(artist), textLeft + font.width(equalizer) + 3.0F, -8.0F, 0xFFAFAFAF, seeThrough, matrix, buffers, event.getPackedLight());
        poseStack.popPose();
    }

    private static void drawNameplateText(Font font, Component text, float x, float y, int color, boolean seeThrough,
                                          Matrix4f matrix, MultiBufferSource buffers, int packedLight) {
        if (seeThrough) {
            int faintColor = 0x20000000 | (color & 0x00FFFFFF);
            font.drawInBatch(text, x, y, faintColor, false, matrix, buffers, Font.DisplayMode.SEE_THROUGH, 0, packedLight);
        }
        font.drawInBatch(text, x, y, color, false, matrix, buffers, Font.DisplayMode.NORMAL, 0, packedLight);
    }

    private static String ellipsize(Font font, String value, int maxWidth) {
        if (font.width(value) <= maxWidth) return value;
        String suffix = "\u2026";
        int suffixWidth = font.width(suffix);
        StringBuilder result = new StringBuilder();
        for (int offset = 0; offset < value.length();) {
            int codePoint = value.codePointAt(offset);
            String next = result.toString() + new String(Character.toChars(codePoint));
            if (font.width(next) + suffixWidth > maxWidth) break;
            result.appendCodePoint(codePoint);
            offset += Character.charCount(codePoint);
        }
        return result.append(suffix).toString();
    }

    private static ResourceLocation textureFor(ImpulseMusicActivity121 music) {
        if (music.artworkId().isEmpty()) return null;
        if (ARTWORK_FAILED.contains(music.artworkId())) return null;
        ResourceLocation existing = ARTWORK_TEXTURES.get(music.artworkId());
        if (existing != null) return existing;
        byte[] bytes = music.artwork();
        if (bytes == null) bytes = ARTWORK_BYTES.get(music.artworkId());
        if (bytes == null) return null;
        try {
            BufferedImage buffered = ImageIO.read(new ByteArrayInputStream(bytes));
            if (buffered == null || buffered.getWidth() != 64 || buffered.getHeight() != 64) {
                ARTWORK_FAILED.add(music.artworkId());
                return null;
            }
            NativeImage image = new NativeImage(64, 64, false);
            for (int y = 0; y < 64; y++) {
                for (int x = 0; x < 64; x++) {
                    int argb = buffered.getRGB(x, y);
                    int a = (argb >>> 24) & 255;
                    int r = (argb >>> 16) & 255;
                    int g = (argb >>> 8) & 255;
                    int b = argb & 255;
                    image.setPixelRGBA(x, y, (a << 24) | (b << 16) | (g << 8) | r);
                }
            }
            ResourceLocation location = ResourceLocation.fromNamespaceAndPath("impulse", "dynamic/presence/artwork_" + music.artworkId());
            DynamicTexture texture = new DynamicTexture(image);
            texture.setFilter(true, false);
            Minecraft.getInstance().getTextureManager().register(location, texture);
            ARTWORK_TEXTURES.put(music.artworkId(), location);
            trimArtworkTextures();
            return location;
        } catch (Exception ignored) {
            ARTWORK_FAILED.add(music.artworkId());
            return null;
        }
    }

    private static void trimArtworkTextures() {
        synchronized (ARTWORK_TEXTURES) {
            Iterator<Map.Entry<String, ResourceLocation>> iterator = ARTWORK_TEXTURES.entrySet().iterator();
            while (ARTWORK_TEXTURES.size() > MAX_ARTWORK_TEXTURES && iterator.hasNext()) {
                Map.Entry<String, ResourceLocation> entry = iterator.next();
                iterator.remove();
                Minecraft.getInstance().getTextureManager().release(entry.getValue());
            }
        }
    }

    private static void trimArtworkBytes() {
        synchronized (ARTWORK_BYTES) {
            Iterator<Map.Entry<String, byte[]>> iterator = ARTWORK_BYTES.entrySet().iterator();
            while (ARTWORK_BYTES.size() > MAX_ARTWORK_TEXTURES && iterator.hasNext()) {
                iterator.next();
                iterator.remove();
            }
        }
    }

    private static void drawTextureQuad(MultiBufferSource buffers, Matrix4f matrix, ResourceLocation texture,
                                        float left, float top, float right, float bottom, boolean seeThrough, int alpha) {
        VertexConsumer vertices = buffers.getBuffer(seeThrough ? RenderType.textSeeThrough(texture) : RenderType.entityTranslucentEmissive(texture));
        addTextureVertex(vertices, matrix, left, bottom, 0.0F, 1.0F, alpha, seeThrough);
        addTextureVertex(vertices, matrix, right, bottom, 1.0F, 1.0F, alpha, seeThrough);
        addTextureVertex(vertices, matrix, right, top, 1.0F, 0.0F, alpha, seeThrough);
        addTextureVertex(vertices, matrix, left, top, 0.0F, 0.0F, alpha, seeThrough);
    }

    private static void addTextureVertex(VertexConsumer vertices, Matrix4f matrix, float x, float y, float u, float v,
                                         int alpha, boolean seeThrough) {
        VertexConsumer vertex = vertices.addVertex(matrix, x, y, 0.01F).setColor(255, 255, 255, alpha).setUv(u, v);
        if (seeThrough) {
            vertex.setLight(LightTexture.FULL_BRIGHT);
        } else {
            vertex.setOverlay(OverlayTexture.NO_OVERLAY).setLight(LightTexture.FULL_BRIGHT).setNormal(0.0F, 0.0F, 1.0F);
        }
    }

    private static void runAsync(Runnable task) {
        if (!NETWORK_BUSY.compareAndSet(false, true)) return;
        NETWORK.execute(() -> {
            try {
                task.run();
            } catch (Throwable error) {
                lastError = readableError(error);
                state = "Presence API unavailable";
                detail = "Impulse could not update verified presence. Minecraft and server connections continue normally.";
                System.err.println("[Impulse] Presence service unavailable: " + error.getMessage());
            } finally {
                NETWORK_BUSY.set(false);
            }
        });
    }

    private static void authenticate() {
        long now = System.currentTimeMillis();
        try {
            Minecraft minecraft = Minecraft.getInstance();
            String accessToken = minecraft.getUser().getAccessToken();
            UUID profileId = minecraft.getUser().getProfileId();
            String username = minecraft.getUser().getName();
            if (accessToken == null || accessToken.isBlank() || profileId == null || username == null || username.isBlank()) {
                nextAuthAt = now + 60_000L;
                return;
            }
            JsonObject challenge = post("/v1/auth/challenge", null, null);
            String challengeId = requiredString(challenge, "challenge_id");
            String serverId = requiredString(challenge, "server_id");
            MinecraftSessionService sessionService = minecraft.getMinecraftSessionService();
            sessionService.joinServer(profileId, accessToken, serverId);

            JsonObject verifyBody = new JsonObject();
            verifyBody.addProperty("challenge_id", challengeId);
            verifyBody.addProperty("username", username);
            JsonObject verified = post("/v1/auth/verify", verifyBody, null);
            token = requiredString(verified, "token");
            state = "Identity verified";
            detail = "Waiting for the first presence heartbeat.";
            lastError = "";
            lastSuccessAt = now;
            nextHeartbeatAt = 0L;
            nextQueryAt = 0L;
            nextAuthAt = now + 12L * 60L * 60L * 1000L;
        } catch (Throwable error) {
            token = null;
            nextAuthAt = now + 30_000L;
            throw new RuntimeException(error);
        }
    }

    private static void updatePresence(boolean heartbeat, boolean query, List<UUID> roster) {
        String currentToken = token;
        if (currentToken == null) return;
        long now = System.currentTimeMillis();
        try {
            if (heartbeat) {
                JsonObject body = new JsonObject();
                ImpulseMusicActivity121 current = sharedMusic();
                if (current == null) body.add("music", JsonNull.INSTANCE);
                else {
                    JsonObject music = new JsonObject();
                    music.addProperty("title", current.title());
                    music.addProperty("artist", current.artist());
                    if (!current.artworkId().isEmpty()) {
                        music.addProperty("artwork_id", current.artworkId());
                        if ((musicDirty || !current.artworkId().equals(lastApiArtworkId)) && current.artwork() != null) {
                            music.addProperty("artwork_base64", java.util.Base64.getEncoder().encodeToString(current.artwork()));
                        }
                    }
                    body.add("music", music);
                }
                JsonObject heartbeatResponse = post("/v1/presence/heartbeat", body, currentToken);
                boolean artworkMissing = false;
                if (current == null || current.artworkId().isEmpty()) lastApiArtworkId = "";
                else if (heartbeatResponse.has("artwork_missing") && heartbeatResponse.get("artwork_missing").getAsBoolean()) {
                    lastApiArtworkId = "";
                    artworkMissing = true;
                } else lastApiArtworkId = current.artworkId();
                musicDirty = artworkMissing;
                state = "Connected to presence API";
                detail = "Your Minecraft identity is verified and presence is active.";
                lastError = "";
                lastSuccessAt = now;
                nextHeartbeatAt = now + (current == null ? 45_000L : 15_000L);
            }
            if (query) {
                JsonObject body = new JsonObject();
                JsonArray uuids = new JsonArray();
                for (UUID uuid : roster) uuids.add(compactUuid(uuid));
                body.add("uuids", uuids);
                JsonObject response = post("/v1/presence/query", body, currentToken);
                Set<UUID> active = new HashSet<UUID>();
                if (response.has("active") && response.get("active").isJsonArray()) {
                    for (var value : response.getAsJsonArray("active")) {
                        try {
                            active.add(parseUuid(value.getAsString()));
                        } catch (Exception ignored) {
                        }
                    }
                }
                Map<UUID, ImpulseMusicActivity121> nextMusic = new HashMap<UUID, ImpulseMusicActivity121>();
                if (showMusic && response.has("music") && response.get("music").isJsonArray()) {
                    for (var value : response.getAsJsonArray("music")) {
                        try {
                            JsonObject music = value.getAsJsonObject();
                            UUID uuid = parseUuid(requiredString(music, "uuid"));
                            if (active.contains(uuid)) {
                                String artworkId = music.has("artwork_id") && music.get("artwork_id").isJsonPrimitive()
                                    ? ImpulseMusicActivity121.sanitizeArtworkId(music.get("artwork_id").getAsString()) : "";
                                byte[] artwork = artworkId.isEmpty() ? null : ARTWORK_BYTES.get(artworkId);
                                nextMusic.put(uuid, ImpulseMusicActivity121.fresh(requiredString(music, "title"), requiredString(music, "artist"), artworkId, artwork));
                                if (!artworkId.isEmpty() && artwork == null && ARTWORK_REQUESTED.add(artworkId)) {
                                    try {
                                        byte[] downloaded = getArtwork(artworkId, currentToken);
                                        acceptArtworkData(artworkId, downloaded);
                                    } catch (RuntimeException ignored) {
                                    } finally {
                                        ARTWORK_REQUESTED.remove(artworkId);
                                    }
                                }
                            }
                        } catch (Exception ignored) {
                        }
                    }
                }
                if (!impulseServer) {
                    VERIFIED.clear();
                    VERIFIED.addAll(active);
                }
                if (impulseMusicServer) {
                    for (Map.Entry<UUID, ImpulseMusicActivity121> entry : nextMusic.entrySet()) {
                        ImpulseMusicActivity121 direct = MUSIC.get(entry.getKey());
                        ImpulseMusicActivity121 api = entry.getValue();
                        if (direct != null && direct.title().equals(api.title()) && direct.artist().equals(api.artist())) {
                            MUSIC.put(entry.getKey(), ImpulseMusicActivity121.fresh(direct.title(), direct.artist(), api.artworkId(), api.artwork()));
                        }
                    }
                } else {
                    MUSIC.clear();
                    MUSIC.putAll(nextMusic);
                }
                apiCacheExpiresAt = now + 120_000L;
                state = "Connected to presence API";
                detail = "Your Minecraft identity is verified and presence is active.";
                lastError = "";
                lastSuccessAt = now;
                nextQueryAt = now + 10_000L;
            }
        } catch (HttpStatusException error) {
            if (error.status == 401) {
                token = null;
                nextAuthAt = now + 30_000L;
            }
            nextHeartbeatAt = now + 15_000L;
            nextQueryAt = now + 15_000L;
            throw error;
        }
    }

    private static List<UUID> currentRoster() {
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft.getConnection() == null) return List.of();
        List<UUID> result = new ArrayList<UUID>();
        for (PlayerInfo info : minecraft.getConnection().getOnlinePlayers()) {
            if (result.size() >= 200) break;
            if (info.getProfile().getId() != null) result.add(info.getProfile().getId());
        }
        return result;
    }

    private static int rosterHash(Minecraft minecraft) {
        if (minecraft.getConnection() == null) return 0;
        int hash = 1;
        int count = 0;
        for (PlayerInfo info : minecraft.getConnection().getOnlinePlayers()) {
            if (count++ >= 200) break;
            UUID uuid = info.getProfile().getId();
            if (uuid != null) hash = 31 * hash + uuid.hashCode();
        }
        return hash;
    }

    private static JsonObject post(String path, JsonObject body, String bearerToken) {
        HttpURLConnection connection = null;
        try {
            URI endpoint = URI.create(apiBase() + path);
            connection = (HttpURLConnection) endpoint.toURL().openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(6_000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "Impulse-NeoForge/1.21.1");
            if (bearerToken != null) connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
            JsonObject requestBody = body == null ? new JsonObject() : body;
            byte[] bytes = GSON.toJson(requestBody).getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(bytes.length);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String text = stream == null ? "" : new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            if (stream != null) stream.close();
            if (status < 200 || status >= 300) throw new HttpStatusException(status, text);
            return text.isBlank() ? new JsonObject() : GSON.fromJson(text, JsonObject.class);
        } catch (HttpStatusException error) {
            throw error;
        } catch (Exception error) {
            throw new RuntimeException(error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static byte[] getArtwork(String artworkId, String bearerToken) {
        HttpURLConnection connection = null;
        try {
            URI endpoint = URI.create(apiBase() + "/v1/presence/artwork/" + artworkId);
            connection = (HttpURLConnection) endpoint.toURL().openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(6_000);
            connection.setRequestProperty("Accept", "image/jpeg,image/png");
            connection.setRequestProperty("User-Agent", "Impulse-NeoForge/1.21.1");
            connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
            int status = connection.getResponseCode();
            if (status != 200) throw new HttpStatusException(status, "Artwork unavailable");
            int declared = connection.getContentLength();
            if (declared <= 0 || declared > ImpulseMusicActivity121.MAX_ARTWORK_BYTES) throw new IllegalArgumentException("Invalid artwork size.");
            try (InputStream input = connection.getInputStream()) {
                byte[] bytes = input.readNBytes(ImpulseMusicActivity121.MAX_ARTWORK_BYTES + 1);
                if (bytes.length == 0 || bytes.length > ImpulseMusicActivity121.MAX_ARTWORK_BYTES) throw new IllegalArgumentException("Invalid artwork size.");
                return bytes;
            }
        } catch (HttpStatusException error) {
            throw error;
        } catch (Exception error) {
            throw new RuntimeException(error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String apiBase() {
        String value = System.getProperty("impulse.presence.api", "https://api.impulsemc.com").trim();
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        URI uri = URI.create(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !isLocalDevelopment(uri)) {
            throw new IllegalArgumentException("Impulse presence API must use HTTPS.");
        }
        return value;
    }

    private static String apiBaseForDisplay() {
        try {
            return apiBase();
        } catch (Exception error) {
            return System.getProperty("impulse.presence.api", "https://api.impulsemc.com").trim();
        }
    }

    private static boolean isLocalDevelopment(URI uri) {
        String host = uri.getHost();
        return "http".equalsIgnoreCase(uri.getScheme()) && ("localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host));
    }

    private static boolean centralPresenceAllowed() {
        String launcherAcceptance = System.getProperty("impulse.legal.accepted", "").trim();
        if (LEGAL_VERSION.equals(launcherAcceptance)) return true;
        try {
            File file = new File(Minecraft.getInstance().gameDirectory, "impulse/standalone/legal.json");
            if (!file.isFile()) return false;
            JsonObject value = GSON.fromJson(Files.readString(file.toPath(), StandardCharsets.UTF_8), JsonObject.class);
            return value != null && value.has("version") && LEGAL_VERSION.equals(value.get("version").getAsString());
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String requiredString(JsonObject object, String key) {
        if (object == null || !object.has(key) || !object.get(key).isJsonPrimitive()) throw new IllegalArgumentException("Missing " + key);
        String value = object.get(key).getAsString();
        if (value.isBlank()) throw new IllegalArgumentException("Missing " + key);
        return value;
    }

    private static String compactUuid(UUID uuid) {
        return uuid.toString().replace("-", "");
    }

    private static UUID parseUuid(String value) {
        String compact = value.replace("-", "");
        if (!compact.matches("[0-9a-fA-F]{32}")) throw new IllegalArgumentException("Invalid UUID");
        return UUID.fromString(compact.substring(0, 8) + "-" + compact.substring(8, 12) + "-" + compact.substring(12, 16) + "-" + compact.substring(16, 20) + "-" + compact.substring(20));
    }

    private static void clearSession() {
        connected = false;
        impulseServer = false;
        impulseMusicServer = false;
        impulseArtworkServer = false;
        token = null;
        nextAuthAt = 0L;
        nextHeartbeatAt = 0L;
        nextQueryAt = 0L;
        nextDirectMusicAt = 0L;
        apiCacheExpiresAt = 0L;
        lastRosterHash = 0;
        musicDirty = true;
        lastSentArtworkId = "";
        lastApiArtworkId = "";
        VERIFIED.clear();
        MUSIC.clear();
        ARTWORK_BYTES.clear();
        ARTWORK_REQUESTED.clear();
        ARTWORK_FAILED.clear();
        releaseArtworkTextures();
    }

    private static void setPresenceEnabled(boolean value) {
        ensurePreferencesLoaded();
        enabled = value;
        if (!value) shareMusic = false;
        savePreferences();
        token = null;
        VERIFIED.clear();
        MUSIC.clear();
        apiCacheExpiresAt = 0L;
        lastError = "";
        musicDirty = true;
        syncDetector();
        if (!value) {
            state = "Disabled";
            detail = "Player badges are disabled on this Minecraft profile.";
            return;
        }
        retryPresence();
    }

    private static void setShareMusic(boolean value) {
        ensurePreferencesLoaded();
        if (value) enabled = true;
        shareMusic = value;
        musicDirty = true;
        nextHeartbeatAt = 0L;
        nextDirectMusicAt = 0L;
        savePreferences();
        syncDetector();
    }

    private static void setShowMusic(boolean value) {
        ensurePreferencesLoaded();
        showMusic = value;
        if (!value) MUSIC.clear();
        else nextQueryAt = 0L;
        savePreferences();
    }

    private static void syncDetector() {
        ImpulseSpotifyDetector121.setEnabled(enabled && shareMusic && centralPresenceAllowed(), ImpulseBadgeClient121::localMusicChanged);
    }

    private static void retryPresence() {
        ensurePreferencesLoaded();
        syncDetector();
        if (!enabled) return;
        Minecraft minecraft = Minecraft.getInstance();
        token = null;
        VERIFIED.clear();
        MUSIC.clear();
        apiCacheExpiresAt = 0L;
        lastError = "";
        nextAuthAt = 0L;
        nextHeartbeatAt = 0L;
        nextQueryAt = 0L;
        nextDirectMusicAt = 0L;
        musicDirty = true;
        connected = minecraft.getConnection() != null && minecraft.player != null;
        if (!connected) {
            state = "Disconnected";
            detail = "Join a multiplayer server to start verified presence.";
            return;
        }
        impulseServer = NetworkRegistry.hasChannel(minecraft.getConnection().getConnection(), ConnectionProtocol.PLAY, ImpulseBadgeNetwork121.HelloPayload.TYPE.id());
        impulseMusicServer = NetworkRegistry.hasChannel(minecraft.getConnection().getConnection(), ConnectionProtocol.PLAY, ImpulseBadgeNetwork121.MusicActivityPayload.TYPE.id());
        impulseArtworkServer = NetworkRegistry.hasChannel(minecraft.getConnection().getConnection(), ConnectionProtocol.PLAY, ImpulseBadgeNetwork121.ArtworkUploadPayload.TYPE.id());
        if (impulseServer) {
            state = "Connecting through Impulse server";
            detail = "Waiting for the server's verified player roster.";
            PacketDistributor.sendToServer(ImpulseBadgeNetwork121.HelloPayload.INSTANCE);
        } else if (centralPresenceAllowed()) {
            state = "Connecting to presence API";
            detail = "Verifying your Minecraft identity with Mojang.";
        } else {
            state = "Legal acknowledgement required";
            detail = "Accept the current Privacy Policy and Terms to use central presence. Gameplay is unaffected.";
        }
    }

    private static synchronized void ensurePreferencesLoaded() {
        if (preferencesLoaded) return;
        preferencesLoaded = true;
        boolean preferencesChanged = false;
        try {
            File file = preferencesFile();
            if (file.isFile()) {
                JsonObject value = GSON.fromJson(Files.readString(file.toPath(), StandardCharsets.UTF_8), JsonObject.class);
                if (value != null && value.has("enabled")) enabled = value.get("enabled").getAsBoolean();
                if (value != null && value.has("share_music")) {
                    shareMusic = value.get("share_music").getAsBoolean();
                } else {
                    shareMusic = enabled;
                    preferencesChanged = true;
                }
                if (value != null && value.has("show_music")) showMusic = value.get("show_music").getAsBoolean();
            } else {
                preferencesChanged = true;
            }
        } catch (Exception error) {
            lastError = "Could not read presence settings: " + readableError(error);
        }
        if (shareMusic && !enabled) {
            shareMusic = false;
            preferencesChanged = true;
        }
        if (preferencesChanged) {
            savePreferences();
        }
        if (!enabled) {
            state = "Disabled";
            detail = "Player badges are disabled on this Minecraft profile.";
        }
    }

    private static void savePreferences() {
        try {
            File target = preferencesFile();
            File parent = target.getParentFile();
            if (!parent.exists() && !parent.mkdirs()) throw new java.io.IOException("Could not create the Impulse directory.");
            JsonObject value = new JsonObject();
            value.addProperty("enabled", enabled);
            value.addProperty("share_music", shareMusic);
            value.addProperty("show_music", showMusic);
            value.addProperty("updated_at", java.time.Instant.now().toString());
            File temporary = new File(parent, target.getName() + ".tmp");
            Files.writeString(temporary.toPath(), GSON.toJson(value), StandardCharsets.UTF_8);
            try {
                Files.move(temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception ignored) {
                Files.move(temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception error) {
            lastError = "Could not save presence settings: " + readableError(error);
        }
    }

    private static File preferencesFile() {
        return new File(Minecraft.getInstance().gameDirectory, "impulse/presence.json");
    }

    private static void releaseArtworkTextures() {
        Minecraft minecraft = Minecraft.getInstance();
        Runnable release = () -> {
            synchronized (ARTWORK_TEXTURES) {
                for (ResourceLocation texture : ARTWORK_TEXTURES.values()) minecraft.getTextureManager().release(texture);
                ARTWORK_TEXTURES.clear();
            }
        };
        if (minecraft.isSameThread()) release.run();
        else minecraft.execute(release);
    }

    private static String readableError(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null && current.getCause() != current) current = current.getCause();
        String message = current.getMessage();
        return message == null || message.isBlank() ? current.getClass().getSimpleName() : message;
    }

    private static final class HttpStatusException extends RuntimeException {
        private final int status;

        private HttpStatusException(int status, String body) {
            super("HTTP " + status + (body.isBlank() ? "" : ": " + body));
            this.status = status;
        }
    }
}
