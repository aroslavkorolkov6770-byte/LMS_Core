#!/bin/sh
# An explicit, separately confirmed operation. Never replace existing swap or edit fstab.
set -eu
umask 077
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
created=0
reused=0
finished=0
fail() { finished=1; printf '{"version":1,"ok":false,"code":"%s"}\n' "$1"; exit 0; }
trap 'if [ "$finished" = 0 ]; then printf "{\"version\":1,\"ok\":false,\"code\":\"SWAP_INTERRUPTED\"}\n"; fi' EXIT
read_memory() {
  memory=$(awk '/^MemTotal:/ {printf "%.0f",$2*1024}' /proc/meminfo)
  swap=$(awk '/^SwapTotal:/ {printf "%.0f",$2*1024}' /proc/meminfo)
}
success() {
  read_memory
  [ "$memory" -ge 943718400 ] && [ "$((memory + swap))" -ge 3221225472 ] || fail SWAP_NOT_ENOUGH
  finished=1
  printf '{"version":1,"ok":true,"created":%s,"reused":%s,"memoryBytes":%s,"swapBytes":%s}\n' "$created" "$reused" "$memory" "$swap"
}
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
. /etc/os-release
[ "${ID:-}" = ubuntu ] && { [ "${VERSION_ID:-}" = 24.04 ] || [ "${VERSION_ID:-}" = 26.04 ]; } && [ "$(uname -m)" = x86_64 ] || fail UNSUPPORTED_SERVER
[ -d /run/systemd/system ] || fail SYSTEMD_REQUIRED
read_memory
[ "$memory" -ge 943718400 ] || fail RAM_TOO_LOW
if [ "$((memory + swap))" -ge 3221225472 ]; then success; exit 0; fi
for tool in flock stat df dd mkswap swapon; do command -v "$tool" >/dev/null 2>&1 || fail SWAP_TOOLS_MISSING; done
# Refuse linked, foreign-owned or writable namespace components before any file allocation.
for parent in /srv /srv/lms-core /srv/lms-core/preparations /srv/lms-core/memory; do
  [ ! -L "$parent" ] || fail SWAP_PATH_UNSAFE
  if [ ! -e "$parent" ]; then
    permissions=700
    case "$parent" in /srv|/srv/lms-core) permissions=755;; esac
    mkdir -m "$permissions" "$parent" || fail SWAP_PATH_UNSAFE
  fi
  [ -d "$parent" ] && [ "$(stat -c %u "$parent")" = 0 ] || fail SWAP_PATH_UNSAFE
  mode=$(stat -c %a "$parent"); [ "$((0$mode & 0022))" = 0 ] || fail SWAP_PATH_UNSAFE
done
lock=/srv/lms-core/preparations/prepare.lock
[ ! -L "$lock" ] || fail SWAP_PATH_UNSAFE
if [ -e "$lock" ]; then
  [ -f "$lock" ] && [ "$(stat -c %u "$lock")" = 0 ] && [ "$(stat -c %h "$lock")" = 1 ] || fail SWAP_PATH_UNSAFE
  mode=$(stat -c %a "$lock"); [ "$((0$mode & 0022))" = 0 ] || fail SWAP_PATH_UNSAFE
fi
exec 9> "$lock"
flock -n 9 || fail PREPARATION_BUSY
file=/srv/lms-core/memory/build-4g.swap
marker=/srv/lms-core/memory/build-4g.owner
active() { swapon --show --noheadings --raw --output NAME | awk -v file="$file" '$0 == file {found=1} END {exit !found}'; }
if [ -e "$file" ] || [ -L "$file" ] || [ -e "$marker" ] || [ -L "$marker" ]; then
  [ ! -L "$file" ] && [ -f "$file" ] && [ ! -L "$marker" ] && [ -f "$marker" ] || fail SWAP_FILE_OCCUPIED
  for owned in "$file" "$marker"; do
    [ "$(stat -c %u "$owned")" = 0 ] && [ "$(stat -c %h "$owned")" = 1 ] && [ "$(stat -c %a "$owned")" = 600 ] || fail SWAP_FILE_OCCUPIED
  done
  [ "$(stat -c %s "$file")" = 4294967296 ] && [ "$(stat -c %s "$marker")" -le 128 ] && [ "$(cat "$marker")" = 'lms-core-build-swap-v1:4294967296:initialized' ] || fail SWAP_FILE_INCOMPLETE
  reused=1
  if ! active; then swapon "$file" >/dev/null 2>&1 || fail SWAP_ACTIVATION_FAILED; fi
  success
  exit 0
fi
filesystem=$(stat -f -c %T /srv/lms-core/memory)
case "$filesystem" in ext2/ext3|xfs) ;; *) fail SWAP_FILESYSTEM_UNSUPPORTED;; esac
disk=$(df -Pk /srv/lms-core/memory | awk 'NR==2 {printf "%.0f",$4*1024}')
# Keep at least 7 GiB for the release after allocating the 4 GiB swap file.
[ "$disk" -ge 11811160064 ] || fail SWAP_DISK_LOW
# noclobber creates a new file only. Interrupted allocations are retained for explicit inspection.
(set -C; : > "$file") || fail SWAP_FILE_OCCUPIED
chmod 600 "$file" || fail SWAP_FILE_OCCUPIED
dd if=/dev/zero of="$file" bs=1048576 count=4096 conv=notrunc status=none || fail SWAP_ALLOCATION_FAILED
[ "$(stat -c %s "$file")" = 4294967296 ] || fail SWAP_ALLOCATION_FAILED
mkswap "$file" >/dev/null 2>&1 || fail SWAP_INITIALIZATION_FAILED
(set -C; printf '%s\n' 'lms-core-build-swap-v1:4294967296:initialized' > "$marker") || fail SWAP_FILE_OCCUPIED
chmod 600 "$marker"
created=1
swapon "$file" >/dev/null 2>&1 || fail SWAP_ACTIVATION_FAILED
success
