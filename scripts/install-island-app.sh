#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="${COMMANDO_ISLAND_INSTALL_DIR:-$HOME/Applications}"
source_app="$root/dist/Commando Island.app"
installed_app="$install_root/Commando Island.app"

bash "$root/scripts/build-island-app.sh"
mkdir -p "$install_root"
rm -rf "$installed_app"
cp -R "$source_app" "$installed_app"

printf 'Installed %s\n' "$installed_app"
