#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="$root/apps/desktop"
build_mode="${COMMANDO_DESKTOP_BUILD_MODE:-release}"
case "$build_mode" in
    release)
        configuration=release
        app="$root/dist/Commando.app"
        bundle_id=dev.commando.desktop
        ;;
    development)
        configuration=debug
        app="$package/.build/Commando Dev.app"
        bundle_id=dev.commando.desktop.dev
        ;;
    *)
        printf 'COMMANDO_DESKTOP_BUILD_MODE must be release or development\n' >&2
        exit 2
        ;;
esac
contents="$app/Contents"
identity="${COMMANDO_CODESIGN_IDENTITY:--}"

swift build --package-path "$package" -c "$configuration" --product CommandoDesktop
bin_path="$(swift build --package-path "$package" -c "$configuration" --show-bin-path)"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources"
cp "$bin_path/CommandoDesktop" "$contents/MacOS/CommandoDesktop"
cp "$package/Resources/Info.plist" "$contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$bundle_id" "$contents/Info.plist"

swiftterm_bundle="$bin_path/SwiftTerm_SwiftTerm.bundle"
if [[ -d "$swiftterm_bundle" ]]; then
    cp -R "$swiftterm_bundle" "$contents/Resources/SwiftTerm_SwiftTerm.bundle"
fi

if [[ "$identity" == "-" ]]; then
    codesign --force --deep --sign - --timestamp=none "$app"
else
    codesign --force --deep --sign "$identity" "$app"
fi
codesign --verify --deep --strict "$app"

printf 'Built %s\n' "$app"
printf 'Alpha scope: Node and web assets are not bundled; run the external Commando daemon/web service before launching the app.\n'
