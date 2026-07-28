package com.impulse.neoforge121;

import com.impulse.common.ImpulseManifestServer;
import com.impulse.common.ImpulseRuntimeDefaults;
import net.minecraft.SharedConstants;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.ModList;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;

import java.io.File;
import java.lang.reflect.Method;

@Mod("impulse")
public final class ImpulseNeoForge121 {
    public ImpulseNeoForge121(IEventBus modEventBus) {
        NeoForge.EVENT_BUS.register(this);
        if (FMLEnvironment.dist == Dist.CLIENT) {
            try {
                Class.forName("com.impulse.neoforge121.ImpulseClient121").getMethod("register").invoke(null);
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

    private static ImpulseRuntimeDefaults runtimeDefaults(Object server) {
        return new ImpulseRuntimeDefaults(minecraftVersion(), "neoforge", neoForgeVersion(), readString(server, "getServerIp", "getLocalIp"), readInt(server, "getPort", "getServerPort"));
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
