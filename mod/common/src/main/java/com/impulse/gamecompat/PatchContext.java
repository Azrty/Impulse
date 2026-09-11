package com.impulse.gamecompat;

import java.io.File;

/** Deliberately small context; interception hooks can be added without exposing Minecraft internals. */
public final class PatchContext {
    private final File gameDirectory;
    private final String profileId;

    public PatchContext(File gameDirectory, String profileId) {
        this.gameDirectory = gameDirectory;
        this.profileId = profileId;
    }

    public File gameDirectory() { return gameDirectory; }
    public String profileId() { return profileId; }
}
