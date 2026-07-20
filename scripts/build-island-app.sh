#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="$root/apps/island"
app="$root/dist/Commando Island.app"
contents="$app/Contents"

swift build --package-path "$package" -c release
rm -rf "$app"
mkdir -p "$contents/MacOS"
cp "$package/.build/release/CommandoIsland" "$contents/MacOS/CommandoIsland"
cp "$package/Resources/Info.plist" "$contents/Info.plist"
codesign --force --sign - --timestamp=none "$app"

printf 'Built %s\n' "$app"
