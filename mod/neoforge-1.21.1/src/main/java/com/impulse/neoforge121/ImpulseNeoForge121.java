package com.impulse.neoforge121;

import com.impulse.common.ImpulseManifestServer;
import com.impulse.common.ImpulseModUpdater;
import com.impulse.common.ImpulseRuntimeDefaults;
import com.impulse.bootstrap.StandaloneLaunchLog;
import net.minecraft.SharedConstants;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.ModList;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

import java.io.File;
import java.lang.reflect.Method;

@Mod("impulse")
public final class ImpulseNeoForge121 {
    public ImpulseNeoForge121(IEventBus modEventBus, ModContainer modContainer) {
        StandaloneLaunchLog.attachFromSystemProperties(gameDirectory());
        StandaloneLaunchLog.info("runtime", "Impulse NeoForge mod initialized", null);
        modEventBus.addListener(ImpulseBadgeNetwork121::registerPayloads);
        NeoForge.EVENT_BUS.register(this);
        ImpulseModUpdater.checkAsync(gameDirectory(), modContainer.getModInfo().getVersion().toString(), "1.21.1", "neoforge");
        if (FMLEnvironment.dist == Dist.CLIENT) {
            try {
                Class.forName("com.impulse.neoforge121.ImpulseNeoForgeClientBootstrap")
                    .getMethod("register", ModContainer.class)
                    .invoke(null, modContainer);
            } catch (Throwable error) {
                System.err.println("[Impulse] Failed to register client menu: " + error.getMessage());
            }
        }
    }

    private static File gameDirectory() {
        try {
            return FMLPaths.GAMEDIR.get().toFile();
        } catch (Throwable ignored) {
            return new File(".");
        }
    }

    @SubscribeEvent
    public void serverStarted(ServerStartedEvent event) {
        if (FMLEnvironment.dist == Dist.DEDICATED_SERVER) {
            ImpulseManifestServer.start(new File("."), runtimeDefaults(event.getServer()), resolveImpulseJar());
        }
    }

    @SubscribeEvent
    public void serverStopping(ServerStoppingEvent event) {
        ImpulseBadgeNetwork121.clearServerRoster();
        if (FMLEnvironment.dist == Dist.DEDICATED_SERVER) {
            ImpulseManifestServer.stop();
        }
    }

    @SubscribeEvent
    public void playerLoggedOut(PlayerEvent.PlayerLoggedOutEvent event) {
        ImpulseBadgeNetwork121.playerLoggedOut(event);
    }

    @SubscribeEvent
    public void serverTick(ServerTickEvent.Post event) {
        ImpulseBadgeNetwork121.expireMusic();
    }

    @SubscribeEvent
    public void registerCommands(RegisterCommandsEvent event) {
        event.getDispatcher().register(Commands.literal("impulse")
            .requires(source -> source.hasPermission(3))
            .then(Commands.literal("reload").executes(context -> reply(context.getSource(), ImpulseManifestServer.reload())))
            .then(Commands.literal("maintenance")
                .then(Commands.literal("off").executes(context -> reply(context.getSource(), ImpulseManifestServer.setMaintenance(false, null))))
                .then(Commands.literal("on")
                    .executes(context -> reply(context.getSource(), ImpulseManifestServer.setMaintenance(true, null)))
                    .then(Commands.argument("message", StringArgumentType.greedyString()).executes(context -> reply(context.getSource(), ImpulseManifestServer.setMaintenance(true, StringArgumentType.getString(context, "message"))))))));
    }

    private static int reply(net.minecraft.commands.CommandSourceStack source, ImpulseManifestServer.ReloadResult result) {
        if (result.success) source.sendSuccess(() -> Component.literal(result.message), true);
        else source.sendFailure(Component.literal(result.message));
        return result.success ? 1 : 0;
    }

    private static ImpulseRuntimeDefaults runtimeDefaults(Object server) {
        return new ImpulseRuntimeDefaults(minecraftVersion(), "neoforge", neoForgeVersion(), readString(server, "getServerIp", "getLocalIp"), readInt(server, "getPort", "getServerPort"), impulseVersion());
    }

    private static String minecraftVersion() {
        try {
            return SharedConstants.getCurrentVersion().getName();
        } catch (Throwable ignored) {
            return "1.21.1";
        }
    }

    private static String neoForgeVersion() {
        try {
            return ModList.get().getModContainerById("neoforge").get().getModInfo().getVersion().toString();
        } catch (Throwable ignored) {
            return "21.1.243";
        }
    }

    private static String impulseVersion() {
        try {
            return ModList.get().getModContainerById("impulse").get().getModInfo().getVersion().toString();
        } catch (Throwable ignored) {
            return "1.3.1";
        }
    }

    private static File resolveImpulseJar() {
        try {
            Object modFile = invokeWithArgs(ModList.get(), "getModFileById", new Class[] { String.class }, new Object[] { "impulse" });
            if (modFile instanceof java.util.Optional) modFile = ((java.util.Optional<?>) modFile).orElse(null);
            if (modFile == null) return null;

            Object file = invoke(modFile, "getFile");
            if (file == null) file = modFile;
            if (file instanceof java.nio.file.Path) return pathToFile((java.nio.file.Path) file);

            Object path = invoke(file, "getFilePath");
            File resolved = path instanceof java.nio.file.Path ? pathToFile((java.nio.file.Path) path) : null;
            if (resolved != null) return resolved;

            path = invoke(file, "getPath");
            resolved = path instanceof java.nio.file.Path ? pathToFile((java.nio.file.Path) path) : null;
            if (resolved != null) return resolved;

            Object secureJar = invoke(file, "getSecureJar");
            path = invoke(secureJar, "getPrimaryPath");
            resolved = path instanceof java.nio.file.Path ? pathToFile((java.nio.file.Path) path) : null;
            if (resolved != null) return resolved;
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static File pathToFile(java.nio.file.Path path) {
        try {
            if (path != null && "file".equalsIgnoreCase(path.toUri().getScheme())) return path.toFile();
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static String readString(Object target, String first, String second) {
        Object value = invoke(target, first);
        if (value == null) value = invoke(target, second);
        String out = value == null ? "" : String.valueOf(value).trim();
        return out.length() == 0 ? "localhost" : out;
    }

    private static Integer readInt(Object target, String first, String second) {
        Object value = invoke(target, first);
        if (value == null) value = invoke(target, second);
        if (value instanceof Number) return Integer.valueOf(((Number) value).intValue());
        try {
            return Integer.valueOf(String.valueOf(value));
        } catch (Exception ignored) {
            return Integer.valueOf(25565);
        }
    }

    private static Object invoke(Object target, String methodName) {
        if (target == null) return null;
        try {
            Method method = target.getClass().getMethod(methodName);
            return method.invoke(target);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static Object invokeWithArgs(Object target, String methodName, Class[] types, Object[] args) {
        if (target == null) return null;
        try {
            Method method = target.getClass().getMethod(methodName, types);
            return method.invoke(target, args);
        } catch (Throwable ignored) {
            return null;
        }
    }
}
