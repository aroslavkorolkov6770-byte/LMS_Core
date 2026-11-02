#!/bin/sh
# Read-only preparation for a NEW installation. No mkdir, install, stop or credentials.
set -eu
export LC_ALL=C
app_path='__CORE_INSTALL_PATH__'
printf 'protocol\tlms-new-install-v1\n'
printf 'kernel\t'; uname -s
printf 'os\t'; sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1 | tr -d '"'
printf 'username\t'; id -un
printf 'uid\t'; id -u
printf 'appPath\t%s\n' "$app_path"

# Check every existing component before resolving anything through it.
path_state=available
current=''
ancestor='/'
old_ifs=$IFS
IFS='/'
for component in $app_path; do
  [ -n "$component" ] || continue
  current="$current/$component"
  if [ -L "$current" ]; then path_state=unsafe; break; fi
  if [ -e "$current" ]; then
    if [ ! -d "$current" ]; then path_state=unsafe; break; fi
    ancestor=$current
  fi
done
IFS=$old_ifs
if [ "$path_state" = available ] && [ -e "$app_path" ]; then path_state=occupied; fi
printf 'pathState\t%s\n' "$path_state"
writable=0
if [ "$path_state" = available ] && [ -w "$ancestor" ] && [ -x "$ancestor" ]; then writable=1; fi
printf 'writable\t%s\n' "$writable"
printf 'node\t'; if command -v node >/dev/null 2>&1; then node --version 2>/dev/null || printf '\n'; else printf '\n'; fi
printf 'npm\t'; if command -v npm >/dev/null 2>&1; then npm --version 2>/dev/null || printf '\n'; else printf '\n'; fi
# command -v is safe: running pm2 --version can start a daemon on a clean server.
printf 'pm2\t'; command -v pm2 || printf '\n'
systemd=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then systemd=1; fi
printf 'systemd\t%s\n' "$systemd"
# A running Node/old LMS does not imply PostgreSQL has been installed or can provision a new client.
postgres_state=missing
if command -v psql >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  postgres_state=unavailable
  if [ "$(id -u)" = 0 ] && command -v timeout >/dev/null 2>&1; then
    if answer=$(PGCONNECT_TIMEOUT=5 timeout 12 runuser -u postgres -- psql -XAtw -h /var/run/postgresql -p 5432 -d postgres -c "SELECT CASE WHEN (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN 'core-db-admin-ok' ELSE 'denied' END" 2>/dev/null) && [ "$answer" = core-db-admin-ok ]; then postgres_state=ready; fi
  fi
fi
printf 'postgresState\t%s\n' "$postgres_state"
ss_available=0
candidate=0
if command -v ss >/dev/null 2>&1; then
  if listeners=$(ss -H -ltn 2>/dev/null); then
    ports=$(printf '%s\n' "$listeners" | awk '{n=$4; sub(/^.*:/,"",n); if(n ~ /^[0-9]+$/) print n}')
    ss_available=1
    # Loopback WSL targets must not shadow the Core services on Windows.
    port=__CORE_WEB_PORT_START__
    while [ "$port" -le 3099 ]; do
      if ! printf '%s\n' "$ports" | grep -qx "$port"; then candidate=$port; break; fi
      port=$((port + 1))
    done
  fi
fi
printf 'ssAvailable\t%s\n' "$ss_available"
printf 'candidatePort\t%s\n' "$candidate"
api_port=0
if [ "$ss_available" = 1 ]; then
  port=4101
  while [ "$port" -le 4199 ]; do
    if ! printf '%s\n' "$ports" | grep -qx "$port"; then api_port=$port; break; fi
    port=$((port + 1))
  done
fi
printf 'apiPort\t%s\n' "$api_port"
printf 'freeDiskBytes\t'; df -Pk "$ancestor" | awk 'NR==2 {printf "%.0f\n",$4*1024}'
printf 'memoryBytes\t'; awk '/^MemTotal:/ {printf "%.0f\n",$2*1024}' /proc/meminfo
printf 'swapBytes\t'; awk '/^SwapTotal:/ {printf "%.0f\n",$2*1024}' /proc/meminfo
