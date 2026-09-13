package com.impulse.patches.aeromekanism;

import com.impulse.bootstrap.neoforge121.ImpulseClassTransformer;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.Set;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.InsnNode;
import org.objectweb.asm.tree.JumpInsnNode;
import org.objectweb.asm.tree.LabelNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.TryCatchBlockNode;
import org.objectweb.asm.tree.VarInsnNode;

public final class AeroMekanismClientPatch implements ImpulseClassTransformer {
    private static final String TRACKING = "com.jarrettonesource.createmekanismcompat.client.CmcClientSableTracking";
    private static final String SUBLEVEL = "com.jarrettonesource.createmekanismcompat.client.CmcClientSubLevelHelper";
    private static final String MINECRAFT = "net.minecraft.client.Minecraft";
    private static final String STABILIZER = "mekanism.client.gui.GuiDimensionalStabilizer";
    private static final String TILE = "mekanism/common/tile/machine/TileEntityDimensionalStabilizer";
    private static final String BLOCK_POS = "()Lnet/minecraft/core/BlockPos;";

    @Override
    public Set<String> targetClasses() {
        return Set.of(TRACKING, SUBLEVEL, MINECRAFT, STABILIZER);
    }

    @Override
    public void transform(String className, ClassNode node) throws Exception {
        if (!className.replace('.', '/').equals(node.name)) throw new IllegalArgumentException("Unexpected class: " + node.name);
        switch (className) {
            case TRACKING -> replaceClientClass(node, "CmcClientSableTracking.class", "applyTeleportState");
            case SUBLEVEL -> replaceClientClass(node, "CmcClientSubLevelHelper.class", "resolve");
            case MINECRAFT -> addTeleportRetry(node);
            case STABILIZER -> fixMountedStabilizerPosition(node);
            default -> throw new IllegalArgumentException("Class is not a patch target: " + className);
        }
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

    private static void addTeleportRetry(ClassNode node) {
        MethodNode tick = node.methods.stream()
            .filter(method -> "tick".equals(method.name) && "()V".equals(method.desc))
            .findFirst().orElseThrow(() -> new IllegalStateException("Minecraft.tick() is unavailable."));
        LabelNode start = new LabelNode();
        LabelNode end = new LabelNode();
        LabelNode failed = new LabelNode();
        LabelNode continueTick = new LabelNode();
        InsnList retry = new InsnList();
        retry.add(start);
        retry.add(new MethodInsnNode(Opcodes.INVOKESTATIC, TRACKING.replace('.', '/'), "retryPending", "()V", false));
        retry.add(end);
        retry.add(new JumpInsnNode(Opcodes.GOTO, continueTick));
        retry.add(failed);
        retry.add(new InsnNode(Opcodes.POP));
        retry.add(continueTick);
        tick.instructions.insert(retry);
        tick.tryCatchBlocks.add(new TryCatchBlockNode(start, end, failed, "java/lang/NoSuchMethodError"));
    }

    private static void fixMountedStabilizerPosition(ClassNode node) throws IOException {
        MethodNode gui = node.methods.stream().filter(method -> "addGuiElements".equals(method.name))
            .findFirst().orElseThrow(() -> new IllegalStateException("Stabilizer GUI has changed."));
        ClassNode template = readTemplate("GuiDimensionalStabilizerMixin.class");
        MethodNode source = template.methods.stream().filter(method -> "cmc$useMountedWorldPosition".equals(method.name))
            .findFirst().orElseThrow(() -> new IllegalStateException("Mounted-position template is missing."));
        String helperName = "impulse$mountedWorldPosition";
        if (node.methods.stream().anyMatch(method -> helperName.equals(method.name)))
            throw new IllegalStateException("Stabilizer GUI already contains the patch helper.");
        MethodNode helper = new MethodNode(Opcodes.ACC_PRIVATE, helperName, source.desc, source.signature, null);
        source.accept(helper);
        helper.visibleAnnotations = null;
        helper.invisibleAnnotations = null;
        helper.localVariables = null;
        int replacements = 0;
        for (AbstractInsnNode instruction = gui.instructions.getFirst(); instruction != null; ) {
            AbstractInsnNode next = instruction.getNext();
            if (instruction instanceof MethodInsnNode call && TILE.equals(call.owner)
                && "getBlockPos".equals(call.name) && BLOCK_POS.equals(call.desc)) {
                InsnList replacement = new InsnList();
                replacement.add(new VarInsnNode(Opcodes.ALOAD, 0));
                replacement.add(new InsnNode(Opcodes.SWAP));
                replacement.add(new MethodInsnNode(Opcodes.INVOKESPECIAL, node.name, helperName, source.desc, false));
                gui.instructions.insertBefore(call, replacement);
                gui.instructions.remove(call);
                replacements++;
            }
            instruction = next;
        }
        if (replacements < 1 || replacements > 2)
            throw new IllegalStateException("Unexpected stabilizer position lookup count: " + replacements);
        gui.maxStack = Math.max(gui.maxStack, 8);
        node.methods.add(helper);
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
