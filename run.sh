#!/usr/bin/env bash
# run.sh - load .env into the environment, then run the k6 load test.
# k6 does not read .env files itself; it reads real environment variables (__ENV).
#
# Usage:
#   ./run.sh                         # uses .env and load-test.js
#   ENV_FILE=.env.user1 ./run.sh     # different env file
#   ./run.sh -e CYCLES_PER_USER=2    # extra args are forwarded to `k6 run`
set -euo pipefail

# Git Bash / MSYS mangles env-var values that start with "/" (e.g. TOKEN_PATH)
# into Windows paths before handing them to k6.exe. This disables that.
export MSYS2_ENV_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

ENV_FILE="${ENV_FILE:-.env}"
SCRIPT="${SCRIPT:-load-test.js}"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"

mkdir -p results

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  echo "Loaded environment from $ENV_FILE"
else
  echo "No $ENV_FILE found - relying on already-set environment variables"
fi

# Mirror any `-e KEY=VALUE` / `--env KEY=VALUE` args into the environment (still
# forwarded to k6 too), so wrapper-side flags like APPEND_SUMMARY_CSV work with -e.
prev=""
for a in "$@"; do
  case "$prev" in
    -e|--env) case "$a" in *=*) export "${a%%=*}=${a#*=}" ;; esac ;;
  esac
  case "$a" in
    --env=*) kv="${a#--env=}"; case "$kv" in *=*) export "${kv%%=*}=${kv#*=}" ;; esac ;;
    -e=*)    kv="${a#-e=}";    case "$kv" in *=*) export "${kv%%=*}=${kv#*=}" ;; esac ;;
  esac
  prev="$a"
done

# Run id encodes the run shape so output files are self-describing:
#   <type>-<U>u-<C>c-<timestamp>   e.g. requests-3u-100c-2026-09-10T19-16-32.csv
RUN_ID="${USERS:-1}u-${CYCLES_PER_USER:-100}c-${STAMP}"
REQFILE="results/requests-${RUN_ID}.csv"
REPORTFILE="results/report-${RUN_ID}.csv"

# Run k6; decode the per-request log lines (@@REQ@@ / @@REQHDR@@ <base64>) into a
# CSV as they stream past, print everything else live.
rm -f "$REQFILE"
set +e
k6 run -e "RUN_ID=${RUN_ID}" "$@" "$SCRIPT" 2>&1 | while IFS= read -r line; do
  case "$line" in
    *"@@REQHDR@@ "*)
      printf '%s\n' "$line" | sed -E 's/.*@@REQHDR@@ ([A-Za-z0-9+/=]+).*/\1/' | base64 -d > "$REQFILE"
      printf '\n' >> "$REQFILE" ;;
    *"@@REQ@@ "*)
      printf '%s\n' "$line" | sed -E 's/.*@@REQ@@ ([A-Za-z0-9+/=]+).*/\1/' | base64 -d >> "$REQFILE"
      printf '\n' >> "$REQFILE" ;;
    *)
      printf '%s\n' "$line" ;;
  esac
done
k6rc=${PIPESTATUS[0]}
set -e

echo
if [ -f "$REQFILE" ]; then
  cp "$REQFILE" results/requests-latest.csv
  echo "Per-request log: $REQFILE  ($(( $(wc -l < "$REQFILE") - 1 )) rows)"
  echo "(JSON embedding of request rows is done by run.ps1 only; on bash use the CSV.)"
fi

# Append the full run summary to the bottom of the per-request CSV.
if [ "${APPEND_SUMMARY_CSV:-true}" != "false" ] && [ -f "$REQFILE" ] && [ -f "$REPORTFILE" ]; then
  for t in "$REQFILE" results/requests-latest.csv; do
    printf '\n' >> "$t"
    cat "$REPORTFILE" >> "$t"
  done
  rm -f "$REPORTFILE"   # folded into requests-*.csv; no separate file
  echo "Appended run summary to $REQFILE (and requests-latest.csv)"
fi

echo "k6 exit code: ${k6rc}  (0 = all thresholds passed, 99 = a threshold failed)"
exit "${k6rc}"
