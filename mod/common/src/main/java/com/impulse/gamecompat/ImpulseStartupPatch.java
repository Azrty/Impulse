package com.impulse.gamecompat;

/** Entry point for compatibility patches that must initialize before NeoForge discovers mods. */
public interface ImpulseStartupPatch {
    void initialize(PatchContext context) throws Exception;
}
