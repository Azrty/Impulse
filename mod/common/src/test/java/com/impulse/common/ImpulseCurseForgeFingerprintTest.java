package com.impulse.common;

import com.impulse.bootstrap.ImpulseStandaloneBootstrap;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public final class ImpulseCurseForgeFingerprintTest {
    public static void main(String[] args) throws Exception {
        assertFingerprint("hello", 2788266382L);
        assertFingerprint("hello world", 2824650221L);
        assertFingerprint("hell o\n\tworld\r", 2824650221L);
    }

    private static void assertFingerprint(String content, long expected) throws Exception {
        File file = File.createTempFile("impulse-curseforge-", ".jar");
        FileOutputStream output = new FileOutputStream(file);
        try { output.write(content.getBytes(StandardCharsets.UTF_8)); } finally { output.close(); }
        try {
            long actual = ImpulseStandaloneBootstrap.curseForgeFingerprint(file);
            if (actual != expected) throw new AssertionError("Expected " + expected + " but got " + actual + " for " + content);
        } finally { file.delete(); }
    }
}
