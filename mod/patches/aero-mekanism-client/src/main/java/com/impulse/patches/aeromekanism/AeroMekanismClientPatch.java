package com.impulse.patches.aeromekanism;

import com.impulse.bootstrap.neoforge121.ImpulseClassTransformer;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.Set;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.tree.ClassNode;

public final class AeroMekanismClientPatch implements ImpulseClassTransformer {
    private static final String TRACKING = "com.jarrettonesource.createmekanismcompat.client.CmcClientSableTracking";

    @Override
    public Set<String> targetClasses() {
        // Minecraft itself is loaded before standalone profile selection on many
        // clients. Targeting it causes the launch plugin to reject the entire
        // patch, including the teleporter movement fix below.
        return Set.of(TRACKING);
    }

    @Override
    public void transform(String className, ClassNode node) throws Exception {
        if (!className.replace('.', '/').equals(node.name)) throw new IllegalArgumentException("Unexpected class: " + node.name);
        if (!TRACKING.equals(className)) throw new IllegalArgumentException("Class is not a patch target: " + className);
        replaceClientClass(node, "CmcClientSableTracking.class", "applyTeleportState");
    }

    private static void replaceClientClass(ClassNode node, String templateName, String originalMethod) throws Exception {
        if (node.methods.stream().noneMatch(method -> originalMethod.equals(method.name)))
            throw new IllegalStateException("Original compat class has an unexpected shape: " + node.name);
        ClassNode template = readTemplate(templateName);
        if (!node.name.equals(template.name)) throw new IllegalStateException("Template class name does not match target.");
        for (Field field : ClassNode.class.getFields()) {
            if (!Modifier.isStatic(field.getModifiers())) field.set(node, field.get(template));
        }
    }

    private static ClassNode readTemplate(String name) throws IOException {
        try (InputStream input = AeroMekanismClientPatch.class.getResourceAsStream("/templates/" + name)) {
            if (input == null) throw new IOException("Missing client template: " + name);
            ClassNode node = new ClassNode();
            new ClassReader(input).accept(node, 0);
            return node;
        }
    }
}
