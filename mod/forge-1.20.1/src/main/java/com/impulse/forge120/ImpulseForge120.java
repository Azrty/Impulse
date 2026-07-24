package com.impulse.forge120;

import com.impulse.common.ImpulseManifestServer;
import com.impulse.common.ImpulseRuntimeDefaults;
import net.minecraft.SharedConstants;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
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
        if (FMLEnvironment.dist == Dist.CLIENT) {
            try {
                Class.forName("com.impulse.forge120.ImpulseClient120").getMethod("register").invoke(null);
            } catch (Throwable error) {
                System.err.println("[Impulse] Failed to register client menu: " + error.getMessage());
            }
        }
    }

    @SubscribeEvent
    public void serverStarted(ServerStartedEvent event) {
        if (FMLEnvironment.dist == Dist.DEDICATED_SERVER) {
            ImpulseManifestServer.start(new File("."), runtimeDefaults(event.getServer()));
        }
    }

    @SubscribeEvent
    public void serverStopping(ServerStoppingEvent event) {
        if (FMLEnvironment.dist == Dist.DEDICATED_SERVER) {
            ImpulseManifestServer.stop();
        }
    }

    private static ImpulseRuntimeDefaults runtimeDefaults(Object server) {
        return new ImpulseRuntimeDefaults(minecraftVersion(), forgeVersion(), readString(server, "getServerIp", "getLocalIp"), readInt(server, "getPort", "getServerPort"));
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
}
