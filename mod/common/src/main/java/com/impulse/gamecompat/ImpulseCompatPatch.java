package com.impulse.gamecompat;

/** Runtime contract for reversible Impulse compatibility patches. */
public interface ImpulseCompatPatch {
    void enable(PatchContext context) throws Exception;
    void disable() throws Exception;
}
