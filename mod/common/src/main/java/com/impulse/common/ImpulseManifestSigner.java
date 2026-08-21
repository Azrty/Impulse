package com.impulse.common;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

final class ImpulseManifestSigner {
    static final String ALGORITHM = "Ed25519";

    private ImpulseManifestSigner() {}

    static SignedManifest sign(ImpulseConfig config, byte[] body) throws IOException {
        if (!config.manifestSigningEnabled) return SignedManifest.unsigned(body);
        try {
            Signature.getInstance(ALGORITHM);
            KeyPairGenerator.getInstance(ALGORITHM);
        } catch (NoSuchAlgorithmException unsupported) {
            System.err.println("[Impulse] Ed25519 is unavailable on this Java runtime; serving an unsigned legacy manifest.");
            return SignedManifest.unsigned(body);
        }
        try {
            ensureKeyPair(config.manifestSigningPrivateKey, config.manifestSigningPublicKey);
            byte[] privateBytes = read(config.manifestSigningPrivateKey);
            byte[] publicBytes = read(config.manifestSigningPublicKey);
            KeyFactory factory = KeyFactory.getInstance(ALGORITHM);
            PrivateKey privateKey = factory.generatePrivate(new PKCS8EncodedKeySpec(privateBytes));
            PublicKey publicKey = factory.generatePublic(new X509EncodedKeySpec(publicBytes));
            Signature signer = Signature.getInstance(ALGORITHM);
            signer.initSign(privateKey);
            signer.update(body);
            String publicKeyValue = Base64.getUrlEncoder().withoutPadding().encodeToString(publicKey.getEncoded());
            String signatureValue = Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign());
            String fingerprint = hex(MessageDigest.getInstance("SHA-256").digest(publicKey.getEncoded()));
            return new SignedManifest(body, publicKeyValue, fingerprint, signatureValue);
        } catch (Exception error) {
            throw new IOException("Could not sign the Impulse manifest with Ed25519: " + error.getMessage(), error);
        }
    }

    private static void ensureKeyPair(File privateFile, File publicFile) throws Exception {
        if (privateFile.isFile() && publicFile.isFile()) return;
        File parent = privateFile.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Could not create " + parent);
        File publicParent = publicFile.getParentFile();
        if (publicParent != null && !publicParent.exists() && !publicParent.mkdirs()) throw new IOException("Could not create " + publicParent);
        KeyPair pair = KeyPairGenerator.getInstance(ALGORITHM).generateKeyPair();
        writeAtomic(privateFile, pair.getPrivate().getEncoded());
        writeAtomic(publicFile, pair.getPublic().getEncoded());
        privateFile.setReadable(false, false);
        privateFile.setReadable(true, true);
        privateFile.setWritable(false, false);
        privateFile.setWritable(true, true);
    }

    private static void writeAtomic(File target, byte[] value) throws IOException {
        File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
        FileOutputStream output = new FileOutputStream(temporary);
        try { output.write(value); output.getFD().sync(); } finally { output.close(); }
        try {
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception ignored) {
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static byte[] read(File file) throws IOException {
        FileInputStream input = new FileInputStream(file);
        try {
            byte[] data = new byte[(int) file.length()];
            int offset = 0;
            while (offset < data.length) {
                int read = input.read(data, offset, data.length - offset);
                if (read < 0) throw new IOException("Unexpected end of file: " + file);
                offset += read;
            }
            return data;
        } finally { input.close(); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (int i = 0; i < bytes.length; i++) out.append(String.format("%02x", bytes[i] & 0xff));
        return out.toString();
    }

    static final class SignedManifest {
        final byte[] body;
        final String publicKey;
        final String fingerprint;
        final String signature;

        SignedManifest(byte[] body, String publicKey, String fingerprint, String signature) {
            this.body = body;
            this.publicKey = publicKey;
            this.fingerprint = fingerprint;
            this.signature = signature;
        }

        static SignedManifest unsigned(byte[] body) { return new SignedManifest(body, null, null, null); }
        boolean isSigned() { return signature != null; }
    }
}
