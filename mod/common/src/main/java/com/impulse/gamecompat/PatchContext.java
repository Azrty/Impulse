package com.impulse.gamecompat;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** Patch context and ownership of reversible registrations. */
public final class PatchContext {
    private final File gameDirectory;
    private final String profileId;
    private final List<AutoCloseable> registrations = new ArrayList<AutoCloseable>();
    private boolean closed;

    public PatchContext(File gameDirectory, String profileId) {
        this.gameDirectory = gameDirectory;
        this.profileId = profileId;
    }

    public File gameDirectory() { return gameDirectory; }
    public String profileId() { return profileId; }

    /** Transfer ownership of a listener or hook registration to Impulse. */
    public synchronized <T extends AutoCloseable> T registerHook(T registration) {
        if (registration == null) throw new IllegalArgumentException("registration is required");
        if (closed) throw new IllegalStateException("Patch context is closed");
        registrations.add(registration);
        return registration;
    }

    synchronized void closeHooks() throws Exception {
        if (closed) return;
        closed = true;
        Exception failure = null;
        for (int i = registrations.size() - 1; i >= 0; i--) {
            try { registrations.get(i).close(); }
            catch (Exception error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        }
        registrations.clear();
        if (failure != null) throw failure;
    }
}
