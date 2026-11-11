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
#   archive.ubuntu.com (ports.ubuntu.com), and stay so. It's checked before
#   the first try and after each failed one.
#   GitHub's runners name it through a mirror list instead
#   (mirror+file:/etc/apt/apt-mirrors.txt): when a host in that list can't be
#   reached, or the list is missing, those entries become
#   http://archive.ubuntu.com/ubuntu (http://security.ubuntu.com/ubuntu for
#   the -security suites; http://ports.ubuntu.com/ubuntu-ports for both on
#   other architectures than amd64 and i386).
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

sources=(/etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources)

# Whether HOST takes a connection on PORT within 15 s (a name that doesn't
# resolve fails at once).
reachable() { timeout 15 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

# Switches the sources to Ubuntu's own archive when they name the runner's
# mirror and it can't be reached.
fall_back() {
  fall_back_azure
  fall_back_mirror_list
}

fall_back_azure() {
  local files host
  mapfile -t files < <(grep -lsE '://azure\.(archive|ports)\.ubuntu\.com' "${sources[@]}" || true)
  [ ${#files[@]} -gt 0 ] || return 0
  host=$(grep -ohsE 'azure\.(archive|ports)\.ubuntu\.com' "${files[@]}" | head -n1)
  if reachable "$host" 80; then return 0; fi
  echo "::warning::apt: the runner's mirror $host can't be reached; switching to ${host#azure.} in ${files[*]}"
  "${sudo[@]}" sed -i -E 's#://azure\.(archive|ports)\.ubuntu\.com#://\1.ubuntu.com#g' "${files[@]}"
}

# Sources such as "URIs: mirror+file:/etc/apt/apt-mirrors.txt", whose list
# names one URL per line ("http://azure.archive.ubuntu.com/ubuntu/
# priority:1"): apt doesn't move on to the list's next URL when the first
# one's name doesn't resolve, and with a host that refuses, each file waits
# out every retry first, so the entries are replaced instead.
fall_back_mirror_list() {
  local files lists list url scheme host port why= archive security file new
  mapfile -t files < <(grep -lsE 'mirror\+file:' "${sources[@]}" || true)
  [ ${#files[@]} -gt 0 ] || return 0
  mapfile -t lists < <(grep -ohsE 'mirror\+file:[^ ]+' "${files[@]}" | sed 's/^mirror+file://' | sort -u)
  for list in "${lists[@]}"; do
    if [ ! -s "$list" ]; then why="the mirror list $list is missing or empty"; break; fi
    while read -r url _; do
      [[ $url =~ ^(https?)://([^/:]+)(:([0-9]+))? ]] || continue
      scheme=${BASH_REMATCH[1]} host=${BASH_REMATCH[2]} port=${BASH_REMATCH[4]}
      [ -n "$port" ] || { [ "$scheme" = https ] && port=443 || port=80; }
      if ! reachable "$host" "$port"; then why="$host in the mirror list $list can't be reached"; break 2; fi
    done < <(grep -vE '^[[:space:]]*(#|$)' "$list")
  done
  [ -n "$why" ] || return 0
  case $(dpkg --print-architecture) in
    amd64 | i386) archive=http://archive.ubuntu.com/ubuntu security=http://security.ubuntu.com/ubuntu ;;
    *) archive=http://ports.ubuntu.com/ubuntu-ports security=$archive ;;
  esac
  echo "::warning::apt: $why; switching the mirror+file entries in ${files[*]} to $archive (-security suites: $security)"
  for file in "${files[@]}"; do
    new=$(mktemp)
    awk -v archive="$archive" -v security="$security" -f /dev/stdin "$file" > "$new" <<'AWK'
# One-line style (.list): "deb [options] URI suite components...".
FILENAME !~ /\.sources$/ {
  if ($0 ~ /^[[:space:]]*deb(-src)?[[:space:]]/ && $0 ~ /mirror\+file:/) {
    n = split($0, f, /[[:space:]]+/); suite = ""
    for (i = 1; i <= n; i++) if (f[i] ~ /^mirror\+file:/) { suite = f[i + 1]; break }
    sub(/mirror\+file:[^[:space:]]+/, suite ~ /-security$/ ? security : archive)
  }
  print; next
}
# deb822 style (.sources): a stanza with mirror+file in URIs is written once
# with its other suites and the archive, once with its -security suites and
# the security archive.
/^[[:space:]]*$/ { flush(); print; next }
{ stanza[++lines] = $0 }
END { flush() }
function flush(   i, j, n, s, other, sec, uris) {
  if (!lines) return
  uris = 0
  for (i = 1; i <= lines; i++) {
    if (stanza[i] ~ /^URIs:/ && stanza[i] ~ /mirror\+file:/) uris = i
    if (stanza[i] ~ /^Suites:/) {
      other = sec = ""
      n = split(substr(stanza[i], 8), s, /[[:space:]]+/)
      for (j = 1; j <= n; j++) if (s[j] != "") {
        if (s[j] ~ /-security$/) sec = sec " " s[j]; else other = other " " s[j]
      }
    }
  }
  if (!uris) { for (i = 1; i <= lines; i++) print stanza[i] }
  else {
    if (other != "") emit(uris, archive, other)
    if (other != "" && sec != "") print ""
    if (sec != "") emit(uris, security, sec)
  }
  lines = 0
}
function emit(uris, url, suites,   i, line) {
  for (i = 1; i <= lines; i++) {
    line = stanza[i]
    if (i == uris) gsub(/mirror\+file:[^[:space:]]+/, url, line)
    else if (line ~ /^Suites:/) line = "Suites:" suites
    print line
  }
}
AWK
    "${sudo[@]}" tee "$file" < "$new" >/dev/null
    rm -f "${new:?}"
    echo "apt: $file is now:"; grep -vE '^[[:space:]]*(#|$)' "$file" | sed 's/^/  /'
  done
}

# Before the first try too: with a mirror list, a mirror that can't be
# reached makes the try last many minutes rather than fail.
fall_back

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
