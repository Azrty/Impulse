package com.impulse.neoforge121;

import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Objects;

public record ImpulseMusicActivity121(String title, String artist, String artworkId, byte[] artwork, long expiresAt) {
    public static final int MAX_FIELD_LENGTH = 128;
    public static final int MAX_ARTWORK_BYTES = 24 * 1024;
    public static final long TTL_MS = 30_000L;

    public ImpulseMusicActivity121 {
        title = sanitize(title);
        artist = sanitize(artist);
        artworkId = sanitizeArtworkId(artworkId);
        artwork = artwork == null ? null : artwork.clone();
        if (title.isEmpty() || artist.isEmpty()) throw new IllegalArgumentException("Music title and artist are required.");
        if (artwork != null) {
            if (artwork.length == 0 || artwork.length > MAX_ARTWORK_BYTES) throw new IllegalArgumentException("Spotify artwork is too large.");
            if (!isSupportedArtwork(artwork)) throw new IllegalArgumentException("Spotify artwork must be JPEG or PNG.");
            String actualId = artworkId(artwork);
            if (artworkId.isEmpty()) artworkId = actualId;
            else if (!artworkId.equals(actualId)) throw new IllegalArgumentException("Spotify artwork checksum does not match.");
        }
    }

    public static ImpulseMusicActivity121 fresh(String title, String artist) {
        return fresh(title, artist, "", null);
    }

    public static ImpulseMusicActivity121 fresh(String title, String artist, String artworkId, byte[] artwork) {
        return new ImpulseMusicActivity121(title, artist, artworkId, artwork, System.currentTimeMillis() + TTL_MS);
    }

    public ImpulseMusicActivity121 refreshed() {
        return new ImpulseMusicActivity121(title, artist, artworkId, artwork, System.currentTimeMillis() + TTL_MS);
    }

    public boolean isFresh() {
        return expiresAt > System.currentTimeMillis();
    }

    public boolean sameTrack(ImpulseMusicActivity121 other) {
        return other != null && title.equals(other.title) && artist.equals(other.artist) && artworkId.equals(other.artworkId);
    }

    @Override
    public byte[] artwork() {
        return artwork == null ? null : artwork.clone();
    }

    public static String artworkId(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable.", error);
        }
    }

    public static String sanitizeArtworkId(String value) {
        String cleaned = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
        if (cleaned.isEmpty()) return "";
        if (!cleaned.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid Spotify artwork id.");
        return cleaned;
    }

    public static boolean isSupportedArtwork(byte[] bytes) {
        if (bytes == null) return false;
        boolean jpeg = bytes.length >= 3 && (bytes[0] & 255) == 0xFF && (bytes[1] & 255) == 0xD8 && (bytes[2] & 255) == 0xFF;
        boolean png = bytes.length >= 8 && (bytes[0] & 255) == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47
            && bytes[4] == 0x0D && bytes[5] == 0x0A && bytes[6] == 0x1A && bytes[7] == 0x0A;
        return jpeg || png;
    }

    public static String sanitize(String value) {
        if (value == null) return "";
        StringBuilder cleaned = new StringBuilder();
        boolean pendingSpace = false;
        for (int offset = 0; offset < value.length();) {
            int codePoint = value.codePointAt(offset);
            offset += Character.charCount(codePoint);
            if (Character.isISOControl(codePoint) || Character.isWhitespace(codePoint)) {
                pendingSpace = cleaned.length() > 0;
                continue;
            }
            if (pendingSpace) cleaned.append(' ');
            cleaned.appendCodePoint(codePoint);
            pendingSpace = false;
        }
        String result = cleaned.toString().trim();
        if (result.codePointCount(0, result.length()) > MAX_FIELD_LENGTH) {
            throw new IllegalArgumentException("Music title and artist must contain at most " + MAX_FIELD_LENGTH + " characters.");
        }
        return result;
    }

    @Override
    public boolean equals(Object value) {
        if (this == value) return true;
        if (!(value instanceof ImpulseMusicActivity121 other)) return false;
        return title.equals(other.title) && artist.equals(other.artist) && artworkId.equals(other.artworkId) && Arrays.equals(artwork, other.artwork);
    }

    @Override
    public int hashCode() {
        return 31 * Objects.hash(title, artist, artworkId) + Arrays.hashCode(artwork);
    }
}
