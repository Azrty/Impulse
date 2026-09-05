package com.impulse.bootstrap.neoforge121;

import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import com.impulse.bootstrap.StandaloneLaunchLog;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.ModLoadingIssue;
import net.neoforged.fml.loading.FMLLoader;
import net.neoforged.fml.loading.progress.ProgressMeter;
import net.neoforged.fml.loading.progress.StartupNotificationManager;
import net.neoforged.neoforgespi.ILaunchContext;
import net.neoforged.neoforgespi.locating.IDiscoveryPipeline;
import net.neoforged.neoforgespi.locating.IModFileCandidateLocator;
import net.neoforged.neoforgespi.locating.IncompatibleFileReporting;
import net.neoforged.neoforgespi.locating.ModFileDiscoveryAttributes;

import java.io.File;

/** Loads the isolated Impulse profile before NeoForge completes mod discovery. */
public final class ImpulseStandaloneLocator implements IModFileCandidateLocator {
    @Override
    public int getPriority() {
        // Run before NeoForge's default mods-folder locator so UI changes to /mods
        // affect the same launch and incompatible jars can be skipped safely.
        return 2000;
    }

    @Override
    public void findCandidates(ILaunchContext launchContext, IDiscoveryPipeline pipeline) {
        try {
            File gameDirectory = FMLLoader.getGamePath().toFile();
            StandaloneLaunchLog.start(gameDirectory, ImpulseStandaloneBootstrap.currentImpulseVersion(),
                FMLLoader.versionInfo().mcVersion(), "neoforge", FMLLoader.versionInfo().neoForgeVersion());
            StandaloneLaunchLog.info("discovery", "Impulse candidate locator started", null);
            ImpulseStandaloneBootstrap.setProgressReporter(new NeoForgeProgressReporter());
            File runtimeMod = ImpulseStandaloneBootstrap.prepareRuntimeMod(gameDirectory, getClass());
            StandaloneLaunchLog.info("discovery", "Adding embedded Impulse runtime", StandaloneLaunchLog.fields("file", runtimeMod.getName()));
            pipeline.addPath(runtimeMod.toPath(), ModFileDiscoveryAttributes.DEFAULT, IncompatibleFileReporting.ERROR);

            if (FMLLoader.getDist() != Dist.CLIENT || ImpulseStandaloneBootstrap.isLauncherLaunch()) return;

            ImpulseStandaloneBootstrap.UiOutcome uiOutcome = ImpulseStandaloneBootstrap.configureWithNativeUi(
                gameDirectory,
                FMLLoader.versionInfo().mcVersion(),
                "neoforge",
                FMLLoader.versionInfo().neoForgeVersion()
            );
            if (uiOutcome == ImpulseStandaloneBootstrap.UiOutcome.QUIT) {
                System.exit(0);
                return;
            }
            if (uiOutcome != ImpulseStandaloneBootstrap.UiOutcome.SELECTED) return;

            ImpulseStandaloneBootstrap.BootstrapResult result = ImpulseStandaloneBootstrap.bootstrap(
                gameDirectory,
                FMLLoader.versionInfo().mcVersion(),
                "neoforge",
                FMLLoader.versionInfo().neoForgeVersion()
            );
            if (result.active && result.managedModsDirectory != null) {
                ImpulseStandaloneBootstrap.setProgressReporter(new NeoForgeProgressReporter());
                StartupNotificationManager.locatorConsumer().ifPresent(consumer -> consumer.accept("Impulse: loading managed mods"));
                IModFileCandidateLocator.forFolder(result.managedModsDirectory, "").findCandidates(launchContext, pipeline);
                if (!result.customModFiles.isEmpty()) {
                    StartupNotificationManager.locatorConsumer().ifPresent(consumer -> consumer.accept(
                        "Impulse: loading " + result.customModFiles.size() + " custom mod(s)"));
                    for (File customMod : result.customModFiles) {
                        StandaloneLaunchLog.info("discovery", "Adding custom mod candidate", StandaloneLaunchLog.fields("file", customMod.getName()));
                        pipeline.addPath(customMod.toPath(), ModFileDiscoveryAttributes.DEFAULT, IncompatibleFileReporting.ERROR);
                    }
                }
                StandaloneLaunchLog.markGameReached();
            }
        } catch (Exception error) {
            StandaloneLaunchLog.error("discovery", "Standalone synchronization failed", error);
            pipeline.addIssue(ModLoadingIssue.error("Impulse standalone sync failed: " + error.getMessage()).withCause(error));
        }
    }

    @Override
    public String toString() {
        return "impulse-standalone";
    }

    private static final class NeoForgeProgressReporter implements ImpulseStandaloneBootstrap.ProgressReporter {
        private ProgressMeter meter;

        public synchronized void message(String text) {
            StandaloneLaunchLog.info("progress", text, null);
            StartupNotificationManager.locatorConsumer().ifPresent(consumer -> consumer.accept(text));
            if (meter != null) meter.label(text);
        }

        public synchronized void begin(String text, int steps) {
            end();
            meter = StartupNotificationManager.prependProgressBar(text, Math.max(1, steps));
            message(text);
        }

        public synchronized void progress(String text, int current, int total) {
            StandaloneLaunchLog.info("progress", text, StandaloneLaunchLog.fields("current", current, "total", total));
            if (meter == null) meter = StartupNotificationManager.prependProgressBar(text, Math.max(1, total));
            meter.label(text);
            meter.setAbsolute(Math.max(0, Math.min(current, meter.steps())));
            StartupNotificationManager.locatorConsumer().ifPresent(consumer -> consumer.accept(text));
        }

        public synchronized void end() {
            if (meter == null) return;
            meter.complete();
            StartupNotificationManager.popBar(meter);
            meter = null;
        }
    }
}
