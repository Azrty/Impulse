package com.impulse.gamecompat;

public final class ImpulseGameCompatTest {
    public static void main(String[] args) {
        require(ImpulseGameCompat.matchesVersion("2.4.1", ">=2.0.0 <3.0.0"), "compound range");
        require(!ImpulseGameCompat.matchesVersion("3.0.0", ">=2.0.0 <3.0.0"), "exclusive upper bound");
        require(ImpulseGameCompat.matchesVersion("1.5.0", "[1.0.0,2.0.0)"), "Maven range");
        require(ImpulseGameCompat.compareVersions("1.10.0", "1.9.9") > 0, "numeric ordering");
        require(ImpulseGameCompat.compareVersions("1.0.0", "1.0.0") == 0, "equal versions");
        System.out.println("ImpulseGameCompatTest passed");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError("Game Compat failed: " + message);
    }
}
