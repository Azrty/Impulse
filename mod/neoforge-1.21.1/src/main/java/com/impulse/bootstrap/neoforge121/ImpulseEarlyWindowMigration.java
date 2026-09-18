package com.impulse.bootstrap.neoforge121;

import net.neoforged.fml.loading.FMLConfig;
import net.neoforged.neoforgespi.earlywindow.GraphicsBootstrapper;

/** Restores NeoForge's loading window for installations that previously selected Impulse's provider. */
public final class ImpulseEarlyWindowMigration implements GraphicsBootstrapper {
    private static final String LEGACY_PROVIDER = "impulseearlywindow";
    private static final String NEOFORGE_PROVIDER = "fmlearlywindow";

    @Override
    public String name() {
        return "impulse-early-window-migration";
    }

    @Override
    public void bootstrap(String[] arguments) {
        String configured = FMLConfig.getConfigValue(FMLConfig.ConfigValue.EARLY_WINDOW_PROVIDER);
        if (LEGACY_PROVIDER.equals(configured)) {
            FMLConfig.updateConfig(FMLConfig.ConfigValue.EARLY_WINDOW_PROVIDER, NEOFORGE_PROVIDER);
        }
    }
}
