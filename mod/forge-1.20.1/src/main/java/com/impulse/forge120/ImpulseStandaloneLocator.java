package com.impulse.forge120;

import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.loading.FMLLoader;
import net.minecraftforge.fml.loading.moddiscovery.AbstractJarFileModLocator;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/** Loads the isolated Impulse profile before Forge completes mod discovery. */
public final class ImpulseStandaloneLocator extends AbstractJarFileModLocator {
    @Override
    public Stream<Path> scanCandidates() {
        try {
            File gameDirectory = FMLLoader.getGamePath().toFile();
            List<Path> candidates = new ArrayList<Path>();
            candidates.add(ImpulseStandaloneBootstrap.prepareRuntimeMod(gameDirectory, getClass()).toPath());

            if (FMLLoader.getDist() != Dist.CLIENT || ImpulseStandaloneBootstrap.isLauncherLaunch()) {
                return candidates.stream();
            }

            ImpulseStandaloneBootstrap.BootstrapResult result = ImpulseStandaloneBootstrap.bootstrap(
                gameDirectory,
                FMLLoader.versionInfo().mcVersion(),
                "forge",
                FMLLoader.versionInfo().forgeVersion()
            );
            if (result.active && result.managedModsDirectory != null) {
                Stream<Path> managed = Files.list(result.managedModsDirectory.toPath());
                try {
                    managed.filter(Files::isRegularFile)
                        .filter(path -> path.getFileName().toString().toLowerCase().endsWith(".jar"))
                        .forEach(candidates::add);
                } finally {
                    managed.close();
                }
            }
            return candidates.stream();
        } catch (IOException error) {
            throw new RuntimeException("Impulse could not read its standalone mod directory.", error);
        } catch (Exception error) {
            throw new RuntimeException("Impulse standalone sync failed: " + error.getMessage(), error);
        }
    }

    @Override
    public String name() {
        return "impulse-standalone";
    }

    @Override
    public void initArguments(Map<String, ?> arguments) {
    }
}
