#!/usr/bin/env bash
# Tries the .deb in dist/ on this Linux host as a user gets it: installs it
# with apt (its after-install script loads the AppArmor profile, spec §15.6),
# starts its self-test under xvfb-run as this user, with Chromium's sandbox
# on, and removes it again. For the release's Ubuntu 24.04 runners, which
# have AppArmor and restrict user namespaces as a desktop does; a container
# can't load AppArmor profiles. Uses sudo; changes the host, so it's for
# throwaway runners only.
set -euo pipefail
cd "$(dirname "$0")/.."

arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
deb=$(ls "$PWD"/dist/*-linux-"$arch".deb)
package=$(dpkg-deb --field "$deb" Package)

# within SECONDS COMMAND...: runs it, and stops it and its children when it takes longer.
within() {
  local secs=$1 status=0
  shift
  timeout -k 10 "$secs" "$@" || status=$?
  if [ "$status" = 124 ] || [ "$status" = 137 ]; then echo "FAILED: still running after ${secs}s, stopped: $*" >&2; fi
  return "$status"
}

echo "kernel.apparmor_restrict_unprivileged_userns: $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo none)"
# Lists for the .deb's dependencies, and xvfb-run where the runner has none.
# scripts/apt-install.sh retries, and falls back from the runner's mirror.
within 900 scripts/apt-install.sh
command -v xvfb-run >/dev/null || within 300 sudo apt-get install -y -qq xvfb >/dev/null

echo "== apt install $deb"
within 300 sudo apt-get install -y -qq "$deb" >/dev/null
trap 'within 300 sudo apt-get remove -y -qq "$package" >/dev/null' EXIT
exe=$(sed -n 's/^StartupWMClass=//p' "$(dpkg -L "$package" | grep -m1 '^/usr/share/applications/.*\.desktop$')")
test -x "/usr/bin/$exe"
dir=$(dirname "$(readlink -f "/usr/bin/$exe")")
echo "chrome-sandbox: $(stat -c '%U %a' "$dir/chrome-sandbox")"
if [ -e /sys/kernel/security/apparmor/profiles ]; then
  echo "AppArmor profile: $(sudo grep "^$exe " /sys/kernel/security/apparmor/profiles || echo 'not loaded')"
fi

echo "== its self-test, as $(id -un)"
within 300 xvfb-run -a "$exe" --self-test
