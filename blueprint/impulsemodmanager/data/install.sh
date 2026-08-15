#!/usr/bin/env bash

set -u

# Versions before 0.1.4 used Blueprint's global dashboard CSS import. During an
# extension update, some Blueprint releases retained the import without creating
# its symlink, which prevented Webpack from compiling the panel.
extensions_css="$PTERODACTYL_DIRECTORY/resources/scripts/blueprint/css/extensions.css"
legacy_css="$PTERODACTYL_DIRECTORY/resources/scripts/blueprint/css/imported/impulsemodmanager.css"

if [[ -f "$extensions_css" ]]; then
    sed -i.bak 's~@import url(\./imported/impulsemodmanager\.css);~~g' "$extensions_css"
    rm -f "$extensions_css.bak"
fi

rm -f "$legacy_css"

# Existing queue workers may still have the previous extension classes loaded.
# Ask Laravel to restart them gracefully before new mod operations are handled.
if [[ -n "${PTERODACTYL_DIRECTORY:-}" && -f "$PTERODACTYL_DIRECTORY/artisan" ]]; then
    (cd "$PTERODACTYL_DIRECTORY" && php artisan queue:restart >/dev/null 2>&1) || true
fi
