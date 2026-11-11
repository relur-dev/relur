#!/usr/bin/env bash
# retry.sh ATTEMPTS PAUSE COMMAND...: runs COMMAND up to ATTEMPTS times, PAUSE
# seconds apart, for steps whose downloads fail now and then in CI (a 504
# while downloading Electron, a name that doesn't resolve). Each failed
# attempt is a ::warning:: in the run's log and summary.
set -uo pipefail

attempts=$1 pause=$2
shift 2
for ((try = 1; ; try++)); do
  status=0
  "$@" || status=$?
  if [ "$status" = 0 ]; then
    if [ "$try" -gt 1 ]; then echo "retry: succeeded on attempt $try of $attempts: $*"; fi
    exit 0
  fi
  if [ "$try" -ge "$attempts" ]; then
    echo "::error::retry: failed $attempts times (exit $status): $*"
    exit "$status"
  fi
  echo "::warning::retry: attempt $try of $attempts failed (exit $status), again in ${pause}s: $*"
  sleep "$pause"
done
