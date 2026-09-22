#!/usr/bin/env bash
#
# localstack reports "Ready" as soon as its edge proxy is up, but the SQS
# backend (elasticmq) lazy-initializes on first request. Under emulation this
# can take several seconds, during which SQS calls get "502 Bad Gateway".
# This waits for the SQS backend to actually respond before continuing.
set -uo pipefail

TIMEOUT=${SQS_WARMUP_TIMEOUT:-60}
START=$(date +%s)

echo -n "Waiting for SQS backend to warm up.."
while true; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:9003/")
  if [[ "$CODE" != "502" && "$CODE" != "000" ]]; then
    echo "done (HTTP $CODE)."
    exit 0
  fi

  NOW=$(date +%s)
  if (( NOW - START > TIMEOUT )); then
    echo "timed out after ${TIMEOUT}s waiting for SQS backend (last HTTP $CODE)."
    exit 1
  fi

  echo -n "."
  sleep 1
done
