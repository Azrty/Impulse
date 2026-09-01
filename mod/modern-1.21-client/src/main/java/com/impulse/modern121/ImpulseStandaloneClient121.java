package com.impulse.modern121;

import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.Renderable;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.ServerList;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Standalone profile UI and normal-Minecraft integration. */
public final class ImpulseStandaloneClient121 {
    private static boolean setupOpened;
    private static boolean serverListUpdated;
    private static boolean autoConnectConsumed;
    private static PresenceController presenceController = PresenceController.NONE;

    private ImpulseStandaloneClient121() {
    }

    public static void tick() {
        if (ImpulseStandaloneBootstrap.isLauncherLaunch()) return;
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft == null || !(minecraft.screen instanceof TitleScreen)) return;
        if (!Boolean.parseBoolean(System.getProperty("impulse.standalone", "false"))) return;
        ensureServerList(minecraft);
        if (!autoConnectConsumed && Boolean.parseBoolean(System.getProperty("impulse.auto_connect", "false"))) {
            autoConnectConsumed = true;
            connect(minecraft.screen);
        }
    }

    public static Screen configScreen(Screen parent) {
        return new ProfilesScreen(parent, true);
    }

    public static void setPresenceController(PresenceController controller) {
        presenceController = controller == null ? PresenceController.NONE : controller;
    }

    public interface PresenceController {
        PresenceController NONE = new PresenceController() {
            public PresenceStatus status() { return new PresenceStatus(false, "Unavailable", "Presence is not supported by this build.", "", 0, 0L, "", false, true, "Unavailable", "", "", 0L, ""); }
            public void setEnabled(boolean enabled) { }
            public void setShareMusic(boolean enabled) { }
            public void setShowMusic(boolean enabled) { }
            public void retry() { }
        };

        PresenceStatus status();
        void setEnabled(boolean enabled);
        void setShareMusic(boolean enabled);
        void setShowMusic(boolean enabled);
        void retry();
    }

    public record PresenceStatus(boolean enabled, String state, String detail, String endpoint, int visiblePlayers, long lastSuccessAt, String lastError,
                                 boolean shareMusic, boolean showMusic, String musicState, String musicDetail, String currentTrack,
                                 long musicLastSuccessAt, String musicLastError) {
    }

    private static File gameDirectory() {
        return Minecraft.getInstance().gameDirectory;
    }

    private static void ensureServerList(Minecraft minecraft) {
        if (serverListUpdated) return;
        serverListUpdated = true;
        String host = System.getProperty("impulse.server.address", "").trim();
        if (host.length() == 0) return;
        String ip = host + ":" + System.getProperty("impulse.server.port", "25565");
        File profileDirectory = standaloneProfileDirectory(minecraft);
        if (profileDirectory == null || (!profileDirectory.isDirectory() && !profileDirectory.mkdirs())) {
            System.err.println("[Impulse] Could not create the standalone profile directory; servers.dat was left unchanged.");
            return;
        }
        File global = new File(minecraft.gameDirectory, "servers.dat");
        File rollback = new File(profileDirectory, "servers.dat.rollback");
        File original = new File(profileDirectory, "servers.dat.original");
        try {
            if (global.isFile()) {
                Files.copy(global.toPath(), rollback.toPath(), StandardCopyOption.REPLACE_EXISTING);
                if (!original.isFile()) Files.copy(global.toPath(), original.toPath());
            }
            ServerList list = new ServerList(minecraft);
            list.load();
            if (list.get(ip) == null) {
                list.add(new ServerData(System.getProperty("impulse.server.name", "Impulse Server"), ip, ServerData.Type.OTHER), false);
                list.save();
            }
            if (global.isFile()) {
                Files.copy(global.toPath(), new File(profileDirectory, "servers.dat").toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            Files.deleteIfExists(rollback.toPath());
        } catch (Exception error) {
            try {
                if (rollback.isFile()) Files.copy(rollback.toPath(), global.toPath(), StandardCopyOption.REPLACE_EXISTING);
                else Files.deleteIfExists(global.toPath());
            } catch (Exception restoreError) {
                System.err.println("[Impulse] Could not restore servers.dat: " + restoreError.getMessage());
            }
            System.err.println("[Impulse] Could not merge the standalone server into servers.dat: " + error.getMessage());
        }
    }

    private static File standaloneProfileDirectory(Minecraft minecraft) {
        String profileId = System.getProperty("impulse.standalone.profile_id", "").trim();
        if (!profileId.matches("[A-Za-z0-9_-]+")) return null;
        return new File(new File(new File(minecraft.gameDirectory, "impulse"), "standalone"), profileId);
    }

    private static void connect(Screen parent) {
        String host = System.getProperty("impulse.server.address", "").trim();
        if (host.length() == 0) return;
        String ip = host + ":" + System.getProperty("impulse.server.port", "25565");
        Minecraft minecraft = Minecraft.getInstance();
        ServerData data = new ServerData(System.getProperty("impulse.server.name", "Impulse Server"), ip, ServerData.Type.OTHER);
        ConnectScreen.startConnecting(parent, minecraft, ServerAddress.parseString(ip), data, false, null);
    }

    private static final class ProfilesScreen extends Screen {
        private final Screen parent;
        private final boolean presenceOnly;
        private String message = "";
        private ConfigTab tab = ConfigTab.PROFILES;

        private ProfilesScreen(Screen parent) {
            this(parent, false);
        }

        private ProfilesScreen(Screen parent, boolean presenceOnly) {
            super(Component.literal(presenceOnly ? "Impulse presence" : "Impulse settings"));
            this.parent = parent;
            this.presenceOnly = presenceOnly;
            if (presenceOnly) this.tab = ConfigTab.PRESENCE;
        }

        protected void init() {
            if (this.presenceOnly) {
                initPresence();
                return;
            }
            int tabWidth = Math.min(120, Math.max(90, (this.width - 28) / 2));
            this.addRenderableWidget(Button.builder(Component.literal("Profiles"), button -> switchTab(ConfigTab.PROFILES))
                .bounds(this.width / 2 - tabWidth - 2, 34, tabWidth, 20).build()).active = this.tab != ConfigTab.PROFILES;
            this.addRenderableWidget(Button.builder(Component.literal("Presence"), button -> switchTab(ConfigTab.PRESENCE))
                .bounds(this.width / 2 + 2, 34, tabWidth, 20).build()).active = this.tab != ConfigTab.PRESENCE;
            if (this.tab == ConfigTab.PRESENCE) {
                initPresence();
                return;
            }
            ImpulseStandaloneBootstrap.Store store = ImpulseStandaloneBootstrap.loadStore(gameDirectory());
            int y = 66;
            for (final ImpulseStandaloneBootstrap.Profile profile : store.profiles) {
                boolean active = profile.id != null && profile.id.equals(store.active_profile_id);
                this.addRenderableWidget(Button.builder(Component.literal((active ? "Active: " : "Use: ") + profile.name), button -> select(profile.id))
                    .bounds(this.width / 2 - 155, y, 200, 20).build());
                this.addRenderableWidget(Button.builder(Component.literal("Refresh"), button -> this.minecraft.setScreen(new SetupScreen(this, profile)))
                    .bounds(this.width / 2 + 49, y, 64, 20).build());
                this.addRenderableWidget(Button.builder(Component.literal("Delete"), button -> delete(profile.id))
                    .bounds(this.width / 2 + 117, y, 64, 20).build());
                y += 24;
                if (y > this.height - 80) break;
            }
            this.addRenderableWidget(Button.builder(Component.literal("Add server"), button -> this.minecraft.setScreen(new SetupScreen(this, null)))
                .bounds(this.width / 2 - 102, this.height - 52, 100, 20).build());
            this.addRenderableWidget(Button.builder(Component.literal("Done"), button -> this.minecraft.setScreen(this.parent))
                .bounds(this.width / 2 + 2, this.height - 52, 100, 20).build());
        }

        private void initPresence() {
            PresenceStatus status = presenceController.status();
            int panelWidth = Math.min(360, Math.max(240, this.width - 32));
            int left = this.width / 2 - panelWidth / 2;
            this.addRenderableWidget(Button.builder(Component.literal(status.enabled() ? "Player badges: On" : "Player badges: Off"), button -> {
                presenceController.setEnabled(!presenceController.status().enabled());
                rebuildWidgets();
            }).bounds(left, 112, panelWidth, 20).build());
            Button showMusic = this.addRenderableWidget(Button.builder(Component.literal(status.showMusic() ? "Show player music: On" : "Show player music: Off"), button -> {
                presenceController.setShowMusic(!presenceController.status().showMusic());
                rebuildWidgets();
            }).bounds(left, 138, panelWidth, 20).build());
            showMusic.active = status.enabled();
            Button shareMusic = this.addRenderableWidget(Button.builder(Component.literal(status.shareMusic() ? "Share Spotify activity: On" : "Share Spotify activity: Off"), button -> {
                presenceController.setShareMusic(!presenceController.status().shareMusic());
                rebuildWidgets();
            }).bounds(left, 164, panelWidth, 20).build());
            shareMusic.active = status.enabled();
            Button retry = this.addRenderableWidget(Button.builder(Component.literal("Retry presence"), button -> {
                presenceController.retry();
                this.message = "Presence retry requested.";
            }).bounds(left, 190, panelWidth, 20).build());
            retry.active = status.enabled();
            this.addRenderableWidget(Button.builder(Component.literal("Done"), button -> this.minecraft.setScreen(this.parent))
                .bounds(this.width / 2 - 50, this.height - 38, 100, 20).build());
        }

        private void switchTab(ConfigTab next) {
            this.tab = next;
            this.message = "";
            rebuildWidgets();
        }

        private void select(String id) {
            try {
                ImpulseStandaloneBootstrap.setActiveProfile(gameDirectory(), id);
                this.message = "Restart required to load this profile.";
                rebuildWidgets();
            } catch (Exception error) {
                this.message = error.getMessage();
            }
        }

        private void delete(String id) {
            try {
                ImpulseStandaloneBootstrap.deleteProfile(gameDirectory(), id);
                this.message = "Profile deleted. Restart required.";
                rebuildWidgets();
            } catch (Exception error) {
                this.message = error.getMessage();
            }
        }

        public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
            graphics.fill(0, 0, this.width, this.height, 0xFF101010);
            graphics.drawCenteredString(this.font, this.title, this.width / 2, 22, 0xFFFFFF);
            if (this.presenceOnly || this.tab == ConfigTab.PRESENCE) renderPresence(graphics);
            if (this.message.length() > 0) graphics.drawCenteredString(this.font, fit(this.message, this.width - 24), this.width / 2, this.height - 62, 0xDDDDDD);
            renderWidgets(this, graphics, mouseX, mouseY, partialTick);
        }

        private void renderPresence(GuiGraphics graphics) {
            PresenceStatus status = presenceController.status();
            int panelWidth = Math.min(392, Math.max(236, this.width - 24));
            int left = this.width / 2 - panelWidth / 2;
            int right = left + panelWidth;
            graphics.fill(left, 64, right, this.height - 48, 0xFF151515);
            graphics.renderOutline(left, 64, panelWidth, this.height - 112, 0xFF393939);
            graphics.drawString(this.font, "Current status", left + 14, 76, 0xFFAAAAAA, false);
            graphics.drawString(this.font, status.state(), left + 14, 90, status.enabled() ? 0xFFFFFFFF : 0xFF999999, false);

            int textWidth = panelWidth - 28;
            List<FormattedCharSequence> details = this.font.split(Component.literal(status.detail()), textWidth);
            int y = 218;
            for (int i = 0; i < Math.min(3, details.size()); i++) {
                graphics.drawString(this.font, details.get(i), left + 14, y + i * 10, 0xFFCCCCCC, false);
            }
            y += Math.min(3, details.size()) * 10 + 10;
            graphics.drawString(this.font, "Badged players visible: " + status.visiblePlayers(), left + 14, y, 0xFFBBBBBB, false);
            y += 16;
            if (!status.endpoint().isBlank()) {
                graphics.drawString(this.font, fit("API: " + status.endpoint(), textWidth), left + 14, y, 0xFF888888, false);
                y += 16;
            }
            if (status.lastSuccessAt() > 0L) {
                String time = java.time.Instant.ofEpochMilli(status.lastSuccessAt()).atZone(java.time.ZoneId.systemDefault()).toLocalTime().withNano(0).toString();
                graphics.drawString(this.font, "Last success: " + time, left + 14, y, 0xFF8FC79D, false);
                y += 16;
            }
            if (!status.lastError().isBlank()) {
                graphics.drawString(this.font, "Last error", left + 14, y, 0xFFFF9292, false);
                y += 12;
                List<FormattedCharSequence> errors = this.font.split(Component.literal(status.lastError()), textWidth);
                for (int i = 0; i < Math.min(3, errors.size()); i++) {
                    graphics.drawString(this.font, errors.get(i), left + 14, y + i * 10, 0xFFFFB4B4, false);
                }
                y += Math.min(3, errors.size()) * 10 + 8;
            }
            if (y < this.height - 86) {
                graphics.drawString(this.font, "Spotify Desktop", left + 14, y, 0xFFAAAAAA, false);
                y += 13;
                graphics.drawString(this.font, status.musicState(), left + 14, y, status.shareMusic() ? 0xFFFFFFFF : 0xFF999999, false);
                y += 13;
                String spotifyLine = status.currentTrack().isBlank() ? status.musicDetail() : status.currentTrack();
                List<FormattedCharSequence> spotifyDetails = this.font.split(Component.literal(spotifyLine), textWidth);
                for (int i = 0; i < Math.min(2, spotifyDetails.size()) && y < this.height - 66; i++) {
                    graphics.drawString(this.font, spotifyDetails.get(i), left + 14, y + i * 10, 0xFFCCCCCC, false);
                }
                y += Math.min(2, spotifyDetails.size()) * 10 + 6;
                if (!status.musicLastError().isBlank() && y < this.height - 60) {
                    graphics.drawString(this.font, fit(status.musicLastError(), textWidth), left + 14, y, 0xFFFF9292, false);
                }
            }
        }

        public void onClose() {
            this.minecraft.setScreen(this.parent);
        }
    }

    private enum ConfigTab {
        PROFILES,
        PRESENCE
    }

    private static final class SetupScreen extends Screen {
        private final Screen parent;
        private final ImpulseStandaloneBootstrap.Profile existing;
        private final Set<String> selected = new HashSet<String>();
        private EditBox address;
        private ImpulseStandaloneBootstrap.Discovery discovery;
        private String status = "Enter the Minecraft server address to continue.";
        private boolean checking;
        private int optionalPage;
        private ImpulseStandaloneBootstrap.RestrictedServerException restriction;

        private SetupScreen(Screen parent, ImpulseStandaloneBootstrap.Profile existing) {
            super(Component.literal(existing == null ? "Add Impulse server" : "Refresh Impulse server"));
            this.parent = parent;
            this.existing = existing;
        }

        protected void init() {
            int center = this.width / 2;
            int panelWidth = Math.min(360, Math.max(220, this.width - 32));
            int left = center - panelWidth / 2;
            if (this.restriction != null) {
                this.addRenderableWidget(Button.builder(Component.literal("Back"), button -> {
                    this.restriction = null;
                    rebuildWidgets();
                }).bounds(center - (this.existing == null ? 60 : 124), this.height - 46, 120, 20).build());
                if (this.existing != null) {
                    this.addRenderableWidget(Button.builder(Component.literal("Remove server"), button -> {
                        try { ImpulseStandaloneBootstrap.deleteProfile(gameDirectory(), this.existing.id); }
                        catch (Exception ignored) { }
                        this.minecraft.setScreen(this.parent);
                    }).bounds(center + 4, this.height - 46, 120, 20).build());
                }
                return;
            }
            this.address = new EditBox(this.font, left, 42, panelWidth, 20, Component.literal("Server address"));
            this.address.setMaxLength(255);
            this.address.setValue(this.existing == null ? "" : this.existing.address);
            this.addRenderableWidget(this.address);
            this.addRenderableWidget(Button.builder(Component.literal(this.checking ? "Checking..." : "Check server"), button -> discover())
                .bounds(left, 68, panelWidth, 20).build()).active = !this.checking;

            if (this.discovery != null) addOptionalButtons(left, panelWidth);
            int gap = 4;
            int actionWidth = (panelWidth - gap) / 2;
            Button save = this.addRenderableWidget(Button.builder(Component.literal("Save and quit"), button -> saveAndQuit())
                .bounds(left, this.height - 30, actionWidth, 20).build());
            save.active = this.discovery != null && !this.checking;
            this.addRenderableWidget(Button.builder(Component.literal("Cancel"), button -> this.minecraft.setScreen(this.parent))
                .bounds(left + actionWidth + gap, this.height - 30, panelWidth - actionWidth - gap, 20).build());
        }

        private void addOptionalButtons(int left, int panelWidth) {
            List<ImpulseStandaloneBootstrap.ManifestMod> mods = this.discovery.manifest.optional_mods;
            int optionalTop = 126;
            int pageSize = Math.max(1, Math.min(5, (this.height - optionalTop - 82) / 24));
            int maxPage = Math.max(0, (mods.size() - 1) / pageSize);
            optionalPage = Math.min(optionalPage, maxPage);
            int start = optionalPage * pageSize;
            int end = Math.min(mods.size(), start + pageSize);
            int y = optionalTop;
            for (int i = start; i < end; i++) {
                final ImpulseStandaloneBootstrap.ManifestMod mod = mods.get(i);
                final String id = mod.id == null ? "" : mod.id;
                boolean enabled = selected.contains(id);
                String label = (enabled ? "[x] " : "[ ] ") + mod.name;
                this.addRenderableWidget(Button.builder(Component.literal(fit(label, panelWidth - 12)), button -> toggle(mod))
                    .bounds(left, y, panelWidth, 20).build());
                y += 24;
            }
            if (mods.size() > pageSize) {
                int navWidth = Math.min(96, (panelWidth - 4) / 2);
                int navY = Math.min(y + 2, this.height - 58);
                this.addRenderableWidget(Button.builder(Component.literal("Previous"), button -> { optionalPage = Math.max(0, optionalPage - 1); rebuildWidgets(); })
                    .bounds(left, navY, navWidth, 20).build());
                this.addRenderableWidget(Button.builder(Component.literal("Next"), button -> { optionalPage = Math.min((mods.size() - 1) / pageSize, optionalPage + 1); rebuildWidgets(); })
                    .bounds(left + panelWidth - navWidth, navY, navWidth, 20).build());
            }
        }

        private void discover() {
            final String value = this.address.getValue().trim();
            if (value.length() == 0 || this.checking) return;
            this.checking = true;
            this.status = "Checking server and manifest...";
            rebuildWidgets();
            Thread worker = new Thread(() -> {
                try {
                    final ImpulseStandaloneBootstrap.Discovery found = ImpulseStandaloneBootstrap.discover(value);
                    this.minecraft.execute(() -> {
                        this.discovery = found;
                        this.selected.clear();
                        if (this.existing != null && this.existing.selected_optional_ids != null) this.selected.addAll(this.existing.selected_optional_ids);
                        else this.selected.addAll(ImpulseStandaloneBootstrap.defaultOptionalIds(found.manifest));
                        this.status = "Choose optional mods, then save the server.";
                        this.checking = false;
                        rebuildWidgets();
                    });
                } catch (final Exception error) {
                    this.minecraft.execute(() -> {
                        if (error instanceof ImpulseStandaloneBootstrap.RestrictedServerException blocked) this.restriction = blocked;
                        this.status = error.getMessage() == null ? "Could not reach this Impulse server." : error.getMessage();
                        this.checking = false;
                        rebuildWidgets();
                    });
                }
            }, "impulse-standalone-discovery");
            worker.setDaemon(true);
            worker.start();
        }

        private void toggle(ImpulseStandaloneBootstrap.ManifestMod mod) {
            String id = mod.id == null ? "" : mod.id;
            if (selected.contains(id)) selected.remove(id); else selected.add(id);
            try {
                List<String> effective = ImpulseStandaloneBootstrap.effectiveOptionalIds(this.discovery.manifest, new ArrayList<String>(selected));
                selected.clear();
                selected.addAll(effective);
                status = "Optional dependencies selected automatically.";
            } catch (Exception error) {
                if (selected.contains(id)) selected.remove(id); else selected.add(id);
                status = error.getMessage();
            }
            rebuildWidgets();
        }

        private void saveAndQuit() {
            if (this.checking) return;
            this.checking = true;
            this.status = "Downloading and verifying server mods...";
            rebuildWidgets();
            final List<String> selections = new ArrayList<String>(this.selected);
            Thread worker = new Thread(() -> {
                try {
                    ImpulseStandaloneBootstrap.Profile saved = ImpulseStandaloneBootstrap.prepareProfileForLaunch(gameDirectory(), this.discovery, selections);
                    List<ImpulseStandaloneBootstrap.ManifestMod> problems = ImpulseStandaloneBootstrap.problematicMods(this.discovery.manifest, selections);
                    String signature = ImpulseStandaloneBootstrap.problematicSignature(problems);
                    this.minecraft.execute(() -> {
                        this.checking = false;
                        if (!problems.isEmpty() && !signature.equals(saved.accepted_unverified_mod_signature)) {
                            this.minecraft.setScreen(new ModVerificationWarningScreen(this, saved, problems, signature));
                        } else this.minecraft.stop();
                    });
                } catch (Exception error) {
                    this.minecraft.execute(() -> {
                        this.status = error.getMessage() == null ? "Could not prepare this server." : error.getMessage();
                        this.checking = false;
                        rebuildWidgets();
                    });
                }
            }, "impulse-standalone-prepare");
            worker.setDaemon(true);
            worker.start();
        }

        public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
            if (this.restriction != null) {
                graphics.fill(0, 0, this.width, this.height, 0xFF050505);
                int center = this.width / 2;
                int top = Math.max(32, this.height / 2 - 78);
                graphics.renderOutline(center - 22, top, 44, 44, 0xFF777777);
                graphics.drawCenteredString(this.font, "LOCKED", center, top + 18, 0xFFFFFFFF);
                graphics.drawCenteredString(this.font, ImpulseStandaloneBootstrap.SERVER_ACCESS_RESTRICTED_HEADING, center, top + 58, 0xFFFFFFFF);
                graphics.drawCenteredString(this.font, this.restriction.title, center, top + 76, 0xFFE2E2E2);
                List<FormattedCharSequence> reason = this.font.split(Component.literal(this.restriction.description), Math.min(460, this.width - 36));
                for (int i = 0; i < Math.min(3, reason.size()); i++) {
                    graphics.drawCenteredString(this.font, reason.get(i), center, top + 94 + i * 10, 0xFFAAAAAA);
                }
                graphics.drawCenteredString(this.font, "Restricted address: " + this.restriction.host, center, top + 132, 0xFF777777);
                renderWidgets(this, graphics, mouseX, mouseY, partialTick);
                return;
            }
            graphics.fill(0, 0, this.width, this.height, 0xFF0D0D0D);
            int panelWidth = Math.min(392, Math.max(236, this.width - 16));
            int panelLeft = this.width / 2 - panelWidth / 2;
            graphics.fill(panelLeft, 8, panelLeft + panelWidth, this.height - 4, 0xFF151515);
            graphics.renderOutline(panelLeft, 8, panelWidth, this.height - 12, 0xFF393939);
            graphics.drawCenteredString(this.font, this.title, this.width / 2, 18, 0xFFFFFF);
            if (this.discovery != null) {
                String profile = this.discovery.manifest.name + " | Minecraft " + this.discovery.manifest.minecraft.version + " | "
                    + this.discovery.manifest.minecraft.loader + " " + this.discovery.manifest.minecraft.loader_version;
                graphics.drawCenteredString(this.font, fit(profile, panelWidth - 24), this.width / 2, 96, 0xFFFFFF);
                String summary = this.discovery.manifest.mods.size() + " required | "
                    + this.discovery.manifest.optional_mods.size() + " optional | " + readableBytes(this.discovery.totalRequiredBytes());
                graphics.drawCenteredString(this.font, fit(summary, panelWidth - 24), this.width / 2, 108, 0xBBBBBB);
            }
            List<FormattedCharSequence> lines = this.font.split(Component.literal(this.status), panelWidth - 28);
            int statusY = this.height - 52 - Math.min(2, lines.size()) * 10;
            for (int i = 0; i < Math.min(2, lines.size()); i++) {
                graphics.drawCenteredString(this.font, lines.get(i), this.width / 2, statusY + i * 10, 0xDDDDDD);
            }
            renderWidgets(this, graphics, mouseX, mouseY, partialTick);
        }

        public void onClose() {
            this.minecraft.setScreen(this.parent);
        }
    }

    private static final class ModVerificationWarningScreen extends Screen {
        private final Screen parent;
        private final ImpulseStandaloneBootstrap.Profile profile;
        private final List<ImpulseStandaloneBootstrap.ManifestMod> mods;
        private final String signature;
        private final long readyAt = System.currentTimeMillis() + 5000L;
        private Button continueButton;

        private ModVerificationWarningScreen(Screen parent, ImpulseStandaloneBootstrap.Profile profile, List<ImpulseStandaloneBootstrap.ManifestMod> mods, String signature) {
            super(Component.literal("Some server mods could not be independently verified"));
            this.parent = parent; this.profile = profile; this.mods = mods; this.signature = signature;
        }

        protected void init() {
            int width = Math.min(420, this.width - 32);
            this.addRenderableWidget(Button.builder(Component.literal("Copy SHA-512 list"), button -> {
                StringBuilder value = new StringBuilder();
                for (ImpulseStandaloneBootstrap.ManifestMod mod : mods) value.append(mod.name).append(" | ").append(mod.file_name).append(" | ").append(mod.sha512).append('\n');
                this.minecraft.keyboardHandler.setClipboard(value.toString());
            }).bounds(this.width / 2 - 70, this.height - 62, 140, 20).build());
            this.addRenderableWidget(Button.builder(Component.literal("Cancel"), button -> this.minecraft.setScreen(this.parent)).bounds(this.width / 2 - 134, this.height - 36, 128, 20).build());
            this.continueButton = this.addRenderableWidget(Button.builder(Component.literal("Continue anyway (5)"), button -> {
                try { ImpulseStandaloneBootstrap.acceptUnverifiedMods(gameDirectory(), profile.id, signature); this.minecraft.stop(); }
                catch (Exception error) { this.minecraft.setScreen(this.parent); }
            }).bounds(this.width / 2 + 6, this.height - 36, 128, 20).build());
            this.continueButton.active = false;
        }

        public void tick() {
            int seconds = Math.max(0, (int) Math.ceil((readyAt - System.currentTimeMillis()) / 1000.0));
            this.continueButton.active = seconds == 0;
            this.continueButton.setMessage(Component.literal(seconds > 0 ? "Continue anyway (" + seconds + ")" : "Continue anyway"));
        }

        public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
            graphics.fill(0, 0, this.width, this.height, 0xFF0B0B0B);
            int panelWidth = Math.min(540, this.width - 24);
            graphics.drawCenteredString(this.font, this.title, this.width / 2, 18, 0xFFFFFF);
            String body = "Impulse confirmed that these files match the SHA-512 hashes declared by the server, but some could not be matched to a compatible Modrinth or CurseForge release, or the Impulse recognized-mod registry. Minecraft mods can run code on your computer. Continue only if you trust this server or have reviewed these files yourself.";
            List<FormattedCharSequence> lines = this.font.split(Component.literal(body), panelWidth);
            int y = 40;
            for (FormattedCharSequence line : lines) { graphics.drawCenteredString(this.font, line, this.width / 2, y, 0xBBBBBB); y += 10; }
            y += 8;
            for (int i = 0; i < Math.min(mods.size(), Math.max(1, (this.height - y - 52) / 48)); i++) {
                ImpulseStandaloneBootstrap.ManifestMod mod = mods.get(i);
                graphics.drawString(this.font, fit(mod.name, panelWidth), this.width / 2 - panelWidth / 2, y, 0xFFFFFF, false);
                graphics.drawString(this.font, fit((mod.verification == null ? "Verification unavailable" : mod.verification.status) + " | " + mod.file_name, panelWidth), this.width / 2 - panelWidth / 2, y + 11, 0xD8A95D, false);
                String hash = mod.sha512 == null ? "" : mod.sha512;
                String firstHalf = hash.substring(0, Math.min(64, hash.length()));
                String secondHalf = hash.length() > 64 ? hash.substring(64) : "";
                graphics.drawString(this.font, fit("SHA-512 " + firstHalf, panelWidth), this.width / 2 - panelWidth / 2, y + 22, 0x888888, false);
                if (!secondHalf.isEmpty()) graphics.drawString(this.font, fit(secondHalf, panelWidth), this.width / 2 - panelWidth / 2, y + 33, 0x888888, false);
                y += 48;
            }
            super.render(graphics, mouseX, mouseY, partialTick);
        }
    }

    private static String readableBytes(long bytes) {
        if (bytes < 1024L * 1024L) return (bytes / 1024L) + " KB";
        return String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1048576.0D);
    }

    private static void renderWidgets(Screen screen, GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        for (Renderable renderable : screen.renderables) {
            renderable.render(graphics, mouseX, mouseY, partialTick);
        }
    }

    private static String fit(String value, int width) {
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft.font.width(value) <= width) return value;
        return minecraft.font.plainSubstrByWidth(value, Math.max(8, width - minecraft.font.width("..."))) + "...";
    }
}
