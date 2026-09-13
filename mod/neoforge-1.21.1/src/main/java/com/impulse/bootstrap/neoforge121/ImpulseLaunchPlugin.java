package com.impulse.bootstrap.neoforge121;

import cpw.mods.modlauncher.serviceapi.ILaunchPluginService;
import com.impulse.bootstrap.StandaloneLaunchLog;
import org.objectweb.asm.Type;
import org.objectweb.asm.tree.ClassNode;
import com.impulse.gamecompat.PatchClassLoader;

import java.io.File;
import java.io.IOException;
import java.net.URLClassLoader;
import java.util.ServiceLoader;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Registered before mod discovery; providers are installed after profile selection. */
public final class ImpulseLaunchPlugin implements ILaunchPluginService {
    private static final Map<String, List<ImpulseClassTransformer>> TARGETS = new HashMap<>();
    private static final Set<String> SEEN = new java.util.HashSet<>();
    private static final List<URLClassLoader> LOADERS = new ArrayList<>();
    private static final Map<ImpulseClassTransformer, Runnable> FAILURE_HANDLERS = new java.util.concurrent.ConcurrentHashMap<>();
    private static boolean shutdownHookRegistered;

    @Override public String name() { return "impulse_game_compat"; }

    @Override public EnumSet<Phase> handlesClass(Type type, boolean isEmpty) {
        synchronized (TARGETS) {
            String name = type.getClassName();
            SEEN.add(name);
            return TARGETS.containsKey(name) ? EnumSet.of(Phase.BEFORE) : EnumSet.noneOf(Phase.class);
        }
    }

    @Override public boolean processClass(Phase phase, ClassNode node, Type type) {
        List<ImpulseClassTransformer> providers;
        synchronized (TARGETS) { providers = new ArrayList<>(TARGETS.getOrDefault(type.getClassName(), Collections.emptyList())); }
        if (phase != Phase.BEFORE || providers.isEmpty()) return false;
        boolean changed = false;
        for (ImpulseClassTransformer provider : providers) {
            try {
                ClassNode candidate = new ClassNode();
                node.accept(candidate);
                provider.transform(type.getClassName(), candidate);
                for (java.lang.reflect.Field field : ClassNode.class.getFields()) {
                    if (!java.lang.reflect.Modifier.isStatic(field.getModifiers())) field.set(node, field.get(candidate));
                }
                changed = true;
            } catch (Throwable error) {
                StandaloneLaunchLog.error("game-compat", "Startup transformation failed for " + type.getClassName(), error);
                unregister(provider);
                Runnable handler = FAILURE_HANDLERS.remove(provider);
                if (handler != null) handler.run();
            }
        }
        return changed;
    }

    public static void register(ImpulseClassTransformer provider) {
        Set<String> names = provider.targetClasses();
        if (names == null || names.isEmpty()) throw new IllegalArgumentException("A startup transformer must declare target classes.");
        synchronized (TARGETS) {
            for (String name : names) {
                if (name == null || !name.matches("[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)+")) throw new IllegalArgumentException("Invalid transformation target: " + name);
                if (SEEN.contains(name)) throw new IllegalStateException("Transformation target has already been loaded: " + name);
            }
            for (String name : names) TARGETS.computeIfAbsent(name, ignored -> new ArrayList<>()).add(provider);
        }
    }

    public static void unregister(ImpulseClassTransformer provider) {
        synchronized (TARGETS) { TARGETS.values().forEach(list -> list.remove(provider)); TARGETS.values().removeIf(List::isEmpty); }
    }

    /** Returns true when the JAR contains a startup transformer service. */
    public static boolean installFromJar(File jar, Set<String> approvedTargets, Runnable onFailure) throws IOException {
        PatchClassLoader loader = new PatchClassLoader(jar.toURI().toURL(), ImpulseClassTransformer.class.getClassLoader(), Thread.currentThread().getContextClassLoader());
        List<ImpulseClassTransformer> registered = new ArrayList<>();
        try {
            ServiceLoader<ImpulseClassTransformer> services = ServiceLoader.load(ImpulseClassTransformer.class, loader);
            for (ImpulseClassTransformer service : services) {
                if (approvedTargets == null || approvedTargets.isEmpty() || !approvedTargets.equals(service.targetClasses()))
                    throw new IOException("Transformer targets do not match the signed catalog.");
                register(service);
                FAILURE_HANDLERS.put(service, onFailure);
                registered.add(service);
            }
            if (registered.isEmpty()) { loader.close(); return false; }
            LOADERS.add(loader);
            if (!shutdownHookRegistered) {
                Runtime.getRuntime().addShutdownHook(new Thread(ImpulseLaunchPlugin::closePatchLoaders, "impulse-compat-transformer-shutdown"));
                shutdownHookRegistered = true;
            }
            return true;
        } catch (Throwable error) {
            for (ImpulseClassTransformer service : registered) { unregister(service); FAILURE_HANDLERS.remove(service); }
            loader.close();
            throw new IOException("Could not register startup transformations from " + jar.getName(), error);
        }
    }

    public static void closePatchLoaders() {
        for (URLClassLoader loader : LOADERS) try { loader.close(); } catch (IOException ignored) { }
        LOADERS.clear();
        synchronized (TARGETS) { TARGETS.clear(); SEEN.clear(); FAILURE_HANDLERS.clear(); }
    }
}
