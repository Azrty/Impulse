package com.impulse.bootstrap.loading;

import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import com.impulse.bootstrap.StandaloneLaunchLog;
import net.neoforged.fml.loading.FMLConfig;
import net.neoforged.neoforgespi.earlywindow.GraphicsBootstrapper;

/** Selects the Impulse early window only for standalone client launches. */
public final class ImpulseGraphicsBootstrapper implements GraphicsBootstrapper {
    @Override
    public String name() {
        return "impulse";
    }

    @Override
    public void bootstrap(String[] arguments) {
        try {
            // FMLEnvironment caches DIST before FML assigns it at this stage.
            // Inspect only the launch arguments; never initialize that class here.
            if (!isClientLaunch(arguments)) return;
            if (ImpulseStandaloneBootstrap.isLauncherLaunch()) {
                FMLConfig.updateConfig(FMLConfig.ConfigValue.EARLY_WINDOW_PROVIDER, "fmlearlywindow");
                return;
            }
            FMLConfig.updateConfig(FMLConfig.ConfigValue.EARLY_WINDOW_PROVIDER, "impulseearlywindow");
            StandaloneLaunchLog.info("loading-window", "Selected Impulse standalone loading experience", null);
        } catch (Throwable error) {
            StandaloneLaunchLog.error("loading-window", "Could not select Impulse loading experience", error);
        }
    }

    static boolean isClientLaunch(String[] arguments) {
        for (int i = 0; i < arguments.length; i++) {
            String target = null;
            if (arguments[i].equals("--launchTarget") && i + 1 < arguments.length) {
                target = arguments[++i];
            } else if (arguments[i].startsWith("--launchTarget=")) {
                target = arguments[i].substring("--launchTarget=".length());
            }
            if (target != null) {
                return target.equals("forgeclient") || target.equals("forgeclientdev")
                        || target.equals("forgeclientuserdev");
            }
        }
        return false;
    }
}
