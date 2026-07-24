package com.impulse.forge17;

import com.impulse.common.ImpulseManifestServer;
import com.impulse.common.ImpulseRuntimeDefaults;
import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.event.FMLServerStartedEvent;
import cpw.mods.fml.common.event.FMLServerStoppingEvent;
import cpw.mods.fml.common.Loader;
import cpw.mods.fml.relauncher.Side;

import java.io.File;
import java.lang.reflect.Method;

@Mod(modid = ImpulseForge17.MODID, name = "Impulse", version = ImpulseForge17.VERSION, acceptableRemoteVersions = "*")
public final class ImpulseForge17 {
    public static final String MODID = "impulse";
    public static final String VERSION = "0.1.0";

    public ImpulseForge17() {
        if (FMLCommonHandler.instance().getSide() == Side.CLIENT) {
            try {
                Class.forName("com.impulse.forge17.ImpulseClient17").getMethod("register").invoke(null);
            } catch (Throwable error) {
                System.err.println("[Impulse] Failed to register client menu: " + error.getMessage());
            }
        }
    }

    @Mod.EventHandler
    public void serverStarted(FMLServerStartedEvent event) {
        if (FMLCommonHandler.instance().getSide() == Side.SERVER) {
            ImpulseManifestServer.start(new File("."), runtimeDefaults(FMLCommonHandler.instance().getMinecraftServerInstance()));
        }
    }

    @Mod.EventHandler
    public void serverStopping(FMLServerStoppingEvent event) {
        if (FMLCommonHandler.instance().getSide() == Side.SERVER) {
            ImpulseManifestServer.stop();
        }
    }

    private static ImpulseRuntimeDefaults runtimeDefaults(Object server) {
        return new ImpulseRuntimeDefaults("1.7.10", forgeVersion(), readString(server, "getServerHostname", "getHostname"), readInt(server, "getServerPort", "getPort"));
    }

    private static String forgeVersion() {
        try {
            return Loader.instance().getIndexedModList().get("Forge").getVersion();
        } catch (Throwable ignored) {
            return "10.13.4.1614";
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
