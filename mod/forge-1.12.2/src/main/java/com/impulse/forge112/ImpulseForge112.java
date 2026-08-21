package com.impulse.forge112;

import com.impulse.common.ImpulseManifestServer;
import com.impulse.common.ImpulseModUpdater;
import com.impulse.common.ImpulseRuntimeDefaults;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.Loader;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLServerStartedEvent;
import net.minecraftforge.fml.common.event.FMLServerStoppingEvent;
import net.minecraftforge.fml.relauncher.Side;

import java.io.File;
import java.lang.reflect.Method;

@Mod(modid = ImpulseForge112.MODID, name = "Impulse", version = ImpulseForge112.VERSION, acceptableRemoteVersions = "*")
public final class ImpulseForge112 {
    public static final String MODID = "impulse";
    public static final String VERSION = "1.2.0-beta.2";

    public ImpulseForge112() {
        MinecraftForge.EVENT_BUS.register(this);
        ImpulseModUpdater.checkAsync(new File("."), VERSION, "1.12.2", "forge");
        if (FMLCommonHandler.instance().getSide() == Side.CLIENT) {
            try {
                Class.forName("com.impulse.forge112.ImpulseClient112").getMethod("register").invoke(null);
            } catch (Throwable error) {
                System.err.println("[Impulse] Failed to register client menu: " + error.getMessage());
            }
        }
    }

    @Mod.EventHandler
    public void serverStarted(FMLServerStartedEvent event) {
        if (FMLCommonHandler.instance().getSide() == Side.SERVER) {
            ImpulseManifestServer.start(new File("."), runtimeDefaults(FMLCommonHandler.instance().getMinecraftServerInstance()));
            ((net.minecraft.command.ServerCommandManager) FMLCommonHandler.instance().getMinecraftServerInstance().getCommandManager()).registerCommand(new ImpulseCommand112());
        }
    }

    @Mod.EventHandler
    public void serverStopping(FMLServerStoppingEvent event) {
        if (FMLCommonHandler.instance().getSide() == Side.SERVER) {
            ImpulseManifestServer.stop();
        }
    }

    private static ImpulseRuntimeDefaults runtimeDefaults(Object server) {
        return new ImpulseRuntimeDefaults("1.12.2", forgeVersion(), readString(server, "getServerHostname", "getHostname"), readInt(server, "getServerPort", "getPort"));
    }

    private static String forgeVersion() {
        try {
            return Loader.instance().getIndexedModList().get("forge").getVersion();
        } catch (Throwable ignored) {
            return "14.23.5.2860";
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
