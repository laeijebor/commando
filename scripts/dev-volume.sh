#!/bin/bash
# Create a dedicated APFS volume for git worktrees and package caches, with
# fseventsd journaling and Spotlight indexing switched off on it.
#
# Why: with many agents churning node_modules and build output, fseventsd falls
# behind writing its on-disk journal, the kernel starts dropping file events and
# every watcher (watchman, Metro, Vite, Spotlight) rescans in a loop. A volume
# with `.fseventsd/no_log` still delivers live events to watchers; it only stops
# the journal. Spotlight has nothing useful to index there either.
#
# Usage:  sudo bash scripts/dev-volume.sh            # defaults to a volume named "Dev"
#         sudo DEV_VOLUME_NAME=Work bash scripts/dev-volume.sh
#
# Safe to re-run: every step checks before it acts. Nothing is moved; afterwards,
# point new worktrees at the volume (COMMANDO_WORKTREE_ROOT, see README) and let
# the old ones age out.
set -euo pipefail

name=${DEV_VOLUME_NAME:-Dev}
mount=/Volumes/$name
user=${SUDO_USER:-}

if [ "$(id -u)" != 0 ] || [ -z "$user" ]; then
  echo "run with sudo (needs root for diskutil/mdutil, and the invoking user for config)" >&2
  exit 1
fi

step() { printf '\n== %s\n' "$*"; }

step "APFS container holding the Data volume"
container=$(diskutil info /System/Volumes/Data | awk -F': *' '/APFS Container:/ { print $2 }')
[ -n "$container" ] || { echo "could not find the APFS container of /System/Volumes/Data" >&2; exit 1; }
echo "$container"

step "volume $name"
if mount | grep -q " on $mount "; then
  echo "already mounted at $mount"
elif diskutil info "$name" >/dev/null 2>&1; then
  diskutil mount "$name"
else
  diskutil apfs addVolume "$container" APFS "$name"
fi
mount | grep -q " on $mount " || { echo "$mount is not mounted" >&2; exit 1; }
diskutil enableOwnership "$mount" >/dev/null

step "fseventsd journal off, Spotlight off"
mkdir -p "$mount/.fseventsd"
touch "$mount/.fseventsd/no_log" "$mount/.metadata_never_index"
mdutil -i off "$mount" >/dev/null
tmutil addexclusion -p "$mount" 2>/dev/null || true
# fseventsd only reads no_log when the volume mounts.
diskutil unmount "$mount" >/dev/null
diskutil mount "$name" >/dev/null
mdutil -s "$mount"
if ls "$mount/.fseventsd" | grep -q fseventsd-uuid; then
  echo "warning: fseventsd is still journaling $mount" >&2
else
  echo "fseventsd journal: off"
fi

step "directories (owned by $user)"
chown "$user":staff "$mount"
sudo -u "$user" mkdir -p "$mount/worktrees" "$mount/cache/npm" "$mount/cache/DerivedData"
ls -ld "$mount"/worktrees "$mount"/cache/*

step "npm cache and Xcode DerivedData on the volume"
# pnpm needs no change: when a project sits on another volume than its store,
# pnpm creates a per-volume store at $mount/.pnpm-store so hard links keep working.
sudo -u "$user" -i -- npm config set cache "$mount/cache/npm"
echo "npm cache: $(sudo -u "$user" -i -- npm config get cache)"
sudo -u "$user" defaults write com.apple.dt.Xcode IDECustomDerivedDataLocation "$mount/cache/DerivedData"
echo "DerivedData: $mount/cache/DerivedData (Xcode picks it up after a restart)"

step "done"
cat <<EOF
Next:
  - New Commando worktrees: export COMMANDO_WORKTREE_ROOT=$mount/worktrees for the daemon (see README).
  - Docker Desktop shares /Volumes by default; check Settings > Resources > File sharing if a bind mount fails.
  - Existing worktrees stay where they are; create new ones on the volume and remove old ones as PRs merge.
EOF
