#!/usr/bin/env bash
# apt-install.sh [PACKAGE...]: installs packages with apt-get on a CI runner,
# whatever its package mirror is doing; with no packages, only updates the
# lists. Packages already installed are skipped, and with none left, apt isn't
# touched at all.
#
# - apt retries each download itself, with a growing pause (Acquire::Retries).
# - A failed update or install is tried again, up to 3 times, 20s apart.
# - When the runner's own mirror (azure.archive.ubuntu.com, or
#   azure.ports.ubuntu.com on arm64) can't be reached, the sources switch to
#   archive.ubuntu.com (ports.ubuntu.com) before the next try, and stay so.
#
# Each retry and the switch is a ::warning:: in the run's log and summary.
# Uses sudo; changes the host's apt settings, so it's for throwaway runners only.
set -euo pipefail

sudo=()
[ "$(id -u)" = 0 ] || sudo=(sudo)

missing=() installed=()
for package in "$@"; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$'; then
    installed+=("$package")
  else
    missing+=("$package")
  fi
done
if [ ${#installed[@]} -gt 0 ]; then echo "apt: already installed, skipped: ${installed[*]}"; fi
if [ $# -gt 0 ] && [ ${#missing[@]} = 0 ]; then exit 0; fi

printf '%s\n' 'Acquire::Retries "5";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' |
  "${sudo[@]}" tee /etc/apt/apt.conf.d/80-ci-retries >/dev/null

attempt() {
  # Error-Mode=any: a list that failed to download fails the update, instead
  # of a warning and an install from stale lists.
  "${sudo[@]}" apt-get -o APT::Update::Error-Mode=any update -qq || return
  [ ${#missing[@]} = 0 ] ||
    "${sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
}

# Switches the sources to Ubuntu's own archive when they name the runner's
# mirror and it can't be reached.
fall_back() {
  local files host
  mapfile -t files < <(grep -lsE '://azure\.(archive|ports)\.ubuntu\.com' \
    /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources || true)
  [ ${#files[@]} -gt 0 ] || return 0
  host=$(grep -ohsE 'azure\.(archive|ports)\.ubuntu\.com' "${files[@]}" | head -n1)
  if timeout 15 bash -c "exec 3<>/dev/tcp/$host/80" 2>/dev/null; then return 0; fi
  echo "::warning::apt: the runner's mirror $host can't be reached; switching to ${host#azure.} in ${files[*]}"
  "${sudo[@]}" sed -i -E 's#://azure\.(archive|ports)\.ubuntu\.com#://\1.ubuntu.com#g' "${files[@]}"
}

attempts=3
for ((try = 1; ; try++)); do
  if attempt; then
    if [ "$try" -gt 1 ]; then echo "apt: succeeded on attempt $try of $attempts"; fi
    exit 0
  fi
  if [ "$try" -ge "$attempts" ]; then
    echo "::error::apt: failed $attempts times"
    exit 1
  fi
  echo "::warning::apt: attempt $try of $attempts failed, again in 20s"
  fall_back
  sleep 20
done
