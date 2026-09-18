package com.impulse.modern121;

import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.ServerList;
import net.minecraft.client.multiplayer.resolver.ServerAddress;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** Keeps standalone server-list isolation and auto-connect without an in-game settings screen. */
public final class ImpulseStandaloneClient121 {
    private static boolean serverListUpdated;
    private static boolean autoConnectConsumed;

    private ImpulseStandaloneClient121() { }

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

    private static void ensureServerList(Minecraft minecraft) {
        if (serverListUpdated) return;
        serverListUpdated = true;
        String host = System.getProperty("impulse.server.address", "").trim();
        if (host.isEmpty()) return;
        String address = host + ":" + System.getProperty("impulse.server.port", "25565");
        File profileDirectory = standaloneProfileDirectory(minecraft);
        if (profileDirectory == null || (!profileDirectory.isDirectory() && !profileDirectory.mkdirs())) return;
        File global = new File(minecraft.gameDirectory, "servers.dat");
        File rollback = new File(profileDirectory, "servers.dat.rollback");
        try {
            if (global.isFile()) Files.copy(global.toPath(), rollback.toPath(), StandardCopyOption.REPLACE_EXISTING);
            ServerList list = new ServerList(minecraft);
            list.load();
            if (list.get(address) == null) {
                list.add(new ServerData(System.getProperty("impulse.server.name", "Impulse Server"), address, ServerData.Type.OTHER), false);
                list.save();
            }
            if (global.isFile()) Files.copy(global.toPath(), new File(profileDirectory, "servers.dat").toPath(), StandardCopyOption.REPLACE_EXISTING);
            Files.deleteIfExists(rollback.toPath());
        } catch (Exception error) {
            try {
                if (rollback.isFile()) Files.copy(rollback.toPath(), global.toPath(), StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception ignored) { }
        }
    }

    private static File standaloneProfileDirectory(Minecraft minecraft) {
        String profileId = System.getProperty("impulse.standalone.profile_id", "").trim();
        if (!profileId.matches("[A-Za-z0-9_-]+")) return null;
        return new File(new File(new File(minecraft.gameDirectory, "impulse"), "standalone"), profileId);
    }

    private static void connect(Screen parent) {
        String host = System.getProperty("impulse.server.address", "").trim();
        if (host.isEmpty()) return;
        String address = host + ":" + System.getProperty("impulse.server.port", "25565");
        Minecraft minecraft = Minecraft.getInstance();
        ServerData data = new ServerData(System.getProperty("impulse.server.name", "Impulse Server"), address, ServerData.Type.OTHER);
        ConnectScreen.startConnecting(parent, minecraft, ServerAddress.parseString(address), data, false, null);
    }
}
