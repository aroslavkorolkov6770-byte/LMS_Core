#!/bin/sh
# Supported first-host contract: Ubuntu 24.04/26.04 amd64, root SSH, working systemd.
set -eu
umask 077
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
job='__CORE_PREP_ID__'
dir="/srv/lms-core/preparations/$job"
phase=validating
finished=0
status() {
  printf '{"id":"%s","phase":"%s","errorCode":"%s","updatedAt":"%s"}\n' "$job" "$1" "${2:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dir/status.tmp"
  mv "$dir/status.tmp" "$dir/status.json"
}
failed() { finished=1; status needs_attention "$1"; exit 1; }
trap 'if [ "$finished" = 0 ]; then status needs_attention PREPARATION_INTERRUPTED; fi' EXIT
exec 9> /srv/lms-core/preparations/prepare.lock
flock -n 9 || failed PREPARATION_BUSY
status validating
[ "$(id -u)" = 0 ] || failed ROOT_REQUIRED
. /etc/os-release
[ "${ID:-}" = ubuntu ] && { [ "${VERSION_ID:-}" = 24.04 ] || [ "${VERSION_ID:-}" = 26.04 ]; } && [ "$(uname -m)" = x86_64 ] || failed UNSUPPORTED_SERVER
[ -d /run/systemd/system ] || failed SYSTEMD_REQUIRED
disk=$(df -Pk / | awk 'NR==2 {printf "%.0f",$4*1024}')
memory=$(awk '/^MemTotal:/ {printf "%.0f",$2*1024}' /proc/meminfo)
swap=$(awk '/^SwapTotal:/ {printf "%.0f",$2*1024}' /proc/meminfo)
# A nominal 1 GB VPS has kernel-reserved memory; keep the full 3 GiB RAM+swap build gate.
[ "$disk" -ge 7516192768 ] && [ "$memory" -ge 943718400 ] && [ "$((memory + swap))" -ge 3221225472 ] || failed INSUFFICIENT_RESOURCES
node_needed=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || failed NODE_VERSION_CONFLICT
  node_needed=0
fi
pg_existing=0
if command -v psql >/dev/null 2>&1 || [ -d /etc/postgresql ]; then pg_existing=1; fi
if [ "$node_needed" = 1 ]; then
  printf '%s  %s\n' '1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce' "$dir/node.tar.xz" | sha256sum -c - >/dev/null || failed NODE_ARCHIVE_CHANGED
  for bin in node npm npx; do [ ! -e "/usr/local/bin/$bin" ] && [ ! -L "/usr/local/bin/$bin" ] || failed NODE_PATH_OCCUPIED; done
  [ ! -e /opt/lms-core/node-v22.23.4 ] && [ ! -L /opt/lms-core/node-v22.23.4 ] || failed NODE_PATH_OCCUPIED
fi
status packages
export DEBIAN_FRONTEND=noninteractive
timeout 1200 apt-get -o DPkg::Lock::Timeout=120 update || failed APT_UPDATE_FAILED
if [ "$pg_existing" = 0 ]; then
  timeout 1200 apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends postgresql postgresql-client ca-certificates iproute2 xz-utils libstdc++6 || failed APT_INSTALL_FAILED
else
  timeout 1200 apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends ca-certificates iproute2 xz-utils libstdc++6 || failed APT_INSTALL_FAILED
fi
if [ "$node_needed" = 1 ]; then
  status node
  # Refuse linked/foreign writable namespace components before creating anything under /opt.
  for parent in /opt /opt/lms-core; do
    [ ! -L "$parent" ] || failed NODE_PATH_OCCUPIED
    if [ ! -e "$parent" ]; then mkdir -m 755 "$parent"; fi
    [ "$(stat -c %u "$parent")" = 0 ] || failed NODE_PATH_OCCUPIED
    mode=$(stat -c %a "$parent"); [ "$((0$mode & 0022))" = 0 ] || failed NODE_PATH_OCCUPIED
  done
  mkdir -m 755 /opt/lms-core/node-v22.23.4
  tar -xJf "$dir/node.tar.xz" --strip-components=1 --no-same-owner -C /opt/lms-core/node-v22.23.4 || failed NODE_EXTRACTION_FAILED
  printf '%s\n' 'lms-core-node-v1:22.23.4:1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce' > /opt/lms-core/node-v22.23.4/.core-owner
  for bin in node npm npx; do ln -s "/opt/lms-core/node-v22.23.4/bin/$bin" "/usr/local/bin/$bin" || failed NODE_LINK_FAILED; done
fi
status postgres
if [ "$pg_existing" = 0 ]; then systemctl enable --now postgresql || failed POSTGRES_START_FAILED; fi
command -v psql >/dev/null 2>&1 || failed EXISTING_POSTGRES_UNSUPPORTED
version=$(runuser --user postgres -- psql -h /var/run/postgresql -p 5432 -d postgres -Atqc 'SHOW server_version_num') || failed POSTGRES_PEER_UNAVAILABLE
[ "$version" -ge 150000 ] || failed POSTGRES_VERSION_UNSUPPORTED
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || failed NODE_NOT_READY
npm --version >/dev/null || failed NPM_NOT_READY
status succeeded
finished=1
