package com.impulse.gamecompat;

import java.net.URL;
import java.net.URLClassLoader;

/** Patch-owned classes with fallback visibility into NeoForge's game loader. */
public final class PatchClassLoader extends URLClassLoader {
    private final ClassLoader gameLoader;

    public PatchClassLoader(URL jar, ClassLoader apiLoader, ClassLoader gameLoader) {
        super(new URL[] { jar }, apiLoader);
        this.gameLoader = gameLoader;
    }

    @Override protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
        try { return super.loadClass(name, resolve); }
        catch (ClassNotFoundException missing) {
            if (gameLoader == null || gameLoader == getParent()) throw missing;
            return gameLoader.loadClass(name);
        }
    }
}
