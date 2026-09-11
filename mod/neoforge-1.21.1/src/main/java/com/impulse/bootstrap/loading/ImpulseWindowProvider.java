package com.impulse.bootstrap.loading;

import com.impulse.bootstrap.StandaloneLaunchLog;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.function.IntConsumer;
import java.util.function.IntSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import net.neoforged.fml.earlydisplay.DisplayWindow;
import net.neoforged.neoforgespi.earlywindow.ImmediateWindowProvider;

/** Impulse renderer with an immediate, in-process fallback to NeoForge's provider. */
public final class ImpulseWindowProvider implements ImmediateWindowProvider {
    private ImmediateWindowProvider delegate = new ImpulseEarlyWindow();

    @Override public String name() { return "impulseearlywindow"; }

    @Override
    public Runnable initialize(String[] arguments) {
        try {
            return delegate.initialize(arguments);
        } catch (Throwable error) {
            StandaloneLaunchLog.error("loading-window", "Impulse renderer failed; using NeoForge loading window", error);
            delegate = new DisplayWindow();
            return delegate.initialize(arguments);
        }
    }

    @Override public void updateFramebufferSize(IntConsumer width, IntConsumer height) { delegate.updateFramebufferSize(width, height); }
    @Override public long setupMinecraftWindow(IntSupplier width, IntSupplier height, Supplier<String> title, LongSupplier monitor) { return delegate.setupMinecraftWindow(width, height, title, monitor); }
    @Override public boolean positionWindow(Optional<Object> monitor, IntConsumer width, IntConsumer height, IntConsumer x, IntConsumer y) { return delegate.positionWindow(monitor, width, height, x, y); }
    @Override public <T> Supplier<T> loadingOverlay(Supplier<?> minecraft, Supplier<?> reload, Consumer<Optional<Throwable>> finish, boolean fade) { return delegate.loadingOverlay(minecraft, reload, finish, fade); }
    @Override public void updateModuleReads(ModuleLayer layer) { delegate.updateModuleReads(layer); }
    @Override public void periodicTick() { delegate.periodicTick(); }
    @Override public String getGLVersion() { return delegate.getGLVersion(); }
    @Override public void crash(String message) { delegate.crash(message); }
}
