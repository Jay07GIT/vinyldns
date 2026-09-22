#!/usr/bin/env bash
#
# Starts dependencies, waits for the SQS backend to warm up (avoids the
# 502 Bad Gateway race with localstack's lazy SQS init), then starts the
# VinylDNS API and tails logs. Used by `make run-deps-bg` for local testing.
#
# Note: we call start_vinyldns_api.sh directly (not `/initialize.sh vinyldns-api`)
# because initialize.sh unconditionally (re)starts nginx, which fails to rebind
# when deps-only already started it.
set -euo pipefail

/initialize.sh deps-only
/wait-for-sqs.sh
echo -n "Starting VinylDNS API.." && { /opt/vinyldns/start_vinyldns_api.sh || exit $?; } && echo "done."
exec tail -f /opt/vinyldns/vinyldns.log /var/log/named.log /var/log/mysql/error.log /localstack/localstack.log
