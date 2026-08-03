#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="${COMMANDO_DESKTOP_INSTALL_DIR:-$HOME/Applications}"
source_app="$root/dist/Commando.app"
installed_app="$install_root/Commando.app"

bash "$root/scripts/build-desktop-app.sh"
mkdir -p "$install_root"
rm -rf "$installed_app"
cp -R "$source_app" "$installed_app"

printf 'Installed %s\n' "$installed_app"
printf 'Alpha requirement: this app needs the separately running Commando Node daemon/web service.\n'
