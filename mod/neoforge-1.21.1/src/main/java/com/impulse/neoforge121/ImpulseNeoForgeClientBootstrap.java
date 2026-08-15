package com.impulse.neoforge121;

import com.impulse.modern121.ImpulseStandaloneClient121;
import net.neoforged.fml.ModContainer;
import net.neoforged.neoforge.client.gui.IConfigScreenFactory;

public final class ImpulseNeoForgeClientBootstrap {
    private ImpulseNeoForgeClientBootstrap() {
    }

    public static void register(ModContainer modContainer) {
        ImpulseStandaloneClient121.setPresenceController(ImpulseBadgeClient121.controller());
        modContainer.registerExtensionPoint(IConfigScreenFactory.class,
            (IConfigScreenFactory) (container, parent) -> ImpulseStandaloneClient121.configScreen(parent));
        ImpulseClient121.register();
    }
}
