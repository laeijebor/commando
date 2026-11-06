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
# Usage:  sudo bash scripts/dev-volume.sh                      # volume named "Dev"
#         sudo DEV_VOLUME_NAME=Work bash scripts/dev-volume.sh  # another name
#         sudo DEV_VOLUME_ADOPT=1 bash scripts/dev-volume.sh    # reuse a volume this script did not create
#
# Safe to re-run: every step checks before it acts, and the remount that makes
# fseventsd read no_log happens only on the run that creates it. Nothing is
# moved; afterwards, point new worktrees at the volume (COMMANDO_WORKTREE_ROOT,
# see README) and let the old ones age out. The npm step runs the user's login
# shell, so a node manager loaded only from ~/.zshrc is not on its PATH.
set -euo pipefail

name=${DEV_VOLUME_NAME:-Dev}
mount=/Volumes/$name
user=${SUDO_USER:-}
marker=.dev-volume   # written by this script; proves the volume is ours to configure

if [ "$(id -u)" != 0 ] || [ -z "$user" ]; then
  echo "run with sudo (needs root for diskutil/mdutil, and the invoking user for config)" >&2
  exit 1
fi

step() { printf '\n== %s\n' "$*"; }
warn() { echo "warning: $*" >&2; }
volume_container() { diskutil info "$1" 2>/dev/null | awk -F': *' '/APFS Container:/ { print $2 }'; }

step "APFS container holding the Data volume"
container=$(volume_container /System/Volumes/Data)
[ -n "$container" ] || { echo "could not find the APFS container of /System/Volumes/Data" >&2; exit 1; }
echo "$container"

step "volume $name"
created=0
if mount | grep -q " on $mount "; then
  echo "already mounted at $mount"
elif diskutil info "$name" >/dev/null 2>&1; then
  diskutil mount "$name"
else
  diskutil apfs addVolume "$container" APFS "$name"
  created=1
fi
mount | grep -q " on $mount " || { echo "$mount is not mounted" >&2; exit 1; }
if [ "$created" = 1 ]; then
  touch "$mount/$marker"
elif [ ! -e "$mount/$marker" ]; then
  # Not ours: refuse to reconfigure (Spotlight, backups, ownership) somebody else's data.
  if [ "${DEV_VOLUME_ADOPT:-}" != 1 ]; then
    echo "$mount exists but was not created by this script; re-run with DEV_VOLUME_ADOPT=1 to use it anyway" >&2
    exit 1
  fi
  [ "$(volume_container "$mount")" = "$container" ] || { echo "$mount is not in container $container; refusing to adopt it" >&2; exit 1; }
  touch "$mount/$marker"
fi
diskutil enableOwnership "$mount" >/dev/null

step "fseventsd journal off, Spotlight off, Time Machine excluded"
mkdir -p "$mount/.fseventsd"
touch "$mount/.metadata_never_index"
mdutil -i off "$mount" >/dev/null
tmutil addexclusion -p "$mount" 2>/dev/null || warn "tmutil could not exclude $mount from Time Machine; add it in System Settings > General > Time Machine > Options"
if [ -e "$mount/.fseventsd/no_log" ]; then
  echo "fseventsd journal: already off"
else
  touch "$mount/.fseventsd/no_log"
  # fseventsd only reads no_log when the volume mounts; the volume is still empty on this run.
  if diskutil unmount "$mount" >/dev/null; then
    diskutil mount "$name" >/dev/null
  else
    warn "could not remount $mount; no_log takes effect at the next mount (reboot or diskutil unmount/mount while it is idle)"
  fi
fi
mdutil -s "$mount"
if [ -n "$(find "$mount/.fseventsd" -maxdepth 1 -name 'fseventsd-uuid' -newer "$mount/.fseventsd/no_log" 2>/dev/null)" ]; then
  warn "fseventsd is still journaling $mount"
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
echo "DerivedData: $mount/cache/DerivedData (Xcode picks it up after a restart; the old folder is left in place)"

step "done"
cat <<EOF
Next:
  - New Commando worktrees: export COMMANDO_WORKTREE_ROOT=$mount/worktrees for the daemon (see README).
  - Docker Desktop shares /Volumes by default; check Settings > Resources > File sharing if a bind mount fails.
  - Existing worktrees stay where they are; create new ones on the volume and remove old ones as PRs merge.
EOF
