package com.impulse.common;

final class Json {
    private final StringBuilder out = new StringBuilder();

    Json object() {
        out.append('{');
        return this;
    }

    Json endObject() {
        out.append('}');
        return this;
    }

    Json array() {
        out.append('[');
        return this;
    }

    Json endArray() {
        out.append(']');
        return this;
    }

    Json comma() {
        out.append(',');
        return this;
    }

    Json key(String key) {
        out.append('"').append(escape(key)).append('"').append(':');
        return this;
    }

    Json prop(String key, String value) {
        key(key);
        if (value == null) out.append("null");
        else out.append('"').append(escape(value)).append('"');
        return this;
    }

    Json prop(String key, int value) {
        key(key).out.append(value);
        return this;
    }

    Json prop(String key, long value) {
        key(key).out.append(value);
        return this;
    }

    Json prop(String key, boolean value) {
        key(key).out.append(value ? "true" : "false");
        return this;
    }

    public String toString() {
        return out.toString();
    }

    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': escaped.append("\\\""); break;
                case '\\': escaped.append("\\\\"); break;
                case '\b': escaped.append("\\b"); break;
                case '\f': escaped.append("\\f"); break;
                case '\n': escaped.append("\\n"); break;
                case '\r': escaped.append("\\r"); break;
                case '\t': escaped.append("\\t"); break;
                default:
                    if (c < 0x20) escaped.append(String.format("\\u%04x", (int) c));
                    else escaped.append(c);
            }
        }
        return escaped.toString();
    }
}
