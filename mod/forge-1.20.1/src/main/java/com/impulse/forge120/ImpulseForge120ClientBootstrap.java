package com.impulse.forge120;

import net.minecraftforge.client.ConfigScreenHandler;
import net.minecraftforge.fml.ModLoadingContext;

public final class ImpulseForge120ClientBootstrap {
    private ImpulseForge120ClientBootstrap() {
    }

    public static void register() {
        ModLoadingContext.get().registerExtensionPoint(ConfigScreenHandler.ConfigScreenFactory.class,
            () -> new ConfigScreenHandler.ConfigScreenFactory((minecraft, parent) -> ImpulseStandaloneClient.configScreen(parent)));
        ImpulseClient120.register();
    }
}
