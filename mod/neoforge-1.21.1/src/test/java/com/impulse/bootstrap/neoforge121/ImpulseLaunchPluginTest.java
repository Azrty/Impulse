package com.impulse.bootstrap.neoforge121;

import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldNode;

import java.util.Collections;
import java.util.Set;

public final class ImpulseLaunchPluginTest {
    public static void main(String[] args) {
        java.nio.file.Path bundled = java.nio.file.Paths.get(System.getProperty("impulse.test.jar"));
        if (!net.neoforged.fml.loading.TransformerDiscovererConstants.shouldLoadInServiceLayer(bundled))
            throw new AssertionError("Impulse JAR is not promoted to the early service layer");
        try (java.util.jar.JarFile archive = new java.util.jar.JarFile(bundled.toFile())) {
            if (archive.getJarEntry("META-INF/services/cpw.mods.modlauncher.serviceapi.ILaunchPluginService") == null)
                throw new AssertionError("early launch plugin service is missing");
        } catch (java.io.IOException error) { throw new AssertionError(error); }
        ImpulseLaunchPlugin plugin = new ImpulseLaunchPlugin();
        ImpulseClassTransformer successful = new ImpulseClassTransformer() {
            public Set<String> targetClasses() { return Collections.singleton("example.Target"); }
            public void transform(String name, ClassNode node) { node.fields.add(new FieldNode(Opcodes.ACC_PUBLIC, "patched", "Z", null, null)); }
        };
        ImpulseClassTransformer failing = new ImpulseClassTransformer() {
            public Set<String> targetClasses() { return Collections.singleton("example.Target"); }
            public void transform(String name, ClassNode node) { node.fields.clear(); throw new IllegalStateException("fixture failure"); }
        };
        ImpulseLaunchPlugin.register(successful);
        ImpulseLaunchPlugin.register(failing);
        ClassNode node = new ClassNode();
        node.visit(Opcodes.V17, Opcodes.ACC_PUBLIC, "example/Target", null, "java/lang/Object", null);
        if (plugin.handlesClass(Type.getObjectType("example/Target"), false).isEmpty()) throw new AssertionError("target was not selected");
        if (!plugin.processClass(cpw.mods.modlauncher.serviceapi.ILaunchPluginService.Phase.BEFORE, node, Type.getObjectType("example/Target"))) throw new AssertionError("transformation did not run");
        if (node.fields.size() != 1 || !"patched".equals(node.fields.get(0).name)) throw new AssertionError("failed transformer mutated the accepted class");
        ImpulseLaunchPlugin.unregister(successful);
        ImpulseLaunchPlugin.unregister(failing);
        try { ImpulseLaunchPlugin.register(successful); throw new AssertionError("late target registration was accepted"); }
        catch (IllegalStateException expected) { /* class has already entered ModLauncher */ }
        ImpulseLaunchPlugin.closePatchLoaders();
    }
}
