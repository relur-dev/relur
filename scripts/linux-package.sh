#!/usr/bin/env bash
# Builds the Linux AppImage and .deb in Docker (scripts/linux-package.Dockerfile)
# into dist/, for this machine's architecture, or PLATFORM=linux/amd64 or
# linux/arm64. node-pty is compiled for the architecture it is built on, so
# each architecture is built on its own (spec §15.6). VERSION=1.2.3 sets the
# app's version.
#
# DOWNLOADS=folder: Electron's and electron-builder's downloads, kept between
# runs (the release workflow caches it): the build starts with what's in it
# and puts what it downloaded back. RETRIES=3 tries the build up to 3 times,
# for downloads that fail now and then.
set -euo pipefail
cd "$(dirname "$0")/.."

image=desktop-app-linux-package${PLATFORM:+-${PLATFORM//\//-}}
platform_args=()
if [[ -n "${PLATFORM:-}" ]]; then platform_args=(--platform "$PLATFORM"); fi

retries=${RETRIES:-1}
downloads=${DOWNLOADS:-}
empty=
cleanup() {
  if [[ -n "${container:-}" ]]; then docker rm -f "$container" >/dev/null; fi
  if [[ -n "$empty" ]]; then rm -rf "${empty:?}"; fi
}
trap cleanup EXIT
if [[ -n "$downloads" ]]; then
  mkdir -p "$downloads"
  echo "Downloads from $downloads: $(find "$downloads" -type f | wc -l | tr -d ' ') files"
else
  empty=$(mktemp -d)
fi

scripts/retry.sh "$retries" 30 docker build ${platform_args[@]+"${platform_args[@]}"} \
  --build-context downloads="${downloads:-$empty}" -f scripts/linux-package.Dockerfile -t "$image" .
mkdir -p dist
# No mounted output folder: on a Linux host it belongs to the host's uid, not
# the container's node user. docker cp writes as the user running it, so the
# packages belong to the host's user on Linux and on Docker Desktop alike.
container=$(docker create ${platform_args[@]+"${platform_args[@]}"} -e VERSION="${VERSION:-}" "$image")
scripts/retry.sh "$retries" 30 docker start -a "$container"
docker cp "$container:/home/node/out/." dist/
if [[ -n "$downloads" ]]; then
  for dir in electron electron-builder; do
    docker cp "$container:/home/node/.cache/$dir" "$downloads/" 2>/dev/null || true
  done
fi
(cd dist && ls -l -- *-linux-*.AppImage *-linux-*.deb)
