package com.impulse.patches.aeromekanism;

import java.util.Set;
import java.io.InputStream;
import java.util.jar.JarFile;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.util.CheckClassAdapter;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.MethodNode;

public final class AeroMekanismClientPatchTest {
    public static void main(String[] args) throws Exception {
        AeroMekanismClientPatch patch = new AeroMekanismClientPatch();
        Set<String> targets = patch.targetClasses();
        require(targets.size() == 1 && !targets.contains("net.minecraft.client.Minecraft")
            && targets.stream().noneMatch(name -> name.toLowerCase().contains("miner")), "client-only target list");

        ClassNode tracking = fixture("com/jarrettonesource/createmekanismcompat/client/CmcClientSableTracking");
        tracking.methods.add(new MethodNode(Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC, "applyTeleportState", "()V", null, null));
        patch.transform(tracking.name.replace('/', '.'), tracking);
        require(tracking.methods.stream().anyMatch(method -> "retryPending".equals(method.name)), "teleporter retry method");
        require(tracking.fields.stream().anyMatch(field -> "pending".equals(field.name)), "pending teleport state");

        verifyOriginalJar(patch, System.getProperty("patch.test.originalCompatJar"),
            "com/jarrettonesource/createmekanismcompat/client/CmcClientSableTracking.class");
        System.out.println("AeroMekanismClientPatchTest passed");
    }

    private static void verifyOriginalJar(AeroMekanismClientPatch patch, String path, String... entries) throws Exception {
        if (path == null || path.isBlank()) return;
        try (JarFile jar = new JarFile(path)) {
            for (String entry : entries) {
                require(jar.getJarEntry(entry) != null, "missing real target " + entry);
                ClassNode node = new ClassNode();
                try (InputStream input = jar.getInputStream(jar.getJarEntry(entry))) {
                    new ClassReader(input).accept(node, 0);
                }
                patch.transform(node.name.replace('/', '.'), node);
                ClassWriter output = new ClassWriter(ClassWriter.COMPUTE_MAXS);
                node.accept(new CheckClassAdapter(output));
                require(output.toByteArray().length > 0, "invalid transformed class " + entry);
            }
        }
    }

    private static ClassNode fixture(String name) {
        ClassNode node = new ClassNode();
        node.visit(Opcodes.V17, Opcodes.ACC_PUBLIC, name, null, "java/lang/Object", null);
        return node;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
