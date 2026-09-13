package com.impulse.bootstrap.neoforge121;

import org.objectweb.asm.tree.ClassNode;

import java.util.Set;

/** Startup-only transformation of explicitly named classes. */
public interface ImpulseClassTransformer {
    Set<String> targetClasses();
    void transform(String className, ClassNode classNode) throws Exception;
}
