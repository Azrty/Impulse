package com.impulse.forge120;

import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.ServerList;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Standalone profile UI and normal-Minecraft integration. */
public final class ImpulseStandaloneClient {
    private static boolean setupOpened;
    private static boolean serverListUpdated;
    private static boolean autoConnectConsumed;

    private ImpulseStandaloneClient() {
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
        return new ProfilesScreen(parent);
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
                list.add(new ServerData(System.getProperty("impulse.server.name", "Impulse Server"), ip, false), false);
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
        ServerData data = new ServerData(System.getProperty("impulse.server.name", "Impulse Server"), ip, false);
        ConnectScreen.startConnecting(parent, minecraft, ServerAddress.parseString(ip), data, false);
    }

    private static final class ProfilesScreen extends Screen {
        private final Screen parent;
        private String message = "";

        private ProfilesScreen(Screen parent) {
            super(Component.literal("Impulse standalone profiles"));
            this.parent = parent;
        }

        protected void init() {
            ImpulseStandaloneBootstrap.Store store = ImpulseStandaloneBootstrap.loadStore(gameDirectory());
            int y = 54;
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
            this.renderBackground(graphics);
            graphics.drawCenteredString(this.font, this.title, this.width / 2, 22, 0xFFFFFF);
            if (this.message.length() > 0) graphics.drawCenteredString(this.font, this.message, this.width / 2, this.height - 72, 0xDDDDDD);
            super.render(graphics, mouseX, mouseY, partialTick);
        }

        public void onClose() {
            this.minecraft.setScreen(this.parent);
        }
    }

    private static final class SetupScreen extends Screen {
        private final Screen parent;
        private final ImpulseStandaloneBootstrap.Profile existing;
        private final Set<String> selected = new HashSet<String>();
        private EditBox address;
        private ImpulseStandaloneBootstrap.Discovery discovery;
        private String status = "Enter the Minecraft server address to continue.";
        private boolean checking;
        private boolean trusted;
        private int optionalPage;

        private SetupScreen(Screen parent, ImpulseStandaloneBootstrap.Profile existing) {
            super(Component.literal(existing == null ? "Add Impulse server" : "Refresh Impulse server"));
            this.parent = parent;
            this.existing = existing;
        }

        protected void init() {
            int center = this.width / 2;
            this.address = new EditBox(this.font, center - 150, 46, 300, 20, Component.literal("Server address"));
            this.address.setMaxLength(255);
            this.address.setValue(this.existing == null ? "" : this.existing.address);
            this.addRenderableWidget(this.address);
            this.addRenderableWidget(Button.builder(Component.literal(this.checking ? "Checking..." : "Check server"), button -> discover())
                .bounds(center - 150, 72, 148, 20).build()).active = !this.checking;
            this.addRenderableWidget(Button.builder(Component.literal(this.trusted ? "Trusted" : "Trust this server"), button -> {
                this.trusted = !this.trusted;
                rebuildWidgets();
            }).bounds(center + 2, 72, 148, 20).build()).active = this.discovery != null;

            if (this.discovery != null) addOptionalButtons(center);
            Button save = this.addRenderableWidget(Button.builder(Component.literal("Save and quit"), button -> saveAndQuit())
                .bounds(center - 150, this.height - 52, 148, 20).build());
            save.active = this.discovery != null && this.trusted && !this.checking;
            this.addRenderableWidget(Button.builder(Component.literal("Cancel"), button -> this.minecraft.setScreen(this.parent))
                .bounds(center + 2, this.height - 52, 148, 20).build());
        }

        private void addOptionalButtons(int center) {
            List<ImpulseStandaloneBootstrap.ManifestMod> mods = this.discovery.manifest.optional_mods;
            int pageSize = 5;
            int start = Math.min(optionalPage * pageSize, Math.max(0, mods.size() - 1));
            int end = Math.min(mods.size(), start + pageSize);
            int y = 138;
            for (int i = start; i < end; i++) {
                final ImpulseStandaloneBootstrap.ManifestMod mod = mods.get(i);
                final String id = mod.id == null ? "" : mod.id;
                boolean enabled = selected.contains(id);
                this.addRenderableWidget(Button.builder(Component.literal((enabled ? "[x] " : "[ ] ") + mod.name), button -> toggle(mod))
                    .bounds(center - 150, y, 300, 20).build());
                y += 24;
            }
            if (mods.size() > pageSize) {
                this.addRenderableWidget(Button.builder(Component.literal("Previous"), button -> { optionalPage = Math.max(0, optionalPage - 1); rebuildWidgets(); })
                    .bounds(center - 150, 262, 94, 20).build());
                this.addRenderableWidget(Button.builder(Component.literal("Next"), button -> { optionalPage = Math.min((mods.size() - 1) / pageSize, optionalPage + 1); rebuildWidgets(); })
                    .bounds(center + 56, 262, 94, 20).build());
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
                        this.status = "Review the server and optional mods, then confirm trust.";
                        this.checking = false;
                        rebuildWidgets();
                    });
                } catch (final Exception error) {
                    this.minecraft.execute(() -> {
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
            try {
                ImpulseStandaloneBootstrap.saveProfile(gameDirectory(), this.discovery, new ArrayList<String>(this.selected));
                this.minecraft.stop();
            } catch (Exception error) {
                this.status = error.getMessage();
            }
        }

        public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
            this.renderBackground(graphics);
            graphics.drawCenteredString(this.font, this.title, this.width / 2, 20, 0xFFFFFF);
            if (this.discovery != null) {
                String profile = this.discovery.manifest.name + " | Minecraft " + this.discovery.manifest.minecraft.version + " | "
                    + this.discovery.manifest.minecraft.loader + " " + this.discovery.manifest.minecraft.loader_version;
                graphics.drawCenteredString(this.font, profile, this.width / 2, 104, 0xFFFFFF);
                graphics.drawCenteredString(this.font, this.discovery.manifest.mods.size() + " required mods | "
                    + this.discovery.manifest.optional_mods.size() + " optional mods | " + readableBytes(this.discovery.totalRequiredBytes()), this.width / 2, 118, 0xBBBBBB);
            }
            graphics.drawCenteredString(this.font, this.status, this.width / 2, this.height - 70, 0xDDDDDD);
            super.render(graphics, mouseX, mouseY, partialTick);
        }

        public void onClose() {
            this.minecraft.setScreen(this.parent);
        }
    }

    private static String readableBytes(long bytes) {
        if (bytes < 1024L * 1024L) return (bytes / 1024L) + " KB";
        return String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1048576.0D);
    }
}
