package com.impulse.forge121;

import com.impulse.modern121.ImpulseStandaloneClient121;
import net.minecraftforge.client.ConfigScreenHandler;
import net.minecraftforge.fml.ModLoadingContext;

public final class ImpulseForge121ClientBootstrap {
    private ImpulseForge121ClientBootstrap() {
    }

    public static void register() {
        ModLoadingContext.get().registerExtensionPoint(ConfigScreenHandler.ConfigScreenFactory.class,
            () -> new ConfigScreenHandler.ConfigScreenFactory((minecraft, parent) -> ImpulseStandaloneClient121.configScreen(parent)));
        ImpulseClient121.register();
    }
}
