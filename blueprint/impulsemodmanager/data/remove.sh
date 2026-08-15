#!/usr/bin/env bash

set -u

extensions_css="$PTERODACTYL_DIRECTORY/resources/scripts/blueprint/css/extensions.css"
legacy_css="$PTERODACTYL_DIRECTORY/resources/scripts/blueprint/css/imported/impulsemodmanager.css"

if [[ -f "$extensions_css" ]]; then
    sed -i.bak 's~@import url(\./imported/impulsemodmanager\.css);~~g' "$extensions_css"
    rm -f "$extensions_css.bak"
fi

rm -f "$legacy_css"
