package com.impulse.forge120;

import com.impulse.common.ImpulseManifestServer;
import com.impulse.common.ImpulseModUpdater;
import com.impulse.common.ImpulseRuntimeDefaults;
import net.minecraft.SharedConstants;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import net.minecraftforge.event.RegisterCommandsEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.ModList;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;

import java.io.File;
import java.lang.reflect.Method;

@Mod("impulse")
public final class ImpulseForge120 {
    public ImpulseForge120() {
        MinecraftForge.EVENT_BUS.register(this);
        ImpulseModUpdater.checkAsync(new File("."), impulseVersion(), "1.20.1", "forge");
        if (FMLEnvironment.dist == Dist.CLIENT) {
            try {
                Class.forName("com.impulse.forge120.ImpulseForge120ClientBootstrap").getMethod("register").invoke(null);
            } catch (Throwable error) {
                System.err.println("[Impulse] Failed to register client menu: " + error.getMessage());
            }
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
        if (FMLEnvironment.dist == Dist.DEDICATED_SERVER) {
            ImpulseManifestServer.stop();
        }
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
        return new ImpulseRuntimeDefaults(minecraftVersion(), "forge", forgeVersion(), readString(server, "getServerIp", "getLocalIp"), readInt(server, "getPort", "getServerPort"), impulseVersion());
    }

    private static String minecraftVersion() {
        try {
            return SharedConstants.getCurrentVersion().getName();
        } catch (Throwable ignored) {
            return "1.20.1";
        }
    }

    private static String forgeVersion() {
        try {
            return ModList.get().getModContainerById("forge").get().getModInfo().getVersion().toString();
        } catch (Throwable ignored) {
            return "47.2.0";
        }
    }

    private static String impulseVersion() {
        try {
            return ModList.get().getModContainerById("impulse").get().getModInfo().getVersion().toString();
        } catch (Throwable ignored) {
            return "1.1.0-beta.5";
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
